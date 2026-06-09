import type { ModelRequest } from "../types.js";
import type { SessionStore } from "../session/store.js";
import { randomId } from "../util/hash.js";
import {
  cloneGoalState,
  completeGoalAfterAudit,
  incompleteGoalPlanningSteps,
  isGoalFrontierExhausted,
  markGoalAuditStarted,
  readGoalState,
  recordGoalCompletionReport,
  writeGoalState,
  type GoalState,
} from "./state.js";
import { buildGoalAuditPrompt, buildGoalWorkPrompt } from "./supervisor-prompts.js";

export const DEFAULT_GOAL_SUPERVISOR_MAX_ITERATIONS = 1000;

export interface GoalSupervisorTurnRequest {
  prompt: string;
  requestClass: ModelRequest["request_class"];
  visibility?: "normal" | "internal";
  runId?: string;
  activityLabel?: string;
  suppressTranscript?: boolean;
}

export interface GoalSupervisorTurnResult {
  run_id: string;
}

export type GoalSupervisorStatus = "idle" | "complete" | "paused" | "blocked" | "waiting" | "max_iterations" | "stopped";

export interface GoalSupervisorResult {
  status: GoalSupervisorStatus;
  iteration: number;
  reason?: string;
  run_id?: string;
  goal_id?: string;
}

export interface GoalSupervisorOptions {
  store: SessionStore;
  sessionId: string;
  supervisor: string;
  maxIterations?: number;
  workRequestClass?: ModelRequest["request_class"];
  shouldContinue?: () => boolean;
  runTurn: (request: GoalSupervisorTurnRequest) => Promise<GoalSupervisorTurnResult | undefined>;
  onIteration?: (iteration: number) => void;
  onAuditExpanded?: (state: GoalState) => void;
  onCompleted?: (state: GoalState, runId: string) => void;
  onPaused?: (state: GoalState, runId: string | undefined, reason: string) => void;
  onWaiting?: (reason: string) => void;
}

export async function runGoalSupervisor(options: GoalSupervisorOptions): Promise<GoalSupervisorResult> {
  const maxIterations = Math.max(1, Math.trunc(options.maxIterations ?? DEFAULT_GOAL_SUPERVISOR_MAX_ITERATIONS));
  let iteration = 0;
  for (; iteration < maxIterations; iteration += 1) {
    if (options.shouldContinue && !options.shouldContinue()) {
      return { status: "stopped", iteration };
    }
    const state = readGoalState(options.store, options.sessionId);
    if (!isRunnableGoal(state)) {
      return { status: "idle", iteration, goal_id: goalId(state) };
    }
    options.onIteration?.(iteration + 1);
    if (isGoalFrontierExhausted(state.goal)) {
      const result = await runGoalAudit(options, state, iteration + 1);
      if (result.status === "waiting") {
        continue;
      }
      return result;
    }
    const workRun = await options.runTurn({
      prompt: buildGoalWorkPrompt(state.goal.objective),
      requestClass: options.workRequestClass ?? "background",
      activityLabel: "Continuing goal frontier",
    });
    if (!workRun || !goalUpdatedDuringRun(options.store, options.sessionId, workRun.run_id)) {
      const reason = "last supervisor turn did not update the frontier";
      options.onWaiting?.(reason);
      return { status: "waiting", iteration: iteration + 1, reason, run_id: workRun?.run_id, goal_id: state.goal.id };
    }
    const afterWork = readGoalState(options.store, options.sessionId);
    if (afterWork && afterWork.goal.planning && incompleteGoalPlanningSteps(afterWork.goal).length === 0) {
      continue;
    }
  }
  const state = readGoalState(options.store, options.sessionId);
  if (isRunnableGoal(state)) {
    const paused = pauseGoal(options, state, undefined, "max_iterations");
    return { status: "max_iterations", iteration, reason: "max_iterations", goal_id: paused.goal.id };
  }
  return { status: "idle", iteration, goal_id: goalId(state) };
}

