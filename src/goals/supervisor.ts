import type { ModelRequest } from "../types.js";
import type { SessionStore } from "../session/store.js";
import { randomId } from "../util/hash.js";
import {
  cloneGoalState,
  completeGoalAfterReflection,
  goalCompletionCandidateBlockMessage,
  goalDurationMs,
  incompleteGoalPlanningSteps,
  isGoalHorizonExhausted,
  markGoalReflectionStarted,
  readGoalState,
  recordGoalCompletionReport,
  replaceGoalPlanning,
  writeGoalState,
  type GoalCandidate,
  type GoalState,
} from "./state.js";
import { buildGoalReflectionPrompt, buildGoalWorkPrompt } from "./supervisor-prompts.js";
import { buildGoalVerificationPrompt } from "./verifier.js";
import { readAutoresearchState, researchCompletionBlockMessage, setAutoresearchMode } from "../autoresearch/state.js";
import { goalVerifierPolicyCompletionBlockMessage } from "../loop/verification.js";

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
  content?: string;
  tool_calls?: number;
  tool_rounds?: number;
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
  autoVerifyCompletion?: boolean;
  shouldContinue?: () => boolean;
  runTurn: (request: GoalSupervisorTurnRequest) => Promise<GoalSupervisorTurnResult | undefined>;
  onIteration?: (iteration: number) => void;
  onReflectionExpanded?: (state: GoalState) => void;
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
    if (isGoalHorizonExhausted(state.goal)) {
      const result = await runGoalReflection(options, state, iteration + 1);
      if (result.status === "waiting") {
        continue;
      }
      return result;
    }
    const workRun = await options.runTurn({
      prompt: buildGoalWorkPrompt(state.goal),
      requestClass: options.workRequestClass ?? "background",
      activityLabel: goalHorizonActivityLabel("Continuing loop task", state.goal.horizon_generation),
    });
    if (!workRun || !goalProgressUpdatedDuringRun(options.store, options.sessionId, workRun.run_id, state)) {
      const reason = goalWorkNoProgressReason(workRun);
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

async function runGoalReflection(options: GoalSupervisorOptions, state: GoalState, iteration: number): Promise<GoalSupervisorResult> {
  const reflectionRunId = randomId("run");
  writeGoalState(options.store, options.sessionId, markGoalReflectionStarted(state, reflectionRunId), reflectionRunId);
  options.store.appendEvent({
    session_id: options.sessionId,
    run_id: reflectionRunId,
    type: "goal.reflection.started",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      supervisor: options.supervisor,
    },
  });
  const reflectionRun = await options.runTurn({
    prompt: buildGoalReflectionPrompt(state.goal),
    requestClass: "reflection",
    visibility: "internal",
    runId: reflectionRunId,
    activityLabel: goalHorizonActivityLabel("Reflecting loop task", state.goal.horizon_generation),
    suppressTranscript: true,
  });
  const reflected = readGoalState(options.store, options.sessionId);
  if (!reflected || reflected.goal.status === "complete" || reflected.goal.status === "dropped") {
    return { status: "idle", iteration, run_id: reflectionRun?.run_id ?? reflectionRunId, goal_id: reflected?.goal.id };
  }
  if (!isCompletedReflectionForRun(reflected, reflectionRunId)) {
    const paused = pauseGoal(options, reflected, reflectionRunId, "reflection_missing_decision");
    return { status: "paused", iteration, reason: "reflection_missing_decision", run_id: reflectionRunId, goal_id: paused.goal.id };
  }
  if (reflected.goal.pending_review_decision) {
    options.onPaused?.(reflected, reflectionRunId, "goal_review_pending");
    return { status: "paused", iteration, reason: "goal_review_pending", run_id: reflectionRunId, goal_id: reflected.goal.id };
  }
  if (reflected.goal.last_reflection_decision === "expand") {
    options.onReflectionExpanded?.(reflected);
    return { status: "waiting", iteration, reason: "expanded", run_id: reflectionRunId, goal_id: reflected.goal.id };
  }
  // Reflection deliberately has no ambiguous continue state: new work must be
  // concrete and substantively tied to the original objective, otherwise done.
  if (reflected.goal.last_reflection_decision === "done") {
    try {
      const candidateBlock = goalCompletionCandidateBlockMessage(reflected.goal);
      if (candidateBlock) {
        const expanded = expandGoalFromLedgerCandidates(reflected);
        if (expanded) {
          const saved = writeGoalState(options.store, options.sessionId, expanded, reflectionRunId);
          appendLedgerExpansionEvent(options, saved, reflected, reflectionRunId, candidateBlock);
          options.onReflectionExpanded?.(saved);
          return { status: "waiting", iteration, reason: "expanded_from_ledger", run_id: reflectionRunId, goal_id: saved.goal.id };
        }
        const paused = pauseGoal(options, reflected, reflectionRunId, candidateBlock);
        return { status: "paused", iteration, reason: candidateBlock, run_id: reflectionRunId, goal_id: paused.goal.id };
      }
      if (reflected.goal.kind === "research") {
        const researchBlock = researchCompletionBlockMessage(readAutoresearchState(options.store, options.sessionId));
        if (researchBlock) {
          const paused = pauseGoal(options, reflected, reflectionRunId, researchBlock);
          return { status: "paused", iteration, reason: researchBlock, run_id: reflectionRunId, goal_id: paused.goal.id };
        }
      }
      const verifierBlock = goalVerifierPolicyCompletionBlockMessage(options.store, options.sessionId, reflected.goal, {
        request_class: options.workRequestClass ?? "background",
      });
      if (verifierBlock) {
        if (options.autoVerifyCompletion) {
          const verificationRun = await runGoalCompletionVerifier(options, reflected, verifierBlock);
          if (!verificationRun) {
            return { status: "stopped", iteration, reason: "verification_cancelled", goal_id: reflected.goal.id };
          }
          const afterVerificationBlock = goalVerifierPolicyCompletionBlockMessage(options.store, options.sessionId, reflected.goal, {
            request_class: options.workRequestClass ?? "background",
          });
          if (!afterVerificationBlock) {
            const completed = completeGoalAfterReflection(reflected, reflected.goal.last_reflection_summary);
            const saved = writeGoalState(options.store, options.sessionId, completed, reflectionRunId);
            if (saved.goal.kind === "research") {
              setAutoresearchMode(options.store, options.sessionId, { mode: "off", goal: saved.goal.objective }, reflectionRunId);
            }
            recordGoalCompletionReport(options.store, options.sessionId, reflectionRunId);
            options.onCompleted?.(saved, reflectionRunId);
            return { status: "complete", iteration, run_id: verificationRun.run_id, goal_id: saved.goal.id };
          }
          const paused = pauseGoal(options, reflected, verificationRun.run_id, afterVerificationBlock);
          return { status: "paused", iteration, reason: afterVerificationBlock, run_id: verificationRun.run_id, goal_id: paused.goal.id };
        }
        const paused = pauseGoal(options, reflected, reflectionRunId, verifierBlock);
        return { status: "paused", iteration, reason: verifierBlock, run_id: reflectionRunId, goal_id: paused.goal.id };
      }
      const completed = completeGoalAfterReflection(reflected, reflected.goal.last_reflection_summary);
      const saved = writeGoalState(options.store, options.sessionId, completed, reflectionRunId);
      if (saved.goal.kind === "research") {
        setAutoresearchMode(options.store, options.sessionId, { mode: "off", goal: saved.goal.objective }, reflectionRunId);
      }
      recordGoalCompletionReport(options.store, options.sessionId, reflectionRunId);
      options.onCompleted?.(saved, reflectionRunId);
      return { status: "complete", iteration, run_id: reflectionRunId, goal_id: saved.goal.id };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const expanded = expandGoalFromLedgerCandidates(reflected);
      if (expanded) {
        const saved = writeGoalState(options.store, options.sessionId, expanded, reflectionRunId);
        appendLedgerExpansionEvent(options, saved, reflected, reflectionRunId, reason);
        options.onReflectionExpanded?.(saved);
        return { status: "waiting", iteration, reason: "expanded_from_ledger", run_id: reflectionRunId, goal_id: saved.goal.id };
      }
      const paused = pauseGoal(options, reflected, reflectionRunId, reason);
      return { status: "paused", iteration, reason, run_id: reflectionRunId, goal_id: paused.goal.id };
    }
  }
  const reason = reflected.goal.blocker ?? reflected.goal.last_reflection_decision ?? "reflection_decision";
  const paused = pauseGoal(options, reflected, reflectionRunId, reason);
  return {
    status: reflected.goal.last_reflection_decision === "blocked" ? "blocked" : "paused",
    iteration,
    reason,
    run_id: reflectionRunId,
    goal_id: paused.goal.id,
  };
}

