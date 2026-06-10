import type { JsonObject, ModelUsage, SessionEvent } from "../types.js";
import { SessionStore } from "../session/store.js";
import { randomId } from "../util/hash.js";
import { truncateText } from "../util/limit.js";

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";
export type GoalStepStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";
export type GoalReflectionDecision = "expand" | "done" | "blocked";
export type GoalReflectionStatus = "running" | "completed";
export type GoalStrategyMode = "surgical" | "opportunistic" | "campaign";
export type GoalCandidateValue = "high" | "medium" | "low";
export type GoalCandidateStatus = "open" | "done" | "rejected";

const PLAN_PROMPT_BODY_LIMIT = 6000;

export interface GoalRecord {
  id: string;
  objective: string;
  status: GoalStatus;
  token_budget?: number;
  tokens_used: number;
  time_used_ms: number;
  time_used_seconds: number;
  tool_rounds_used: number;
  tool_calls_used: number;
  horizon_generation: number;
  strategy?: GoalStrategy;
  ledger?: GoalLedger;
  reflection_status?: GoalReflectionStatus;
  last_reflection_run_id?: string;
  last_reflection_decision?: GoalReflectionDecision;
  last_reflection_summary?: string;
  verification_evidence?: JsonObject;
  blocker?: string;
  planning?: GoalPlanningState;
  plan?: GoalPlanSnapshot;
  summary?: string;
  created_at: string;
  updated_at: string;
}

export interface GoalStrategy {
  mode: GoalStrategyMode;
  inferred: boolean;
  target_hours?: number;
  rationale?: string;
}

export interface GoalLedger {
  open: GoalCandidate[];
  done: GoalCandidate[];
  rejected: GoalCandidate[];
  updated_at: string;
}

export interface GoalCandidate {
  id: string;
  title: string;
  source?: string;
  value: GoalCandidateValue;
  status: GoalCandidateStatus;
  reason?: string;
  evidence?: JsonObject;
  updated_at: string;
}

export interface GoalPlanningState {
  summary?: string;
  active_step_id?: string;
  steps: GoalPlanningStep[];
  updated_at: string;
}

export interface GoalPlanningStep {
  id: string;
  title: string;
  status: GoalStepStatus;
  notes?: string;
  evidence?: JsonObject;
  updated_at: string;
}

export interface GoalHorizonSnapshot {
  generation: number;
  title?: string;
  summary?: string;
  active_step_id?: string;
  steps: GoalPlanningStep[];
  updated_at: string;
  current: boolean;
}

export interface GoalReflectionSnapshot {
  generation: number;
  next_generation?: number;
  run_id?: string;
  decision: GoalReflectionDecision;
  summary?: string;
  blocker?: string;
  verification_evidence?: JsonObject;
  created_at: string;
}

export interface GoalPlanningInput {
  summary?: string;
  active_step_id?: string;
  steps: GoalPlanningStepInput[];
}

export interface GoalPlanningStepInput {
  id?: string;
  title: string;
  status?: GoalStepStatus;
  notes?: string;
  evidence?: JsonObject;
}

export interface GoalStepUpdateInput {
  step_id: string;
  title?: string;
  status?: GoalStepStatus;
  notes?: string;
  evidence?: JsonObject;
  active_step_id?: string;
}

export interface GoalReflectionInput {
  decision: GoalReflectionDecision;
  summary?: string;
  verification_evidence?: JsonObject;
  blocker?: string;
  steps?: GoalPlanningStepInput[];
  active_step_id?: string;
}

export interface GoalPlanSnapshot {
  id: string;
  objective: string;
  summary?: string;
  body?: string;
  approved_at: string;
}

export interface GoalState {
  enabled: boolean;
  goal: GoalRecord;
}

export interface GoalCompletionReport {
  objective: string;
  report: string;
}

export interface GoalCreateInput {
  objective: string;
  token_budget?: number;
  strategy?: GoalStrategyInput;
}

export interface GoalStrategyInput {
  mode: GoalStrategyMode;
  inferred?: boolean;
  target_hours?: number;
  rationale?: string;
}

export interface GoalLedgerInput {
  open?: GoalCandidateInput[];
  done?: GoalCandidateInput[];
  rejected?: GoalCandidateInput[];
}

export interface GoalCandidateInput {
  id?: string;
  title: string;
  source?: string;
  value?: GoalCandidateValue;
  status?: GoalCandidateStatus;
  reason?: string;
  evidence?: JsonObject;
}

export function readGoalState(store: SessionStore, sessionId: string): GoalState | undefined {
  const event = latestGoalEvent(store.listEvents(sessionId));
  if (!event) {
    return undefined;
  }
  return parseGoalState(event.data);
}

export function readGoalHorizons(store: SessionStore, sessionId: string, goalId?: string): GoalHorizonSnapshot[] {
  const events = store.listEvents(sessionId).filter((event) => event.type === "goal.updated");
  const latest = readGoalState(store, sessionId)?.goal;
  const targetGoalId = goalId ?? latest?.id;
  if (!targetGoalId) {
    return [];
  }
  const byGeneration = new Map<number, GoalHorizonSnapshot>();
  for (const event of events) {
    const state = parseGoalState(event.data);
    const goal = state?.goal;
    if (!goal || goal.id !== targetGoalId || !goal.planning) {
      continue;
    }
    byGeneration.set(goal.horizon_generation, {
      generation: goal.horizon_generation,
      title: goalHorizonTitle(goal.horizon_generation, goal.planning.summary),
      summary: goal.planning.summary,
      active_step_id: goal.planning.active_step_id,
      steps: cloneGoalPlanning(goal.planning).steps,
      updated_at: goal.planning.updated_at || goal.updated_at,
      current: false,
    });
  }
  const currentGeneration = latest?.id === targetGoalId ? latest.horizon_generation : undefined;
  return [...byGeneration.values()]
    .sort((a, b) => a.generation - b.generation)
    .map((horizon) => ({ ...horizon, current: horizon.generation === currentGeneration }));
}

