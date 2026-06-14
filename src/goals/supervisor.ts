import type { ModelRequest } from "../types.js";
import type { SessionStore } from "../session/store.js";
import { randomId } from "../util/hash.js";
import {
  cloneGoalState,
  completeRepeatGoal,
  consumeRepeatGoalRun,
  completeGoalAfterReflection,
  goalCompletionCandidateBlockMessage,
  goalDurationMs,
  incompleteGoalPlanningSteps,
  isGoalHorizonExhausted,
  loopRuntimeCompletionBlockMessage,
  loopRuntimeRemainingMs,
  meaningfulOpenGoalCandidates,
  markGoalReflectionStarted,
  readGoalState,
  recordGoalCompletionReport,
  repeatGoalRemainingRuns,
  replaceGoalPlanning,
  writeGoalState,
  type GoalCandidate,
  type GoalPlanningInput,
  type GoalState,
} from "./state.js";
import { buildLoopDecisionPrompt, buildLoopExecutionPrompt } from "./supervisor-prompts.js";
import { buildGoalVerificationPrompt } from "./verifier.js";
import { readAutoresearchState, researchCompletionBlockMessage, setAutoresearchMode } from "../autoresearch/state.js";
import { goalVerifierPolicyCompletionBlockMessage, readGoalVerificationRecords } from "../loop/verification.js";

export const DEFAULT_GOAL_SUPERVISOR_MAX_ITERATIONS = 1000;
const AT_LEAST_NO_PROGRESS_RECOVERY_LIMIT = 2;

