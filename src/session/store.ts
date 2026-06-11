import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  EndpointSignalSnapshot,
  JsonObject,
  PromptEpochRecord,
  SessionEvent,
  SessionRecord,
  WorkspaceIdentity,
} from "../types.js";
import { nowIso } from "../util/clock.js";
import { ensureDir, homeStateDir } from "../util/fs.js";
import { randomId } from "../util/hash.js";

interface SessionRow {
  session_id: string;
  workspace_id: string;
  title: string;
  status: string;
  current_epoch_id?: string;
  created_at: string;
  updated_at: string;
}

interface ResourceRow {
  uri: string;
  session_id: string;
  kind: string;
  metadata_json: string;
  content: string;
  created_at: string;
}

export interface SessionLock {
  session_id: string;
  owner_client_id: string;
  owner_kind: "cli" | "daemon";
  acquired_at: string;
  heartbeat_at: string;
}

export interface ResourceRecord {
  uri: string;
  session_id: string;
  kind: string;
  metadata: JsonObject;
  content: string;
  created_at: string;
}

export interface ProcessRecord {
  session_id: string;
  process_id: string;
  pid?: number;
  command: string;
  cwd: string;
  status: string;
  exit_code?: number | null;
  started_at?: string;
  updated_at?: string;
}

export interface SupervisorJob {
  job_id: string;
  session_id: string;
  workspace_root: string;
  prompt: string;
  status: "queued" | "running" | "detached" | "cancel_requested" | "cancelled" | "failed" | "complete" | "paused" | "blocked";
  kind: "run" | "goal";
  goal_id?: string;
  iteration: number;
  metadata: JsonObject;
  run_id?: string;
  created_at: string;
  updated_at: string;
}

