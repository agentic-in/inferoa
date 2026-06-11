import { spawn } from "node:child_process";
import type { DiscoveryCandidate, DiscoverySchedule, SessionStore } from "../session/store.js";
import type { JsonObject, WorkspaceIdentity } from "../types.js";
import { shortHash, stableJson } from "../util/hash.js";

export interface CreateLoopDiscoveryScheduleOptions {
  command: string;
  interval_ms: number;
  next_run_at?: string;
  timeout_ms?: number;
  session_id?: string;
  title?: string;
  metadata?: JsonObject;
}

export interface CreateGitChangesDiscoveryScheduleOptions {
  interval_ms: number;
  next_run_at?: string;
  timeout_ms?: number;
  session_id?: string;
  title?: string;
  metadata?: JsonObject;
}

export interface CreateGitHubIssuesDiscoveryScheduleOptions {
  interval_ms: number;
  next_run_at?: string;
  timeout_ms?: number;
  session_id?: string;
  title?: string;
  repo?: string;
  labels?: string[];
  limit?: number;
  metadata?: JsonObject;
}

export interface CreateGitHubAssignedIssuesDiscoveryScheduleOptions {
  interval_ms: number;
  next_run_at?: string;
  timeout_ms?: number;
  session_id?: string;
  title?: string;
  repo?: string;
  assignee?: string;
  labels?: string[];
  limit?: number;
  metadata?: JsonObject;
}

export interface CreateGitHubPullRequestsDiscoveryScheduleOptions {
  interval_ms: number;
  next_run_at?: string;
  timeout_ms?: number;
  session_id?: string;
  title?: string;
  repo?: string;
  labels?: string[];
  limit?: number;
  metadata?: JsonObject;
}

export interface CreateGitHubAssignedPullRequestsDiscoveryScheduleOptions {
  interval_ms: number;
  next_run_at?: string;
  timeout_ms?: number;
  session_id?: string;
  title?: string;
  repo?: string;
  assignee?: string;
  labels?: string[];
  limit?: number;
  metadata?: JsonObject;
}

export interface CreateGitHubReviewRequestsDiscoveryScheduleOptions {
  interval_ms: number;
  next_run_at?: string;
  timeout_ms?: number;
  session_id?: string;
  title?: string;
  repo?: string;
  limit?: number;
  metadata?: JsonObject;
}

export interface CreateGitHubNotificationsDiscoveryScheduleOptions {
  interval_ms: number;
  next_run_at?: string;
  timeout_ms?: number;
  session_id?: string;
  title?: string;
  repo?: string;
  participating?: boolean;
  limit?: number;
  metadata?: JsonObject;
}

export interface CreateGitHubActionsDiscoveryScheduleOptions {
  interval_ms: number;
  next_run_at?: string;
  timeout_ms?: number;
  session_id?: string;
  title?: string;
  repo?: string;
  limit?: number;
  metadata?: JsonObject;
}

export interface CreateGitHubDraftReleasesDiscoveryScheduleOptions {
  interval_ms: number;
  next_run_at?: string;
  timeout_ms?: number;
  session_id?: string;
  title?: string;
  repo?: string;
  limit?: number;
  metadata?: JsonObject;
}

export interface CreateGitHubDeploymentsDiscoveryScheduleOptions {
  interval_ms: number;
  next_run_at?: string;
  timeout_ms?: number;
  session_id?: string;
  title?: string;
  repo: string;
  environment?: string;
  ref?: string;
  limit?: number;
  metadata?: JsonObject;
}

export interface CreateHttpHealthDiscoveryScheduleOptions {
  interval_ms: number;
  url: string;
  expected_status?: number;
  next_run_at?: string;
  timeout_ms?: number;
  session_id?: string;
  title?: string;
  metadata?: JsonObject;
}

export interface CreateNpmPackageDiscoveryScheduleOptions {
  interval_ms: number;
  package_name: string;
  version: string;
  tag?: string;
  next_run_at?: string;
  timeout_ms?: number;
  session_id?: string;
  title?: string;
  metadata?: JsonObject;
}

export interface DueDiscoveryResult {
  ran: { schedule: DiscoverySchedule; candidates: DiscoveryCandidate[] }[];
  failed: { schedule: DiscoverySchedule; error: string }[];
}

interface ParsedDiscoveryCandidate {
  title: string;
  prompt: string;
  detail?: string;
  priority: DiscoveryCandidate["priority"];
  dedupe_key: string;
  source: JsonObject;
}

interface DiscoverySourceDefinition {
  run: (schedule: DiscoverySchedule) => Promise<{ candidates: ParsedDiscoveryCandidate[]; stdout_bytes: number }>;
  dismiss_stale?: boolean;
}

export interface LoopDiscoverySourceDefinition {
  id: string;
  connector: string;
  description: string;
  dismiss_stale: boolean;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;
const DISCOVERY_STDOUT_LIMIT = 512 * 1024;
const GIT_CHANGES_SOURCE = "git-changes";
const GITHUB_ISSUES_SOURCE = "github-issues";
const GITHUB_ASSIGNED_ISSUES_SOURCE = "github-assigned-issues";
const GITHUB_PULL_REQUESTS_SOURCE = "github-prs";
const GITHUB_ASSIGNED_PULL_REQUESTS_SOURCE = "github-assigned-prs";
const GITHUB_REVIEW_REQUESTS_SOURCE = "github-review-requests";
const GITHUB_NOTIFICATIONS_SOURCE = "github-notifications";
const GITHUB_ACTIONS_SOURCE = "github-actions";
const GITHUB_DRAFT_RELEASES_SOURCE = "github-draft-releases";
const GITHUB_DEPLOYMENTS_SOURCE = "github-deployments";
const HTTP_HEALTH_SOURCE = "http-health";
const NPM_PACKAGE_STATUS_SOURCE = "npm-package-status";

const DISCOVERY_SOURCE_CATALOG: Record<string, LoopDiscoverySourceDefinition> = {
  [GIT_CHANGES_SOURCE]: {
    id: GIT_CHANGES_SOURCE,
    connector: "git",
    description: "Discover local working-tree changes that may need review, verification, splitting, or completion.",
    dismiss_stale: true,
  },
  [GITHUB_ISSUES_SOURCE]: {
    id: GITHUB_ISSUES_SOURCE,
    connector: "github",
    description: "Discover open GitHub issues, optionally filtered by explicit labels.",
    dismiss_stale: false,
  },
  [GITHUB_ASSIGNED_ISSUES_SOURCE]: {
    id: GITHUB_ASSIGNED_ISSUES_SOURCE,
    connector: "github",
    description: "Discover open GitHub issues assigned to a user, optionally filtered by explicit labels.",
    dismiss_stale: false,
  },
  [GITHUB_PULL_REQUESTS_SOURCE]: {
    id: GITHUB_PULL_REQUESTS_SOURCE,
    connector: "github",
    description: "Discover open GitHub pull requests, optionally filtered by explicit labels.",
    dismiss_stale: false,
  },
  [GITHUB_ASSIGNED_PULL_REQUESTS_SOURCE]: {
    id: GITHUB_ASSIGNED_PULL_REQUESTS_SOURCE,
    connector: "github",
    description: "Discover open GitHub pull requests assigned to a user, optionally filtered by explicit labels.",
    dismiss_stale: false,
  },
  [GITHUB_REVIEW_REQUESTS_SOURCE]: {
    id: GITHUB_REVIEW_REQUESTS_SOURCE,
    connector: "github",
    description: "Discover GitHub pull requests requesting review.",
    dismiss_stale: false,
  },
  [GITHUB_NOTIFICATIONS_SOURCE]: {
    id: GITHUB_NOTIFICATIONS_SOURCE,
    connector: "github",
    description: "Discover unread GitHub notifications.",
    dismiss_stale: false,
  },
  [GITHUB_ACTIONS_SOURCE]: {
    id: GITHUB_ACTIONS_SOURCE,
    connector: "github",
    description: "Discover failing GitHub Actions runs.",
    dismiss_stale: false,
  },
  [GITHUB_DRAFT_RELEASES_SOURCE]: {
    id: GITHUB_DRAFT_RELEASES_SOURCE,
    connector: "github",
    description: "Discover draft GitHub releases that may need review or publication.",
    dismiss_stale: false,
  },
  [GITHUB_DEPLOYMENTS_SOURCE]: {
    id: GITHUB_DEPLOYMENTS_SOURCE,
    connector: "github",
    description: "Discover recent GitHub Deployments that may need status verification or follow-up.",
    dismiss_stale: false,
  },
  [HTTP_HEALTH_SOURCE]: {
    id: HTTP_HEALTH_SOURCE,
    connector: "http",
    description: "Discover HTTP endpoint health failures.",
    dismiss_stale: true,
  },
  [NPM_PACKAGE_STATUS_SOURCE]: {
    id: NPM_PACKAGE_STATUS_SOURCE,
    connector: "npm",
    description: "Discover npm package version or dist-tag mismatches that need release follow-up.",
    dismiss_stale: true,
  },
};

const DISCOVERY_SOURCE_REGISTRY: Record<string, DiscoverySourceDefinition> = {
  [GIT_CHANGES_SOURCE]: {
    run: async (schedule) => ({ candidates: await discoverGitChanges(schedule), stdout_bytes: 0 }),
    dismiss_stale: true,
  },
  [GITHUB_ISSUES_SOURCE]: { run: discoverGitHubIssues },
  [GITHUB_ASSIGNED_ISSUES_SOURCE]: { run: discoverGitHubAssignedIssues },
  [GITHUB_PULL_REQUESTS_SOURCE]: { run: discoverGitHubPullRequests },
  [GITHUB_ASSIGNED_PULL_REQUESTS_SOURCE]: { run: discoverGitHubAssignedPullRequests },
  [GITHUB_REVIEW_REQUESTS_SOURCE]: { run: discoverGitHubReviewRequests },
  [GITHUB_NOTIFICATIONS_SOURCE]: { run: discoverGitHubNotifications },
  [GITHUB_ACTIONS_SOURCE]: { run: discoverGitHubActions },
  [GITHUB_DRAFT_RELEASES_SOURCE]: { run: discoverGitHubDraftReleases },
  [GITHUB_DEPLOYMENTS_SOURCE]: { run: discoverGitHubDeployments },
  [HTTP_HEALTH_SOURCE]: {
    run: discoverHttpHealth,
    dismiss_stale: true,
  },
  [NPM_PACKAGE_STATUS_SOURCE]: {
    run: discoverNpmPackageStatus,
    dismiss_stale: true,
  },
};

export function listDiscoverySourceDefinitions(): LoopDiscoverySourceDefinition[] {
  return Object.values(DISCOVERY_SOURCE_CATALOG).map((definition) => ({ ...definition }));
}

export function createLoopDiscoverySchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateLoopDiscoveryScheduleOptions,
): DiscoverySchedule {
  const command = options.command.trim();
  if (!command) {
    throw new Error("Discovery command must not be empty.");
  }
  const session = options.session_id
    ? store.getSession(options.session_id) ?? store.findSessionByPrefix(workspace.id, options.session_id)
    : store.createSession(workspace, options.title ?? `discover:${command.slice(0, 48)}`);
  if (!session) {
    throw new Error(`Unknown session for discovery: ${options.session_id}`);
  }
  return store.createDiscoverySchedule(workspace, session.session_id, command, {
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at ?? new Date(Date.now() + options.interval_ms).toISOString(),
    timeout_ms: options.timeout_ms ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    metadata: options.metadata,
  });
}

export function createGitChangesDiscoverySchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateGitChangesDiscoveryScheduleOptions,
): DiscoverySchedule {
  return createLoopDiscoverySchedule(store, workspace, {
    command: GIT_CHANGES_SOURCE,
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at,
    timeout_ms: options.timeout_ms,
    session_id: options.session_id,
    title: options.title ?? "discover:git-changes",
    metadata: {
      ...options.metadata,
      source: GIT_CHANGES_SOURCE,
    },
  });
}

export function createGitHubIssuesDiscoverySchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateGitHubIssuesDiscoveryScheduleOptions,
): DiscoverySchedule {
  const repo = options.repo?.trim();
  const labels = normalizeGitHubLabelFilter(options.labels);
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  return createLoopDiscoverySchedule(store, workspace, {
    command: GITHUB_ISSUES_SOURCE,
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at,
    timeout_ms: options.timeout_ms,
    session_id: options.session_id,
    title: options.title ?? "discover:github-issues",
    metadata: {
      ...options.metadata,
      source: GITHUB_ISSUES_SOURCE,
      repo: repo || undefined,
      label_filter: labels.length ? labels : undefined,
      limit,
    },
  });
}

export function createGitHubAssignedIssuesDiscoverySchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateGitHubAssignedIssuesDiscoveryScheduleOptions,
): DiscoverySchedule {
  const repo = options.repo?.trim();
  const assignee = options.assignee?.trim() || "@me";
  const labels = normalizeGitHubLabelFilter(options.labels);
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  return createLoopDiscoverySchedule(store, workspace, {
    command: GITHUB_ASSIGNED_ISSUES_SOURCE,
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at,
    timeout_ms: options.timeout_ms,
    session_id: options.session_id,
    title: options.title ?? "discover:github-assigned-issues",
    metadata: {
      ...options.metadata,
      source: GITHUB_ASSIGNED_ISSUES_SOURCE,
      repo: repo || undefined,
      assignee,
      label_filter: labels.length ? labels : undefined,
      limit,
    },
  });
}

export function createGitHubPullRequestsDiscoverySchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateGitHubPullRequestsDiscoveryScheduleOptions,
): DiscoverySchedule {
  const repo = options.repo?.trim();
  const labels = normalizeGitHubLabelFilter(options.labels);
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  return createLoopDiscoverySchedule(store, workspace, {
    command: GITHUB_PULL_REQUESTS_SOURCE,
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at,
    timeout_ms: options.timeout_ms,
    session_id: options.session_id,
    title: options.title ?? "discover:github-prs",
    metadata: {
      ...options.metadata,
      source: GITHUB_PULL_REQUESTS_SOURCE,
      repo: repo || undefined,
      label_filter: labels.length ? labels : undefined,
      limit,
    },
  });
}

export function createGitHubAssignedPullRequestsDiscoverySchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateGitHubAssignedPullRequestsDiscoveryScheduleOptions,
): DiscoverySchedule {
  const repo = options.repo?.trim();
  const assignee = options.assignee?.trim() || "@me";
  const labels = normalizeGitHubLabelFilter(options.labels);
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  return createLoopDiscoverySchedule(store, workspace, {
    command: GITHUB_ASSIGNED_PULL_REQUESTS_SOURCE,
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at,
    timeout_ms: options.timeout_ms,
    session_id: options.session_id,
    title: options.title ?? "discover:github-assigned-prs",
    metadata: {
      ...options.metadata,
      source: GITHUB_ASSIGNED_PULL_REQUESTS_SOURCE,
      repo: repo || undefined,
      assignee,
      label_filter: labels.length ? labels : undefined,
      limit,
    },
  });
}

export function createGitHubReviewRequestsDiscoverySchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateGitHubReviewRequestsDiscoveryScheduleOptions,
): DiscoverySchedule {
  const repo = options.repo?.trim();
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  return createLoopDiscoverySchedule(store, workspace, {
    command: GITHUB_REVIEW_REQUESTS_SOURCE,
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at,
    timeout_ms: options.timeout_ms,
    session_id: options.session_id,
    title: options.title ?? "discover:github-review-requests",
    metadata: {
      ...options.metadata,
      source: GITHUB_REVIEW_REQUESTS_SOURCE,
      repo: repo || undefined,
      limit,
    },
  });
}

export function createGitHubNotificationsDiscoverySchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateGitHubNotificationsDiscoveryScheduleOptions,
): DiscoverySchedule {
  const repo = options.repo?.trim();
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  const participating = options.participating === true;
  return createLoopDiscoverySchedule(store, workspace, {
    command: GITHUB_NOTIFICATIONS_SOURCE,
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at,
    timeout_ms: options.timeout_ms,
    session_id: options.session_id,
    title: options.title ?? "discover:github-notifications",
    metadata: {
      ...options.metadata,
      source: GITHUB_NOTIFICATIONS_SOURCE,
      repo: repo || undefined,
      participating,
      limit,
    },
  });
}

export function createGitHubActionsDiscoverySchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateGitHubActionsDiscoveryScheduleOptions,
): DiscoverySchedule {
  const repo = options.repo?.trim();
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  return createLoopDiscoverySchedule(store, workspace, {
    command: GITHUB_ACTIONS_SOURCE,
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at,
    timeout_ms: options.timeout_ms,
    session_id: options.session_id,
    title: options.title ?? "discover:github-actions",
    metadata: {
      ...options.metadata,
      source: GITHUB_ACTIONS_SOURCE,
      repo: repo || undefined,
      limit,
    },
  });
}

export function createGitHubDraftReleasesDiscoverySchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateGitHubDraftReleasesDiscoveryScheduleOptions,
): DiscoverySchedule {
  const repo = options.repo?.trim();
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  return createLoopDiscoverySchedule(store, workspace, {
    command: GITHUB_DRAFT_RELEASES_SOURCE,
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at,
    timeout_ms: options.timeout_ms,
    session_id: options.session_id,
    title: options.title ?? "discover:github-draft-releases",
    metadata: {
      ...options.metadata,
      source: GITHUB_DRAFT_RELEASES_SOURCE,
      repo: repo || undefined,
      limit,
    },
  });
}

export function createGitHubDeploymentsDiscoverySchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateGitHubDeploymentsDiscoveryScheduleOptions,
): DiscoverySchedule {
  const repo = normalizeGitHubRepo(options.repo, "--repo");
  const environment = options.environment?.trim() || undefined;
  const ref = options.ref?.trim() || undefined;
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  return createLoopDiscoverySchedule(store, workspace, {
    command: GITHUB_DEPLOYMENTS_SOURCE,
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at,
    timeout_ms: options.timeout_ms,
    session_id: options.session_id,
    title: options.title ?? "discover:github-deployments",
    metadata: {
      ...options.metadata,
      source: GITHUB_DEPLOYMENTS_SOURCE,
      repo,
      environment,
      ref,
      limit,
    },
  });
}

export function createHttpHealthDiscoverySchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateHttpHealthDiscoveryScheduleOptions,
): DiscoverySchedule {
  const url = normalizeHttpUrl(options.url);
  const expectedStatus = normalizeHttpStatus(options.expected_status ?? 200);
  return createLoopDiscoverySchedule(store, workspace, {
    command: HTTP_HEALTH_SOURCE,
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at,
    timeout_ms: options.timeout_ms,
    session_id: options.session_id,
    title: options.title ?? "discover:http-health",
    metadata: {
      ...options.metadata,
      source: HTTP_HEALTH_SOURCE,
      url,
      expected_status: expectedStatus,
    },
  });
}

export function createNpmPackageDiscoverySchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateNpmPackageDiscoveryScheduleOptions,
): DiscoverySchedule {
  const packageName = normalizeNpmPackageName(options.package_name);
  const version = normalizeNpmVersion(options.version);
  const tag = options.tag === undefined ? undefined : normalizeNpmDistTag(options.tag);
  return createLoopDiscoverySchedule(store, workspace, {
    command: NPM_PACKAGE_STATUS_SOURCE,
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at,
    timeout_ms: options.timeout_ms,
    session_id: options.session_id,
    title: options.title ?? "discover:npm-package-status",
    metadata: {
      ...options.metadata,
      source: NPM_PACKAGE_STATUS_SOURCE,
      package_name: packageName,
      version,
      tag,
    },
  });
}

export async function runDueDiscoverySchedules(store: SessionStore, options: { now?: Date; limit?: number } = {}): Promise<DueDiscoveryResult> {
  const now = options.now ?? new Date();
  const due = store.listDiscoverySchedules({ status: "enabled", dueAt: now.toISOString() }).slice(0, options.limit ?? 25);
  const ran: DueDiscoveryResult["ran"] = [];
  const failed: DueDiscoveryResult["failed"] = [];
  for (const schedule of due) {
    try {
      const source = discoveryScheduleSource(schedule);
      const discovered = await runDiscoverySource(schedule, source);
      const parsed = discovered.candidates;
      const candidates = parsed.map((candidate) => {
        const saved = store.upsertDiscoveryCandidate({
          candidate_id: discoveryCandidateId(schedule, candidate),
          schedule_id: schedule.schedule_id,
          workspace_id: schedule.workspace_id,
          session_id: schedule.session_id,
          title: candidate.title,
          prompt: candidate.prompt,
          detail: candidate.detail,
          priority: candidate.priority,
          dedupe_key: candidate.dedupe_key,
          source: {
            ...candidate.source,
            discovery_schedule_id: schedule.schedule_id,
            command: schedule.command,
          },
        });
        store.appendEvent({
          session_id: schedule.session_id,
          type: "loop.discovery.candidate",
          data: {
            candidate_id: saved.candidate_id,
            schedule_id: schedule.schedule_id,
            title: saved.title,
            priority: saved.priority,
            dedupe_key: saved.dedupe_key,
          },
        });
        return saved;
      });
      dismissStaleSourceCandidates(store, schedule, candidates, source);
      const nextRunAt = nextDiscoveryRunAt(schedule, now);
      store.updateDiscoverySchedule(schedule.schedule_id, {
        last_run_at: now.toISOString(),
        last_error: "",
        next_run_at: nextRunAt,
      });
      store.appendEvent({
        session_id: schedule.session_id,
        type: "loop.discovery.completed",
        data: {
          schedule_id: schedule.schedule_id,
          candidate_count: candidates.length,
          next_run_at: nextRunAt,
          stdout_bytes: discovered.stdout_bytes,
        },
      });
      ran.push({ schedule: store.getDiscoverySchedule(schedule.schedule_id) ?? schedule, candidates });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextRunAt = nextDiscoveryRunAt(schedule, now);
      store.updateDiscoverySchedule(schedule.schedule_id, {
        last_run_at: now.toISOString(),
        last_error: message,
        next_run_at: nextRunAt,
      });
      store.appendEvent({
        session_id: schedule.session_id,
        type: "loop.discovery.failed",
        data: { schedule_id: schedule.schedule_id, error: message, next_run_at: nextRunAt },
      });
      failed.push({ schedule: store.getDiscoverySchedule(schedule.schedule_id) ?? schedule, error: message });
    }
  }
  return { ran, failed };
}

function discoveryScheduleSource(schedule: DiscoverySchedule): string {
  return typeof schedule.metadata.source === "string" && schedule.metadata.source.trim()
    ? schedule.metadata.source.trim()
    : "command";
}

async function runDiscoverySource(
  schedule: DiscoverySchedule,
  source: string,
): Promise<{ candidates: ParsedDiscoveryCandidate[]; stdout_bytes: number }> {
  const registered = DISCOVERY_SOURCE_REGISTRY[source];
  if (registered) {
    return await registered.run(schedule);
  }
  const output = await runDiscoveryCommand(schedule);
  return { candidates: parseDiscoveryOutput(output.stdout, schedule), stdout_bytes: output.stdout.length };
}

async function discoverGitChanges(schedule: DiscoverySchedule): Promise<ParsedDiscoveryCandidate[]> {
  const status = await runDiscoveryProcess("git", ["status", "--porcelain=v1", "--untracked-files=normal"], schedule.workspace_root, schedule.timeout_ms);
  const lines = status.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  if (!lines.length) {
    return [];
  }
  const summary = summarizeGitStatus(lines);
  const sample = summary.paths.slice(0, 8);
  const detail = [
    `${summary.total} changed ${summary.total === 1 ? "path" : "paths"}`,
    summary.modified ? `${summary.modified} modified` : undefined,
    summary.deleted ? `${summary.deleted} deleted` : undefined,
    summary.untracked ? `${summary.untracked} untracked` : undefined,
    summary.renamed ? `${summary.renamed} renamed` : undefined,
    summary.conflicted ? `${summary.conflicted} conflicted` : undefined,
    sample.length ? `sample: ${sample.join(", ")}` : undefined,
  ].filter((item): item is string => Boolean(item)).join("; ");
  const title = summary.conflicted
    ? `Resolve local git conflicts (${summary.total} paths)`
    : `Review local git changes (${summary.total} ${summary.total === 1 ? "path" : "paths"})`;
  return [{
    title,
    prompt: [
      "Inspect the local git working tree for this workspace.",
      "Start with git status --short and relevant git diff commands.",
      "Decide whether the local changes should be completed, verified, split, committed, or clarified with the user.",
      "Preserve user changes unless the user explicitly asks to discard them.",
    ].join(" "),
    detail,
    priority: summary.conflicted || summary.deleted > 0 ? "high" : "medium",
    dedupe_key: `git-changes:${shortHash(lines.join("\n"), 16)}`,
    source: {
      kind: GIT_CHANGES_SOURCE,
      status_hash: shortHash(lines.join("\n"), 16),
      total_paths: summary.total,
      modified_paths: summary.modified,
      deleted_paths: summary.deleted,
      untracked_paths: summary.untracked,
      renamed_paths: summary.renamed,
      conflicted_paths: summary.conflicted,
      sample_paths: sample,
      suggested_verifier: suggestedVerifier("git-clean", {}),
    },
  }];
}

async function discoverGitHubIssues(schedule: DiscoverySchedule): Promise<{ candidates: ParsedDiscoveryCandidate[]; stdout_bytes: number }> {
  const limit = numberMetadata(schedule.metadata.limit, 25, 1, 100);
  const repo = stringMetadata(schedule.metadata.repo);
  const labelFilter = stringArrayMetadata(schedule.metadata.label_filter);
  const args = [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "number,title,url,labels,updatedAt,assignees",
  ];
  if (repo) {
    args.push("--repo", repo);
  }
  appendGitHubLabelFilterArgs(args, labelFilter);
  const output = await runDiscoveryProcess("gh", args, schedule.workspace_root, schedule.timeout_ms);
  const parsed = JSON.parse(output.stdout.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("gh issue list must return a JSON array.");
  }
  return {
    candidates: parsed.slice(0, limit).map((item) => parseGitHubIssueCandidate(item, repo, {
      extraSource: labelFilter.length ? { label_filter: labelFilter } : undefined,
    })).filter((item): item is ParsedDiscoveryCandidate => Boolean(item)),
    stdout_bytes: output.stdout.length,
  };
}