async function runGoalAudit(options: GoalSupervisorOptions, state: GoalState, iteration: number): Promise<GoalSupervisorResult> {
  const auditRunId = randomId("run");
  writeGoalState(options.store, options.sessionId, markGoalAuditStarted(state, auditRunId), auditRunId);
  options.store.appendEvent({
    session_id: options.sessionId,
    run_id: auditRunId,
    type: "goal.audit.started",
    data: {
      goal_id: state.goal.id,
      frontier_generation: state.goal.frontier_generation,
      supervisor: options.supervisor,
    },
  });
  const auditRun = await options.runTurn({
    prompt: buildGoalAuditPrompt(state.goal.objective),
    requestClass: "audit",
    visibility: "internal",
    runId: auditRunId,
    activityLabel: "Auditing goal frontier",
    suppressTranscript: true,
  });
  const audited = readGoalState(options.store, options.sessionId);
  if (!audited || audited.goal.status === "complete" || audited.goal.status === "dropped") {
    return { status: "idle", iteration, run_id: auditRun?.run_id ?? auditRunId, goal_id: audited?.goal.id };
  }
  if (!isCompletedAuditForRun(audited, auditRunId)) {
    const paused = pauseGoal(options, audited, auditRunId, "audit_missing_decision");
    return { status: "paused", iteration, reason: "audit_missing_decision", run_id: auditRunId, goal_id: paused.goal.id };
  }
  if (audited.goal.last_audit_decision === "expand") {
    options.onAuditExpanded?.(audited);
    return { status: "waiting", iteration, reason: "expanded", run_id: auditRunId, goal_id: audited.goal.id };
  }
  if (audited.goal.last_audit_decision === "done") {
    try {
      const completed = completeGoalAfterAudit(audited, audited.goal.last_audit_summary);
      const saved = writeGoalState(options.store, options.sessionId, completed, auditRunId);
      recordGoalCompletionReport(options.store, options.sessionId, auditRunId);
      options.onCompleted?.(saved, auditRunId);
      return { status: "complete", iteration, run_id: auditRunId, goal_id: saved.goal.id };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const paused = pauseGoal(options, audited, auditRunId, reason);
      return { status: "paused", iteration, reason, run_id: auditRunId, goal_id: paused.goal.id };
    }
  }
  const reason = audited.goal.blocker ?? audited.goal.last_audit_decision ?? "audit_decision";
  const paused = pauseGoal(options, audited, auditRunId, reason);
  return {
    status: audited.goal.last_audit_decision === "blocked" ? "blocked" : "paused",
    iteration,
    reason,
    run_id: auditRunId,
    goal_id: paused.goal.id,
  };
}

function isRunnableGoal(state: GoalState | undefined): state is GoalState {
  return Boolean(state?.enabled && state.goal.status === "active");
}

function goalId(state: GoalState | undefined): string | undefined {
  return state?.goal.id;
}

function isCompletedAuditForRun(state: GoalState, auditRunId: string): boolean {
  return state.goal.last_audit_run_id === auditRunId && state.goal.audit_status === "completed";
}

function goalUpdatedDuringRun(store: SessionStore, sessionId: string, runId: string): boolean {
  return store.listEvents(sessionId).some((event) => event.run_id === runId && event.type === "goal.updated");
}

function pauseGoal(options: GoalSupervisorOptions, state: GoalState, runId: string | undefined, reason: string): GoalState {
  const next = cloneGoalState(state);
  next.enabled = false;
  next.goal.status = "paused";
  next.goal.blocker = reason;
  next.goal.updated_at = new Date().toISOString();
  const saved = writeGoalState(options.store, options.sessionId, next, runId);
  options.store.appendEvent({
    session_id: options.sessionId,
    run_id: runId,
    type: "goal.supervisor.paused",
    data: { goal_id: state.goal.id, reason, supervisor: options.supervisor },
  });
  options.onPaused?.(saved, runId, reason);
  return saved;
}