export function readGoalReflections(store: SessionStore, sessionId: string, goalId?: string): GoalReflectionSnapshot[] {
  const events = store.listEvents(sessionId);
  const latest = readGoalState(store, sessionId)?.goal;
  const targetGoalId = goalId ?? latest?.id;
  if (!targetGoalId) {
    return [];
  }
  const startedByRun = new Map<string, number>();
  const reflections: GoalReflectionSnapshot[] = [];
  for (const event of events) {
    if (event.data.goal_id !== targetGoalId) {
      continue;
    }
    if (event.type === "goal.reflection.started") {
      const generation = numericValue(event.data.horizon_generation) ?? 0;
      if (event.run_id) {
        startedByRun.set(event.run_id, generation);
      }
      continue;
    }
    if (event.type !== "goal.reflection.completed") {
      continue;
    }
    const decision = parseGoalReflectionDecision(event.data.decision);
    if (!decision) {
      continue;
    }
    const generation =
      numericValue(event.data.source_horizon_generation) ??
      (event.run_id ? startedByRun.get(event.run_id) : undefined) ??
      numericValue(event.data.previous_horizon_generation) ??
      numericValue(event.data.horizon_generation);
    if (generation === undefined) {
      continue;
    }
    const nextGeneration = numericValue(event.data.horizon_generation);
    reflections.push({
      generation,
      next_generation: nextGeneration,
      run_id: event.run_id,
      decision,
      summary: optionalString(event.data.summary),
      blocker: optionalString(event.data.blocker),
      verification_evidence: event.data.verification_evidence && typeof event.data.verification_evidence === "object" && !Array.isArray(event.data.verification_evidence)
        ? cloneJsonObject(event.data.verification_evidence as JsonObject)
        : undefined,
      created_at: event.created_at ?? "",
    });
  }
  return reflections;
}

export function createGoalState(input: GoalCreateInput, now = new Date()): GoalState {
  const objective = input.objective.trim();
  if (!objective) {
    throw new Error("objective is required");
  }
  validateTokenBudget(input.token_budget);
  const timestamp = now.toISOString();
  const strategy = createGoalStrategy(input.strategy);
  return {
    enabled: true,
    goal: {
      id: randomId("goal"),
      objective,
      status: "active",
      token_budget: input.token_budget,
      tokens_used: 0,
      time_used_ms: 0,
      time_used_seconds: 0,
      tool_rounds_used: 0,
      tool_calls_used: 0,
      horizon_generation: 0,
      strategy,
      ledger: emptyGoalLedger(timestamp),
      planning: createGoalPlanning(horizonZeroPlanningInput(), now),
      created_at: timestamp,
      updated_at: timestamp,
    },
  };
}

function horizonZeroPlanningInput(): GoalPlanningInput {
  return {
    summary: "Horizon 0 · Orientation",
    active_step_id: "read_objective_and_constraints",
    steps: [
      { id: "read_objective_and_constraints", title: "Read objective and constraints", status: "in_progress" },
      { id: "inspect_workspace_shape", title: "Inspect workspace shape", status: "pending" },
      { id: "identify_candidate_sources", title: "Identify candidate sources", status: "pending" },
      { id: "infer_goal_strategy", title: "Infer goal strategy and seed candidate ledger", status: "pending" },
    ],
  };
}

function createGoalStrategy(input?: GoalStrategyInput): GoalStrategy {
  if (!input) {
    return {
      mode: "opportunistic",
      inferred: true,
      rationale: "Auto mode starts opportunistic and should be refined after Horizon 0 orientation.",
    };
  }
  const targetHours = input.target_hours === undefined ? undefined : Math.max(0, input.target_hours);
  return {
    mode: input.mode,
    inferred: input.inferred ?? true,
    target_hours: targetHours && Number.isFinite(targetHours) ? targetHours : undefined,
    rationale: cleanOptionalString(input.rationale),
  };
}

function emptyGoalLedger(timestamp: string): GoalLedger {
  return {
    open: [],
    done: [],
    rejected: [],
    updated_at: timestamp,
  };
}

function createGoalCandidates(inputs: GoalCandidateInput[], status: GoalCandidateStatus, timestamp: string): GoalCandidate[] {
  const used = new Set<string>();
  return inputs.map((input, index) => {
    const title = input.title.trim();
    if (!title) {
      throw new Error("goal ledger candidates must have non-empty titles");
    }
    const id = normalizeGoalStepId(input.id, title, index, used);
    used.add(id);
    return {
      id,
      title,
      source: cleanOptionalString(input.source),
      value: input.value ?? "medium",
      status,
      reason: cleanOptionalString(input.reason),
      evidence: input.evidence ? cloneJsonObject(input.evidence) : undefined,
      updated_at: timestamp,
    };
  });
}

export function replaceGoalPlanning(state: GoalState, input: GoalPlanningInput, now = new Date()): GoalState {
  const next = cloneGoalState(state);
  next.goal.planning = createGoalPlanning(input, now);
  next.goal.updated_at = next.goal.planning.updated_at;
  return next;
}

export function setGoalStrategy(state: GoalState, input: GoalStrategyInput, now = new Date()): GoalState {
  const next = cloneGoalState(state);
  next.goal.strategy = createGoalStrategy(input);
  next.goal.updated_at = now.toISOString();
  return next;
}

export function updateGoalLedger(state: GoalState, input: GoalLedgerInput, now = new Date()): GoalState {
  const next = cloneGoalState(state);
  const timestamp = now.toISOString();
  const current = next.goal.ledger ?? emptyGoalLedger(timestamp);
  next.goal.ledger = {
    open: input.open !== undefined ? createGoalCandidates(input.open, "open", timestamp) : current.open,
    done: input.done !== undefined ? createGoalCandidates(input.done, "done", timestamp) : current.done,
    rejected: input.rejected !== undefined ? createGoalCandidates(input.rejected, "rejected", timestamp) : current.rejected,
    updated_at: timestamp,
  };
  next.goal.updated_at = timestamp;
  return next;
}

export function markGoalReflectionStarted(state: GoalState, runId: string, now = new Date()): GoalState {
  const next = cloneGoalState(state);
  next.goal.reflection_status = "running";
  next.goal.last_reflection_run_id = runId;
  next.goal.last_reflection_decision = undefined;
  next.goal.last_reflection_summary = undefined;
  next.goal.verification_evidence = undefined;
  next.goal.blocker = undefined;
  next.goal.updated_at = now.toISOString();
  return next;
}