async function discoverGitHubAssignedIssues(schedule: DiscoverySchedule): Promise<{ candidates: ParsedDiscoveryCandidate[]; stdout_bytes: number }> {
  const limit = numberMetadata(schedule.metadata.limit, 25, 1, 100);
  const repo = stringMetadata(schedule.metadata.repo);
  const assignee = stringMetadata(schedule.metadata.assignee) ?? "@me";
  const labelFilter = stringArrayMetadata(schedule.metadata.label_filter);
  const args = [
    "issue",
    "list",
    "--state",
    "open",
    "--assignee",
    assignee,
    "--limit",
    String(limit),
    "--json",
    "number,title,url,labels,updatedAt,assignees",
  ];
  if (repo) {
    args.push("--repo", repo);
  }
  appendGitHubLabelFilterArgs(args, labelFilter);
  const output = await runDiscoveryProcess("gh", args, schedule.workspace_root, schedule.timeout_ms);
  const parsed = JSON.parse(output.stdout.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("gh issue list must return a JSON array.");
  }
  return {
    candidates: parsed.slice(0, limit).map((item) => parseGitHubIssueCandidate(item, repo, {
      sourceKind: GITHUB_ASSIGNED_ISSUES_SOURCE,
      dedupePrefix: "github-assigned-issue",
      titlePrefix: "GitHub assigned issue",
      promptIntro: "Inspect assigned GitHub issue",
      extraSource: { assignee_filter: assignee, ...(labelFilter.length ? { label_filter: labelFilter } : {}) },
    })).filter((item): item is ParsedDiscoveryCandidate => Boolean(item)),
    stdout_bytes: output.stdout.length,
  };
}

interface GitHubIssueCandidateOptions {
  sourceKind?: string;
  dedupePrefix?: string;
  titlePrefix?: string;
  promptIntro?: string;
  extraSource?: JsonObject;
}

function parseGitHubIssueCandidate(value: unknown, repo: string | undefined, options: GitHubIssueCandidateOptions = {}): ParsedDiscoveryCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const number = typeof data.number === "number" && Number.isFinite(data.number) ? Math.trunc(data.number) : undefined;
  const title = stringValue(data.title)?.trim();
  if (number === undefined || !title) {
    return undefined;
  }
  const url = stringValue(data.url);
  const labels = githubLabelNames(data.labels);
  const assignees = githubLoginList(data.assignees);
  const updatedAt = stringValue(data.updatedAt);
  const repoClause = repo ? ` in ${repo}` : "";
  const titlePrefix = options.titlePrefix ?? "GitHub issue";
  const promptIntro = options.promptIntro ?? "Inspect GitHub issue";
  const dedupePrefix = options.dedupePrefix ?? "github-issue";
  const sourceKind = options.sourceKind ?? GITHUB_ISSUES_SOURCE;
  const labelText = labels.length ? `labels: ${labels.join(", ")}` : undefined;
  const assigneeText = assignees.length ? `assignees: ${assignees.join(", ")}` : undefined;
  const detail = [
    `issue #${number}${repoClause}`,
    labelText,
    assigneeText,
    updatedAt ? `updated ${updatedAt}` : undefined,
    url,
  ].filter((item): item is string => Boolean(item)).join("; ");
  return {
    title: `${titlePrefix} #${number}: ${title}`,
    prompt: [
      `${promptIntro} #${number}${repoClause}.`,
      repo ? `Use gh issue view ${number} --repo ${repo} as needed.` : `Use gh issue view ${number} as needed.`,
      "Summarize the requested work, inspect the local codebase, and either propose a bounded goal plan or ask for clarification.",
      "Do not change issue state or post comments unless the user explicitly asks.",
    ].join(" "),
    detail,
    priority: "medium",
    dedupe_key: `${dedupePrefix}:${repo ?? "current"}:${number}`,
    source: {
      kind: sourceKind,
      provider: "github",
      repo,
      number,
      url,
      labels,
      assignees,
      updated_at: updatedAt,
      suggested_verifier: suggestedVerifier("github-issue-status", { issue: String(number), repo }),
      ...options.extraSource,
    },
  };
}

async function discoverGitHubPullRequests(schedule: DiscoverySchedule): Promise<{ candidates: ParsedDiscoveryCandidate[]; stdout_bytes: number }> {
  const limit = numberMetadata(schedule.metadata.limit, 25, 1, 100);
  const repo = stringMetadata(schedule.metadata.repo);
  const labelFilter = stringArrayMetadata(schedule.metadata.label_filter);
  const args = [
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "number,title,url,baseRefName,headRefName,isDraft,reviewDecision,mergeStateStatus,updatedAt,labels,assignees,author",
  ];
  if (repo) {
    args.push("--repo", repo);
  }
  appendGitHubLabelFilterArgs(args, labelFilter);
  const output = await runDiscoveryProcess("gh", args, schedule.workspace_root, schedule.timeout_ms);
  const parsed = JSON.parse(output.stdout.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("gh pr list must return a JSON array.");
  }
  return {
    candidates: parsed.slice(0, limit).map((item) => parseGitHubPullRequestCandidate(item, repo, {
      extraSource: labelFilter.length ? { label_filter: labelFilter } : undefined,
    })).filter((item): item is ParsedDiscoveryCandidate => Boolean(item)),
    stdout_bytes: output.stdout.length,
  };
}

async function discoverGitHubAssignedPullRequests(schedule: DiscoverySchedule): Promise<{ candidates: ParsedDiscoveryCandidate[]; stdout_bytes: number }> {
  const limit = numberMetadata(schedule.metadata.limit, 25, 1, 100);
  const repo = stringMetadata(schedule.metadata.repo);
  const assignee = stringMetadata(schedule.metadata.assignee) ?? "@me";
  const labelFilter = stringArrayMetadata(schedule.metadata.label_filter);
  const args = [
    "pr",
    "list",
    "--state",
    "open",
    "--assignee",
    assignee,
    "--limit",
    String(limit),
    "--json",
    "number,title,url,baseRefName,headRefName,isDraft,reviewDecision,mergeStateStatus,updatedAt,labels,assignees,author",
  ];
  if (repo) {
    args.push("--repo", repo);
  }
  appendGitHubLabelFilterArgs(args, labelFilter);
  const output = await runDiscoveryProcess("gh", args, schedule.workspace_root, schedule.timeout_ms);
  const parsed = JSON.parse(output.stdout.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("gh pr list must return a JSON array.");
  }
  return {
    candidates: parsed.slice(0, limit).map((item) => parseGitHubPullRequestCandidate(item, repo, {
      sourceKind: GITHUB_ASSIGNED_PULL_REQUESTS_SOURCE,
      dedupePrefix: "github-assigned-pr",
      titlePrefix: "GitHub assigned PR",
      promptIntro: "Inspect assigned GitHub pull request",
      extraSource: { assignee_filter: assignee, ...(labelFilter.length ? { label_filter: labelFilter } : {}) },
    })).filter((item): item is ParsedDiscoveryCandidate => Boolean(item)),
    stdout_bytes: output.stdout.length,
  };
}

interface GitHubPullRequestCandidateOptions {
  sourceKind?: string;
  dedupePrefix?: string;
  titlePrefix?: string;
  promptIntro?: string;
  extraSource?: JsonObject;
}

function parseGitHubPullRequestCandidate(value: unknown, repo: string | undefined, options: GitHubPullRequestCandidateOptions = {}): ParsedDiscoveryCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const number = typeof data.number === "number" && Number.isFinite(data.number) ? Math.trunc(data.number) : undefined;
  const title = stringValue(data.title)?.trim();
  if (number === undefined || !title) {
    return undefined;
  }
  const url = stringValue(data.url);
  const labels = githubLabelNames(data.labels);
  const assignees = githubLoginList(data.assignees);
  const author = githubLogin(data.author);
  const updatedAt = stringValue(data.updatedAt);
  const baseRef = stringValue(data.baseRefName);
  const headRef = stringValue(data.headRefName);
  const reviewDecision = stringValue(data.reviewDecision);
  const mergeStateStatus = stringValue(data.mergeStateStatus);
  const isDraft = data.isDraft === true;
  const repoClause = repo ? ` in ${repo}` : "";
  const titlePrefix = options.titlePrefix ?? "GitHub PR";
  const promptIntro = options.promptIntro ?? "Inspect GitHub pull request";
  const dedupePrefix = options.dedupePrefix ?? "github-pr";
  const sourceKind = options.sourceKind ?? GITHUB_PULL_REQUESTS_SOURCE;
  const refText = baseRef || headRef ? `refs: ${headRef ?? "unknown"} -> ${baseRef ?? "unknown"}` : undefined;
  const detail = [
    `pull request #${number}${repoClause}`,
    isDraft ? "draft" : undefined,
    author ? `author: ${author}` : undefined,
    refText,
    reviewDecision ? `review: ${reviewDecision}` : undefined,
    mergeStateStatus ? `merge: ${mergeStateStatus}` : undefined,
    labels.length ? `labels: ${labels.join(", ")}` : undefined,
    assignees.length ? `assignees: ${assignees.join(", ")}` : undefined,
    updatedAt ? `updated ${updatedAt}` : undefined,
    url,
  ].filter((item): item is string => Boolean(item)).join("; ");
  return {
    title: `${titlePrefix} #${number}: ${title}`,
    prompt: [
      `${promptIntro} #${number}${repoClause}.`,
      repo ? `Use gh pr view ${number} --repo ${repo} as needed.` : `Use gh pr view ${number} as needed.`,
      "Inspect the local codebase and relevant branch context, then propose a bounded goal plan, verification plan, or clarification question.",
      "Do not change pull request state, post comments, merge, or push unless the user explicitly asks.",
    ].join(" "),
    detail,
    priority: "medium",
    dedupe_key: `${dedupePrefix}:${repo ?? "current"}:${number}`,
    source: {
      kind: sourceKind,
      provider: "github",
      repo,
      number,
      url,
      base_ref: baseRef,
      head_ref: headRef,
      draft: isDraft,
      review_decision: reviewDecision,
      merge_state: mergeStateStatus,
      labels,
      assignees,
      author,
      updated_at: updatedAt,
      suggested_verifier: suggestedVerifier("github-pr-status", { pr: String(number), repo }),
      ...options.extraSource,
    },
  };
}

