import type { JsonObject, ToolResult } from "../types.js";
import { fail, ok } from "../util/limit.js";
import type { ToolExecutionContext } from "./context.js";
import {
  cloneGoalState,
  completeGoalReflection,
  completionBudgetReport,
  createGoalState,
  formatGoalDuration,
  goalCompletionCandidateBlockMessage,
  goalCompletionReflectionBlockMessage,
  incompleteGoalPlanningMessage,
  goalPlanningProgressSummary,
  parseGoalReflectionDecision,
  parseGoalStepStatus,
  readGoalHorizons,
  readGoalState,
  replaceGoalPlanning,
  setGoalStrategy,
  updateGoalPlanningStep,
  updateGoalLedger,
  validateTokenBudget,
  writeGoalState,
  type GoalCandidateInput,
  type GoalCandidateValue,
  type GoalPlanningStepInput,
  type GoalRecord,
  type GoalStrategyMode,
  type GoalState,
} from "../goals/state.js";

export async function goalTool(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const op = stringArg(args.op) ?? "get";
  try {
    switch (op) {
      case "create":
        return createGoal(args, context);
      case "get":
        return describeGoal(readGoalState(context.store, context.session_id), "Goal state", context);
      case "decompose":
      case "update_plan":
        return updateGoalPlan(args, context, op);
      case "update_step":
        return updateGoalStep(args, context);
      case "reflect":
        return recordGoalReflection(args, context);
      case "set_strategy":
        return updateGoalStrategy(args, context);
      case "update_ledger":
        return updateLedger(args, context);
      case "resume":
        return resumeGoal(context);
      case "complete":
        return finishGoal(args, context, "complete");
      case "drop":
        return finishGoal(args, context, "dropped");
      default:
        return fail("invalid_goal_op", `Unknown goal operation: ${op}`);
    }
  } catch (error) {
    return fail("goal_error", error instanceof Error ? error.message : String(error));
  }
}

function createGoal(args: JsonObject, context: ToolExecutionContext): ToolResult {
  const existing = readGoalState(context.store, context.session_id);
  if (existing && existing.goal.status !== "complete" && existing.goal.status !== "dropped") {
    return fail("goal_exists", "cannot create a new goal because this session already has a goal");
  }
  const objective = stringArg(args.objective)?.trim();
  if (!objective) {
    return fail("goal_objective_required", "objective is required when op=create");
  }
  const tokenBudget = numberArg(args.token_budget);
  validateTokenBudget(tokenBudget);
  const mode = parseGoalStrategyModeArg(args.mode);
  if (args.mode !== undefined && !mode) {
    return fail("goal_strategy_mode_invalid", "mode must be surgical, opportunistic, or campaign");
  }
  let state = createGoalState({
    objective,
    token_budget: tokenBudget,
    strategy: mode
      ? {
          mode,
          inferred: booleanArg(args.inferred),
          target_hours: numberArg(args.target_hours),
          rationale: stringArg(args.rationale),
        }
      : undefined,
  });
  const steps = stepsArg(args.steps);
  if (steps) {
    state = replaceGoalPlanning(
      state,
      {
        summary: stringArg(args.summary),
        active_step_id: stringArg(args.active_step_id),
        steps,
      },
    );
  }
  state = writeGoalState(context.store, context.session_id, state, context.run_id);
  return describeGoal(state, "Goal created", context);
}

function updateGoalPlan(args: JsonObject, context: ToolExecutionContext, op: string): ToolResult {
  const state = readGoalState(context.store, context.session_id);
  if (!state) {
    return fail("goal_missing", "No goal to decompose.");
  }
  if (state.goal.status === "complete" || state.goal.status === "dropped") {
    return fail("goal_closed", `Cannot update a ${state.goal.status} goal.`);
  }
  const steps = stepsArg(args.steps);
  if (!steps && op === "decompose") {
    return fail("goal_steps_required", "steps are required when op=decompose");
  }
  let next = cloneGoalState(state);
  if (steps) {
    next = replaceGoalPlanning(next, {
      summary: stringArg(args.summary),
      active_step_id: stringArg(args.active_step_id),
      steps,
    });
  } else if (next.goal.planning) {
    const summary = stringArg(args.summary);
    if (summary !== undefined) {
      const trimmed = summary.trim();
      if (trimmed) {
        next.goal.planning.summary = trimmed;
      } else {
        delete next.goal.planning.summary;
      }
    }
    const activeStepId = stringArg(args.active_step_id)?.trim();
    if (activeStepId && next.goal.planning.steps.some((step) => step.id === activeStepId)) {
      next.goal.planning.active_step_id = activeStepId;
      const active = next.goal.planning.steps.find((step) => step.id === activeStepId);
      if (active && active.status === "pending") {
        active.status = "in_progress";
      }
    }
    next.goal.planning.updated_at = new Date().toISOString();
    next.goal.updated_at = next.goal.planning.updated_at;
  } else {
    return fail("goal_steps_required", "steps are required before goal planning can be updated");
  }
  return describeGoal(writeGoalState(context.store, context.session_id, next, context.run_id), steps ? "Goal decomposed" : "Goal plan updated", context);
}

