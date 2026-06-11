import { cloneGoalState, writeGoalState, type GoalRecord, type GoalState } from "../goals/state.js";
import { buildGoalVerificationPrompt, type GoalVerifierRole } from "../goals/verifier.js";
import type { RuntimeRunOptions, RuntimeRunResult } from "../runtime.js";
import type { SessionStore } from "../session/store.js";
import type { JsonObject, WorkspaceIdentity } from "../types.js";
import { randomId } from "../util/hash.js";
import { readGoalLoopView } from "./projection.js";
import type { GoalLoopVerification } from "./types.js";
import { createLoopWorktree, loopWorktreeRunTarget } from "./worktree.js";

export interface GoalVerificationRuntime {
  run(options: RuntimeRunOptions): Promise<RuntimeRunResult>;
}

export interface GoalVerificationSuiteOptions {
  store: SessionStore;
  runtime: GoalVerificationRuntime;
  session_id: string;
  goal: GoalRecord;
  roles: GoalVerifierRole[];
  rubric?: string;
  source: "cli" | "tui" | "daemon";
}

export interface GoalVerificationSuiteRoleResult {
  role: GoalVerifierRole;
  run_id: string;
  tool_rounds: number;
  tool_calls: number;
  tokens_used: number;
  verification?: GoalLoopVerification;
  content: string;
}

export interface GoalVerificationSuiteResult {
  suite_id: string;
  roles: GoalVerifierRole[];
  results: GoalVerificationSuiteRoleResult[];
}

export type GoalVerificationSuiteIsolation = "session" | "worktree";

export interface QueueGoalVerificationSuiteOptions {
  store: SessionStore;
  workspace: WorkspaceIdentity;
  session_id: string;
  goal_state: GoalState;
  roles: GoalVerifierRole[];
  rubric?: string;
  source: "cli" | "tui";
  isolation?: GoalVerificationSuiteIsolation;
  config_path?: string;
}

export interface QueuedGoalVerificationRole {
  role: GoalVerifierRole;
  session_id: string;
  job_id: string;
  worktree_id?: string;
  workspace_root: string;
}

export interface QueuedGoalVerificationSuite {
  suite_id: string;
  roles: GoalVerifierRole[];
  isolation: GoalVerificationSuiteIsolation;
  jobs: QueuedGoalVerificationRole[];
}

export async function runGoalVerificationSuite(options: GoalVerificationSuiteOptions): Promise<GoalVerificationSuiteResult> {
  const roles = uniqueRoles(options.roles);
  if (!roles.length) {
    throw new Error("Verification suite requires at least one role.");
  }
  const suiteId = randomId("verify_suite");
  options.store.appendEvent({
    session_id: options.session_id,
    type: "goal.verification.suite.requested",
    data: {
      suite_id: suiteId,
      goal_id: options.goal.id,
      horizon_generation: options.goal.horizon_generation,
      roles,
      source: options.source,
    },
  });
  const results: GoalVerificationSuiteRoleResult[] = [];
  for (const role of roles) {
    const runId = randomId("verify");
    options.store.appendEvent({
      session_id: options.session_id,
      run_id: runId,
      type: "goal.verification.requested",
      data: {
        suite_id: suiteId,
        goal_id: options.goal.id,
        horizon_generation: options.goal.horizon_generation,
        role,
        source: options.source,
      },
    });
    const result = await options.runtime.run({
      prompt: buildGoalVerificationPrompt(options.goal, { role, rubric: options.rubric }),
      session_id: options.session_id,
      run_id: runId,
      client_id: randomId("verify"),
      request_class: "verification",
      visibility: "internal",
    });
    const verification = readGoalLoopView(options.store, options.session_id).verifications.find((record) => record.run_id === result.run_id);
    results.push({
      role,
      run_id: result.run_id,
      tool_rounds: result.tool_rounds,
      tool_calls: result.tool_calls,
      tokens_used: result.tokens_used,
      verification,
      content: result.content,
    });
  }
  options.store.appendEvent({
    session_id: options.session_id,
    type: "goal.verification.suite.completed",
    data: {
      suite_id: suiteId,
      goal_id: options.goal.id,
      horizon_generation: options.goal.horizon_generation,
      roles,
      result_count: results.length,
      verdicts: results.map((result) => ({
        role: result.role,
        run_id: result.run_id,
        verdict: result.verification?.verdict,
        confidence: result.verification?.confidence,
      })),
    },
  });
  return { suite_id: suiteId, roles, results };
}