async function discoverGitHubReviewRequests(schedule: DiscoverySchedule): Promise<{ candidates: ParsedDiscoveryCandidate[]; stdout_bytes: number }> {
  const limit = numberMetadata(schedule.metadata.limit, 25, 1, 100);
  const repo = stringMetadata(schedule.metadata.repo);
  const args = [
    "search",
    "prs",
    "--review-requested",
    "@me",
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "number,title,url,isDraft,updatedAt,labels,assignees,author,repository",
  ];
  if (repo) {
    args.push("--repo", repo);
  }
  const output = await runDiscoveryProcess("gh", args, schedule.workspace_root, schedule.timeout_ms);
  const parsed = JSON.parse(output.stdout.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("gh search prs must return a JSON array.");
  }
  return {
    candidates: parsed.slice(0, limit).map((item) => parseGitHubReviewRequestCandidate(item, repo)).filter((item): item is ParsedDiscoveryCandidate => Boolean(item)),
    stdout_bytes: output.stdout.length,
  };
}

function parseGitHubReviewRequestCandidate(value: unknown, repo: string | undefined): ParsedDiscoveryCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const number = typeof data.number === "number" && Number.isFinite(data.number) ? Math.trunc(data.number) : undefined;
  const title = stringValue(data.title)?.trim();
  if (number === undefined || !title) {
    return undefined;
  }
  const itemRepo = githubRepositoryName(data.repository) ?? repo;
  const url = stringValue(data.url);
  const labels = githubLabelNames(data.labels);
  const assignees = githubLoginList(data.assignees);
  const author = githubLogin(data.author);
  const updatedAt = stringValue(data.updatedAt);
  const isDraft = data.isDraft === true;
  const repoClause = itemRepo ? ` in ${itemRepo}` : "";
  const viewCommand = itemRepo
    ? `Use gh pr view ${number} --repo ${itemRepo} as needed.`
    : url
      ? `Use gh pr view ${url} as needed.`
      : `Use gh pr view ${number} as needed.`;
  const detail = [
    `review request for pull request #${number}${repoClause}`,
    isDraft ? "draft" : undefined,
    author ? `author: ${author}` : undefined,
    labels.length ? `labels: ${labels.join(", ")}` : undefined,
    assignees.length ? `assignees: ${assignees.join(", ")}` : undefined,
    updatedAt ? `updated ${updatedAt}` : undefined,
    url,
  ].filter((item): item is string => Boolean(item)).join("; ");
  return {
    title: `GitHub review request${itemRepo ? ` ${itemRepo}` : ""}#${number}: ${title}`,
    prompt: [
      `Inspect GitHub review request for pull request #${number}${repoClause}.`,
      viewCommand,
      "Review the diff, project context, and verification evidence, then propose a concise review summary, requested changes, or a bounded follow-up goal.",
      "Do not submit a review, post comments, approve, request changes, merge, or push unless the user explicitly asks.",
    ].join(" "),
    detail,
    priority: isDraft ? "low" : "medium",
    dedupe_key: `github-review-request:${itemRepo ?? "current"}:${number}`,
    source: {
      kind: GITHUB_REVIEW_REQUESTS_SOURCE,
      provider: "github",
      repo: itemRepo,
      number,
      url,
      draft: isDraft,
      labels,
      assignees,
      author,
      updated_at: updatedAt,
      suggested_verifier: suggestedVerifier("github-review-request", { pr: String(number), repo: itemRepo }),
    },
  };
}

async function discoverGitHubNotifications(schedule: DiscoverySchedule): Promise<{ candidates: ParsedDiscoveryCandidate[]; stdout_bytes: number }> {
  const limit = numberMetadata(schedule.metadata.limit, 25, 1, 100);
  const repo = stringMetadata(schedule.metadata.repo);
  const participating = schedule.metadata.participating === true;
  const endpoint = repo ? `repos/${repo}/notifications` : "notifications";
  const args = [
    "api",
    "--method",
    "GET",
    endpoint,
    "-F",
    `per_page=${limit}`,
  ];
  if (participating) {
    args.push("-F", "participating=true");
  }
  const output = await runDiscoveryProcess("gh", args, schedule.workspace_root, schedule.timeout_ms);
  const parsed = JSON.parse(output.stdout.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("gh api notifications must return a JSON array.");
  }
  return {
    candidates: parsed.slice(0, limit).map((item) => parseGitHubNotificationCandidate(item, repo, participating)).filter((item): item is ParsedDiscoveryCandidate => Boolean(item)),
    stdout_bytes: output.stdout.length,
  };
}

function parseGitHubNotificationCandidate(value: unknown, repoFilter: string | undefined, participating: boolean): ParsedDiscoveryCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const id = stringValue(data.id)?.trim();
  const subject = data.subject && typeof data.subject === "object" && !Array.isArray(data.subject)
    ? data.subject as Record<string, unknown>
    : undefined;
  const title = stringValue(subject?.title)?.trim();
  if (!id || !title) {
    return undefined;
  }
  const repo = githubRepositoryName(data.repository) ?? repoFilter;
  const reason = stringValue(data.reason);
  const unread = data.unread === true;
  const updatedAt = stringValue(data.updated_at) ?? stringValue(data.updatedAt);
  const subjectType = stringValue(subject?.type);
  const subjectUrl = stringValue(subject?.url);
  const latestCommentUrl = stringValue(subject?.latest_comment_url) ?? stringValue(subject?.latestCommentUrl);
  const target = githubNotificationTarget(subjectType, subjectUrl, repo);
  const repoClause = repo ? ` in ${repo}` : "";
  const inspectCommand = target.inspect_command
    ? `Use ${target.inspect_command} for the subject and gh api notifications/threads/${id} for the notification thread as needed.`
    : `Use gh api notifications/threads/${id} as needed.`;
  const detail = [
    `notification ${id}${repoClause}`,
    subjectType ? `type: ${subjectType}` : undefined,
    reason ? `reason: ${reason}` : undefined,
    unread ? "unread" : undefined,
    participating ? "participating" : undefined,
    updatedAt ? `updated ${updatedAt}` : undefined,
    target.kind ? `target: ${target.kind}${target.number !== undefined ? ` #${target.number}` : ""}` : undefined,
  ].filter((item): item is string => Boolean(item)).join("; ");
  return {
    title: `GitHub notification${repo ? ` ${repo}` : ""}: ${title}`,
    prompt: [
      `Inspect GitHub notification ${id}${repoClause}.`,
      inspectCommand,
      "Summarize the requested attention, inspect the local codebase if needed, and propose a bounded goal plan, review action, or clarification question.",
      "Do not mark notifications as read, post comments, change issue or pull request state, merge, or push unless the user explicitly asks.",
    ].join(" "),
    detail,
    priority: "medium",
    dedupe_key: `github-notification:${id}`,
    source: {
      kind: GITHUB_NOTIFICATIONS_SOURCE,
      provider: "github",
      id,
      repo,
      reason,
      unread,
      participating,
      subject_type: subjectType,
      subject_title: title,
      subject_url: subjectUrl,
      latest_comment_url: latestCommentUrl,
      target_kind: target.kind,
      target_number: target.number,
      updated_at: updatedAt,
      suggested_verifier: suggestedVerifier("github-notification-status", { thread: id }),
    },
  };
}