export interface GoalSupervisorTurnRequest {
  prompt: string;
  requestClass: ModelRequest["request_class"];
  visibility?: "normal" | "internal";
  runId?: string;
  activityLabel?: string;
  suppressTranscript?: boolean;
  renderPrompt?: boolean;
  origin?: "loop";
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
  let consecutiveAtLeastNoProgressTurns = 0;
  for (; iteration < maxIterations; iteration += 1) {
    if (options.shouldContinue && !options.shouldContinue()) {
      return { status: "stopped", iteration };
    }
    const state = readGoalState(options.store, options.sessionId);
    if (!isRunnableGoal(state)) {
      return { status: "idle", iteration, goal_id: goalId(state) };
    }
    options.onIteration?.(iteration + 1);
    if (state.goal.preference === "replay") {
      const remaining = repeatGoalRemainingRuns(state.goal);
      if (remaining <= 0) {
        const runId = randomId("run");
        const saved = writeGoalState(options.store, options.sessionId, completeRepeatGoal(state, "Repeat loop finished."), runId);
        recordGoalCompletionReport(options.store, options.sessionId, runId);
        options.onCompleted?.(saved, runId);
        return { status: "complete", iteration: iteration + 1, run_id: runId, goal_id: saved.goal.id };
      }
      const consumed = consumeRepeatGoalRun(state);
      if (!consumed) {
        return { status: "waiting", iteration: iteration + 1, reason: "repeat loop has no remaining runs", goal_id: state.goal.id };
      }
      writeGoalState(options.store, options.sessionId, consumed);
      const run = await options.runTurn({
        prompt: state.goal.objective,
        requestClass: options.workRequestClass ?? "background",
        activityLabel: repeatGoalActivityLabel(consumed.goal),
        renderPrompt: true,
        origin: "loop",
      });
      if (!run) {
        options.onWaiting?.("repeat loop turn did not complete");
        return { status: "waiting", iteration: iteration + 1, reason: "repeat loop turn did not complete", goal_id: state.goal.id };
      }
      const afterRepeat = readGoalState(options.store, options.sessionId);
      if (!isRunnableGoal(afterRepeat)) {
        return { status: "idle", iteration: iteration + 1, run_id: run.run_id, goal_id: goalId(afterRepeat) };
      }
      if (afterRepeat.goal.preference === "replay" && repeatGoalRemainingRuns(afterRepeat.goal) <= 0) {
        const saved = writeGoalState(options.store, options.sessionId, completeRepeatGoal(afterRepeat, "Repeat loop finished."), run.run_id);
        recordGoalCompletionReport(options.store, options.sessionId, run.run_id);
        options.onCompleted?.(saved, run.run_id);
        return { status: "complete", iteration: iteration + 1, run_id: run.run_id, goal_id: saved.goal.id };
      }
      continue;
    }
    if (isGoalHorizonExhausted(state.goal)) {
      const result = await runGoalReflection(options, state, iteration + 1);
      if (result.status === "waiting") {
        continue;
      }
      return result;
    }
    const workRun = await options.runTurn({
      prompt: buildLoopExecutionPrompt(state.goal),
      requestClass: options.workRequestClass ?? "background",
      activityLabel: goalHorizonActivityLabel("Continuing loop task", state.goal.horizon_generation),
      origin: "loop",
    });
    if (!workRun || !goalProgressUpdatedDuringRun(options.store, options.sessionId, workRun.run_id, state)) {
      const reason = goalWorkNoProgressReason(workRun);
      const latest = readGoalState(options.store, options.sessionId) ?? state;
      if (isAtLeastRuntimePending(latest)) {
        consecutiveAtLeastNoProgressTurns += 1;
        appendAtLeastNoProgressEvent(options, latest, workRun?.run_id, reason, consecutiveAtLeastNoProgressTurns);
        if (workRun && consecutiveAtLeastNoProgressTurns >= AT_LEAST_NO_PROGRESS_RECOVERY_LIMIT) {
          const recoveryReason = `Last ${consecutiveAtLeastNoProgressTurns} execution turns did not update loop state (${reason}). Continue because At least runtime is still pending.`;
          const expanded = expandGoalForRuntimeMinimum(latest, recoveryReason);
          const saved = writeGoalState(options.store, options.sessionId, expanded, workRun.run_id);
          appendRuntimeMinimumExpansionEvent(options, saved, latest, workRun.run_id, recoveryReason);
          options.onReflectionExpanded?.(saved);
          consecutiveAtLeastNoProgressTurns = 0;
        }
        continue;
      }
      options.onWaiting?.(reason);
      return { status: "waiting", iteration: iteration + 1, reason, run_id: workRun?.run_id, goal_id: state.goal.id };
    }
    consecutiveAtLeastNoProgressTurns = 0;
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
    prompt: buildLoopDecisionPrompt(state.goal),
    requestClass: "reflection",
    visibility: "internal",
    runId: reflectionRunId,
    activityLabel: goalHorizonActivityLabel("Reflecting loop task", state.goal.horizon_generation),
    suppressTranscript: true,
    origin: "loop",
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
      const runtimeBlock = loopRuntimeCompletionBlockMessage(reflected.goal);
      if (runtimeBlock) {
        const expanded = expandGoalForRuntimeMinimum(reflected, runtimeBlock);
        const saved = writeGoalState(options.store, options.sessionId, expanded, reflectionRunId);
        appendRuntimeMinimumExpansionEvent(options, saved, reflected, reflectionRunId, runtimeBlock);
        options.onReflectionExpanded?.(saved);
        return { status: "waiting", iteration, reason: "expanded_for_runtime_minimum", run_id: reflectionRunId, goal_id: saved.goal.id };
      }
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
      if (reflected.goal.preference === "discover") {
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
            if (saved.goal.preference === "discover") {
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
      if (saved.goal.preference === "discover") {
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
  const firstRun = await options.runTurn({
    prompt: buildGoalVerificationPrompt(state.goal, { role: "completion", rubric: reason }),
    requestClass: "verification",
    visibility: "internal",
    runId,
    activityLabel: goalHorizonActivityLabel("Verifying loop task", state.goal.horizon_generation),
    suppressTranscript: true,
  });
  if (!firstRun || hasCompletionVerifierPass(options.store, options.sessionId, state.goal)) {
    return firstRun;
  }
  if (options.shouldContinue && !options.shouldContinue()) {
    return undefined;
  }
  const retryRunId = randomId("verify");
  options.store.appendEvent({
    session_id: options.sessionId,
    run_id: retryRunId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      supervisor: options.supervisor,
      reason: "completion verifier did not record a checker verdict",
      retry_of_run_id: firstRun.run_id,
      role: "completion",
    },
  });
  return await options.runTurn({
    prompt: buildGoalVerificationRetryPrompt(state, reason),
    requestClass: "verification",
    visibility: "internal",
    runId: retryRunId,
    activityLabel: goalHorizonActivityLabel("Verifying loop task", state.goal.horizon_generation),
    suppressTranscript: true,
  });
}

function hasCompletionVerifierPass(store: SessionStore, sessionId: string, goal: GoalState["goal"]): boolean {
  return readGoalVerificationRecords(store, sessionId, goal.id).some((record) => {
    return record.horizon_generation === goal.horizon_generation
      && record.verdict === "pass"
      && (record.provider === "checker" || record.provider === "command" || record.provider === "human");
  });
}

function buildGoalVerificationRetryPrompt(state: GoalState, reason: string): string {
  return [
    buildGoalVerificationPrompt(state.goal, { role: "completion", rubric: reason }),
    "",
    "Verifier retry: the previous checker turn inspected state but did not record a verdict.",
    "Do not call goal get first. Call goal op=verify exactly once now with provider=checker, verdict, confidence, summary, and concrete evidence or failure_reason.",
  ].join("\n");
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

function isAtLeastRuntimePending(state: GoalState | undefined): state is GoalState {
  if (!state || state.goal.preference === "replay") {
    return false;
  }
  return (loopRuntimeRemainingMs(state.goal) ?? 0) > 0;
}

function repeatGoalActivityLabel(goal: GoalState["goal"]): string {
  const target = goal.replay?.target_attempts ?? 1;
  const remaining = repeatGoalRemainingRuns(goal);
  const current = Math.max(1, target - remaining);
  return `Repeating loop ${current}/${target}`;
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

function appendRuntimeMinimumExpansionEvent(
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
      reason: "runtime_minimum",
      blocked_completion: blockedCompletion,
      elapsed_ms: goalDurationMs(saved.goal),
      min_duration_ms: saved.goal.runtime_policy.mode === "at_least" ? saved.goal.runtime_policy.min_duration_ms : undefined,
      remaining_ms: loopRuntimeRemainingMs(saved.goal),
    },
  });
}

function appendAtLeastNoProgressEvent(
  options: GoalSupervisorOptions,
  state: GoalState,
  runId: string | undefined,
  reason: string,
  consecutive: number,
): void {
  options.store.appendEvent({
    session_id: options.sessionId,
    run_id: runId,
    type: "goal.runtime.no_progress",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      reason,
      consecutive,
      elapsed_ms: goalDurationMs(state.goal),
      min_duration_ms: state.goal.runtime_policy.mode === "at_least" ? state.goal.runtime_policy.min_duration_ms : undefined,
      remaining_ms: loopRuntimeRemainingMs(state.goal),
      supervisor: options.supervisor,
    },
  });
}

function expandGoalFromLedgerCandidates(state: GoalState): GoalState | undefined {
  const goal = state.goal;
  if (!goal.ledger || goal.preference === "replay") {
    return undefined;
  }
  const candidates = nextHorizonCandidates(goal);
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

function expandGoalForRuntimeMinimum(state: GoalState, blockedCompletion: string): GoalState {
  const goal = state.goal;
  const next = cloneGoalState(state);
  next.goal.horizon_generation += 1;
  const planned = replaceGoalPlanning(next, runtimeMinimumPlanningInput(goal, next.goal.horizon_generation, blockedCompletion));
  planned.enabled = true;
  planned.goal.status = "active";
  return planned;
}

function runtimeMinimumPlanningInput(goal: GoalState["goal"], generation: number, blockedCompletion: string): GoalPlanningInput {
  const remaining = loopRuntimeRemainingMs(goal);
  const remainingNote = remaining === undefined ? "runtime minimum is still pending" : `${remaining}ms of minimum runtime remains`;
  const candidates = nextHorizonCandidates(goal).slice(0, 3);
  const frontier = candidates.map((candidate) => `${candidate.value}: ${candidate.title}`).join("; ");
  const frontierNote = frontier ? ` Existing unresolved frontier: ${frontier}.` : "";
  const notes = `${blockedCompletion} Continue because At least runtime is a lower bound, not a stop timer; ${remainingNote}.${frontierNote}`;
  if (candidates.length > 0) {
    return runtimeCandidatePlanningInput(goal, generation, notes, candidates);
  }
  if (goal.preference === "discover") {
    return runtimeSurfacePlanningInput(generation, notes, RUNTIME_DISCOVER_SURFACES, "Research continuation");
  }
  return runtimeSurfacePlanningInput(generation, notes, RUNTIME_DELIVER_SURFACES, "Runtime continuation");
}

const RUNTIME_DELIVER_SURFACES = [
  {
    label: "external input and auth boundaries",
    examples: "APIs, request parsing, authz/authn assumptions, SSRF, injection, uploads, and user-controlled identifiers.",
  },
  {
    label: "persistence, file paths, and secret handling",
    examples: "storage paths, config rollback, credentials, logs, cache keys, database writes, and cleanup paths.",
  },
  {
    label: "network and integration trust boundaries",
    examples: "proxying, gRPC/TLS, webhooks, operator-runtime integrations, telemetry, and cross-service defaults.",
  },
  {
    label: "deployment, operator, and runtime defaults",
    examples: "Helm values, Kubernetes security context, OpenShift behavior, environment defaults, and rollback safety.",
  },
  {
    label: "tests, CI, error paths, and regression coverage",
    examples: "missing regression tests, negative cases, build coverage, lint/AST checks, and failure-mode handling.",
  },
];

const RUNTIME_DISCOVER_SURFACES = [
  {
    label: "benchmark design and controls",
    examples: "metrics, baselines, ablations, reproducibility, sampling, and failure criteria.",
  },
  {
    label: "alternative hypotheses",
    examples: "competing explanations, rejected branches, counterexamples, and uncertainty reduction.",
  },
  {
    label: "evidence quality and generalization",
    examples: "dataset coverage, edge cases, sensitivity checks, confounders, and robustness checks.",
  },
  {
    label: "implementation implications",
    examples: "prototype changes, integration paths, guardrails, rollout risk, and measurement hooks.",
  },
];

function runtimeCandidatePlanningInput(
  goal: GoalState["goal"],
  generation: number,
  notes: string,
  candidates: GoalCandidate[],
): GoalPlanningInput {
  const verb = goal.preference === "discover" ? "Investigate frontier" : "Resolve frontier";
  const steps: GoalPlanningInput["steps"] = candidates.map((candidate, index) => ({
    id: `runtime_frontier_${generation}_${index + 1}_${goalStepSlug(candidate.id || candidate.title)}`,
    title: `${verb}: ${candidate.title}`,
    status: "pending",
    notes: candidateNotes(candidate, index === 0 ? notes : undefined),
  }));
  steps.push({
    id: `runtime_verify_frontier_${generation}`,
    title: "Verify frontier outcomes and update ledger",
    status: "pending",
    notes: "Run targeted checks, reconcile stale open/done/rejected candidates, and leave concrete evidence for the next decision.",
  });
  return {
    summary: `Loop task ${generation} · Frontier continuation`,
    active_step_id: steps[0]?.id ?? `runtime_verify_frontier_${generation}`,
    steps,
  };
}

function runtimeSurfacePlanningInput(
  generation: number,
  notes: string,
  surfaces: Array<{ label: string; examples: string }>,
  summaryKind: string,
): GoalPlanningInput {
  const surface = surfaces[Math.abs(generation - 1) % surfaces.length] ?? {
    label: "workspace risk surface",
    examples: "uninspected modules, tests, integrations, configuration, and user-visible behavior.",
  };
  const surfaceId = goalStepSlug(surface.label);
  return {
    summary: `Loop task ${generation} · ${summaryKind}: ${surface.label}`,
    active_step_id: `runtime_surface_${generation}_${surfaceId}`,
    steps: [
      {
        id: `runtime_surface_${generation}_${surfaceId}`,
        title: `Audit ${surface.label}`,
        status: "pending",
        notes: `${notes} Focus surface: ${surface.examples}`,
      },
      {
        id: `runtime_act_${generation}_${surfaceId}`,
        title: `Act on findings from ${surface.label}`,
        status: "pending",
        notes: "Implement, document, reject with evidence, or add ledger candidates for concrete findings from this surface.",
      },
      {
        id: `runtime_verify_${generation}_${surfaceId}`,
        title: `Verify ${surface.label}`,
        status: "pending",
        notes: "Run, add, or justify focused verification that can raise confidence in end-to-end completion.",
      },
      {
        id: `runtime_update_frontier_${generation}`,
        title: "Update frontier and prepare the next decision",
        status: "pending",
        notes: "Reconcile stale candidates, record completed evidence, and leave concrete next steps or closure evidence for the decision turn.",
      },
    ],
  };
}

function candidateNotes(candidate: GoalCandidate, prefix?: string): string {
  return [
    prefix,
    `${candidate.value} value frontier.`,
    candidate.source ? `Source: ${candidate.source}.` : undefined,
    candidate.reason ? `Reason: ${candidate.reason}.` : undefined,
    "Resolve it with implementation, verification, rejection evidence, or a narrower follow-up candidate.",
  ].filter((part): part is string => Boolean(part)).join(" ");
}

function goalStepSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || "frontier";
}

function nextHorizonCandidates(goal: GoalState["goal"]): GoalCandidate[] {
  return meaningfulOpenGoalCandidates(goal)
    .filter((candidate) => candidate.value === "high" || candidate.value === "medium")
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