function updateGoalStep(args: JsonObject, context: ToolExecutionContext): ToolResult {
  const state = readGoalState(context.store, context.session_id);
  if (!state) {
    return fail("goal_missing", "No goal to update.");
  }
  if (state.goal.status === "complete" || state.goal.status === "dropped") {
    return fail("goal_closed", `Cannot update a ${state.goal.status} goal.`);
  }
  const stepId = stringArg(args.step_id)?.trim() || state.goal.planning?.active_step_id;
  if (!stepId) {
    return failGoalWithState(state, "goal_step_required", "step_id is required when op=update_step and no active goal step is available");
  }
  const status = parseGoalStepStatus(stringArg(args.status));
  if (args.status !== undefined && !status) {
    return failGoalWithState(state, "goal_step_status_invalid", "status must be pending, in_progress, completed, blocked, or skipped");
  }
  try {
    const next = updateGoalPlanningStep(state, {
      step_id: stepId,
      title: stringArg(args.title),
      status,
      notes: stringArg(args.notes),
      evidence: objectArg(args.evidence),
      active_step_id: stringArg(args.active_step_id),
    });
    return describeGoal(writeGoalState(context.store, context.session_id, next, context.run_id), "Goal step updated", context);
  } catch (error) {
    return failGoalWithState(state, "goal_step_update_failed", error instanceof Error ? error.message : String(error));
  }
}

function updateGoalStrategy(args: JsonObject, context: ToolExecutionContext): ToolResult {
  const state = readGoalState(context.store, context.session_id);
  if (!state) {
    return fail("goal_missing", "No goal to update.");
  }
  if (state.goal.status === "complete" || state.goal.status === "dropped") {
    return fail("goal_closed", `Cannot update a ${state.goal.status} goal.`);
  }
  const mode = parseGoalStrategyModeArg(args.mode);
  if (!mode) {
    return failGoalWithState(state, "goal_strategy_mode_required", "mode is required and must be surgical, opportunistic, or campaign");
  }
  const next = setGoalStrategy(state, {
    mode,
    inferred: args.inferred === undefined ? true : booleanArg(args.inferred),
    target_hours: numberArg(args.target_hours),
    rationale: stringArg(args.rationale),
  });
  return describeGoal(writeGoalState(context.store, context.session_id, next, context.run_id), "Goal strategy updated", context);
}

function updateLedger(args: JsonObject, context: ToolExecutionContext): ToolResult {
  const state = readGoalState(context.store, context.session_id);
  if (!state) {
    return fail("goal_missing", "No goal to update.");
  }
  if (state.goal.status === "complete" || state.goal.status === "dropped") {
    return fail("goal_closed", `Cannot update a ${state.goal.status} goal.`);
  }
  try {
    const next = updateGoalLedger(state, {
      open: candidatesArg(args.open),
      done: candidatesArg(args.done),
      rejected: candidatesArg(args.rejected),
    });
    return describeGoal(writeGoalState(context.store, context.session_id, next, context.run_id), "Goal ledger updated", context);
  } catch (error) {
    return failGoalWithState(state, "goal_ledger_update_failed", error instanceof Error ? error.message : String(error));
  }
}

