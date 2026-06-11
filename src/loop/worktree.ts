import path from "node:path";
import { promises as fs } from "node:fs";
import type { ManagedWorktree, SessionStore, SupervisorJob } from "../session/store.js";
import type { JsonObject, WorkspaceIdentity } from "../types.js";
import { ensureDir, findGitRoot, pathExists, realpathOrResolve, runSmallCommand } from "../util/fs.js";
import { randomId } from "../util/hash.js";

export interface CreateLoopWorktreeOptions {
  base_ref?: string;
  branch?: string;
  path?: string;
  metadata?: JsonObject;
}

export interface RemoveLoopWorktreeOptions {
  force?: boolean;
}

export interface AdoptLoopWorktreeOptions {
  dry_run?: boolean;
  message?: string;
}

export interface CleanupLoopWorktreesOptions {
  dry_run?: boolean;
  force?: boolean;
  older_than_ms?: number;
}

export interface LoopWorktreeRunTarget {
  worktree: ManagedWorktree;
  workspace_root: string;
}

export interface LoopWorktreeAdoption {
  worktree: ManagedWorktree;
  status: "ready" | "adopted" | "already_adopted";
  dry_run: boolean;
  base_head: string;
  worktree_head: string;
  output?: string;
}

export interface LoopWorktreeCleanupResult {
  dry_run: boolean;
  cutoff: string;
  candidates: ManagedWorktree[];
  removed: ManagedWorktree[];
  failed: Array<{ worktree: ManagedWorktree; error: string }>;
}

export interface LoopWorktreeHealthOptions {
  active_stale_ms?: number;
  cleanup_due_ms?: number;
}

export interface LoopWorktreeHealthItem {
  worktree: ManagedWorktree;
  job?: SupervisorJob;
  age_ms: number;
  updated_age_ms: number;
  severity: "ok" | "watch" | "attention";
  reasons: string[];
}

export interface LoopWorktreeHealth {
  generated_at: string;
  counts: Record<ManagedWorktree["status"], number>;
  active_stale_count: number;
  cleanup_due_count: number;
  attention_count: number;
  items: LoopWorktreeHealthItem[];
}

const GIT_TIMEOUT_MS = 60_000;
const DEFAULT_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVE_STALE_MS = 24 * 60 * 60 * 1000;

export async function createLoopWorktree(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateLoopWorktreeOptions = {},
): Promise<ManagedWorktree> {
  const baseRoot = await managedBaseRoot(workspace);
  store.upsertWorkspace(workspace);
  const worktreeId = randomId("wt");
  const baseRef = cleanRef(options.base_ref) ?? "HEAD";
  const branch = options.branch?.trim() || `inferoa/loop/${worktreeId}`;
  await validateBranchName(baseRoot, branch);
  const worktreePath = path.resolve(options.path ?? defaultLoopWorktreePath(baseRoot, worktreeId));
  if (await pathExists(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }
  await ensureDir(path.dirname(worktreePath));
  const result = await runSmallCommand("git", ["worktree", "add", "-b", branch, worktreePath, baseRef], baseRoot, GIT_TIMEOUT_MS);
  if (result.code !== 0) {
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`git worktree add failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }
  const realPath = await realpathOrResolve(worktreePath);
  return store.createManagedWorktree({
    worktree_id: worktreeId,
    workspace_id: workspace.id,
    base_root: baseRoot,
    path: realPath,
    branch,
    base_ref: baseRef,
    metadata: options.metadata,
  });
}

export function listLoopWorktrees(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: { includeRemoved?: boolean } = {},
): ManagedWorktree[] {
  const items = store.listManagedWorktrees({ workspaceId: workspace.id });
  return options.includeRemoved ? items : items.filter((item) => item.status === "active");
}

export async function removeLoopWorktree(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  worktreeIdOrPrefix: string,
  options: RemoveLoopWorktreeOptions = {},
): Promise<ManagedWorktree> {
  const worktree = resolveLoopWorktree(store, workspace, worktreeIdOrPrefix);
  if (worktree.status === "removed") {
    return worktree;
  }
  if (await pathExists(worktree.path)) {
    const args = ["worktree", "remove"];
    if (options.force) {
      args.push("--force");
    }
    args.push(worktree.path);
    const result = await runSmallCommand("git", args, worktree.base_root, GIT_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new Error(`git worktree remove failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
    }
  }
  store.updateManagedWorktree(worktree.worktree_id, { status: "removed" });
  return store.getManagedWorktree(worktree.worktree_id)!;
}