async function runGoalCompletionVerifier(
  options: GoalSupervisorOptions,
  state: GoalState,
  reason: string,
): Promise<GoalSupervisorTurnResult | undefined> {
  if (options.shouldContinue && !options.shouldContinue()) {
    return undefined;
  }
  const runId = randomId("verify");
  options.store.appendEvent({
    session_id: options.sessionId,
    run_id: runId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      supervisor: options.supervisor,
      reason,
      role: "completion",
    },
  });
  return await options.runTurn({
    prompt: buildGoalVerificationPrompt(state.goal, { role: "completion", rubric: reason }),
    requestClass: "verification",
    visibility: "internal",
    runId,
    activityLabel: goalHorizonActivityLabel("Verifying loop task", state.goal.horizon_generation),
    suppressTranscript: true,
  });
}

function isRunnableGoal(state: GoalState | undefined): state is GoalState {
  return Boolean(state?.enabled && state.goal.status === "active");
}

function goalId(state: GoalState | undefined): string | undefined {
  return state?.goal.id;
}

function goalHorizonActivityLabel(prefix: string, generation: number): string {
  return `${prefix} ${generation}`;
}

function isCompletedReflectionForRun(state: GoalState, reflectionRunId: string): boolean {
  return state.goal.last_reflection_run_id === reflectionRunId && state.goal.reflection_status === "completed";
}