function recordGoalReflection(args: JsonObject, context: ToolExecutionContext): ToolResult {
  if (context.request_class !== "reflection" || context.visibility !== "internal") {
    return fail("goal_reflection_context_required", "goal reflection decisions can only be recorded by an internal reflection run");
  }
  const state = readGoalState(context.store, context.session_id);
  if (!state) {
    return fail("goal_missing", "No goal to reflect on.");
  }
  if (state.goal.status === "complete" || state.goal.status === "dropped") {
    return failGoalWithState(state, "goal_closed", `Cannot reflect on a ${state.goal.status} goal.`);
  }
  const decision = parseGoalReflectionDecision(stringArg(args.decision));
  if (!decision) {
    return failGoalWithState(state, "goal_reflection_decision_required", "decision is required for op=reflect and must be expand, done, or blocked");
  }
  try {
    const next = completeGoalReflection(
      state,
      {
        decision,
        summary: stringArg(args.summary),
        verification_evidence: objectArg(args.verification_evidence) ?? objectArg(args.evidence),
        blocker: stringArg(args.blocker),
        steps: stepsArg(args.steps),
        active_step_id: stringArg(args.active_step_id),
      },
      context.run_id ?? "",
    );
    const saved = writeGoalState(context.store, context.session_id, next, context.run_id);
    context.store.appendEvent({
      session_id: context.session_id,
      run_id: context.run_id,
      type: "goal.reflection.completed",
      data: {
        goal_id: saved.goal.id,
        source_horizon_generation: state.goal.horizon_generation,
        horizon_generation: saved.goal.horizon_generation,
        decision,
        summary: saved.goal.last_reflection_summary,
        verification_evidence: saved.goal.verification_evidence,
        blocker: saved.goal.blocker,
      },
    });
    if (decision === "expand") {
      context.store.appendEvent({
        session_id: context.session_id,
        run_id: context.run_id,
        type: "goal.horizon.expanded",
        data: {
          goal_id: saved.goal.id,
          previous_horizon_generation: state.goal.horizon_generation,
          horizon_generation: saved.goal.horizon_generation,
          step_count: saved.goal.planning?.steps.length ?? 0,
          active_step_id: saved.goal.planning?.active_step_id,
        },
      });
    }
    return describeGoal(saved, decision === "expand" ? "Goal horizon expanded" : "Goal reflection recorded", context);
  } catch (error) {
    return failGoalWithState(state, "goal_reflection_failed", error instanceof Error ? error.message : String(error));
  }
}

function resumeGoal(context: ToolExecutionContext): ToolResult {
  const state = readGoalState(context.store, context.session_id);
  if (!state) {
    return fail("goal_missing", "No goal to resume.");
  }
  if (state.goal.status === "complete") {
    return fail("goal_complete", "Goal is already complete.");
  }
  if (state.goal.status === "dropped") {
    return fail("goal_dropped", "Cannot resume a dropped goal.");
  }
  const next = cloneGoalState(state);
  next.enabled = true;
  next.goal.status = "active";
  next.goal.updated_at = new Date().toISOString();
  return describeGoal(writeGoalState(context.store, context.session_id, next, context.run_id), "Goal resumed", context);
}

function finishGoal(args: JsonObject, context: ToolExecutionContext, status: "complete" | "dropped"): ToolResult {
  const state = readGoalState(context.store, context.session_id);
  if (!state) {
    return fail("goal_missing", status === "complete" ? "cannot complete goal because no goal is active" : "No goal to drop.");
  }
  if (state.goal.status === "dropped") {
    return fail("goal_dropped", "Goal is already dropped.");
  }
  if (status === "complete" && state.goal.status === "complete") {
    return fail("goal_complete", "Goal is already complete.");
  }
  const summary = stringArg(args.summary)?.trim();
  if (status === "complete" && !summary) {
    return failGoalWithState(state, "goal_summary_required", "summary is required when completing a goal");
  }
  if (status === "complete" && isInternalReflectionContext(context)) {
    return recordGoalReflection(
      {
        ...args,
        op: "reflect",
        decision: "done",
        summary,
        verification_evidence: objectArg(args.verification_evidence) ?? objectArg(args.evidence) ?? { summary },
      },
      context,
    );
  }
  if (status === "complete") {
    const incompleteMessage = incompleteGoalPlanningMessage(state.goal);
    if (incompleteMessage) {
      return failGoalWithState(state, "goal_incomplete_plan", incompleteMessage);
    }
    const reflectionMessage = goalCompletionReflectionBlockMessage(state.goal);
    if (reflectionMessage) {
      return failGoalWithState(state, "goal_reflection_required", reflectionMessage);
    }
    const candidateMessage = goalCompletionCandidateBlockMessage(state.goal);
    if (candidateMessage) {
      return failGoalWithState(state, "goal_completion_candidates_remaining", candidateMessage);
    }
  }
  const next = cloneGoalState(state);
  if (summary) {
    next.goal.summary = summary;
  }
  next.enabled = false;
  next.goal.status = status;
  next.goal.updated_at = new Date().toISOString();
  return describeGoal(writeGoalState(context.store, context.session_id, next, context.run_id), status === "complete" ? "Goal complete" : "Goal dropped", context);
}