export async function queueGoalVerificationSuite(options: QueueGoalVerificationSuiteOptions): Promise<QueuedGoalVerificationSuite> {
  const roles = uniqueRoles(options.roles);
  if (!roles.length) {
    throw new Error("Verification suite requires at least one role.");
  }
  const isolation = options.isolation ?? "session";
  const suiteId = randomId("verify_suite");
  const goal = options.goal_state.goal;
  options.store.appendEvent({
    session_id: options.session_id,
    type: "goal.verification.suite.requested",
    data: {
      suite_id: suiteId,
      goal_id: goal.id,
      horizon_generation: goal.horizon_generation,
      roles,
      source: options.source,
      mode: "isolated_queue",
      isolation,
    },
  });
  const jobs: QueuedGoalVerificationRole[] = [];
  for (const role of roles) {
    const child = options.store.createSession(options.workspace, `verify:${role}:${goal.objective.slice(0, 48)}`);
    writeGoalState(options.store, child.session_id, cloneGoalState(options.goal_state));
    const prompt = buildGoalVerificationPrompt(goal, { role, rubric: options.rubric });
    const metadata = verifierJobMetadata({
      config_path: options.config_path,
      suite_id: suiteId,
      role,
      parent_session_id: options.session_id,
      parent_goal_id: goal.id,
      parent_horizon_generation: goal.horizon_generation,
      isolation,
    });
    let worktreeId: string | undefined;
    let workspaceRoot = options.workspace.root;
    if (isolation === "worktree") {
      const worktree = await createLoopWorktree(options.store, options.workspace, {
        metadata: {
          purpose: "verification_suite",
          suite_id: suiteId,
          verifier_role: role,
          parent_session_id: options.session_id,
          parent_goal_id: goal.id,
        },
      });
      const target = loopWorktreeRunTarget(worktree, options.workspace);
      worktreeId = worktree.worktree_id;
      workspaceRoot = target.workspace_root;
      metadata.worktree_id = worktree.worktree_id;
      metadata.worktree_path = worktree.path;
      metadata.worktree_branch = worktree.branch;
      metadata.base_ref = worktree.base_ref;
    }
    const job = options.store.createSupervisorJob(child.session_id, workspaceRoot, prompt, {
      kind: "run",
      goal_id: goal.id,
      metadata,
    });
    if (worktreeId) {
      const current = options.store.getManagedWorktree(worktreeId);
      if (current) {
        options.store.updateManagedWorktree(worktreeId, {
          session_id: child.session_id,
          job_id: job.job_id,
          metadata: { ...current.metadata, session_id: child.session_id, job_id: job.job_id },
        });
      }
    }
    options.store.appendEvent({
      session_id: options.session_id,
      type: "goal.verification.child_session.created",
      data: {
        suite_id: suiteId,
        goal_id: goal.id,
        horizon_generation: goal.horizon_generation,
        role,
        child_session_id: child.session_id,
        job_id: job.job_id,
        isolation,
        worktree_id: worktreeId,
      },
    });
    options.store.appendEvent({
      session_id: child.session_id,
      type: "goal.verification.parent_linked",
      data: {
        suite_id: suiteId,
        parent_session_id: options.session_id,
        parent_goal_id: goal.id,
        horizon_generation: goal.horizon_generation,
        role,
        isolation,
        worktree_id: worktreeId,
      },
    });
    jobs.push({ role, session_id: child.session_id, job_id: job.job_id, worktree_id: worktreeId, workspace_root: workspaceRoot });
  }
  options.store.appendEvent({
    session_id: options.session_id,
    type: "goal.verification.suite.queued",
    data: {
      suite_id: suiteId,
      goal_id: goal.id,
      horizon_generation: goal.horizon_generation,
      roles,
      source: options.source,
      isolation,
      job_count: jobs.length,
      jobs: jobs.map((job) => ({
        role: job.role,
        session_id: job.session_id,
        job_id: job.job_id,
        worktree_id: job.worktree_id,
        workspace_root: job.workspace_root,
      })),
    },
  });
  return { suite_id: suiteId, roles, isolation, jobs };
}

function uniqueRoles(roles: GoalVerifierRole[]): GoalVerifierRole[] {
  const seen = new Set<GoalVerifierRole>();
  const output: GoalVerifierRole[] = [];
  for (const role of roles) {
    if (!seen.has(role)) {
      seen.add(role);
      output.push(role);
    }
  }
  return output;
}

function verifierJobMetadata(input: {
  config_path?: string;
  suite_id: string;
  role: GoalVerifierRole;
  parent_session_id: string;
  parent_goal_id: string;
  parent_horizon_generation: number;
  isolation: GoalVerificationSuiteIsolation;
}): JsonObject {
  const metadata: JsonObject = {
    request_class: "verification",
    skip_goal_supervisor: true,
    suite_id: input.suite_id,
    verifier_role: input.role,
    goal_id: input.parent_goal_id,
    horizon_generation: input.parent_horizon_generation,
    parent_session_id: input.parent_session_id,
    parent_goal_id: input.parent_goal_id,
    parent_horizon_generation: input.parent_horizon_generation,
    isolation: input.isolation,
  };
  if (input.config_path) {
    metadata.config_path = input.config_path;
  }
  return metadata;
}