export function completeGoalReflection(state: GoalState, input: GoalReflectionInput, runId: string, now = new Date()): GoalState {
  const timestamp = now.toISOString();
  let next = cloneGoalState(state);
  next.goal.reflection_status = "completed";
  next.goal.last_reflection_run_id = runId;
  next.goal.last_reflection_decision = input.decision;
  next.goal.last_reflection_summary = cleanOptionalString(input.summary);
  next.goal.verification_evidence = input.verification_evidence ? cloneJsonObject(input.verification_evidence) : undefined;
  next.goal.blocker = cleanOptionalString(input.blocker);
  if (input.decision === "expand") {
    if (!input.steps?.length) {
      throw new Error("reflection decision expand requires concrete new steps with substantive impact on the original goal");
    }
    next.goal.horizon_generation = Math.max(0, next.goal.horizon_generation) + 1;
    next.goal.planning = createGoalPlanning(
      {
        summary: input.summary ?? next.goal.planning?.summary,
        active_step_id: input.active_step_id,
        steps: input.steps,
      },
      now,
    );
  }
  if (input.decision === "done" && !input.verification_evidence) {
    throw new Error("reflection decision done requires verification_evidence");
  }
  next.goal.updated_at = timestamp;
  return next;
}

export function completeGoalAfterReflection(state: GoalState, summary: string | undefined, now = new Date()): GoalState {
  const reflectionMessage = goalCompletionReflectionBlockMessage(state.goal);
  if (reflectionMessage) {
    throw new Error(reflectionMessage);
  }
  const candidateMessage = goalCompletionCandidateBlockMessage(state.goal);
  if (candidateMessage) {
    throw new Error(candidateMessage);
  }
  const next = cloneGoalState(state);
  const trimmed = summary?.trim() || next.goal.last_reflection_summary;
  if (trimmed) {
    next.goal.summary = trimmed;
  }
  next.enabled = false;
  next.goal.status = "complete";
  next.goal.updated_at = now.toISOString();
  return next;
}

export function attachGoalPlanSnapshot(state: GoalState, plan: GoalPlanSnapshot, now = new Date()): GoalState {
  let next = cloneGoalState(state);
  next.goal.plan = { ...plan };
  const steps = goalPlanningStepsFromMarkdown(plan.body);
  if (steps.length) {
    next = syncApprovedPlanIntoGoalPlanning(next, steps, plan.summary, now);
  }
  next.goal.updated_at = now.toISOString();
  return next;
}

function syncApprovedPlanIntoGoalPlanning(state: GoalState, planSteps: GoalPlanningStepInput[], summary: string | undefined, now: Date): GoalState {
  if (!state.goal.planning) {
    return replaceGoalPlanning(
      state,
      {
        summary,
        steps: planSteps,
      },
      now,
    );
  }
  const existing = state.goal.planning;
  const byId = new Map(existing.steps.map((step) => [step.id, step]));
  const byTitle = new Map(existing.steps.map((step) => [goalStepTitleKey(step.title), step]));
  const used = new Set<string>();
  const mergedSteps = planSteps.map((step, index) => {
    const title = step.title.trim();
    const provisionalId = normalizeGoalStepId(step.id, title, index, new Set());
    const prior = byId.get(provisionalId) ?? byTitle.get(goalStepTitleKey(title));
    const id = normalizeGoalStepId(prior?.id ?? step.id, title, index, used);
    used.add(id);
    return {
      id,
      title,
      status: prior?.status ?? step.status ?? "pending",
      notes: prior?.notes ?? cleanOptionalString(step.notes),
      evidence: prior?.evidence ? cloneJsonObject(prior.evidence) : step.evidence ? cloneJsonObject(step.evidence) : undefined,
    };
  });
  return replaceGoalPlanning(
    state,
    {
      summary: summary ?? existing.summary,
      active_step_id: existing.active_step_id && mergedSteps.some((step) => step.id === existing.active_step_id) ? existing.active_step_id : undefined,
      steps: mergedSteps,
    },
    now,
  );
}

export function updateGoalPlanningStep(state: GoalState, input: GoalStepUpdateInput, now = new Date()): GoalState {
  if (!state.goal.planning) {
    throw new Error("goal planning has not been decomposed yet");
  }
  const stepId = input.step_id.trim();
  if (!stepId) {
    throw new Error("step_id is required");
  }
  const timestamp = now.toISOString();
  const next = cloneGoalState(state);
  const planning = next.goal.planning!;
  let step = planning.steps.find((item) => item.id === stepId);
  if (!step) {
    const title = input.title?.trim();
    if (!title) {
      throw new Error(`unknown goal step: ${stepId}`);
    }
    step = {
      id: normalizeGoalStepId(stepId, title, planning.steps.length, new Set(planning.steps.map((item) => item.id))),
      title,
      status: input.status ?? "pending",
      updated_at: timestamp,
    };
    planning.steps.push(step);
  }
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) {
      throw new Error("step title cannot be empty");
    }
    step.title = title;
  }
  if (input.status) {
    step.status = input.status;
  }
  if (input.notes !== undefined) {
    const notes = input.notes.trim();
    if (notes) {
      step.notes = notes;
    } else {
      delete step.notes;
    }
  }
  if (input.evidence !== undefined) {
    step.evidence = cloneJsonObject(input.evidence);
  }
  step.updated_at = timestamp;
  if (input.active_step_id !== undefined) {
    planning.active_step_id = normalizeExistingStepId(input.active_step_id, planning.steps);
  } else if (step.status === "in_progress") {
    planning.active_step_id = step.id;
  } else if (planning.active_step_id === step.id && isTerminalGoalStepStatus(step.status)) {
    planning.active_step_id = firstNonTerminalStep(planning.steps)?.id;
  }
  const active = planning.active_step_id ? planning.steps.find((item) => item.id === planning.active_step_id) : undefined;
  if (active && active.status === "pending") {
    active.status = "in_progress";
    active.updated_at = timestamp;
  }
  reconcileLedgerCandidateFromStep(next.goal, step, timestamp);
  planning.updated_at = timestamp;
  next.goal.updated_at = timestamp;
  return next;
}