function isInternalReflectionContext(context: ToolExecutionContext): boolean {
  return context.request_class === "reflection" && context.visibility === "internal";
}

function failGoalWithState(state: GoalState, code: string, message: string, extra: JsonObject = {}): ToolResult {
  return fail(code, message, {
    enabled: state.enabled,
    goal: state.goal as unknown as JsonObject,
    remaining_tokens: state.goal.token_budget === undefined ? null : Math.max(0, state.goal.token_budget - state.goal.tokens_used),
    ...extra,
  });
}

function describeGoal(state: GoalState | undefined, summary: string, context?: ToolExecutionContext): ToolResult {
  if (!state) {
    return ok("No goal set.", { goal: null });
  }
  const goal = state.goal;
  const horizons = context ? readGoalHorizons(context.store, context.session_id, goal.id) : [];
  const completion =
    goal.status === "complete"
      ? {
          completion_summary: goal.summary ?? null,
          completion_budget_report: completionBudgetReport(goal) ?? null,
        }
      : {};
  return ok(goalSummary(summary, goal), {
    enabled: state.enabled,
    goal: goal as unknown as JsonObject,
    horizons: horizons as unknown as JsonObject[],
    remaining_tokens: goal.token_budget === undefined ? null : Math.max(0, goal.token_budget - goal.tokens_used),
    ...completion,
  });
}

function goalSummary(prefix: string, goal: GoalRecord): string {
  const lines = [`${prefix}: ${goal.objective}`, `Status: ${goal.status}`];
  if (goal.token_budget !== undefined || goal.tokens_used > 0) {
    lines.push(
      goal.token_budget === undefined
        ? `${goal.tokens_used} tokens used`
        : `${goal.tokens_used} / ${goal.token_budget} tokens used`,
    );
  }
  if (goal.time_used_ms > 0) {
    lines.push(`Time: ${formatGoalDuration(goal)}`);
  }
  if (goal.planning) {
    lines.push(`Horizon: ${goal.horizon_generation}`);
    lines.push(`Plan: ${goalPlanningProgressSummary(goal.planning)}`);
    const active = goal.planning.active_step_id ? goal.planning.steps.find((step) => step.id === goal.planning!.active_step_id) : undefined;
    if (active) {
      lines.push(`Active step: ${active.id} ${active.title}`);
    }
  }
  if (goal.last_reflection_decision) {
    lines.push(`Last reflection: ${goal.last_reflection_decision}${goal.last_reflection_summary ? ` - ${goal.last_reflection_summary}` : ""}`);
  }
  if (goal.status === "complete" && goal.summary) {
    lines.push(`Completion summary: ${goal.summary}`);
  }
  if (goal.status === "complete") {
    const report = completionBudgetReport(goal);
    if (report) {
      lines.push(report);
    }
  }
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function booleanArg(value: unknown): boolean {
  return value === true;
}

function objectArg(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

function parseGoalStrategyModeArg(value: unknown): GoalStrategyMode | undefined {
  return value === "surgical" || value === "opportunistic" || value === "campaign" ? value : undefined;
}

function parseGoalCandidateValueArg(value: unknown): GoalCandidateValue | undefined {
  return value === "high" || value === "medium" || value === "low" ? value : undefined;
}

function candidatesArg(value: unknown): GoalCandidateInput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const candidates: GoalCandidateInput[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const title = item.trim();
      if (title) {
        candidates.push({ title });
      }
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const data = item as Record<string, unknown>;
    const title = stringArg(data.title)?.trim();
    if (!title) {
      continue;
    }
    candidates.push({
      id: stringArg(data.id),
      title,
      source: stringArg(data.source),
      value: parseGoalCandidateValueArg(data.value),
      reason: stringArg(data.reason),
      evidence: objectArg(data.evidence),
    });
  }
  return candidates.length ? candidates : undefined;
}

function stepsArg(value: unknown): GoalPlanningStepInput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const steps: GoalPlanningStepInput[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const title = item.trim();
      if (title) {
        steps.push({ title });
      }
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const data = item as Record<string, unknown>;
    const title = stringArg(data.title)?.trim();
    if (!title) {
      continue;
    }
    const status = parseGoalStepStatus(stringArg(data.status));
    steps.push({
      id: stringArg(data.id),
      title,
      status,
      notes: stringArg(data.notes),
      evidence: objectArg(data.evidence),
    });
  }
  return steps.length ? steps : undefined;
}