export interface AutomationSchedule {
  schedule_id: string;
  workspace_id: string;
  workspace_root: string;
  session_id: string;
  prompt: string;
  status: "enabled" | "paused";
  interval_ms: number;
  next_run_at: string;
  kind: "run" | "goal";
  goal_id?: string;
  metadata: JsonObject;
  last_job_id?: string;
  last_run_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ManagedWorktree {
  worktree_id: string;
  workspace_id: string;
  base_root: string;
  path: string;
  branch: string;
  base_ref: string;
  status: "active" | "adopted" | "removed" | "failed";
  session_id?: string;
  job_id?: string;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface DiscoverySchedule {
  schedule_id: string;
  workspace_id: string;
  workspace_root: string;
  session_id: string;
  command: string;
  status: "enabled" | "paused";
  interval_ms: number;
  next_run_at: string;
  timeout_ms: number;
  metadata: JsonObject;
  last_run_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryCandidate {
  candidate_id: string;
  schedule_id: string;
  workspace_id: string;
  session_id: string;
  title: string;
  prompt: string;
  detail?: string;
  priority: "high" | "medium" | "low";
  status: "open" | "promoted" | "dismissed";
  dedupe_key: string;
  source: JsonObject;
  created_at: string;
  updated_at: string;
}

function parseJsonObject(value: string | null | undefined): JsonObject {
  if (!value) {
    return {};
  }
  return JSON.parse(value) as JsonObject;
}

function parsePromptEpoch(row: Record<string, unknown>): PromptEpochRecord {
  return {
    prompt_epoch_id: String(row.prompt_epoch_id),
    session_id: String(row.session_id),
    provider_id: String(row.provider_id),
    model_id: String(row.model_id),
    cache_salt: String(row.cache_salt),
    prompt_layout_hash: String(row.prompt_layout_hash),
    tool_schema_hash: String(row.tool_schema_hash),
    section_hashes: JSON.parse(String(row.section_hashes_json)) as Record<string, string>,
    reason: String(row.reason),
    created_at: String(row.created_at),
  };
}

function parseResource(row: ResourceRow): ResourceRecord {
  return {
    uri: row.uri,
    session_id: row.session_id,
    kind: row.kind,
    metadata: parseJsonObject(row.metadata_json),
    content: row.content,
    created_at: row.created_at,
  };
}

function parseSessionEvent(row: Record<string, unknown>): SessionEvent {
  return {
    id: Number(row.id),
    session_id: String(row.session_id),
    run_id: row.run_id ? String(row.run_id) : undefined,
    type: String(row.type),
    data: parseJsonObject(String(row.data_json)),
    created_at: String(row.created_at),
  };
}

function parseManagedWorktree(row: Record<string, unknown>): ManagedWorktree {
  return {
    worktree_id: String(row.worktree_id),
    workspace_id: String(row.workspace_id),
    base_root: String(row.base_root),
    path: String(row.worktree_path),
    branch: String(row.branch),
    base_ref: String(row.base_ref),
    status: String(row.status) as ManagedWorktree["status"],
    session_id: typeof row.session_id === "string" ? row.session_id : undefined,
    job_id: typeof row.job_id === "string" ? row.job_id : undefined,
    metadata: parseJsonObject(String(row.metadata_json ?? "{}")),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function parseDiscoverySchedule(row: Record<string, unknown>): DiscoverySchedule {
  return {
    schedule_id: String(row.schedule_id),
    workspace_id: String(row.workspace_id),
    workspace_root: String(row.workspace_root),
    session_id: String(row.session_id),
    command: String(row.command),
    status: row.status === "paused" ? "paused" : "enabled",
    interval_ms: typeof row.interval_ms === "number" && Number.isFinite(row.interval_ms) ? Math.max(1000, Math.trunc(row.interval_ms)) : 60_000,
    next_run_at: String(row.next_run_at),
    timeout_ms: typeof row.timeout_ms === "number" && Number.isFinite(row.timeout_ms) ? Math.max(1000, Math.trunc(row.timeout_ms)) : 30_000,
    metadata: parseJsonObject(String(row.metadata_json ?? "{}")),
    last_run_at: typeof row.last_run_at === "string" && row.last_run_at ? row.last_run_at : undefined,
    last_error: typeof row.last_error === "string" && row.last_error ? row.last_error : undefined,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function parseDiscoveryCandidate(row: Record<string, unknown>): DiscoveryCandidate {
  const priority = row.priority === "high" || row.priority === "low" ? row.priority : "medium";
  const status = row.status === "promoted" || row.status === "dismissed" ? row.status : "open";
  return {
    candidate_id: String(row.candidate_id),
    schedule_id: String(row.schedule_id),
    workspace_id: String(row.workspace_id),
    session_id: String(row.session_id),
    title: String(row.title),
    prompt: String(row.prompt),
    detail: typeof row.detail === "string" && row.detail ? row.detail : undefined,
    priority,
    status,
    dedupe_key: String(row.dedupe_key),
    source: parseJsonObject(String(row.source_json ?? "{}")),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function cacheHitRate(promptTokens: number | undefined, cachedPromptTokens: number | undefined): number | undefined {
  if (promptTokens === undefined || cachedPromptTokens === undefined || promptTokens <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(1, cachedPromptTokens / promptTokens));
}

export class SessionStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  private constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  static async open(stateDir?: string): Promise<SessionStore> {
    const dir = stateDir ?? process.env.INFEROA_STATE_DIR ?? homeStateDir();
    await ensureDir(dir);
    return new SessionStore(path.join(dir, "state.sqlite"));
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        root TEXT NOT NULL UNIQUE,
        alias TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        current_epoch_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        run_id TEXT,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_session_type_id ON events(session_id, type, id);

      CREATE TABLE IF NOT EXISTS locks (
        session_id TEXT PRIMARY KEY,
        owner_client_id TEXT NOT NULL,
        owner_kind TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS prompt_epochs (
        prompt_epoch_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        cache_salt TEXT NOT NULL,
        prompt_layout_hash TEXT NOT NULL,
        tool_schema_hash TEXT NOT NULL,
        section_hashes_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS resources (
        uri TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS endpoint_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        run_id TEXT,
        provider_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        request_id TEXT,
        response_id TEXT,
        prompt_hash TEXT,
        tool_schema_hash TEXT,
        prompt_tokens INTEGER,
        cached_prompt_tokens INTEGER,
        model_id TEXT,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS processes (
        session_id TEXT NOT NULL,
        process_id TEXT NOT NULL,
        pid INTEGER,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id, process_id),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS process_output (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        process_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        stream TEXT NOT NULL,
        chunk TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id, process_id) REFERENCES processes(session_id, process_id)
      );

      CREATE TABLE IF NOT EXISTS supervisor_jobs (
        job_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'run',
        goal_id TEXT,
        iteration INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS automation_schedules (
        schedule_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        next_run_at TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'run',
        goal_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        last_job_id TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS managed_worktrees (
        worktree_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        base_root TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        job_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id),
        FOREIGN KEY(job_id) REFERENCES supervisor_jobs(job_id)
      );

      CREATE TABLE IF NOT EXISTS discovery_schedules (
        schedule_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        session_id TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        next_run_at TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        last_run_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS discovery_candidates (
        candidate_id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        detail TEXT,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        source_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(schedule_id) REFERENCES discovery_schedules(schedule_id),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );
    `);
    this.ensureColumn("supervisor_jobs", "kind", "TEXT NOT NULL DEFAULT 'run'");
    this.ensureColumn("supervisor_jobs", "goal_id", "TEXT");
    this.ensureColumn("supervisor_jobs", "iteration", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("supervisor_jobs", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("automation_schedules", "kind", "TEXT NOT NULL DEFAULT 'run'");
    this.ensureColumn("automation_schedules", "goal_id", "TEXT");
    this.ensureColumn("automation_schedules", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("automation_schedules", "last_job_id", "TEXT");
    this.ensureColumn("automation_schedules", "last_run_at", "TEXT");
    this.ensureColumn("managed_worktrees", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("managed_worktrees", "session_id", "TEXT");
    this.ensureColumn("managed_worktrees", "job_id", "TEXT");
    this.ensureColumn("discovery_schedules", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("discovery_schedules", "last_run_at", "TEXT");
    this.ensureColumn("discovery_schedules", "last_error", "TEXT");
    this.ensureColumn("discovery_candidates", "source_json", "TEXT NOT NULL DEFAULT '{}'");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((item) => item.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  upsertWorkspace(workspace: WorkspaceIdentity): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO workspaces(workspace_id, root, alias, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET root = excluded.root, alias = excluded.alias`,
      )
      .run(workspace.id, workspace.root, workspace.alias, now);
  }

  createSession(workspace: WorkspaceIdentity, title?: string): SessionRecord {
    this.upsertWorkspace(workspace);
    const now = nowIso();
    const session: SessionRecord = {
      session_id: randomId("s"),
      workspace_id: workspace.id,
      title: title ?? "New session",
      status: "created",
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO sessions(session_id, workspace_id, title, status, current_epoch_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(session.session_id, session.workspace_id, session.title, session.status, null, now, now);
    this.appendEvent({
      session_id: session.session_id,
      type: "session.created",
      data: {
        workspace_alias: workspace.alias,
        workspace_root: workspace.root,
        title: session.title,
      },
    });
    return session;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as SessionRow | undefined;
    return row ? { ...row } : undefined;
  }

  findSessionByPrefix(workspaceId: string, prefix: string): SessionRecord | undefined {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE workspace_id = ? AND session_id LIKE ? ORDER BY updated_at DESC")
      .all(workspaceId, `${prefix}%`) as SessionRow[];
    if (rows.length > 1) {
      throw new Error(`Session prefix is ambiguous: ${prefix}`);
    }
    return rows[0] ? { ...rows[0] } : undefined;
  }

  listSessions(workspaceId: string, options: { includeArchived?: boolean } = {}): SessionRecord[] {
    const rows = options.includeArchived
      ? (this.db.prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId) as SessionRow[])
      : (this.db
          .prepare("SELECT * FROM sessions WHERE workspace_id = ? AND status != 'archived' ORDER BY updated_at DESC")
          .all(workspaceId) as SessionRow[]);
    return rows.map((row) => ({ ...row }));
  }

  updateSession(sessionId: string, changes: { title?: string; status?: string; current_epoch_id?: string | null }): void {
    const current = this.getSession(sessionId);
    if (!current) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const title = changes.title ?? current.title;
    const status = changes.status ?? current.status;
    const epoch = changes.current_epoch_id === undefined ? (current.current_epoch_id ?? null) : changes.current_epoch_id;
    const now = nowIso();
    this.db
      .prepare("UPDATE sessions SET title = ?, status = ?, current_epoch_id = ?, updated_at = ? WHERE session_id = ?")
      .run(title, status, epoch, now, sessionId);
  }

  renameSession(sessionId: string, title: string): SessionRecord {
    const trimmed = title.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!trimmed) {
      throw new Error("Session title must not be empty");
    }
    const previous = this.getSession(sessionId);
    if (!previous) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    this.appendEvent({
      session_id: sessionId,
      type: "session.renamed",
      data: { title: trimmed },
    });
    this.updateSession(sessionId, { title: trimmed, status: previous.status });
    return this.getSession(sessionId)!;
  }

  archiveSession(sessionId: string): SessionRecord {
    this.updateSession(sessionId, { status: "archived" });
    this.appendEvent({
      session_id: sessionId,
      type: "session.archived",
      data: {},
    });
    return this.getSession(sessionId)!;
  }

  appendEvent(event: Omit<SessionEvent, "created_at"> & { created_at?: string }): number {
    const createdAt = event.created_at ?? nowIso();
    const result = this.db
      .prepare("INSERT INTO events(session_id, run_id, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(event.session_id, event.run_id ?? null, event.type, JSON.stringify(event.data), createdAt);
    const status = this.eventStatus(event.type);
    if (status) {
      this.updateSession(event.session_id, { status });
    }
    return Number(result.lastInsertRowid);
  }

  private eventStatus(type: string): string | undefined {
    if (type === "session.locked" || type === "session.unlocked" || type === "session.renamed" || type === "resource.created") return undefined;
    if (type.startsWith("goal.")) return undefined;
    if (type.includes("permission.requested")) return "waiting_permission";
    if (type === "tool.call" || type === "tool.execution.started" || type === "tool.progress") return "running_tool";
    if (type === "tool.result" || type === "tool.success" || type === "tool.failure" || type === "tool.abort") return "idle";
    if (type.includes("compaction")) return "compacting";
    if (type.includes("resumed")) return "resumed";
    if (type.includes("archived")) return "archived";
    if (type === "run.completed") return "idle";
    if (type === "run.stopped") return "stopped";
    if (type === "run.failed") return "failed";
    if (type.includes("model.response.settled")) return "idle";
    return "active";
  }

  listEvents(sessionId: string, limit?: number): SessionEvent[] {
    const sql =
      limit === undefined
        ? "SELECT * FROM events WHERE session_id = ? ORDER BY id ASC"
        : "SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?";
    const rows = (limit === undefined
      ? this.db.prepare(sql).all(sessionId)
      : this.db.prepare(sql).all(sessionId, limit)) as Record<string, unknown>[];
    const ordered = limit === undefined ? rows : rows.reverse();
    return ordered.map(parseSessionEvent);
  }

  listEventsOfTypes(sessionId: string, types: readonly string[], limit?: number): SessionEvent[] {
    const cleanTypes = [...new Set(types.filter((type) => type.trim()))];
    if (!cleanTypes.length) {
      return [];
    }
    const placeholders = cleanTypes.map(() => "?").join(", ");
    const sql =
      limit === undefined
        ? `SELECT * FROM events WHERE session_id = ? AND type IN (${placeholders}) ORDER BY id ASC`
        : `SELECT * FROM events WHERE session_id = ? AND type IN (${placeholders}) ORDER BY id DESC LIMIT ?`;
    const params = limit === undefined ? [sessionId, ...cleanTypes] : [sessionId, ...cleanTypes, limit];
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    const ordered = limit === undefined ? rows : rows.reverse();
    return ordered.map(parseSessionEvent);
  }

  latestEventOfTypes(sessionId: string, types: readonly string[]): SessionEvent | undefined {
    const cleanTypes = [...new Set(types.filter((type) => type.trim()))];
    if (!cleanTypes.length) {
      return undefined;
    }
    const placeholders = cleanTypes.map(() => "?").join(", ");
    const row = this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? AND type IN (${placeholders}) ORDER BY id DESC LIMIT 1`)
      .get(sessionId, ...cleanTypes) as Record<string, unknown> | undefined;
    return row ? parseSessionEvent(row) : undefined;
  }

  latestEventId(sessionId: string): number {
    const row = this.db
      .prepare("SELECT id FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 1")
      .get(sessionId) as { id?: number } | undefined;
    return Number(row?.id ?? 0);
  }

  acquireLock(sessionId: string, ownerClientId: string, ownerKind: "cli" | "daemon", staleMs = 60_000): SessionLock {
    const now = nowIso();
    const existing = this.db.prepare("SELECT * FROM locks WHERE session_id = ?").get(sessionId) as SessionLock | undefined;
    if (existing) {
      const age = Date.now() - Date.parse(existing.heartbeat_at);
      if (age < staleMs && existing.owner_client_id !== ownerClientId) {
        throw new Error(`Session is locked by ${existing.owner_kind}:${existing.owner_client_id}`);
      }
    }
    this.db
      .prepare(
        `INSERT INTO locks(session_id, owner_client_id, owner_kind, acquired_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           owner_client_id = excluded.owner_client_id,
           owner_kind = excluded.owner_kind,
           acquired_at = excluded.acquired_at,
           heartbeat_at = excluded.heartbeat_at`,
      )
      .run(sessionId, ownerClientId, ownerKind, now, now);
    this.appendEvent({
      session_id: sessionId,
      type: "session.locked",
      data: { owner_client_id: ownerClientId, owner_kind: ownerKind },
    });
    return { session_id: sessionId, owner_client_id: ownerClientId, owner_kind: ownerKind, acquired_at: now, heartbeat_at: now };
  }

  heartbeatLock(sessionId: string, ownerClientId: string): void {
    this.db
      .prepare("UPDATE locks SET heartbeat_at = ? WHERE session_id = ? AND owner_client_id = ?")
      .run(nowIso(), sessionId, ownerClientId);
  }

  releaseLock(sessionId: string, ownerClientId: string): void {
    this.db.prepare("DELETE FROM locks WHERE session_id = ? AND owner_client_id = ?").run(sessionId, ownerClientId);
    this.appendEvent({
      session_id: sessionId,
      type: "session.unlocked",
      data: { owner_client_id: ownerClientId },
    });
  }

  getLock(sessionId: string): SessionLock | undefined {
    return this.db.prepare("SELECT * FROM locks WHERE session_id = ?").get(sessionId) as SessionLock | undefined;
  }

  clearStaleLocks(staleMs = 60_000): number {
    const locks = this.db.prepare("SELECT * FROM locks").all() as SessionLock[];
    let cleared = 0;
    for (const lock of locks) {
      const age = Date.now() - Date.parse(lock.heartbeat_at);
      if (age < staleMs) {
        continue;
      }
      const latestRunId = this.latestOpenRunId(lock.session_id);
      if (latestRunId) {
        this.appendEvent({
          session_id: lock.session_id,
          run_id: latestRunId,
          type: "run.stopped",
          data: { reason: "stale_lock", owner_client_id: lock.owner_client_id, owner_kind: lock.owner_kind, heartbeat_at: lock.heartbeat_at },
        });
      }
      this.db.prepare("DELETE FROM locks WHERE session_id = ? AND owner_client_id = ?").run(lock.session_id, lock.owner_client_id);
      this.appendEvent({
        session_id: lock.session_id,
        type: "session.unlocked",
        data: { owner_client_id: lock.owner_client_id, owner_kind: lock.owner_kind, reason: "stale_lock", heartbeat_at: lock.heartbeat_at },
      });
      cleared += 1;
    }
    return cleared;
  }

  private latestOpenRunId(sessionId: string): string | undefined {
    const row = this.db
      .prepare("SELECT run_id FROM events WHERE session_id = ? AND run_id IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(sessionId) as { run_id?: string } | undefined;
    const runId = row?.run_id;
    if (!runId) {
      return undefined;
    }
    const terminal = this.db
      .prepare("SELECT 1 FROM events WHERE session_id = ? AND run_id = ? AND type IN ('run.completed', 'run.stopped', 'run.failed') LIMIT 1")
      .get(sessionId, runId);
    return terminal ? undefined : runId;
  }

  insertPromptEpoch(record: PromptEpochRecord): void {
    const createdAt = record.created_at ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO prompt_epochs(
          prompt_epoch_id, session_id, provider_id, model_id, cache_salt,
          prompt_layout_hash, tool_schema_hash, section_hashes_json, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.prompt_epoch_id,
        record.session_id,
        record.provider_id,
        record.model_id,
        record.cache_salt,
        record.prompt_layout_hash,
        record.tool_schema_hash,
        JSON.stringify(record.section_hashes),
        record.reason,
        createdAt,
      );
    this.updateSession(record.session_id, { current_epoch_id: record.prompt_epoch_id });
    this.appendEvent({
      session_id: record.session_id,
      type: "prompt.epoch.created",
      data: {
        prompt_epoch_id: record.prompt_epoch_id,
        provider_id: record.provider_id,
        model_id: record.model_id,
        cache_salt: record.cache_salt,
        prompt_layout_hash: record.prompt_layout_hash,
        tool_schema_hash: record.tool_schema_hash,
        section_hashes: record.section_hashes,
        reason: record.reason,
      },
    });
  }

  getCurrentPromptEpoch(sessionId: string): PromptEpochRecord | undefined {
    const session = this.getSession(sessionId);
    if (!session?.current_epoch_id) {
      return undefined;
    }
    const row = this.db
      .prepare("SELECT * FROM prompt_epochs WHERE prompt_epoch_id = ?")
      .get(session.current_epoch_id) as Record<string, unknown> | undefined;
    return row ? parsePromptEpoch(row) : undefined;
  }

  putResource(sessionId: string, kind: string, content: string, metadata: JsonObject = {}): ResourceRecord {
    const uri = `resource://${sessionId}/${randomId("r")}`;
    const createdAt = nowIso();
    this.db
      .prepare("INSERT INTO resources(uri, session_id, kind, metadata_json, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(uri, sessionId, kind, JSON.stringify(metadata), content, createdAt);
    this.appendEvent({
      session_id: sessionId,
      type: "resource.created",
      data: { uri, kind, metadata, bytes: Buffer.byteLength(content) },
    });
    return { uri, session_id: sessionId, kind, metadata, content, created_at: createdAt };
  }

  readResource(uri: string): ResourceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM resources WHERE uri = ?").get(uri) as ResourceRow | undefined;
    return row ? parseResource(row) : undefined;
  }

  listResources(sessionId: string, limit = 50): ResourceRecord[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
    const rows = this.db
      .prepare("SELECT * FROM resources WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(sessionId, safeLimit) as ResourceRow[];
    return rows.map(parseResource);
  }

  recordEndpointEvidence(
    sessionId: string,
    runId: string | undefined,
    providerId: string,
    snapshot: EndpointSignalSnapshot,
    promptHash?: string,
    toolSchemaHash?: string,
  ): void {
    const evidence: EndpointSignalSnapshot = {
      ...snapshot,
      prompt_hash: snapshot.prompt_hash ?? promptHash,
      tool_schema_hash: snapshot.tool_schema_hash ?? toolSchemaHash,
      cache_hit_rate: snapshot.cache_hit_rate ?? cacheHitRate(snapshot.usage?.prompt_tokens, snapshot.usage?.cached_prompt_tokens),
    };
    this.db
      .prepare(
        `INSERT INTO endpoint_evidence(
          session_id, run_id, provider_id, mode, request_id, response_id, prompt_hash,
          tool_schema_hash, prompt_tokens, cached_prompt_tokens, model_id, evidence_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        runId ?? null,
        providerId,
        evidence.mode,
        evidence.request_id ?? null,
        evidence.response_id ?? null,
        promptHash ?? null,
        toolSchemaHash ?? null,
        evidence.usage?.prompt_tokens ?? null,
        evidence.usage?.cached_prompt_tokens ?? null,
        evidence.model ?? null,
        JSON.stringify(evidence),
        nowIso(),
      );
    this.appendEvent({
      session_id: sessionId,
      run_id: runId,
      type: "endpoint.evidence.recorded",
      data: {
        provider_id: providerId,
        mode: evidence.mode,
        step_id: evidence.step_id,
        step_index: evidence.step_index,
        request_id: evidence.request_id,
        response_id: evidence.response_id,
        request_class: evidence.request_class,
        prompt_hash: evidence.prompt_hash,
        tool_schema_hash: evidence.tool_schema_hash,
        prompt_epoch_id: evidence.prompt_epoch_id,
        prompt_tokens: evidence.usage?.prompt_tokens,
        cached_prompt_tokens: evidence.usage?.cached_prompt_tokens,
        cache_hit_rate: evidence.cache_hit_rate,
        model: evidence.model,
      },
    });
  }

  listEndpointEvidence(sessionId: string): JsonObject[] {
    return (this.db
      .prepare("SELECT run_id, evidence_json, created_at FROM endpoint_evidence WHERE session_id = ? ORDER BY id ASC")
      .all(sessionId) as { run_id?: string | null; evidence_json: string; created_at?: string }[]).map((row) => ({
        ...parseJsonObject(row.evidence_json),
        run_id: row.run_id ?? undefined,
        created_at: row.created_at,
      }));
  }

  upsertProcess(record: {
    session_id: string;
    process_id: string;
    pid?: number;
    command: string;
    cwd: string;
    status: string;
    exit_code?: number | null;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO processes(session_id, process_id, pid, command, cwd, status, exit_code, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, process_id) DO UPDATE SET
           pid = excluded.pid,
           status = excluded.status,
           exit_code = excluded.exit_code,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.session_id,
        record.process_id,
        record.pid ?? null,
        record.command,
        record.cwd,
        record.status,
        record.exit_code ?? null,
        now,
        now,
      );
  }

  getProcess(sessionId: string, processId: string): ProcessRecord | undefined {
    const row = this.db
      .prepare("SELECT session_id, process_id, pid, command, cwd, status, exit_code, started_at, updated_at FROM processes WHERE session_id = ? AND process_id = ?")
      .get(sessionId, processId) as
      | {
          session_id: string;
          process_id: string;
          pid?: number | null;
          command: string;
          cwd: string;
          status: string;
          exit_code?: number | null;
          started_at?: string;
          updated_at?: string;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      session_id: row.session_id,
      process_id: row.process_id,
      pid: row.pid ?? undefined,
      command: row.command,
      cwd: row.cwd,
      status: row.status,
      exit_code: row.exit_code ?? undefined,
      started_at: row.started_at,
      updated_at: row.updated_at,
    };
  }

  appendProcessOutput(sessionId: string, processId: string, stream: "stdout" | "stderr", chunk: string): number {
    const last = this.db
      .prepare("SELECT MAX(seq) AS seq FROM process_output WHERE session_id = ? AND process_id = ?")
      .get(sessionId, processId) as { seq?: number | null } | undefined;
    const seq = Number(last?.seq ?? 0) + 1;
    this.db
      .prepare("INSERT INTO process_output(session_id, process_id, seq, stream, chunk, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sessionId, processId, seq, stream, chunk, nowIso());
    return seq;
  }

  readProcessOutput(sessionId: string, processId: string, sinceSeq = 0, maxBytes = 24_000): { seq: number; text: string } {
    const rows = this.db
      .prepare(
        "SELECT seq, stream, chunk FROM process_output WHERE session_id = ? AND process_id = ? AND seq > ? ORDER BY seq ASC",
      )
      .all(sessionId, processId, sinceSeq) as { seq: number; stream: string; chunk: string }[];
    let text = "";
    let seq = sinceSeq;
    for (const row of rows) {
      const next = `${row.stream}: ${row.chunk}`;
      if (Buffer.byteLength(text + next) > maxBytes) {
        break;
      }
      text += next;
      seq = row.seq;
    }
    return { seq, text };
  }

  createSupervisorJob(
    sessionId: string,
    workspaceRoot: string,
    prompt: string,
    options: { kind?: "run" | "goal"; goal_id?: string; iteration?: number; metadata?: JsonObject } = {},
  ): SupervisorJob {
    const now = nowIso();
    const job: SupervisorJob = {
      job_id: randomId("j"),
      session_id: sessionId,
      workspace_root: workspaceRoot,
      prompt,
      status: "queued",
      kind: options.kind ?? "run",
      goal_id: options.goal_id,
      iteration: Math.max(0, Math.trunc(options.iteration ?? 0)),
      metadata: options.metadata ?? {},
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        "INSERT INTO supervisor_jobs(job_id, session_id, workspace_root, prompt, status, kind, goal_id, iteration, metadata_json, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(job.job_id, job.session_id, job.workspace_root, job.prompt, job.status, job.kind, job.goal_id ?? null, job.iteration, JSON.stringify(job.metadata), null, now, now);
    this.appendEvent({
      session_id: sessionId,
      type: job.kind === "goal" ? "goal.supervisor.queued" : "daemon.job.queued",
      data: { job_id: job.job_id, prompt, kind: job.kind, goal_id: job.goal_id },
    });
    return job;
  }

  updateSupervisorJob(jobId: string, changes: Partial<Pick<SupervisorJob, "status" | "run_id" | "iteration" | "metadata">>): void {
    const current = this.getSupervisorJob(jobId);
    if (!current) {
      throw new Error(`Unknown supervisor job: ${jobId}`);
    }
    this.db
      .prepare("UPDATE supervisor_jobs SET status = ?, run_id = ?, iteration = ?, metadata_json = ?, updated_at = ? WHERE job_id = ?")
      .run(
        changes.status ?? current.status,
        changes.run_id ?? current.run_id ?? null,
        changes.iteration ?? current.iteration,
        JSON.stringify(changes.metadata ?? current.metadata ?? {}),
        nowIso(),
        jobId,
      );
  }

  getSupervisorJob(jobId: string): SupervisorJob | undefined {
    const row = this.db.prepare("SELECT * FROM supervisor_jobs WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
    return row ? parseSupervisorJob(row) : undefined;
  }

  listSupervisorJobs(status?: string): SupervisorJob[] {
    const rows = status
      ? (this.db
          .prepare("SELECT * FROM supervisor_jobs WHERE status = ? ORDER BY updated_at DESC")
          .all(status) as Record<string, unknown>[])
      : (this.db.prepare("SELECT * FROM supervisor_jobs ORDER BY updated_at DESC").all() as Record<string, unknown>[]);
    return rows.map(parseSupervisorJob);
  }

  createManagedWorktree(record: {
    worktree_id?: string;
    workspace_id: string;
    base_root: string;
    path: string;
    branch: string;
    base_ref: string;
    status?: ManagedWorktree["status"];
    session_id?: string;
    job_id?: string;
    metadata?: JsonObject;
  }): ManagedWorktree {
    const now = nowIso();
    const worktree: ManagedWorktree = {
      worktree_id: record.worktree_id ?? randomId("wt"),
      workspace_id: record.workspace_id,
      base_root: record.base_root,
      path: record.path,
      branch: record.branch,
      base_ref: record.base_ref,
      status: record.status ?? "active",
      session_id: record.session_id,
      job_id: record.job_id,
      metadata: record.metadata ?? {},
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO managed_worktrees(
          worktree_id, workspace_id, base_root, worktree_path, branch, base_ref, status,
          session_id, job_id, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        worktree.worktree_id,
        worktree.workspace_id,
        worktree.base_root,
        worktree.path,
        worktree.branch,
        worktree.base_ref,
        worktree.status,
        worktree.session_id ?? null,
        worktree.job_id ?? null,
        JSON.stringify(worktree.metadata),
        now,
        now,
      );
    return worktree;
  }

  updateManagedWorktree(
    worktreeId: string,
    changes: Partial<Pick<ManagedWorktree, "status" | "session_id" | "job_id" | "metadata">>,
  ): void {
    const current = this.getManagedWorktree(worktreeId);
    if (!current) {
      throw new Error(`Unknown managed worktree: ${worktreeId}`);
    }
    this.db
      .prepare("UPDATE managed_worktrees SET status = ?, session_id = ?, job_id = ?, metadata_json = ?, updated_at = ? WHERE worktree_id = ?")
      .run(
        changes.status ?? current.status,
        changes.session_id ?? current.session_id ?? null,
        changes.job_id ?? current.job_id ?? null,
        JSON.stringify(changes.metadata ?? current.metadata ?? {}),
        nowIso(),
        worktreeId,
      );
  }

  getManagedWorktree(worktreeId: string): ManagedWorktree | undefined {
    const row = this.db.prepare("SELECT * FROM managed_worktrees WHERE worktree_id = ?").get(worktreeId) as Record<string, unknown> | undefined;
    return row ? parseManagedWorktree(row) : undefined;
  }

  findManagedWorktreeByPrefix(workspaceId: string, prefix: string): ManagedWorktree | undefined {
    const rows = this.db
      .prepare("SELECT * FROM managed_worktrees WHERE workspace_id = ? AND worktree_id LIKE ? ORDER BY updated_at DESC")
      .all(workspaceId, `${prefix}%`) as Record<string, unknown>[];
    return rows.length === 1 ? parseManagedWorktree(rows[0]!) : undefined;
  }

  listManagedWorktrees(options: { workspaceId?: string; status?: ManagedWorktree["status"] } = {}): ManagedWorktree[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (options.workspaceId) {
      clauses.push("workspace_id = ?");
      values.push(options.workspaceId);
    }
    if (options.status) {
      clauses.push("status = ?");
      values.push(options.status);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM managed_worktrees${where} ORDER BY updated_at DESC`).all(...values) as Record<string, unknown>[];
    return rows.map(parseManagedWorktree);
  }

  createAutomationSchedule(
    workspace: WorkspaceIdentity,
    sessionId: string,
    prompt: string,
    options: {
      interval_ms: number;
      next_run_at: string;
      kind?: "run" | "goal";
      goal_id?: string;
      metadata?: JsonObject;
      status?: "enabled" | "paused";
    },
  ): AutomationSchedule {
    this.upsertWorkspace(workspace);
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const intervalMs = Math.max(1000, Math.trunc(options.interval_ms));
    const now = nowIso();
    const schedule: AutomationSchedule = {
      schedule_id: randomId("auto"),
      workspace_id: workspace.id,
      workspace_root: workspace.root,
      session_id: session.session_id,
      prompt,
      status: options.status ?? "enabled",
      interval_ms: intervalMs,
      next_run_at: options.next_run_at,
      kind: options.kind ?? "run",
      goal_id: options.goal_id,
      metadata: options.metadata ?? {},
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO automation_schedules(
          schedule_id, workspace_id, workspace_root, session_id, prompt, status, interval_ms, next_run_at,
          kind, goal_id, metadata_json, last_job_id, last_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.schedule_id,
        schedule.workspace_id,
        schedule.workspace_root,
        schedule.session_id,
        schedule.prompt,
        schedule.status,
        schedule.interval_ms,
        schedule.next_run_at,
        schedule.kind,
        schedule.goal_id ?? null,
        JSON.stringify(schedule.metadata),
        null,
        null,
        now,
        now,
      );
    this.appendEvent({
      session_id: schedule.session_id,
      type: "automation.schedule.created",
      data: {
        schedule_id: schedule.schedule_id,
        prompt,
        interval_ms: schedule.interval_ms,
        next_run_at: schedule.next_run_at,
        kind: schedule.kind,
        goal_id: schedule.goal_id,
      },
    });
    return schedule;
  }

  updateAutomationSchedule(
    scheduleId: string,
    changes: Partial<Pick<AutomationSchedule, "status" | "next_run_at" | "last_job_id" | "last_run_at" | "metadata">>,
  ): void {
    const current = this.getAutomationSchedule(scheduleId);
    if (!current) {
      throw new Error(`Unknown automation schedule: ${scheduleId}`);
    }
    this.db
      .prepare(
        `UPDATE automation_schedules
         SET status = ?, next_run_at = ?, last_job_id = ?, last_run_at = ?, metadata_json = ?, updated_at = ?
         WHERE schedule_id = ?`,
      )
      .run(
        changes.status ?? current.status,
        changes.next_run_at ?? current.next_run_at,
        changes.last_job_id ?? current.last_job_id ?? null,
        changes.last_run_at ?? current.last_run_at ?? null,
        JSON.stringify(changes.metadata ?? current.metadata ?? {}),
        nowIso(),
        scheduleId,
      );
  }

  deleteAutomationSchedule(scheduleId: string): AutomationSchedule | undefined {
    const current = this.getAutomationSchedule(scheduleId);
    if (!current) {
      return undefined;
    }
    this.db.prepare("DELETE FROM automation_schedules WHERE schedule_id = ?").run(scheduleId);
    this.appendEvent({
      session_id: current.session_id,
      type: "automation.schedule.deleted",
      data: { schedule_id: scheduleId },
    });
    return current;
  }

  getAutomationSchedule(scheduleId: string): AutomationSchedule | undefined {
    const row = this.db.prepare("SELECT * FROM automation_schedules WHERE schedule_id = ?").get(scheduleId) as Record<string, unknown> | undefined;
    return row ? parseAutomationSchedule(row) : undefined;
  }

  listAutomationSchedules(options: { workspaceId?: string; status?: "enabled" | "paused"; dueAt?: string } = {}): AutomationSchedule[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(options.workspaceId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.dueAt) {
      clauses.push("next_run_at <= ?");
      params.push(options.dueAt);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM automation_schedules ${where} ORDER BY next_run_at ASC, updated_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(parseAutomationSchedule);
  }

  createDiscoverySchedule(
    workspace: WorkspaceIdentity,
    sessionId: string,
    command: string,
    options: {
      interval_ms: number;
      next_run_at: string;
      timeout_ms?: number;
      metadata?: JsonObject;
      status?: "enabled" | "paused";
    },
  ): DiscoverySchedule {
    this.upsertWorkspace(workspace);
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const now = nowIso();
    const schedule: DiscoverySchedule = {
      schedule_id: randomId("disc"),
      workspace_id: workspace.id,
      workspace_root: workspace.root,
      session_id: session.session_id,
      command,
      status: options.status ?? "enabled",
      interval_ms: Math.max(60_000, Math.trunc(options.interval_ms)),
      next_run_at: options.next_run_at,
      timeout_ms: Math.max(1000, Math.trunc(options.timeout_ms ?? 30_000)),
      metadata: options.metadata ?? {},
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO discovery_schedules(
          schedule_id, workspace_id, workspace_root, session_id, command, status, interval_ms,
          next_run_at, timeout_ms, metadata_json, last_run_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.schedule_id,
        schedule.workspace_id,
        schedule.workspace_root,
        schedule.session_id,
        schedule.command,
        schedule.status,
        schedule.interval_ms,
        schedule.next_run_at,
        schedule.timeout_ms,
        JSON.stringify(schedule.metadata),
        null,
        null,
        now,
        now,
      );
    this.appendEvent({
      session_id: schedule.session_id,
      type: "loop.discovery.schedule.created",
      data: {
        schedule_id: schedule.schedule_id,
        command: schedule.command,
        interval_ms: schedule.interval_ms,
        next_run_at: schedule.next_run_at,
        timeout_ms: schedule.timeout_ms,
      },
    });
    return schedule;
  }

  updateDiscoverySchedule(
    scheduleId: string,
    changes: Partial<Pick<DiscoverySchedule, "status" | "next_run_at" | "timeout_ms" | "metadata" | "last_run_at" | "last_error">>,
  ): void {
    const current = this.getDiscoverySchedule(scheduleId);
    if (!current) {
      throw new Error(`Unknown discovery schedule: ${scheduleId}`);
    }
    this.db
      .prepare(
        `UPDATE discovery_schedules
         SET status = ?, next_run_at = ?, timeout_ms = ?, metadata_json = ?, last_run_at = ?, last_error = ?, updated_at = ?
         WHERE schedule_id = ?`,
      )
      .run(
        changes.status ?? current.status,
        changes.next_run_at ?? current.next_run_at,
        changes.timeout_ms ?? current.timeout_ms,
        JSON.stringify(changes.metadata ?? current.metadata ?? {}),
        changes.last_run_at ?? current.last_run_at ?? null,
        changes.last_error === undefined ? current.last_error ?? null : changes.last_error,
        nowIso(),
        scheduleId,
      );
  }

  deleteDiscoverySchedule(scheduleId: string): DiscoverySchedule | undefined {
    const current = this.getDiscoverySchedule(scheduleId);
    if (!current) {
      return undefined;
    }
    this.db.prepare("DELETE FROM discovery_schedules WHERE schedule_id = ?").run(scheduleId);
    this.appendEvent({
      session_id: current.session_id,
      type: "loop.discovery.schedule.deleted",
      data: { schedule_id: scheduleId },
    });
    return current;
  }

  getDiscoverySchedule(scheduleId: string): DiscoverySchedule | undefined {
    const row = this.db.prepare("SELECT * FROM discovery_schedules WHERE schedule_id = ?").get(scheduleId) as Record<string, unknown> | undefined;
    return row ? parseDiscoverySchedule(row) : undefined;
  }

  listDiscoverySchedules(options: { workspaceId?: string; status?: "enabled" | "paused"; dueAt?: string } = {}): DiscoverySchedule[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(options.workspaceId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.dueAt) {
      clauses.push("next_run_at <= ?");
      params.push(options.dueAt);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM discovery_schedules ${where} ORDER BY next_run_at ASC, updated_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(parseDiscoverySchedule);
  }

  upsertDiscoveryCandidate(record: {
    candidate_id: string;
    schedule_id: string;
    workspace_id: string;
    session_id: string;
    title: string;
    prompt: string;
    detail?: string;
    priority: DiscoveryCandidate["priority"];
    dedupe_key: string;
    source?: JsonObject;
  }): DiscoveryCandidate {
    const now = nowIso();
    const existing = this.getDiscoveryCandidate(record.candidate_id);
    const status = existing?.status ?? "open";
    const createdAt = existing?.created_at ?? now;
    this.db
      .prepare(
        `INSERT INTO discovery_candidates(
          candidate_id, schedule_id, workspace_id, session_id, title, prompt, detail, priority,
          status, dedupe_key, source_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(candidate_id) DO UPDATE SET
          title = excluded.title,
          prompt = excluded.prompt,
          detail = excluded.detail,
          priority = excluded.priority,
          source_json = excluded.source_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        record.candidate_id,
        record.schedule_id,
        record.workspace_id,
        record.session_id,
        record.title,
        record.prompt,
        record.detail ?? null,
        record.priority,
        status,
        record.dedupe_key,
        JSON.stringify(record.source ?? {}),
        createdAt,
        now,
      );
    return this.getDiscoveryCandidate(record.candidate_id)!;
  }

  updateDiscoveryCandidate(candidateId: string, changes: Partial<Pick<DiscoveryCandidate, "status" | "source">>): void {
    const current = this.getDiscoveryCandidate(candidateId);
    if (!current) {
      throw new Error(`Unknown discovery candidate: ${candidateId}`);
    }
    this.db
      .prepare("UPDATE discovery_candidates SET status = ?, source_json = ?, updated_at = ? WHERE candidate_id = ?")
      .run(
        changes.status ?? current.status,
        JSON.stringify(changes.source ?? current.source ?? {}),
        nowIso(),
        candidateId,
      );
  }

  getDiscoveryCandidate(candidateId: string): DiscoveryCandidate | undefined {
    const row = this.db.prepare("SELECT * FROM discovery_candidates WHERE candidate_id = ?").get(candidateId) as Record<string, unknown> | undefined;
    return row ? parseDiscoveryCandidate(row) : undefined;
  }

  listDiscoveryCandidates(options: { workspaceId?: string; status?: DiscoveryCandidate["status"] } = {}): DiscoveryCandidate[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(options.workspaceId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM discovery_candidates ${where} ORDER BY updated_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(parseDiscoveryCandidate);
  }
}

function parseSupervisorJob(row: Record<string, unknown>): SupervisorJob {
  return {
    job_id: String(row.job_id),
    session_id: String(row.session_id),
    workspace_root: String(row.workspace_root),
    prompt: String(row.prompt),
    status: String(row.status) as SupervisorJob["status"],
    kind: row.kind === "goal" ? "goal" : "run",
    goal_id: typeof row.goal_id === "string" && row.goal_id ? row.goal_id : undefined,
    iteration: typeof row.iteration === "number" && Number.isFinite(row.iteration) ? Math.max(0, Math.trunc(row.iteration)) : 0,
    metadata: parseJsonObject(String(row.metadata_json ?? "{}")),
    run_id: typeof row.run_id === "string" && row.run_id ? row.run_id : undefined,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function parseAutomationSchedule(row: Record<string, unknown>): AutomationSchedule {
  return {
    schedule_id: String(row.schedule_id),
    workspace_id: String(row.workspace_id),
    workspace_root: String(row.workspace_root),
    session_id: String(row.session_id),
    prompt: String(row.prompt),
    status: row.status === "paused" ? "paused" : "enabled",
    interval_ms: typeof row.interval_ms === "number" && Number.isFinite(row.interval_ms) ? Math.max(1000, Math.trunc(row.interval_ms)) : 1000,
    next_run_at: String(row.next_run_at),
    kind: row.kind === "goal" ? "goal" : "run",
    goal_id: typeof row.goal_id === "string" && row.goal_id ? row.goal_id : undefined,
    metadata: parseJsonObject(String(row.metadata_json ?? "{}")),
    last_job_id: typeof row.last_job_id === "string" && row.last_job_id ? row.last_job_id : undefined,
    last_run_at: typeof row.last_run_at === "string" && row.last_run_at ? row.last_run_at : undefined,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