function githubNotificationTarget(subjectType: string | undefined, subjectUrl: string | undefined, repo: string | undefined): { kind?: string; number?: number; inspect_command?: string } {
  if (!subjectUrl || !repo) {
    return {};
  }
  if (subjectType === "PullRequest") {
    const match = /\/pulls\/(\d+)(?:$|[?#])/.exec(subjectUrl);
    const number = match ? Number.parseInt(match[1]!, 10) : undefined;
    return number !== undefined && Number.isFinite(number)
      ? { kind: "pull_request", number, inspect_command: `gh pr view ${number} --repo ${repo}` }
      : { kind: "pull_request" };
  }
  if (subjectType === "Issue") {
    const match = /\/issues\/(\d+)(?:$|[?#])/.exec(subjectUrl);
    const number = match ? Number.parseInt(match[1]!, 10) : undefined;
    return number !== undefined && Number.isFinite(number)
      ? { kind: "issue", number, inspect_command: `gh issue view ${number} --repo ${repo}` }
      : { kind: "issue" };
  }
  return subjectType ? { kind: subjectType } : {};
}

async function discoverGitHubActions(schedule: DiscoverySchedule): Promise<{ candidates: ParsedDiscoveryCandidate[]; stdout_bytes: number }> {
  const limit = numberMetadata(schedule.metadata.limit, 25, 1, 100);
  const repo = stringMetadata(schedule.metadata.repo);
  const args = [
    "run",
    "list",
    "--status",
    "failure",
    "--limit",
    String(limit),
    "--json",
    "databaseId,number,name,workflowName,displayTitle,event,headBranch,headSha,attempt,status,conclusion,startedAt,updatedAt,url",
  ];
  if (repo) {
    args.push("--repo", repo);
  }
  const output = await runDiscoveryProcess("gh", args, schedule.workspace_root, schedule.timeout_ms);
  const parsed = JSON.parse(output.stdout.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("gh run list must return a JSON array.");
  }
  return {
    candidates: parsed.slice(0, limit).map((item) => parseGitHubActionsCandidate(item, repo)).filter((item): item is ParsedDiscoveryCandidate => Boolean(item)),
    stdout_bytes: output.stdout.length,
  };
}

function parseGitHubActionsCandidate(value: unknown, repo: string | undefined): ParsedDiscoveryCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const runId = numberValue(data.databaseId);
  if (runId === undefined) {
    return undefined;
  }
  const runNumber = numberValue(data.number);
  const workflowName = stringValue(data.workflowName) ?? stringValue(data.name);
  const displayTitle = stringValue(data.displayTitle) ?? workflowName ?? `run ${runId}`;
  const event = stringValue(data.event);
  const branch = stringValue(data.headBranch);
  const headSha = stringValue(data.headSha);
  const attempt = numberValue(data.attempt);
  const status = stringValue(data.status);
  const conclusion = stringValue(data.conclusion);
  const startedAt = stringValue(data.startedAt);
  const updatedAt = stringValue(data.updatedAt);
  const url = stringValue(data.url);
  const repoClause = repo ? ` in ${repo}` : "";
  const detail = [
    `run ${runId}${runNumber !== undefined ? ` (#${runNumber})` : ""}${repoClause}`,
    workflowName ? `workflow: ${workflowName}` : undefined,
    branch ? `branch: ${branch}` : undefined,
    headSha ? `sha: ${headSha.slice(0, 12)}` : undefined,
    event ? `event: ${event}` : undefined,
    attempt !== undefined ? `attempt: ${attempt}` : undefined,
    status ? `status: ${status}` : undefined,
    conclusion ? `conclusion: ${conclusion}` : undefined,
    startedAt ? `started ${startedAt}` : undefined,
    updatedAt ? `updated ${updatedAt}` : undefined,
    url,
  ].filter((item): item is string => Boolean(item)).join("; ");
  return {
    title: `GitHub Actions failure ${runId}: ${displayTitle}`,
    prompt: [
      `Inspect failing GitHub Actions run ${runId}${repoClause}.`,
      repo ? `Use gh run view ${runId} --repo ${repo} --log as needed.` : `Use gh run view ${runId} --log as needed.`,
      "Inspect the local codebase and propose a bounded fix, verification plan, or clarification question.",
      "Do not rerun, cancel, or modify workflows unless the user explicitly asks.",
    ].join(" "),
    detail,
    priority: "high",
    dedupe_key: `github-actions-run:${repo ?? "current"}:${runId}`,
    source: {
      kind: GITHUB_ACTIONS_SOURCE,
      provider: "github",
      repo,
      run_id: runId,
      run_number: runNumber,
      workflow_name: workflowName,
      display_title: displayTitle,
      event,
      head_branch: branch,
      head_sha: headSha,
      attempt,
      status,
      conclusion,
      started_at: startedAt,
      updated_at: updatedAt,
      url,
      suggested_verifier: suggestedVerifier("github-actions-run", { run: String(runId), repo, attempt }),
    },
  };
}

async function discoverGitHubDraftReleases(schedule: DiscoverySchedule): Promise<{ candidates: ParsedDiscoveryCandidate[]; stdout_bytes: number }> {
  const limit = numberMetadata(schedule.metadata.limit, 25, 1, 100);
  const repo = stringMetadata(schedule.metadata.repo);
  const args = [
    "release",
    "list",
    "--limit",
    String(limit),
    "--json",
    "createdAt,isDraft,isLatest,isPrerelease,name,publishedAt,tagName",
  ];
  if (repo) {
    args.push("--repo", repo);
  }
  const output = await runDiscoveryProcess("gh", args, schedule.workspace_root, schedule.timeout_ms);
  const parsed = JSON.parse(output.stdout.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("gh release list must return a JSON array.");
  }
  return {
    candidates: parsed
      .slice(0, limit)
      .map((item) => parseGitHubDraftReleaseCandidate(item, repo))
      .filter((item): item is ParsedDiscoveryCandidate => Boolean(item)),
    stdout_bytes: output.stdout.length,
  };
}

function parseGitHubDraftReleaseCandidate(value: unknown, repo: string | undefined): ParsedDiscoveryCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  if (data.isDraft !== true) {
    return undefined;
  }
  const tag = stringValue(data.tagName)?.trim();
  if (!tag) {
    return undefined;
  }
  const name = stringValue(data.name)?.trim();
  const createdAt = stringValue(data.createdAt);
  const publishedAt = stringValue(data.publishedAt);
  const isPrerelease = data.isPrerelease === true;
  const isLatest = data.isLatest === true;
  const repoClause = repo ? ` in ${repo}` : "";
  const detail = [
    `release ${tag}${repoClause}`,
    name && name !== tag ? `name: ${name}` : undefined,
    "draft",
    isPrerelease ? "prerelease" : undefined,
    isLatest ? "latest" : undefined,
    createdAt ? `created ${createdAt}` : undefined,
    publishedAt ? `published ${publishedAt}` : undefined,
  ].filter((item): item is string => Boolean(item)).join("; ");
  return {
    title: `GitHub draft release ${tag}${name && name !== tag ? `: ${name}` : ""}`,
    prompt: [
      `Inspect GitHub draft release ${tag}${repoClause}.`,
      repo ? `Use gh release view ${tag} --repo ${repo} as needed.` : `Use gh release view ${tag} as needed.`,
      "Review release readiness, local project state, and verification evidence, then propose a bounded publish plan, verification plan, or clarification question.",
      "Do not publish, edit, delete, or upload release assets unless the user explicitly asks.",
    ].join(" "),
    detail,
    priority: "medium",
    dedupe_key: `github-draft-release:${repo ?? "current"}:${tag}`,
    source: {
      kind: GITHUB_DRAFT_RELEASES_SOURCE,
      provider: "github",
      repo,
      tag,
      name,
      draft: true,
      prerelease: isPrerelease,
      latest: isLatest,
      created_at: createdAt,
      published_at: publishedAt,
      suggested_verifier: suggestedVerifier("github-release-status", { tag, repo, expect: "published" }),
    },
  };
}

async function discoverGitHubDeployments(schedule: DiscoverySchedule): Promise<{ candidates: ParsedDiscoveryCandidate[]; stdout_bytes: number }> {
  const repo = normalizeGitHubRepo(stringMetadata(schedule.metadata.repo) ?? "", "--repo");
  const environment = stringMetadata(schedule.metadata.environment);
  const ref = stringMetadata(schedule.metadata.ref);
  const limit = numberMetadata(schedule.metadata.limit, 25, 1, 100);
  const args = [
    "api",
    "--method",
    "GET",
    `repos/${repo}/deployments`,
    "-F",
    `per_page=${limit}`,
  ];
  if (environment) {
    args.push("-F", `environment=${environment}`);
  }
  if (ref) {
    args.push("-F", `ref=${ref}`);
  }
  const output = await runDiscoveryProcess("gh", args, schedule.workspace_root, schedule.timeout_ms);
  const parsed = JSON.parse(output.stdout.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("gh api deployments must return a JSON array.");
  }
  return {
    candidates: parsed
      .slice(0, limit)
      .map((item) => parseGitHubDeploymentCandidate(item, repo, { environment, ref }))
      .filter((item): item is ParsedDiscoveryCandidate => Boolean(item)),
    stdout_bytes: output.stdout.length,
  };
}

function parseGitHubDeploymentCandidate(
  value: unknown,
  repo: string,
  filters: { environment?: string; ref?: string },
): ParsedDiscoveryCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const id = numberValue(data.id);
  if (id === undefined) {
    return undefined;
  }
  const environment = stringValue(data.environment) ?? filters.environment;
  const ref = stringValue(data.ref) ?? filters.ref;
  const sha = stringValue(data.sha);
  const task = stringValue(data.task);
  const description = stringValue(data.description);
  const creator = githubLogin(data.creator);
  const url = stringValue(data.url);
  const statusesUrl = stringValue(data.statuses_url) ?? stringValue(data.statusesUrl);
  const createdAt = stringValue(data.created_at) ?? stringValue(data.createdAt);
  const updatedAt = stringValue(data.updated_at) ?? stringValue(data.updatedAt);
  const envText = environment ?? "default";
  const refText = ref ? `ref: ${ref}` : undefined;
  const detail = [
    `deployment ${id} in ${repo}`,
    `environment: ${envText}`,
    refText,
    sha ? `sha: ${sha.slice(0, 12)}` : undefined,
    task ? `task: ${task}` : undefined,
    creator ? `creator: ${creator}` : undefined,
    description ? `description: ${description}` : undefined,
    createdAt ? `created ${createdAt}` : undefined,
    updatedAt ? `updated ${updatedAt}` : undefined,
    url,
  ].filter((item): item is string => Boolean(item)).join("; ");
  return {
    title: `GitHub Deployment ${id} (${envText})`,
    prompt: [
      `Verify GitHub Deployment ${id} in ${repo}.`,
      `Use inferoa verify-github-deployment <session> --repo ${repo} --deployment-id ${id} to record structured deployment status evidence.`,
      "If the deployment is failed, pending, queued, or in progress, inspect related workflow or deployment logs with read-only connector commands before proposing changes.",
      "Do not create deployment statuses, deploy, publish, or mutate external systems unless the user explicitly asks.",
    ].join(" "),
    detail,
    priority: "medium",
    dedupe_key: `github-deployment:${repo}:${id}`,
    source: {
      kind: GITHUB_DEPLOYMENTS_SOURCE,
      provider: "github",
      repo,
      deployment_id: id,
      environment,
      ref,
      sha,
      task,
      description,
      creator,
      url,
      statuses_url: statusesUrl,
      created_at: createdAt,
      updated_at: updatedAt,
      suggested_verifier: suggestedVerifier("github-deployment-status", { repo, deployment_id: String(id) }),
    },
  };
}

async function discoverHttpHealth(schedule: DiscoverySchedule): Promise<{ candidates: ParsedDiscoveryCandidate[]; stdout_bytes: number }> {
  const url = normalizeHttpUrl(stringMetadata(schedule.metadata.url) ?? "");
  const expectedStatus = normalizeHttpStatus(numberMetadata(schedule.metadata.expected_status, 200, 100, 599));
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), schedule.timeout_ms);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const elapsedMs = Date.now() - started;
    if (response.status === expectedStatus) {
      return { candidates: [], stdout_bytes: 0 };
    }
    return {
      candidates: [httpHealthCandidate({
        url,
        expectedStatus,
        status: response.status,
        statusText: response.statusText,
        elapsedMs,
      })],
      stdout_bytes: 0,
    };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    return {
      candidates: [httpHealthCandidate({
        url,
        expectedStatus,
        elapsedMs,
        error: message,
      })],
      stdout_bytes: 0,
    };
  }
}