export async function adoptLoopWorktree(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  worktreeIdOrPrefix: string,
  options: AdoptLoopWorktreeOptions = {},
): Promise<LoopWorktreeAdoption> {
  const worktree = resolveLoopWorktree(store, workspace, worktreeIdOrPrefix);
  if (worktree.status === "removed") {
    throw new Error(`Cannot adopt removed worktree: ${worktree.worktree_id}`);
  }
  if (worktree.status === "failed") {
    throw new Error(`Cannot adopt failed worktree: ${worktree.worktree_id}`);
  }
  if (!(await pathExists(worktree.path))) {
    throw new Error(`Worktree path does not exist: ${worktree.path}`);
  }
  const baseRoot = await managedBaseRoot(workspace);
  if (baseRoot !== worktree.base_root) {
    throw new Error(`Worktree base root does not match current workspace: ${worktree.base_root}`);
  }
  await assertCleanTrackedCheckout(baseRoot);
  await assertNoActiveMerge(baseRoot);

  const baseHead = await gitOutput(baseRoot, ["rev-parse", "HEAD"], "git rev-parse HEAD failed");
  const worktreeHead = await gitOutput(baseRoot, ["rev-parse", "--verify", worktree.branch], `git rev-parse ${worktree.branch} failed`);
  if (await isAncestor(baseRoot, worktree.branch, "HEAD")) {
    const adopted = options.dry_run ? worktree : markWorktreeAdopted(store, worktree, baseHead, worktreeHead, "already_adopted");
    return {
      worktree: adopted,
      status: "already_adopted",
      dry_run: Boolean(options.dry_run),
      base_head: baseHead,
      worktree_head: worktreeHead,
      output: "worktree branch is already merged",
    };
  }

  const preflight = await runSmallCommand("git", ["merge-tree", "--write-tree", "HEAD", worktree.branch], baseRoot, GIT_TIMEOUT_MS);
  if (preflight.code !== 0) {
    throw new Error(`git merge-tree failed: ${firstNonEmpty(preflight.stderr, preflight.stdout, `exit ${preflight.code}`)}`);
  }
  if (options.dry_run) {
    return {
      worktree,
      status: "ready",
      dry_run: true,
      base_head: baseHead,
      worktree_head: worktreeHead,
      output: preflight.stdout.trim(),
    };
  }

  const message = options.message?.trim() || `Adopt Inferoa worktree ${worktree.worktree_id}`;
  const merge = await runSmallCommand("git", ["merge", "--no-ff", worktree.branch, "-m", message], baseRoot, GIT_TIMEOUT_MS);
  if (merge.code !== 0) {
    await abortMergeIfActive(baseRoot);
    throw new Error(`git merge failed: ${firstNonEmpty(merge.stderr, merge.stdout, `exit ${merge.code}`)}`);
  }
  const adoptedHead = await gitOutput(baseRoot, ["rev-parse", "HEAD"], "git rev-parse HEAD failed after merge");
  const adopted = markWorktreeAdopted(store, worktree, adoptedHead, worktreeHead, "merge");
  if (adopted.session_id) {
    store.appendEvent({
      session_id: adopted.session_id,
      type: "loop.worktree.adopted",
      data: {
        worktree_id: adopted.worktree_id,
        worktree_branch: adopted.branch,
        worktree_path: adopted.path,
        base_root: adopted.base_root,
        adopted_head: adoptedHead,
        worktree_head: worktreeHead,
      },
    });
  }
  return {
    worktree: adopted,
    status: "adopted",
    dry_run: false,
    base_head: baseHead,
    worktree_head: worktreeHead,
    output: [merge.stdout.trim(), merge.stderr.trim()].filter(Boolean).join("\n"),
  };
}