export function createGoalPlanning(input: GoalPlanningInput, now = new Date()): GoalPlanningState {
  const timestamp = now.toISOString();
  const used = new Set<string>();
  const steps = input.steps.map((step, index) => {
    const title = step.title.trim();
    if (!title) {
      throw new Error("goal planning steps must have non-empty titles");
    }
    const id = normalizeGoalStepId(step.id, title, index, used);
    used.add(id);
    return {
      id,
      title,
      status: step.status ?? "pending",
      notes: cleanOptionalString(step.notes),
      evidence: step.evidence ? cloneJsonObject(step.evidence) : undefined,
      updated_at: timestamp,
    };
  });
  if (!steps.length) {
    throw new Error("goal planning requires at least one step");
  }
  const activeStepId = normalizeExistingStepId(input.active_step_id, steps) ?? firstNonTerminalStep(steps)?.id;
  const activeStep = activeStepId ? steps.find((step) => step.id === activeStepId) : undefined;
  if (activeStep && activeStep.status === "pending") {
    activeStep.status = "in_progress";
  }
  return {
    summary: cleanOptionalString(input.summary),
    active_step_id: activeStepId,
    steps,
    updated_at: timestamp,
  };
}

export function writeGoalState(store: SessionStore, sessionId: string, state: GoalState, runId?: string): GoalState {
  const cloned = cloneGoalState(state);
  store.appendEvent({
    session_id: sessionId,
    run_id: runId,
    type: "goal.updated",
    data: goalStateToJson(cloned),
  });
  return cloned;
}

export function goalCompletionReportForRun(store: SessionStore, sessionId: string, runId: string): string | undefined {
  return goalCompletionForRun(store, sessionId, runId)?.report;
}

export function recordGoalCompletionReport(store: SessionStore, sessionId: string, runId: string): GoalCompletionReport | undefined {
  const completion = goalCompletionForRun(store, sessionId, runId);
  if (!completion) {
    return undefined;
  }
  const state = readGoalState(store, sessionId);
  if (!state) {
    return undefined;
  }
  const exists = store.listEvents(sessionId).some((event) => event.run_id === runId && event.type === "goal.completion_report");
  if (!exists) {
    const data: JsonObject = {
      goal_objective: completion.objective,
      report: completion.report,
      tool_rounds: state.goal.tool_rounds_used,
      tool_calls: state.goal.tool_calls_used,
      horizons: state.goal.horizon_generation + 1,
      tokens: state.goal.tokens_used,
      duration_ms: goalDurationMs(state.goal),
    };
    if (state.goal.summary) {
      data.completion_summary = state.goal.summary;
    }
    store.appendEvent({
      session_id: sessionId,
      run_id: runId,
      type: "goal.completion_report",
      data,
    });
  }
  return completion;
}

export function goalStateToJson(state: GoalState): JsonObject {
  return {
    enabled: state.enabled,
    goal: state.goal as unknown as JsonObject,
  };
}

export function applyGoalUsage(
  store: SessionStore,
  sessionId: string,
  usage: { tokens?: number; time_seconds?: number; duration_ms?: number; tool_rounds?: number; tool_calls?: number },
  runId?: string,
): GoalState | undefined {
  const state = readGoalState(store, sessionId);
  if (!state || !shouldAccountGoalUsage(store, sessionId, state, runId)) {
    return state;
  }
  const tokens = Math.max(0, Math.trunc(usage.tokens ?? 0));
  const seconds = Math.max(0, Math.trunc(usage.time_seconds ?? 0));
  const durationMs = Math.max(0, Math.trunc(usage.duration_ms ?? seconds * 1000));
  const toolRounds = Math.max(0, Math.trunc(usage.tool_rounds ?? 0));
  const toolCalls = Math.max(0, Math.trunc(usage.tool_calls ?? 0));
  if (tokens === 0 && durationMs === 0 && toolRounds === 0 && toolCalls === 0) {
    return state;
  }
  const next = cloneGoalState(state);
  next.goal.tokens_used += tokens;
  next.goal.time_used_ms = goalDurationMs(next.goal) + durationMs;
  next.goal.time_used_seconds = Math.floor(next.goal.time_used_ms / 1000);
  next.goal.tool_rounds_used += toolRounds;
  next.goal.tool_calls_used += toolCalls;
  next.goal.updated_at = new Date().toISOString();
  if (
    next.goal.token_budget !== undefined &&
    next.goal.tokens_used >= next.goal.token_budget &&
    next.goal.status === "active"
  ) {
    next.goal.status = "budget-limited";
  }
  return writeGoalState(store, sessionId, next, runId);
}

export function modelUsageTokenCost(usage: ModelUsage | undefined): number {
  if (!usage) {
    return 0;
  }
  if (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)) {
    return Math.max(0, Math.trunc(usage.total_tokens));
  }
  const prompt = numeric(usage.prompt_tokens);
  const completion = numeric(usage.completion_tokens);
  return Math.max(0, prompt + completion);
}