async function discoverNpmPackageStatus(schedule: DiscoverySchedule): Promise<{ candidates: ParsedDiscoveryCandidate[]; stdout_bytes: number }> {
  const packageName = normalizeNpmPackageName(stringMetadata(schedule.metadata.package_name) ?? "");
  const version = normalizeNpmVersion(stringMetadata(schedule.metadata.version) ?? "");
  const tag = schedule.metadata.tag === undefined ? undefined : normalizeNpmDistTag(stringMetadata(schedule.metadata.tag) ?? "");
  const output = await runDiscoveryProcess("npm", ["view", packageName, "versions", "dist-tags", "--json"], schedule.workspace_root, schedule.timeout_ms);
  const parsed = JSON.parse(output.stdout.trim() || "{}") as unknown;
  const status = parseNpmPackageStatus(parsed);
  if (!status) {
    throw new Error("npm view <package> versions dist-tags --json must return a JSON object.");
  }
  const candidate = npmPackageStatusCandidate(packageName, version, tag, status);
  return {
    candidates: candidate ? [candidate] : [],
    stdout_bytes: output.stdout.length,
  };
}

function npmPackageStatusCandidate(
  packageName: string,
  version: string,
  tag: string | undefined,
  status: { versions: string[]; dist_tags: Record<string, string> },
): ParsedDiscoveryCandidate | undefined {
  const versionPresent = status.versions.includes(version);
  const tagVersion = tag ? status.dist_tags[tag] : undefined;
  const tagMatches = tag ? tagVersion === version : true;
  if (versionPresent && tagMatches) {
    return undefined;
  }
  const target = `${packageName}@${version}`;
  const title = !versionPresent
    ? `npm package version missing: ${target}`
    : `npm dist-tag mismatch: ${packageName} ${tag}`;
  const detail = [
    `package: ${packageName}`,
    `version: ${version}`,
    tag ? `tag: ${tag}` : undefined,
    `version present: ${versionPresent ? "yes" : "no"}`,
    tag ? `tag version: ${tagVersion ?? "missing"}` : undefined,
    `known versions: ${status.versions.length}`,
  ].filter((item): item is string => Boolean(item)).join("; ");
  return {
    title,
    prompt: [
      `Investigate npm package publication state for ${target}.`,
      tag ? `Expected dist-tag ${tag} to point to ${version}.` : "Expected the package version to be present in npm metadata.",
      `Use inferoa verify-npm-package <session> ${packageName} --version ${version}${tag ? ` --tag ${tag}` : ""} to record structured registry evidence.`,
      "If publication or tag update is needed, use the dry-run connector action path first and execute only when the user explicitly asks.",
    ].join(" "),
    detail,
    priority: "high",
    dedupe_key: `npm-package-status:${packageName}:${version}:${tag ?? "version"}`,
    source: {
      kind: NPM_PACKAGE_STATUS_SOURCE,
      provider: "npm",
      package_name: packageName,
      version,
      tag,
      version_present: versionPresent,
      tag_version: tagVersion,
      tag_match: tag ? tagMatches : undefined,
      version_count: status.versions.length,
      dist_tags: status.dist_tags,
      suggested_verifier: suggestedVerifier("npm-package-status", { package_name: packageName, version, tag }),
    },
  };
}

function parseNpmPackageStatus(value: unknown): { versions: string[]; dist_tags: Record<string, string> } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  const versions = Array.isArray(object.versions)
    ? object.versions.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  const tags = object["dist-tags"];
  const distTags: Record<string, string> = {};
  if (tags && typeof tags === "object" && !Array.isArray(tags)) {
    for (const [key, tagValue] of Object.entries(tags as Record<string, unknown>)) {
      if (typeof tagValue === "string" && tagValue.trim()) {
        distTags[key] = tagValue.trim();
      }
    }
  }
  return { versions, dist_tags: distTags };
}

function httpHealthCandidate(input: {
  url: string;
  expectedStatus: number;
  status?: number;
  statusText?: string;
  elapsedMs: number;
  error?: string;
}): ParsedDiscoveryCandidate {
  const failed = input.status === undefined;
  const title = failed
    ? `HTTP health unreachable: ${input.url}`
    : `HTTP health status ${input.status}: ${input.url}`;
  const detail = [
    `expected ${input.expectedStatus}`,
    input.status !== undefined ? `actual ${input.status}` : undefined,
    input.statusText ? `status text: ${input.statusText}` : undefined,
    input.error ? `error: ${input.error}` : undefined,
    `elapsed ${input.elapsedMs}ms`,
  ].filter((item): item is string => Boolean(item)).join("; ");
  return {
    title,
    prompt: [
      `Investigate HTTP health check failure for ${input.url}.`,
      `Expected status ${input.expectedStatus}${input.status !== undefined ? ` but received ${input.status}` : " but the endpoint could not be read"}.`,
      "Inspect recent code, configuration, deployment assumptions, and verification evidence.",
      "Use verify-http after changes or investigation to record structured health evidence.",
      "Do not deploy, publish, or mutate external systems unless the user explicitly asks.",
    ].join(" "),
    detail,
    priority: failed || (input.status !== undefined && input.status >= 500) ? "high" : "medium",
    dedupe_key: `http-health:${input.url}:${input.expectedStatus}`,
    source: {
      kind: HTTP_HEALTH_SOURCE,
      provider: "http",
      url: input.url,
      expected_status: input.expectedStatus,
      status: input.status,
      status_text: input.statusText,
      error: input.error,
      elapsed_ms: input.elapsedMs,
      suggested_verifier: suggestedVerifier("http-health", { url: input.url, expected_status: input.expectedStatus }),
    },
  };
}

