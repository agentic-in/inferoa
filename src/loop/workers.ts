import type { ManagedWorktree, SessionStore, SupervisorJob } from "../session/store.js";
import type { JsonObject, SessionRecord, WorkspaceIdentity } from "../types.js";
import { readGoalVerificationRecords } from "./verification.js";

export type LoopWorkerKind = "verifier" | "goal_supervisor" | "run" | "subagent";
export type LoopWorkerStatus = SupervisorJob["status"];

export interface LoopWorkerVerification {
  verdict: string;
  confidence: string;
  verifier_role?: string;
  run_id?: string;
  summary?: string;
  created_at?: string;
}

export interface LoopWorkerItem {
  id: string;
  kind: LoopWorkerKind;
  status: LoopWorkerStatus;
  role?: string;
  suite_id?: string;
  job_id: string;
  run_id?: string;
  session_id: string;
  session_title?: string;
  parent_session_id?: string;
  parent_session_title?: string;
  goal_id?: string;
  horizon_generation?: number;
  isolation: "active_checkout" | "session" | "worktree";
  worktree_id?: string;
  worktree_status?: ManagedWorktree["status"];
  workspace_root: string;
  verification?: LoopWorkerVerification;
  created_at: string;
  updated_at: string;
}

export interface LoopWorkersReport {
  workspace_id: string;
  workspace_root: string;
  generated_at: string;
  summary: {
    total: number;
    active: number;
    verifiers: number;
    subagents: number;
    by_status: Record<string, number>;
    by_kind: Record<string, number>;
    by_role: Record<string, number>;
  };
  workers: LoopWorkerItem[];
}

export function readLoopWorkers(store: SessionStore, workspace: WorkspaceIdentity): LoopWorkersReport {
  const sessions = store.listSessions(workspace.id, { includeArchived: true });
  const sessionById = new Map(sessions.map((session) => [session.session_id, session]));
  const sessionIds = new Set(sessionById.keys());
  const worktrees = new Map(store.listManagedWorktrees({ workspaceId: workspace.id }).map((worktree) => [worktree.worktree_id, worktree]));
  const workers = store
    .listSupervisorJobs()
    .filter((job) => sessionIds.has(job.session_id))
    .map((job) => workerFromJob(store, job, sessionById, worktrees))
    .sort(compareWorkers);

  return {
    workspace_id: workspace.id,
    workspace_root: workspace.root,
    generated_at: new Date().toISOString(),
    summary: {
      total: workers.length,
      active: workers.filter((worker) => isActiveWorkerStatus(worker.status)).length,
      verifiers: workers.filter((worker) => worker.kind === "verifier").length,
      subagents: workers.filter((worker) => worker.kind === "subagent").length,
      by_status: countBy(workers, (worker) => worker.status),
      by_kind: countBy(workers, (worker) => worker.kind),
      by_role: countBy(workers.filter((worker) => Boolean(worker.role)), (worker) => worker.role ?? "unknown"),
    },
    workers,
  };
}

function workerFromJob(
  store: SessionStore,
  job: SupervisorJob,
  sessionById: Map<string, SessionRecord>,
  worktrees: Map<string, ManagedWorktree>,
): LoopWorkerItem {
  const metadata = jsonObject(job.metadata) ?? {};
  const role = stringValue(metadata.verifier_role);
  const parentSessionId = stringValue(metadata.parent_session_id);
  const kind = workerKindFromMetadata(job, metadata);
  const worktreeId = stringValue(metadata.worktree_id);
  const worktree = worktreeId ? worktrees.get(worktreeId) : undefined;
  const isolation = worktreeId ? "worktree" : parentSessionId ? "session" : "active_checkout";
  return {
    id: `worker:${job.job_id}`,
    kind,
    status: job.status,
    role,
    suite_id: stringValue(metadata.suite_id) ?? stringValue(metadata.subagent_id),
    job_id: job.job_id,
    run_id: job.run_id,
    session_id: job.session_id,
    session_title: sessionById.get(job.session_id)?.title,
    parent_session_id: parentSessionId,
    parent_session_title: parentSessionId ? sessionById.get(parentSessionId)?.title : undefined,
    goal_id: stringValue(metadata.parent_goal_id) ?? stringValue(metadata.goal_id) ?? job.goal_id,
    horizon_generation: numberValue(metadata.parent_horizon_generation) ?? numberValue(metadata.horizon_generation),
    isolation,
    worktree_id: worktreeId,
    worktree_status: worktree?.status,
    workspace_root: job.workspace_root,
    verification: kind === "verifier" ? latestWorkerVerification(store, job.session_id, job.run_id, role) : undefined,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function isVerifierJob(job: SupervisorJob, metadata: JsonObject): boolean {
  return metadata.request_class === "verification"
    || typeof metadata.verifier_role === "string"
    || job.prompt.includes("Reviewer role:");
}

function workerKindFromMetadata(job: SupervisorJob, metadata: JsonObject): LoopWorkerKind {
  if (metadata.loop_subagent === true || typeof metadata.subagent_id === "string") {
    return "subagent";
  }
  if (isVerifierJob(job, metadata)) {
    return "verifier";
  }
  return job.kind === "goal" ? "goal_supervisor" : "run";
}

function latestWorkerVerification(
  store: SessionStore,
  sessionId: string,
  runId: string | undefined,
  role: string | undefined,
): LoopWorkerVerification | undefined {
  const records = readGoalVerificationRecords(store, sessionId)
    .filter((record) => !runId || record.run_id === runId)
    .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
  const record = records[0];
  if (!record) {
    return undefined;
  }
  return {
    verdict: record.verdict,
    confidence: record.confidence,
    verifier_role: record.verifier_role ?? role,
    run_id: record.run_id,
    summary: record.summary,
    created_at: record.created_at,
  };
}

function compareWorkers(left: LoopWorkerItem, right: LoopWorkerItem): number {
  const activeDelta = Number(isActiveWorkerStatus(right.status)) - Number(isActiveWorkerStatus(left.status));
  if (activeDelta !== 0) {
    return activeDelta;
  }
  const statusDelta = workerStatusRank(left.status) - workerStatusRank(right.status);
  if (statusDelta !== 0) {
    return statusDelta;
  }
  return right.updated_at.localeCompare(left.updated_at) || left.job_id.localeCompare(right.job_id);
}

function isActiveWorkerStatus(status: LoopWorkerStatus): boolean {
  return status === "queued" || status === "running" || status === "cancel_requested" || status === "paused" || status === "blocked";
}

function workerStatusRank(status: LoopWorkerStatus): number {
  switch (status) {
    case "running":
      return 0;
    case "queued":
      return 1;
    case "paused":
    case "blocked":
      return 2;
    case "cancel_requested":
      return 3;
    case "failed":
      return 4;
    case "detached":
      return 5;
    case "cancelled":
      return 6;
    case "complete":
      return 7;
  }
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function jsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