function appendLedgerExpansionEvent(
  options: GoalSupervisorOptions,
  saved: GoalState,
  previous: GoalState,
  runId: string,
  blockedCompletion: string,
): void {
  options.store.appendEvent({
    session_id: options.sessionId,
    run_id: runId,
    type: "goal.horizon.expanded",
    data: {
      goal_id: saved.goal.id,
      previous_horizon_generation: previous.goal.horizon_generation,
      horizon_generation: saved.goal.horizon_generation,
      step_count: saved.goal.planning?.steps.length ?? 0,
      active_step_id: saved.goal.planning?.active_step_id,
      reason: "completion_gate",
      blocked_completion: blockedCompletion,
    },
  });
}

function expandGoalFromLedgerCandidates(state: GoalState): GoalState | undefined {
  const goal = state.goal;
  const strategy = goal.strategy;
  if (!goal.ledger || strategy?.mode === "surgical") {
    return undefined;
  }
  if (strategy?.mode === "campaign" && strategy.target_hours !== undefined && goalDurationMs(goal) >= strategy.target_hours * 60 * 60 * 1000) {
    return undefined;
  }
  const candidates = nextHorizonCandidates(goal.ledger.open, strategy?.mode ?? "opportunistic");
  if (!candidates.length) {
    return undefined;
  }
  const next = cloneGoalState(state);
  next.goal.horizon_generation += 1;
  const planned = replaceGoalPlanning(next, {
    summary: `Loop task ${next.goal.horizon_generation} · Candidate work`,
    active_step_id: candidates[0]?.id,
    steps: candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      status: "pending",
      notes: candidate.reason ?? candidate.source,
      evidence: candidate.evidence,
    })),
  });
  planned.enabled = true;
  planned.goal.status = "active";
  return planned;
}

function nextHorizonCandidates(candidates: GoalCandidate[], mode: "opportunistic" | "campaign" | undefined): GoalCandidate[] {
  const eligible = mode === "campaign" ? candidates : candidates.filter((candidate) => candidate.value === "high" || candidate.value === "medium");
  return eligible
    .slice()
    .sort((a, b) => candidateValueRank(b.value) - candidateValueRank(a.value))
    .slice(0, 5);
}

function candidateValueRank(value: GoalCandidate["value"]): number {
  switch (value) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

function goalProgressUpdatedDuringRun(store: SessionStore, sessionId: string, runId: string, before: GoalState): boolean {
  return store.listEvents(sessionId).some((event) => {
    if (event.run_id !== runId || event.type !== "goal.updated") {
      return false;
    }
    const after = eventGoalState(event.data);
    return Boolean(after && after.goal.id === before.goal.id && structuralGoalSnapshot(after) !== structuralGoalSnapshot(before));
  });
}

function goalWorkNoProgressReason(workRun: GoalSupervisorTurnResult | undefined): string {
  if (!workRun) {
    return "goal turn did not complete";
  }
  const hasRuntimeResultShape = workRun.content !== undefined || workRun.tool_calls !== undefined || workRun.tool_rounds !== undefined;
  if (hasRuntimeResultShape && (workRun.content ?? "").trim() === "" && (workRun.tool_calls ?? 0) === 0 && (workRun.tool_rounds ?? 0) === 0) {
    return "model returned an empty loop turn; no loop task progress was recorded";
  }
  return "last supervisor turn did not update the loop task";
}

function eventGoalState(data: unknown): GoalState | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const state = data as Partial<GoalState>;
  const goal = state.goal;
  if (!goal || typeof goal !== "object" || Array.isArray(goal) || !("id" in goal)) {
    return undefined;
  }
  return state as GoalState;
}

function structuralGoalSnapshot(state: GoalState): string {
  return JSON.stringify(stripGoalAccounting(state));
}

function stripGoalAccounting(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripGoalAccounting);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (GOAL_ACCOUNTING_KEYS.has(key)) {
      continue;
    }
    out[key] = stripGoalAccounting(item);
  }
  return out;
}

const GOAL_ACCOUNTING_KEYS = new Set([
  "tokens_used",
  "time_used_ms",
  "time_used_seconds",
  "tool_rounds_used",
  "tool_calls_used",
  "updated_at",
]);

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
