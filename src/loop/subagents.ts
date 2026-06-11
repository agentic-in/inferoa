import { cloneGoalState, readGoalState, writeGoalState, type GoalState } from "../goals/state.js";
import type { ManagedWorktree, SessionStore, SupervisorJob } from "../session/store.js";
import type { JsonObject, SessionRecord, WorkspaceIdentity } from "../types.js";
import { randomId } from "../util/hash.js";
import { createLoopWorktree, loopWorktreeRunTarget } from "./worktree.js";

export type LoopSubagentIsolation = "session" | "worktree";
export type LoopSubagentSource = "tool";

export interface QueueLoopSubagentOptions {
  store: SessionStore;
  workspace: WorkspaceIdentity;
  parent_session: SessionRecord;
  task: string;
  source: LoopSubagentSource;
  isolation?: LoopSubagentIsolation;
  config_path?: string;
  metadata?: JsonObject;
}

export interface QueuedLoopSubagent {
  subagent_id: string;
  isolation: LoopSubagentIsolation;
  parent_session_id: string;
  child_session_id: string;
  job_id: string;
  workspace_root: string;
  prompt: string;
  worktree?: ManagedWorktree;
}

export function isLoopSubagentSession(store: SessionStore, sessionId: string): boolean {
  return store.listEvents(sessionId).some((event) => event.type === "loop.subagent.parent_linked");
}

export async function queueLoopSubagent(options: QueueLoopSubagentOptions): Promise<QueuedLoopSubagent> {
  const task = normalizeTask(options.task);
  const isolation = options.isolation ?? "session";
  const parentState = readGoalState(options.store, options.parent_session.session_id);
  const goal = parentState?.goal;
  const subagentId = randomId("subagent");
  const child = options.store.createSession(options.workspace, `subagent:${task.slice(0, 56)}`);
  if (parentState) {
    writeGoalState(options.store, child.session_id, cloneGoalState(parentState), "loop_subagent_clone");
  }
  const metadata = subagentJobMetadata({
    config_path: options.config_path,
    subagent_id: subagentId,
    source: options.source,
    parent_session_id: options.parent_session.session_id,
    parent_goal_id: goal?.id,
    parent_horizon_generation: goal?.horizon_generation,
    isolation,
    extra: options.metadata,
  });
  let worktree: ManagedWorktree | undefined;
  let workspaceRoot = options.workspace.root;
  if (isolation === "worktree") {
    worktree = await createLoopWorktree(options.store, options.workspace, {
      metadata: {
        purpose: "loop_subagent",
        subagent_id: subagentId,
        parent_session_id: options.parent_session.session_id,
        parent_goal_id: goal?.id,
      },
    });
    const target = loopWorktreeRunTarget(worktree, options.workspace);
    workspaceRoot = target.workspace_root;
    metadata.worktree_id = worktree.worktree_id;
    metadata.worktree_path = worktree.path;
    metadata.worktree_branch = worktree.branch;
    metadata.base_ref = worktree.base_ref;
  }
  const prompt = buildLoopSubagentPrompt(task, {
    parent_session: options.parent_session,
    goal_state: parentState,
  });
  const job = options.store.createSupervisorJob(child.session_id, workspaceRoot, prompt, {
    kind: "run",
    goal_id: goal?.id,
    metadata,
  });
  if (worktree) {
    const current = options.store.getManagedWorktree(worktree.worktree_id);
    if (current) {
      options.store.updateManagedWorktree(worktree.worktree_id, {
        session_id: child.session_id,
        job_id: job.job_id,
        metadata: { ...current.metadata, session_id: child.session_id, job_id: job.job_id },
      });
    }
  }
  appendLoopSubagentEvents(options.store, options.parent_session, child, job, {
    subagent_id: subagentId,
    source: options.source,
    isolation,
    goal_id: goal?.id,
    horizon_generation: goal?.horizon_generation,
    worktree_id: worktree?.worktree_id,
  });
  return {
    subagent_id: subagentId,
    isolation,
    parent_session_id: options.parent_session.session_id,
    child_session_id: child.session_id,
    job_id: job.job_id,
    workspace_root: workspaceRoot,
    prompt,
    worktree,
  };
}

function buildLoopSubagentPrompt(
  task: string,
  context: { parent_session: SessionRecord; goal_state?: GoalState },
): string {
  const goal = context.goal_state?.goal;
  return [
    "Run this delegated sub-agent task in the child session.",
    "",
    `Parent session: ${context.parent_session.session_id}`,
    goal ? `Loop: ${goal.objective}` : "Loop: none",
    goal ? `Kind: ${goal.kind}` : undefined,
    goal ? `Loop task: ${goal.horizon_generation}` : undefined,
    "",
    "Task:",
    task,
    "",
    "Sub-agent contract:",
    "- Stay inside the delegated task.",
    "- Do not mark the parent loop complete or mutate parent loop state.",
    "- Return concrete evidence: files touched, commands run, findings, blockers, and suggested next action.",
    "- If final completion judgment is needed, report what should be verified instead of claiming parent completion.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function subagentJobMetadata(input: {
  config_path?: string;
  subagent_id: string;
  source: LoopSubagentSource;
  parent_session_id: string;
  parent_goal_id?: string;
  parent_horizon_generation?: number;
  isolation: LoopSubagentIsolation;
  extra?: JsonObject;
}): JsonObject {
  const metadata: JsonObject = {
    ...input.extra,
    request_class: "background",
    skip_goal_supervisor: true,
    loop_subagent: true,
    subagent_id: input.subagent_id,
    parent_session_id: input.parent_session_id,
    isolation: input.isolation,
    source: input.source,
  };
  if (input.parent_goal_id) {
    metadata.goal_id = input.parent_goal_id;
    metadata.parent_goal_id = input.parent_goal_id;
  }
  if (input.parent_horizon_generation !== undefined) {
    metadata.horizon_generation = input.parent_horizon_generation;
    metadata.parent_horizon_generation = input.parent_horizon_generation;
  }
  if (input.config_path) {
    metadata.config_path = input.config_path;
  }
  return metadata;
}

function appendLoopSubagentEvents(
  store: SessionStore,
  parent: SessionRecord,
  child: SessionRecord,
  job: SupervisorJob,
  data: {
    subagent_id: string;
    source: LoopSubagentSource;
    isolation: LoopSubagentIsolation;
    goal_id?: string;
    horizon_generation?: number;
    worktree_id?: string;
  },
): void {
  const common = {
    subagent_id: data.subagent_id,
    source: data.source,
    isolation: data.isolation,
    goal_id: data.goal_id,
    horizon_generation: data.horizon_generation,
    child_session_id: child.session_id,
    job_id: job.job_id,
    worktree_id: data.worktree_id,
  };
  store.appendEvent({
    session_id: parent.session_id,
    type: "loop.subagent.queued",
    data: common,
  });
  store.appendEvent({
    session_id: child.session_id,
    type: "loop.subagent.parent_linked",
    data: {
      ...common,
      parent_session_id: parent.session_id,
    },
  });
}

function normalizeTask(task: string): string {
  const normalized = task.trim();
  if (!normalized) {
    throw new Error("subagent task is required");
  }
  return normalized;
}