export async function cleanupLoopWorktrees(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CleanupLoopWorktreesOptions = {},
): Promise<LoopWorktreeCleanupResult> {
  const ageMs = Math.max(0, Math.trunc(options.older_than_ms ?? DEFAULT_CLEANUP_AGE_MS));
  const cutoffDate = new Date(Date.now() - ageMs);
  const candidates = store
    .listManagedWorktrees({ workspaceId: workspace.id })
    .filter((worktree) => (worktree.status === "adopted" || worktree.status === "failed") && new Date(worktree.updated_at).getTime() <= cutoffDate.getTime());
  if (options.dry_run) {
    return { dry_run: true, cutoff: cutoffDate.toISOString(), candidates, removed: [], failed: [] };
  }
  const removed: ManagedWorktree[] = [];
  const failed: LoopWorktreeCleanupResult["failed"] = [];
  for (const worktree of candidates) {
    try {
      removed.push(await removeLoopWorktree(store, workspace, worktree.worktree_id, { force: options.force }));
    } catch (error) {
      failed.push({
        worktree,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { dry_run: false, cutoff: cutoffDate.toISOString(), candidates, removed, failed };
}

export function readLoopWorktreeHealth(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: LoopWorktreeHealthOptions = {},
): LoopWorktreeHealth {
  const now = Date.now();
  const activeStaleMs = Math.max(0, Math.trunc(options.active_stale_ms ?? DEFAULT_ACTIVE_STALE_MS));
  const cleanupDueMs = Math.max(0, Math.trunc(options.cleanup_due_ms ?? DEFAULT_CLEANUP_AGE_MS));
  const counts: LoopWorktreeHealth["counts"] = { active: 0, adopted: 0, removed: 0, failed: 0 };
  const items = store.listManagedWorktrees({ workspaceId: workspace.id }).map((worktree) => {
    counts[worktree.status] += 1;
    const createdAt = timestampMs(worktree.created_at);
    const updatedAt = timestampMs(worktree.updated_at);
    const ageMs = Math.max(0, now - createdAt);
    const updatedAgeMs = Math.max(0, now - updatedAt);
    const job = worktree.job_id ? store.getSupervisorJob(worktree.job_id) : undefined;
    const reasons: string[] = [];
    if (worktree.status === "active" && updatedAgeMs >= activeStaleMs) {
      reasons.push("active_stale");
    }
    if ((worktree.status === "adopted" || worktree.status === "failed") && updatedAgeMs >= cleanupDueMs) {
      reasons.push("cleanup_due");
    }
    if (worktree.status === "failed") {
      reasons.push("worktree_failed");
    }
    if (job && (job.status === "failed" || job.status === "blocked" || job.status === "paused")) {
      reasons.push(`job_${job.status}`);
    }
    const severity: LoopWorktreeHealthItem["severity"] =
      reasons.some((reason) => reason === "worktree_failed" || reason === "job_failed" || reason === "job_blocked")
        ? "attention"
        : reasons.length
          ? "watch"
          : "ok";
    return { worktree, job, age_ms: ageMs, updated_age_ms: updatedAgeMs, severity, reasons };
  });
  return {
    generated_at: new Date(now).toISOString(),
    counts,
    active_stale_count: items.filter((item) => item.reasons.includes("active_stale")).length,
    cleanup_due_count: items.filter((item) => item.reasons.includes("cleanup_due")).length,
    attention_count: items.filter((item) => item.severity === "attention").length,
    items,
  };
}

export function resolveLoopWorktree(store: SessionStore, workspace: WorkspaceIdentity, worktreeIdOrPrefix: string): ManagedWorktree {
  const query = worktreeIdOrPrefix.trim();
  if (!query) {
    throw new Error("Worktree id is required.");
  }
  const exact = store.getManagedWorktree(query);
  if (exact && exact.workspace_id === workspace.id) {
    return exact;
  }
  const byPrefix = store.findManagedWorktreeByPrefix(workspace.id, query);
  if (byPrefix) {
    return byPrefix;
  }
  throw new Error(`No managed worktree matches ${worktreeIdOrPrefix}`);
}

export function loopWorktreeRunTarget(worktree: ManagedWorktree, workspace: WorkspaceIdentity): LoopWorktreeRunTarget {
  const relative = path.relative(worktree.base_root, workspace.root);
  const workspaceRoot =
    relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? path.join(worktree.path, relative)
      : worktree.path;
  return { worktree, workspace_root: workspaceRoot };
}

async function managedBaseRoot(workspace: WorkspaceIdentity): Promise<string> {
  const baseRoot = workspace.gitRoot ?? (await findGitRoot(workspace.root));
  if (!baseRoot) {
    throw new Error("Managed worktrees require a git workspace.");
  }
  return realpathOrResolve(baseRoot);
}

async function validateBranchName(baseRoot: string, branch: string): Promise<void> {
  const result = await runSmallCommand("git", ["check-ref-format", "--branch", branch], baseRoot, 5000);
  if (result.code !== 0) {
    throw new Error(`Invalid worktree branch name: ${branch}`);
  }
}

function cleanRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function defaultLoopWorktreePath(baseRoot: string, worktreeId: string): string {
  const repoName = path.basename(baseRoot) || "workspace";
  return path.join(path.dirname(baseRoot), ".inferoa-worktrees", repoName, worktreeId);
}

async function assertCleanTrackedCheckout(baseRoot: string): Promise<void> {
  const status = await runSmallCommand("git", ["status", "--porcelain", "--untracked-files=no"], baseRoot, 10_000);
  if (status.code !== 0) {
    throw new Error(`git status failed: ${firstNonEmpty(status.stderr, status.stdout, `exit ${status.code}`)}`);
  }
  if (status.stdout.trim()) {
    throw new Error("Active checkout has tracked changes. Commit, stash, or revert them before adopting a worktree.");
  }
}

async function assertNoActiveMerge(baseRoot: string): Promise<void> {
  const mergeHead = await runSmallCommand("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], baseRoot, 10_000);
  if (mergeHead.code === 0) {
    throw new Error("Active checkout already has an in-progress merge.");
  }
}

async function isAncestor(baseRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runSmallCommand("git", ["merge-base", "--is-ancestor", ancestor, descendant], baseRoot, 10_000);
  return result.code === 0;
}

async function abortMergeIfActive(baseRoot: string): Promise<void> {
  const mergeHead = await runSmallCommand("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], baseRoot, 10_000);
  if (mergeHead.code === 0) {
    await runSmallCommand("git", ["merge", "--abort"], baseRoot, GIT_TIMEOUT_MS);
  }
}

async function gitOutput(baseRoot: string, args: string[], errorPrefix: string): Promise<string> {
  const result = await runSmallCommand("git", args, baseRoot, GIT_TIMEOUT_MS);
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(`${errorPrefix}: ${firstNonEmpty(result.stderr, result.stdout, `exit ${result.code}`)}`);
  }
  return result.stdout.trim();
}

function markWorktreeAdopted(
  store: SessionStore,
  worktree: ManagedWorktree,
  adoptedHead: string,
  worktreeHead: string,
  mode: string,
): ManagedWorktree {
  store.updateManagedWorktree(worktree.worktree_id, {
    status: "adopted",
    metadata: {
      ...worktree.metadata,
      adopted_at: new Date().toISOString(),
      adopted_head: adoptedHead,
      adopted_from_head: worktreeHead,
      adoption_mode: mode,
    },
  });
  return store.getManagedWorktree(worktree.worktree_id)!;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "unknown error";
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