export function renderGoalModeSection(state: GoalState | undefined): string | undefined {
  if (!state?.enabled || !isActiveGoalPromptStatus(state.goal.status)) {
    return undefined;
  }
  const goal = state.goal;
  const budgetLine =
    goal.token_budget === undefined
      ? "token budget: none"
      : `token budget: ${goal.token_budget}; tokens used: ${goal.tokens_used}; remaining tokens: ${Math.max(0, goal.token_budget - goal.tokens_used)}`;
  const loopLine = `tool loops used: ${goal.tool_rounds_used}; tool calls used: ${goal.tool_calls_used}`;
  const statusLine =
    goal.status === "budget-limited"
      ? "status: budget-limited; finish with a concise final answer or call goal complete when the objective is actually done."
      : `status: ${goal.status}`;
  return [
    "A goal-mode objective is active for this session.",
    renderTrustedObjective(goal.objective),
    statusLine,
    budgetLine,
    loopLine,
    `time used seconds: ${goal.time_used_seconds}`,
    `time used ms: ${goalDurationMs(goal)}`,
    `horizon: ${goal.horizon_generation}`,
    renderGoalStrategy(goal.strategy),
    renderGoalLedger(goal.ledger),
    goal.planning ? renderGoalPlanning(goal.planning) : "Internal goal plan: not decomposed yet.",
    renderLatestReflection(goal),
    goal.plan ? renderApprovedPlan(goal.plan, Boolean(goal.planning)) : undefined,
    goal.planning
      ? "Keep the internal goal plan current with goal op=update_step as findings, edits, and verification change."
      : "For broad or multi-step work, call goal op=decompose with concrete steps before risky edits.",
    "Work on the objective until it is genuinely handled. Use the goal tool to inspect, resume, complete, or drop goal state when appropriate.",
    "When the current horizon appears exhausted, a tool-enabled internal reflection run must decide whether more horizon, verification, decomposition, or polish work with substantive impact on the original objective remains before completion.",
    "When completing the goal, include a completion summary in the goal tool call.",
    "Do not mark the goal complete merely because the current checklist is empty, the turn is ending, or the budget is low.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function completionBudgetReport(goal: GoalRecord): string | undefined {
  const usage =
    goal.token_budget === undefined
      ? `${goal.tokens_used} tokens used`
      : `${goal.tokens_used} of ${goal.token_budget} tokens used`;
  return `Goal achieved. ${countLabel(goal.tool_rounds_used, "loop")} · ${countLabel(goal.tool_calls_used, "tool call")} · ${countLabel(goal.horizon_generation + 1, "horizon")} · ${formatDurationMs(goalDurationMs(goal))} · ${usage}.`;
}

export function goalDurationMs(goal: GoalRecord): number {
  return Math.max(0, Math.trunc(goal.time_used_ms ?? goal.time_used_seconds * 1000));
}

export function formatGoalDuration(goal: GoalRecord): string {
  return formatDurationMs(goalDurationMs(goal));
}

export function renderTrustedObjective(objective: string): string {
  return `<objective>\n${escapeXmlText(objective)}\n</objective>`;
}

export function escapeXmlText(input: string): string {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function cloneGoalState(state: GoalState): GoalState {
  return {
    enabled: state.enabled,
    goal: {
      ...state.goal,
      verification_evidence: state.goal.verification_evidence ? cloneJsonObject(state.goal.verification_evidence) : undefined,
      strategy: state.goal.strategy ? cloneGoalStrategy(state.goal.strategy) : undefined,
      ledger: state.goal.ledger ? cloneGoalLedger(state.goal.ledger) : undefined,
      planning: state.goal.planning ? cloneGoalPlanning(state.goal.planning) : undefined,
      plan: state.goal.plan ? { ...state.goal.plan } : undefined,
    },
  };
}

export function incompleteGoalPlanningSteps(goal: GoalRecord): GoalPlanningStep[] {
  return goal.planning?.steps.filter((step) => !isTerminalGoalStepStatus(step.status)) ?? [];
}

export function incompleteGoalPlanningMessage(goal: GoalRecord): string | undefined {
  const incomplete = incompleteGoalPlanningSteps(goal);
  if (!incomplete.length) {
    return undefined;
  }
  const visible = incomplete.slice(0, 8).map((step) => step.id);
  const suffix = incomplete.length > visible.length ? `, and ${incomplete.length - visible.length} more` : "";
  return `Cannot complete goal with unfinished internal plan steps: ${visible.join(", ")}${suffix}`;
}

export function isGoalHorizonExhausted(goal: GoalRecord): boolean {
  return Boolean(goal.planning && incompleteGoalPlanningSteps(goal).length === 0);
}

export function goalCompletionReflectionBlockMessage(goal: GoalRecord): string | undefined {
  if (goal.last_reflection_decision !== "done") {
    return "Cannot complete goal until a tool-enabled reflection run records decision=done.";
  }
  if (!goal.verification_evidence || Object.keys(goal.verification_evidence).length === 0) {
    return "Cannot complete goal until the latest done reflection records verification_evidence.";
  }
  return undefined;
}

export function goalCompletionCandidateBlockMessage(goal: GoalRecord): string | undefined {
  const strategy = goal.strategy ?? createGoalStrategy();
  const openCandidates = goal.ledger?.open ?? [];
  if (strategy.mode === "surgical") {
    return undefined;
  }
  if (strategy.mode === "opportunistic") {
    const highMedium = openCandidates.filter((candidate) => candidate.value === "high" || candidate.value === "medium");
    if (highMedium.length > 0) {
      return `Cannot complete opportunistic goal while open high/medium ledger candidates remain (${highMedium.length}).`;
    }
    return undefined;
  }
  if (openCandidates.length === 0) {
    return undefined;
  }
  const targetHours = strategy.target_hours;
  if (targetHours !== undefined && goalDurationMs(goal) >= targetHours * 60 * 60 * 1000) {
    return `Campaign target reached with ${countLabel(openCandidates.length, "open ledger candidate")} remaining; checkpoint or pause instead of completing.`;
  }
  return `Cannot complete campaign goal while ${countLabel(openCandidates.length, "open ledger candidate")} remains before the time budget; expand the next horizon.`;
}

export function goalPlanningProgressSummary(planning: GoalPlanningState): string {
  const counts = new Map<GoalStepStatus, number>();
  for (const step of planning.steps) {
    counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
  }
  const parts = [
    countPart(counts, "completed", "completed"),
    countPart(counts, "in_progress", "in progress"),
    countPart(counts, "blocked", "blocked"),
    countPart(counts, "pending", "pending"),
    countPart(counts, "skipped", "skipped"),
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : "no steps";
}

export function goalPlanningStepsFromMarkdown(body: string | undefined): GoalPlanningStepInput[] {
  if (!body) {
    return [];
  }
  return body
    .split(/\r?\n/)
    .map(parseGoalPlanningStepLine)
    .filter((step): step is GoalPlanningStepInput => Boolean(step));
}

export function validateTokenBudget(value: unknown): asserts value is number | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("token_budget must be a positive integer when provided");
  }
}

export function isAccountingGoal(goal: GoalRecord): boolean {
  return goal.status === "active" || goal.status === "budget-limited";
}

function shouldAccountGoalUsage(store: SessionStore, sessionId: string, state: GoalState, runId?: string): boolean {
  if (state.enabled && isAccountingGoal(state.goal)) {
    return true;
  }
  if (!runId || (state.goal.status !== "complete" && state.goal.status !== "dropped")) {
    return false;
  }
  return store.listEvents(sessionId).some((event) => {
    if (event.run_id !== runId || event.type !== "goal.updated") {
      return false;
    }
    const eventState = parseGoalState(event.data);
    return eventState?.goal.id === state.goal.id && (eventState.goal.status === "complete" || eventState.goal.status === "dropped");
  });
}

function goalCompletionForRun(store: SessionStore, sessionId: string, runId: string): GoalCompletionReport | undefined {
  const state = readGoalState(store, sessionId);
  if (!state || state.goal.status !== "complete") {
    return undefined;
  }
  const completedInRun = store.listEvents(sessionId).some((event) => {
    if (event.run_id !== runId || event.type !== "goal.updated") {
      return false;
    }
    const eventState = parseGoalState(event.data);
    return eventState?.goal.id === state.goal.id && eventState.goal.status === "complete";
  });
  const report = completedInRun ? completionBudgetReport(state.goal) : undefined;
  return report ? { objective: state.goal.objective, report } : undefined;
}

export function parseGoalReflectionDecision(value: unknown): GoalReflectionDecision | undefined {
  return value === "expand" || value === "done" || value === "blocked" ? value : undefined;
}

function parseGoalReflectionStatus(value: unknown): GoalReflectionStatus | undefined {
  return value === "running" || value === "completed" ? value : undefined;
}

function isActiveGoalPromptStatus(status: GoalStatus): boolean {
  return status === "active" || status === "budget-limited";
}

function latestGoalEvent(events: SessionEvent[]): SessionEvent | undefined {
  return events.filter((event) => event.type === "goal.updated").at(-1);
}

function parseGoalState(data: JsonObject): GoalState | undefined {
  const goal = data.goal;
  if (!goal || typeof goal !== "object" || Array.isArray(goal)) {
    return undefined;
  }
  const candidate = goal as Record<string, unknown>;
  const objective = typeof candidate.objective === "string" ? candidate.objective : "";
  const status = parseGoalStatus(candidate.status);
  const id = typeof candidate.id === "string" ? candidate.id : "";
  if (!id || !objective || !status) {
    return undefined;
  }
  const tokenBudget = numericOrUndefined(candidate.token_budget);
  const planning = parseGoalPlanning(candidate.planning);
  const horizonGeneration = numeric(candidate.horizon_generation);
  return {
    enabled: data.enabled === true,
    goal: {
      id,
      objective,
      status,
      token_budget: tokenBudget,
      tokens_used: numeric(candidate.tokens_used),
      time_used_ms: durationMsFromGoalData(candidate),
      time_used_seconds: numeric(candidate.time_used_seconds),
      tool_rounds_used: numeric(candidate.tool_rounds_used),
      tool_calls_used: numeric(candidate.tool_calls_used),
      horizon_generation: horizonGeneration,
      strategy: parseGoalStrategy(candidate.strategy),
      ledger: parseGoalLedger(candidate.ledger),
      reflection_status: parseGoalReflectionStatus(candidate.reflection_status),
      last_reflection_run_id: optionalString(candidate.last_reflection_run_id),
      last_reflection_decision: parseGoalReflectionDecision(candidate.last_reflection_decision),
      last_reflection_summary: optionalString(candidate.last_reflection_summary),
      verification_evidence: parseJsonObject(candidate.verification_evidence),
      blocker: optionalString(candidate.blocker),
      planning,
      plan: parseGoalPlan(candidate.plan),
      summary: optionalString(candidate.summary),
      created_at: typeof candidate.created_at === "string" ? candidate.created_at : "",
      updated_at: typeof candidate.updated_at === "string" ? candidate.updated_at : "",
    },
  };
}

function renderApprovedPlan(plan: GoalPlanSnapshot, hasInternalPlanning: boolean): string {
  const bodySyncedIntoInternalPlan = hasInternalPlanning && goalPlanningStepsFromMarkdown(plan.body).length > 0;
  return [
    "Approved plan:",
    `<plan_objective>\n${escapeXmlText(plan.objective)}\n</plan_objective>`,
    plan.summary ? `Plan summary: ${escapeXmlText(plan.summary)}` : undefined,
    bodySyncedIntoInternalPlan ? "Body synced into the internal goal plan above." : plan.body ? `Plan body:\n${escapeXmlText(truncateText(plan.body, PLAN_PROMPT_BODY_LIMIT).text)}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderGoalPlanning(planning: GoalPlanningState): string {
  const active = planning.active_step_id ? planning.steps.find((step) => step.id === planning.active_step_id) : undefined;
  return [
    "Internal goal plan:",
    planning.summary ? `Plan summary: ${escapeXmlText(planning.summary)}` : undefined,
    active ? `Active step: ${escapeXmlText(active.id)} ${escapeXmlText(active.title)}` : undefined,
    `Progress: ${goalPlanningProgressSummary(planning)}`,
    ...planning.steps.flatMap((step) => renderGoalPlanningStep(step)),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function goalHorizonTitle(generation: number, summary: string | undefined): string | undefined {
  const trimmed = cleanOptionalString(summary);
  if (!trimmed) {
    return undefined;
  }
  const prefix = new RegExp(`^horizon\\s+${generation}\\s*(?:[·:.-])\\s*`, "i");
  return trimmed.replace(prefix, "").trim() || trimmed;
}

function renderLatestReflection(goal: GoalRecord): string | undefined {
  if (!goal.reflection_status && !goal.last_reflection_decision && !goal.last_reflection_summary && !goal.verification_evidence && !goal.blocker) {
    return undefined;
  }
  return [
    "Latest internal reflection:",
    goal.reflection_status ? `status: ${goal.reflection_status}` : undefined,
    goal.last_reflection_decision ? `decision: ${goal.last_reflection_decision}` : undefined,
    goal.last_reflection_summary ? `summary: ${escapeXmlText(truncateEvidenceText(goal.last_reflection_summary, 1000))}` : undefined,
    goal.blocker ? `blocker: ${escapeXmlText(truncateEvidenceText(goal.blocker, 1000))}` : undefined,
    goal.verification_evidence ? `verification evidence: ${escapeXmlText(compactEvidenceSummary(goal.verification_evidence))}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderGoalStrategy(strategy: GoalStrategy | undefined): string {
  const current = strategy ?? createGoalStrategy();
  return [
    "Goal strategy:",
    `mode: ${current.mode}`,
    `source: ${current.inferred ? "auto" : "explicit"}`,
    current.target_hours !== undefined ? `target hours: ${formatGoalTargetHours(current.target_hours)}` : undefined,
    current.rationale ? `rationale: ${escapeXmlText(truncateEvidenceText(current.rationale, 500))}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatGoalTargetHours(hours: number): string {
  const precision = hours < 1 ? 3 : 2;
  const formatted = hours.toFixed(precision).replace(/\.?0+$/, "");
  return `${formatted}h`;
}

function renderGoalLedger(ledger: GoalLedger | undefined): string {
  const current = ledger ?? emptyGoalLedger("");
  const visibleOpen = current.open
    .filter((candidate) => candidate.value === "high" || candidate.value === "medium")
    .slice(0, 8)
    .map((candidate) => `- [${candidate.value}] ${escapeXmlText(candidate.id)} ${escapeXmlText(candidate.title)}`);
  return [
    "Candidate ledger:",
    `open: ${current.open.length}; done: ${current.done.length}; rejected: ${current.rejected.length}`,
    visibleOpen.length ? "Open high/medium candidates:" : undefined,
    ...visibleOpen,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderGoalPlanningStep(step: GoalPlanningStep): string[] {
  const marker = stepMarker(step.status);
  const lines = [`[${marker}] ${escapeXmlText(step.id)} ${escapeXmlText(step.title)}`];
  if (step.notes) {
    lines.push(`notes: ${escapeXmlText(truncateEvidenceText(step.notes, 500))}`);
  }
  if (step.evidence) {
    lines.push(`evidence: ${escapeXmlText(compactEvidenceSummary(step.evidence))}`);
  }
  return lines;
}

function reconcileLedgerCandidateFromStep(goal: GoalRecord, step: GoalPlanningStep, timestamp: string): void {
  if (!goal.ledger || (step.status !== "completed" && step.status !== "skipped")) {
    return;
  }
  const openIndex = goal.ledger.open.findIndex((candidate) => candidate.id === step.id);
  if (openIndex < 0) {
    return;
  }
  const [candidate] = goal.ledger.open.splice(openIndex, 1);
  if (!candidate) {
    return;
  }
  const status: GoalCandidateStatus = step.status === "completed" ? "done" : "rejected";
  const moved: GoalCandidate = {
    ...candidate,
    status,
    reason: step.notes ?? candidate.reason,
    evidence: step.evidence ? cloneJsonObject(step.evidence) : candidate.evidence ? cloneJsonObject(candidate.evidence) : undefined,
    updated_at: timestamp,
  };
  if (status === "done") {
    goal.ledger.done = [...goal.ledger.done.filter((item) => item.id !== moved.id), moved];
    goal.ledger.rejected = goal.ledger.rejected.filter((item) => item.id !== moved.id);
  } else {
    goal.ledger.rejected = [...goal.ledger.rejected.filter((item) => item.id !== moved.id), moved];
    goal.ledger.done = goal.ledger.done.filter((item) => item.id !== moved.id);
  }
  goal.ledger.updated_at = timestamp;
}

function compactEvidenceSummary(value: JsonObject): string {
  return compactEvidenceObject(value, 0) || "recorded";
}

function compactEvidenceObject(value: JsonObject, depth: number): string {
  const entries = Object.keys(value)
    .sort()
    .slice(0, depth === 0 ? 8 : 4)
    .map((key) => {
      const compact = compactEvidenceValue(value[key], depth + 1);
      return compact ? `${key}=${compact}` : "";
    })
    .filter(Boolean);
  const omitted = Math.max(0, Object.keys(value).length - (depth === 0 ? 8 : 4));
  if (omitted > 0) {
    entries.push(`${omitted} more`);
  }
  return entries.join("; ");
}

function compactEvidenceValue(value: unknown, depth: number): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return truncateEvidenceText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => compactEvidenceValue(item, depth)).filter(Boolean).slice(0, 6);
    const omitted = Math.max(0, value.length - items.length);
    return `${items.join(", ")}${omitted ? `, ${omitted} more` : ""}`;
  }
  if (typeof value === "object") {
    if (depth >= 3) {
      return "object";
    }
    const compact = compactEvidenceObject(value as JsonObject, depth);
    return compact ? `(${compact})` : "";
  }
  return truncateEvidenceText(String(value));
}

function truncateEvidenceText(value: string, max = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function parseGoalPlan(value: unknown): GoalPlanSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const id = optionalString(data.id);
  const objective = optionalString(data.objective);
  const approvedAt = optionalString(data.approved_at);
  if (!id || !objective || !approvedAt) {
    return undefined;
  }
  return {
    id,
    objective,
    summary: optionalString(data.summary),
    body: optionalString(data.body),
    approved_at: approvedAt,
  };
}

function parseGoalStrategy(value: unknown): GoalStrategy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const mode = parseGoalStrategyMode(data.mode);
  if (!mode) {
    return undefined;
  }
  return createGoalStrategy({
    mode,
    inferred: data.inferred === undefined ? true : data.inferred === true,
    target_hours: positiveNumberOrUndefined(data.target_hours),
    rationale: optionalString(data.rationale),
  });
}

function parseGoalLedger(value: unknown): GoalLedger | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const updatedAt = typeof data.updated_at === "string" ? data.updated_at : "";
  return {
    open: parseGoalCandidates(data.open, "open"),
    done: parseGoalCandidates(data.done, "done"),
    rejected: parseGoalCandidates(data.rejected, "rejected"),
    updated_at: updatedAt,
  };
}

function parseGoalCandidates(value: unknown, status: GoalCandidateStatus): GoalCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => parseGoalCandidate(item, status)).filter((candidate): candidate is GoalCandidate => Boolean(candidate));
}

function parseGoalCandidate(value: unknown, status: GoalCandidateStatus): GoalCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const id = optionalString(data.id);
  const title = optionalString(data.title);
  const candidateValue = parseGoalCandidateValue(data.value);
  if (!id || !title || !candidateValue) {
    return undefined;
  }
  return {
    id,
    title,
    source: optionalString(data.source),
    value: candidateValue,
    status,
    reason: optionalString(data.reason),
    evidence: parseJsonObject(data.evidence),
    updated_at: typeof data.updated_at === "string" ? data.updated_at : "",
  };
}

function parseGoalPlanning(value: unknown): GoalPlanningState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const rawSteps = Array.isArray(data.steps) ? data.steps : [];
  const steps = rawSteps.map(parseGoalPlanningStep).filter((step): step is GoalPlanningStep => Boolean(step));
  if (!steps.length) {
    return undefined;
  }
  const activeStepId = normalizeExistingStepId(optionalString(data.active_step_id), steps) ?? firstNonTerminalStep(steps)?.id;
  return {
    summary: optionalString(data.summary),
    active_step_id: activeStepId,
    steps,
    updated_at: typeof data.updated_at === "string" ? data.updated_at : "",
  };
}

function parseGoalPlanningStep(value: unknown): GoalPlanningStep | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const id = optionalString(data.id);
  const title = optionalString(data.title);
  const status = parseGoalStepStatus(data.status);
  if (!id || !title || !status) {
    return undefined;
  }
  return {
    id,
    title,
    status,
    notes: optionalString(data.notes),
    evidence: parseJsonObject(data.evidence),
    updated_at: typeof data.updated_at === "string" ? data.updated_at : "",
  };
}

function parseGoalStatus(value: unknown): GoalStatus | undefined {
  return value === "active" || value === "paused" || value === "budget-limited" || value === "complete" || value === "dropped"
    ? value
    : undefined;
}

function parseGoalStrategyMode(value: unknown): GoalStrategyMode | undefined {
  return value === "surgical" || value === "opportunistic" || value === "campaign" ? value : undefined;
}

function parseGoalCandidateValue(value: unknown): GoalCandidateValue | undefined {
  return value === "high" || value === "medium" || value === "low" ? value : undefined;
}

export function parseGoalStepStatus(value: unknown): GoalStepStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "blocked" || value === "skipped"
    ? value
    : undefined;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
}

function numericOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function positiveNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function durationMsFromGoalData(candidate: Record<string, unknown>): number {
  const millis = numeric(candidate.time_used_ms);
  if (millis > 0 || typeof candidate.time_used_ms === "number") {
    return millis;
  }
  return numeric(candidate.time_used_seconds) * 1000;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function cleanOptionalString(value: unknown): string | undefined {
  return optionalString(value);
}

function cleanPlanStepTitle(value: string | undefined): string | undefined {
  const trimmed = value
    ?.replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .trim();
  return trimmed || undefined;
}

function parseGoalPlanningStepLine(line: string): GoalPlanningStepInput | undefined {
  const match = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[(?<mark>[ xX-])\]\s*)?(?<title>.+?)\s*$/.exec(line);
  const title = cleanPlanStepTitle(match?.groups?.title);
  if (!title) {
    return undefined;
  }
  const status = goalStepStatusFromCheckbox(match?.groups?.mark);
  return status ? { title, status } : { title };
}

function goalStepStatusFromCheckbox(value: string | undefined): GoalStepStatus | undefined {
  if (value === "x" || value === "X") {
    return "completed";
  }
  if (value === "-") {
    return "skipped";
  }
  if (value === " ") {
    return "pending";
  }
  return undefined;
}

function goalStepTitleKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function cloneGoalPlanning(planning: GoalPlanningState): GoalPlanningState {
  return {
    summary: planning.summary,
    active_step_id: planning.active_step_id,
    updated_at: planning.updated_at,
    steps: planning.steps.map((step) => ({
      ...step,
      evidence: step.evidence ? cloneJsonObject(step.evidence) : undefined,
    })),
  };
}

function cloneGoalStrategy(strategy: GoalStrategy): GoalStrategy {
  return { ...strategy };
}

function cloneGoalLedger(ledger: GoalLedger): GoalLedger {
  return {
    open: ledger.open.map(cloneGoalCandidate),
    done: ledger.done.map(cloneGoalCandidate),
    rejected: ledger.rejected.map(cloneGoalCandidate),
    updated_at: ledger.updated_at,
  };
}

function cloneGoalCandidate(candidate: GoalCandidate): GoalCandidate {
  return {
    ...candidate,
    evidence: candidate.evidence ? cloneJsonObject(candidate.evidence) : undefined,
  };
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function parseJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return cloneJsonObject(value as JsonObject);
}

function normalizeGoalStepId(rawId: string | undefined, title: string, index: number, used: Set<string>): string {
  const seed = rawId?.trim() || title.trim() || `step-${index + 1}`;
  const base = seed
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || `step-${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function normalizeExistingStepId(stepId: string | undefined, steps: GoalPlanningStep[]): string | undefined {
  const trimmed = stepId?.trim();
  if (!trimmed) {
    return undefined;
  }
  return steps.some((step) => step.id === trimmed) ? trimmed : undefined;
}

function firstNonTerminalStep(steps: GoalPlanningStep[]): GoalPlanningStep | undefined {
  return steps.find((step) => !isTerminalGoalStepStatus(step.status));
}

function isTerminalGoalStepStatus(status: GoalStepStatus): boolean {
  return status === "completed" || status === "skipped";
}

function countPart(counts: Map<GoalStepStatus, number>, status: GoalStepStatus, label: string): string | undefined {
  const count = counts.get(status) ?? 0;
  return count > 0 ? `${count} ${label}` : undefined;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatDurationMs(durationMs: number): string {
  const safe = Math.max(0, Math.trunc(durationMs));
  if (safe > 0 && safe < 1000) {
    return `${safe}ms`;
  }
  return formatSeconds(Math.floor(safe / 1000));
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
}

function stepMarker(status: GoalStepStatus): string {
  switch (status) {
    case "completed":
      return "x";
    case "in_progress":
      return "*";
    case "blocked":
      return "!";
    case "skipped":
      return "-";
    case "pending":
      return " ";
  }
}