function suggestedVerifier(id: string, params: JsonObject): JsonObject {
  return { id, params };
}

export function pauseLoopDiscoverySchedule(store: SessionStore, scheduleId: string): DiscoverySchedule {
  store.updateDiscoverySchedule(scheduleId, { status: "paused" });
  const schedule = requireDiscoverySchedule(store, scheduleId);
  store.appendEvent({ session_id: schedule.session_id, type: "loop.discovery.schedule.paused", data: { schedule_id: schedule.schedule_id } });
  return schedule;
}

export function resumeLoopDiscoverySchedule(store: SessionStore, scheduleId: string, now = new Date()): DiscoverySchedule {
  const schedule = requireDiscoverySchedule(store, scheduleId);
  store.updateDiscoverySchedule(scheduleId, {
    status: "enabled",
    next_run_at: nextDiscoveryRunAt(schedule, now),
  });
  const resumed = requireDiscoverySchedule(store, scheduleId);
  store.appendEvent({
    session_id: resumed.session_id,
    type: "loop.discovery.schedule.resumed",
    data: { schedule_id: resumed.schedule_id, next_run_at: resumed.next_run_at },
  });
  return resumed;
}

export function removeLoopDiscoverySchedule(store: SessionStore, scheduleId: string): DiscoverySchedule {
  const removed = store.deleteDiscoverySchedule(scheduleId);
  if (!removed) {
    throw new Error(`Unknown discovery schedule: ${scheduleId}`);
  }
  return removed;
}

export function parseDiscoveryOutput(stdout: string, schedule: Pick<DiscoverySchedule, "schedule_id">): ParsedDiscoveryCandidate[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = JSON.parse(trimmed) as unknown;
  const rawItems = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : undefined;
  if (!rawItems) {
    throw new Error("Discovery command must print a JSON array or { items: [...] }.");
  }
  return rawItems.slice(0, 100).map((item, index) => parseDiscoveryCandidate(item, schedule, index)).filter((item): item is ParsedDiscoveryCandidate => Boolean(item));
}

function parseDiscoveryCandidate(value: unknown, schedule: Pick<DiscoverySchedule, "schedule_id">, index: number): ParsedDiscoveryCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const title = stringValue(data.title)?.trim();
  if (!title) {
    return undefined;
  }
  const prompt = stringValue(data.prompt)?.trim() || title;
  const detail = stringValue(data.detail) ?? stringValue(data.description);
  const priority = data.priority === "high" || data.priority === "low" ? data.priority : "medium";
  const dedupeKey = stringValue(data.dedupe_key)?.trim() || stringValue(data.id)?.trim() || shortHash(`${schedule.schedule_id}:${index}:${title}:${prompt}`, 16);
  return {
    title,
    prompt,
    detail,
    priority,
    dedupe_key: dedupeKey,
    source: data as JsonObject,
  };
}

async function runDiscoveryCommand(schedule: DiscoverySchedule): Promise<{ stdout: string; stderr: string }> {
  const shell = process.platform === "win32" ? "cmd.exe" : "sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", schedule.command] : ["-lc", schedule.command];
  return await runDiscoveryProcess(shell, args, schedule.workspace_root, schedule.timeout_ms);
}

async function runDiscoveryProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < DISCOVERY_STDOUT_LIMIT) {
        stdout += String(chunk).slice(0, DISCOVERY_STDOUT_LIMIT - stdout.length);
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 16_384 - stderr.length);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function summarizeGitStatus(lines: string[]): {
  total: number;
  modified: number;
  deleted: number;
  untracked: number;
  renamed: number;
  conflicted: number;
  paths: string[];
} {
  const paths: string[] = [];
  let modified = 0;
  let deleted = 0;
  let untracked = 0;
  let renamed = 0;
  let conflicted = 0;
  for (const line of lines) {
    const code = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const normalizedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)?.trim() ?? rawPath : rawPath;
    if (normalizedPath) {
      paths.push(normalizedPath);
    }
    if (code === "??") {
      untracked += 1;
      continue;
    }
    if (code.includes("R") || code.includes("C")) {
      renamed += 1;
    }
    if (code.includes("D")) {
      deleted += 1;
    }
    if (code.includes("U") || code === "AA" || code === "DD") {
      conflicted += 1;
    }
    if (code.includes("M") || code.includes("A") || code.includes("R") || code.includes("C")) {
      modified += 1;
    }
  }
  return { total: lines.length, modified, deleted, untracked, renamed, conflicted, paths };
}

function dismissStaleSourceCandidates(
  store: SessionStore,
  schedule: DiscoverySchedule,
  candidates: DiscoveryCandidate[],
  source: string,
): void {
  if (DISCOVERY_SOURCE_REGISTRY[source]?.dismiss_stale !== true) {
    return;
  }
  const currentIds = new Set(candidates.map((candidate) => candidate.candidate_id));
  const stale = store
    .listDiscoveryCandidates({ workspaceId: schedule.workspace_id, status: "open" })
    .filter((candidate) => candidate.schedule_id === schedule.schedule_id && !currentIds.has(candidate.candidate_id));
  for (const candidate of stale) {
    store.updateDiscoveryCandidate(candidate.candidate_id, {
      status: "dismissed",
      source: {
        ...candidate.source,
        dismissed_by_source: source,
        dismissed_reason: "source_no_longer_reports_candidate",
      },
    });
  }
}

function requireDiscoverySchedule(store: SessionStore, scheduleId: string): DiscoverySchedule {
  const schedule = store.getDiscoverySchedule(scheduleId);
  if (!schedule) {
    throw new Error(`Unknown discovery schedule: ${scheduleId}`);
  }
  return schedule;
}

function nextDiscoveryRunAt(schedule: DiscoverySchedule, now: Date): string {
  let next = Date.parse(schedule.next_run_at);
  const nowMs = now.getTime();
  if (!Number.isFinite(next)) {
    next = nowMs;
  }
  while (next <= nowMs) {
    next += schedule.interval_ms;
  }
  return new Date(next).toISOString();
}

function discoveryCandidateId(schedule: DiscoverySchedule, candidate: ParsedDiscoveryCandidate): string {
  return `cand_${shortHash(stableJson({
    workspace_id: schedule.workspace_id,
    schedule_id: schedule.schedule_id,
    dedupe_key: candidate.dedupe_key,
  }), 24)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function githubLabelNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((label) => label && typeof label === "object" && !Array.isArray(label) ? stringValue((label as { name?: unknown }).name) : undefined).filter((label): label is string => Boolean(label))
    : [];
}

function appendGitHubLabelFilterArgs(args: string[], labels: string[]): void {
  for (const label of labels) {
    args.push("--label", label);
  }
}

function githubLoginList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => githubLogin(entry)).filter((login): login is string => Boolean(login))
    : [];
}

function githubLogin(value: unknown): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? stringValue((value as { login?: unknown }).login) : undefined;
}

function githubRepositoryName(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const direct = stringValue(data.nameWithOwner) ?? stringValue(data.fullName) ?? stringValue(data.full_name);
  if (direct) {
    return direct;
  }
  const owner = githubLogin(data.owner) ?? stringValue(data.owner);
  const name = stringValue(data.name);
  return owner && name ? `${owner}/${name}` : undefined;
}

function stringMetadata(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function stringArrayMetadata(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const label = typeof item === "string" ? item.trim() : "";
    if (!label || /[\r\n]/.test(label)) {
      continue;
    }
    const key = label.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      output.push(label);
    }
  }
  return output;
}

function numberMetadata(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeGitHubLabelFilter(labels: string[] | undefined): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of labels ?? []) {
    const label = value.trim();
    if (!label || /[\r\n]/.test(label)) {
      throw new Error("GitHub discovery labels must be non-empty single-line values.");
    }
    const key = label.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      output.push(label);
    }
  }
  return output;
}

function normalizeGitHubRepo(value: string, flag: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    throw new Error(`${flag} requires owner/name.`);
  }
  return trimmed;
}

function normalizeNpmPackageName(value: string): string {
  const packageName = value.trim();
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) {
    throw new Error("npm package discovery requires a package name such as inferoa or @scope/name.");
  }
  return packageName;
}

function normalizeNpmVersion(value: string): string {
  const version = value.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("npm package discovery requires an explicit semver version such as 1.2.3.");
  }
  return version;
}

function normalizeNpmDistTag(value: string): string {
  const tag = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    throw new Error("npm package discovery dist-tag must be a tag such as latest or beta.");
  }
  return tag;
}

function normalizeHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("HTTP health discovery requires a URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("HTTP health discovery URL must be absolute.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("HTTP health discovery URL must use http or https.");
  }
  return parsed.toString();
}

function normalizeHttpStatus(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error("HTTP status must be an integer from 100 to 599.");
  }
  return value;
}
