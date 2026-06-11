import type { JsonObject, ToolResult } from "../types.js";
import { fail, ok } from "../util/limit.js";
import type { ToolExecutionContext } from "./context.js";
import {
  blockGoalForReview,
  clearGoalPendingReviewDecision,
  cloneGoalState,
  completeGoalAfterReflection,
  completeGoalReflection,
  completionBudgetReport,
  createGoalState,
  formatGoalDuration,
  goalCompletionCandidateBlockMessage,
  goalCompletionReflectionBlockMessage,
  goalStrategyModeFromPublicName,
  incompleteGoalPlanningMessage,
  goalPlanningProgressSummary,
  parseGoalReflectionDecision,
  parseGoalHilPolicy,
  parseGoalStepStatus,
  recordGoalCompletionReport,
  readGoalHorizons,
  readGoalState,
  replaceGoalPlanning,
  setGoalVerifierPolicy,
  setGoalOwner,
  setGoalReviewOwner,
  setGoalStrategy,
  stageGoalReviewDecision,
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
  type GoalKind,
  type GoalCommandVerifierInput,
} from "../goals/state.js";
import { readAutoresearchState, researchCompletionBlockMessage, setAutoresearchMode } from "../autoresearch/state.js";
import {
  humanReviewVerificationVerdict,
  goalVerifierPolicyCompletionBlockMessage,
  recordGoalVerification,
  reflectionVerificationVerdict,
} from "../loop/verification.js";
import type { GoalLoopVerificationConfidence, GoalLoopVerificationProvider, GoalLoopVerificationVerdict } from "../loop/types.js";

const CONTROL_PLANE_GOAL_OPS = new Set(["create", "review_decision", "resume", "complete", "drop"]);
const LOOP_SKILL_ID = "inferoa-loop-skill";
const WORKSPACE_SKILL_ID = "inferoa-workspace-skill";

export async function goalTool(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const op = stringArg(args.op) ?? "get";
  if (CONTROL_PLANE_GOAL_OPS.has(op) && !context.control_plane) {
    return fail(
      "goal_control_plane_required",
      `goal op=${op} is a loop control-plane action. Use /loop for user-facing loop creation, review, resume, completion, or drop.`,
    );
  }
  const verificationOperation = handleVerificationGoalOperation(op, context);
  if (verificationOperation) {
    return verificationOperation;
  }
  const reflectionOperation = handleInternalReflectionGoalOperation(op, args, context);
  if (reflectionOperation) {
    return reflectionOperation;
  }
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
      case "verify":
        return recordGoalVerificationTool(args, context);
      case "review_decision":
        return reviewGoalDecision(args, context);
      case "set_strategy":
        return updateGoalStrategy(args, context);
      case "set_owner":
        return updateGoalOwner(args, context);
      case "clear_owner":
        return updateGoalOwner({ owner: "" }, context);
      case "set_review_owner":
        return updateGoalReviewOwner(args, context);
      case "clear_review_owner":
        return updateGoalReviewOwner({ review_owner: "" }, context);
      case "set_verifier_policy":
        return updateGoalVerifierPolicy(args, context);
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

interface GoalVerificationReflectionInput {
  decision: string;
  summary?: string;
  verification_evidence?: JsonObject;
  blocker?: string;
}

function handleVerificationGoalOperation(op: string, context: ToolExecutionContext): ToolResult | undefined {
  if (context.request_class !== "verification") {
    return undefined;
  }
  if (op === "get" || op === "verify") {
    return undefined;
  }
  const state = readGoalState(context.store, context.session_id);
  return state
    ? failGoalWithState(state, "goal_verification_read_only", "Verification runs can only inspect goal state or record goal op=verify.")
    : fail("goal_missing", "No goal to verify.");
}

function handleInternalReflectionGoalOperation(op: string, args: JsonObject, context: ToolExecutionContext): ToolResult | undefined {
  if (!isInternalReflectionContext(context)) {
    return undefined;
  }
  if (op === "get" || op === "reflect" || op === "update_ledger") {
    return undefined;
  }
  if (op === "decompose" || op === "update_plan") {
    const steps = stepsArg(args.steps);
    if (steps?.length) {
      return recordGoalReflection(
        {
          ...args,
          op: "reflect",
          decision: "expand",
          summary: stringArg(args.summary) ?? "Reflection found another horizon.",
        },
        context,
      );
    }
  }
  const state = readGoalState(context.store, context.session_id);
  const message =
    op === "decompose" || op === "update_plan" || op === "update_step"
      ? "Internal reflection cannot update the current horizon directly. Call goal op=reflect with decision=expand and concrete steps, decision=done with verification_evidence, or decision=blocked."
      : `Internal reflection cannot call goal op=${op}. Call goal op=reflect with decision=expand, done, or blocked.`;
  return state ? failGoalWithState(state, "goal_reflection_decision_required", message) : fail("goal_missing", "No goal to reflect on.");
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
  const mode = parseGoalStrategyModeArg(args.approach ?? args.mode);
  if ((args.approach !== undefined || args.mode !== undefined) && !mode) {
    return fail("goal_strategy_mode_invalid", "approach must be focus, explore, or timebox");
  }
  const kind = parseGoalKindArg(args.kind);
  if (args.kind !== undefined && !kind) {
    return fail("goal_kind_invalid", "kind must be task or research");
  }
  const hilPolicy = parseGoalHilPolicy(args.hil_policy);
  if (args.hil_policy !== undefined && !hilPolicy) {
    return fail("goal_hil_policy_invalid", "hil_policy must be auto or review");
  }
  let state = createGoalState({
    objective,
    owner: stringArg(args.owner),
    review_owner: stringArg(args.review_owner),
    kind,
    hil_policy: hilPolicy,
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
  if (state.goal.kind === "research") {
    setAutoresearchMode(context.store, context.session_id, { mode: "on", goal: state.goal.objective }, context.run_id);
  }
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
  return describeGoal(writeGoalState(context.store, context.session_id, next, context.run_id), steps ? "Loop decomposed" : "Loop plan updated", context);
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
    return describeGoal(writeGoalState(context.store, context.session_id, next, context.run_id), "Loop step updated", context);
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
  const mode = parseGoalStrategyModeArg(args.approach ?? args.mode);
  if (!mode) {
    return failGoalWithState(state, "goal_strategy_mode_required", "approach is required and must be focus, explore, or timebox");
  }
  const next = setGoalStrategy(state, {
    mode,
    inferred: args.inferred === undefined ? true : booleanArg(args.inferred),
    target_hours: numberArg(args.target_hours),
    rationale: stringArg(args.rationale),
  });
  return describeGoal(writeGoalState(context.store, context.session_id, next, context.run_id), "Goal strategy updated", context);
}

function updateGoalOwner(args: JsonObject, context: ToolExecutionContext): ToolResult {
  const state = readGoalState(context.store, context.session_id);
  if (!state) {
    return fail("goal_missing", "No goal to assign.");
  }
  if (state.goal.status === "complete" || state.goal.status === "dropped") {
    return fail("goal_closed", `Cannot update owner for a ${state.goal.status} goal.`);
  }
  const owner = stringArg(args.owner)?.trim();
  const next = setGoalOwner(state, owner);
  const saved = writeGoalState(context.store, context.session_id, next, context.run_id);
  return describeGoal(saved, saved.goal.owner ? "Loop owner set" : "Loop owner cleared", context);
}

function updateGoalReviewOwner(args: JsonObject, context: ToolExecutionContext): ToolResult {
  const state = readGoalState(context.store, context.session_id);
  if (!state) {
    return fail("goal_missing", "No goal to assign for review.");
  }
  if (state.goal.status === "complete" || state.goal.status === "dropped") {
    return fail("goal_closed", `Cannot update review owner for a ${state.goal.status} goal.`);
  }
  const owner = stringArg(args.review_owner)?.trim();
  const next = setGoalReviewOwner(state, owner);
  const saved = writeGoalState(context.store, context.session_id, next, context.run_id);
  return describeGoal(saved, saved.goal.review_owner ? "Loop review owner set" : "Loop review owner cleared", context);
}

function updateGoalVerifierPolicy(args: JsonObject, context: ToolExecutionContext): ToolResult {
  const state = readGoalState(context.store, context.session_id);
  if (!state) {
    return fail("goal_missing", "No goal to update.");
  }
  if (state.goal.status === "complete" || state.goal.status === "dropped") {
    return fail("goal_closed", `Cannot update a ${state.goal.status} goal.`);
  }
  const commandVerifiers = commandVerifiersArg(args.command_verifiers);
  if (!commandVerifiers) {
    return failGoalWithState(state, "goal_verifier_policy_required", "command_verifiers is required for op=set_verifier_policy.");
  }
  try {
    const next = setGoalVerifierPolicy(state, { command_verifiers: commandVerifiers });
    const saved = writeGoalState(context.store, context.session_id, next, context.run_id);
    context.store.appendEvent({
      session_id: context.session_id,
      run_id: context.run_id,
      type: "goal.verifier_policy.updated",
      data: {
        goal_id: saved.goal.id,
        command_verifier_count: saved.goal.verifier_policy?.command_verifiers.length ?? 0,
      },
    });
    return describeGoal(saved, "Goal verifier policy updated", context);
  } catch (error) {
    return failGoalWithState(state, "goal_verifier_policy_failed", error instanceof Error ? error.message : String(error));
  }
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
    const input = {
      decision,
      summary: stringArg(args.summary),
      verification_evidence: objectArg(args.verification_evidence) ?? objectArg(args.evidence),
      blocker: stringArg(args.blocker),
      steps: stepsArg(args.steps),
      active_step_id: stringArg(args.active_step_id),
    };
    if (state.goal.hil_policy === "review") {
      const next = stageGoalReviewDecision(state, input, context.run_id ?? "");
      const saved = writeGoalState(context.store, context.session_id, next, context.run_id);
      context.store.appendEvent({
        session_id: context.session_id,
        run_id: context.run_id,
        type: "goal.review.pending",
        data: {
          goal_id: saved.goal.id,
          pending_decision_id: saved.goal.pending_review_decision?.id,
          source_horizon_generation: state.goal.horizon_generation,
          action: decision,
          summary: saved.goal.pending_review_decision?.summary,
          verification_evidence: saved.goal.pending_review_decision?.verification_evidence,
          blocker: saved.goal.pending_review_decision?.blocker,
          step_count: saved.goal.pending_review_decision?.steps?.length ?? 0,
        },
      });
      appendReflectionVerificationRecord(context, state, saved, input);
      return describeGoal(saved, "Goal review pending", context);
    }
    const next = completeGoalReflection(state, input, context.run_id ?? "");
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
    appendReflectionVerificationRecord(context, state, saved, input);
    appendSkillRuleApplied(context, saved.goal, LOOP_SKILL_ID, {
      target: "loop_skill",
      rule_id: "loop-reflection-verification-used",
      rule_summary: "Loop Skill guided a reflection decision with explicit verification or blocker evidence.",
      decision,
      evidence: {
        verification_evidence: input.verification_evidence,
        blocker: input.blocker,
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
    return describeGoal(saved, decision === "expand" ? "Loop task expanded" : "Loop decision recorded", context);
  } catch (error) {
    return failGoalWithState(state, "goal_reflection_failed", error instanceof Error ? error.message : String(error));
  }
}

function recordGoalVerificationTool(args: JsonObject, context: ToolExecutionContext): ToolResult {
  const state = readGoalState(context.store, context.session_id);
  if (!state) {
    return fail("goal_missing", "No goal to verify.");
  }
  const verdict = parseVerificationVerdictArg(args.verdict ?? args.decision);
  if (!verdict) {
    return failGoalWithState(state, "goal_verification_verdict_required", "verdict is required for op=verify and must be pass, fail, partial, blocked, or unknown.");
  }
  const provider = parseVerificationProviderArg(args.provider) ?? (context.request_class === "verification" ? "checker" : "human");
  if (provider === "reflection" || provider === "research") {
    return failGoalWithState(state, "goal_verification_provider_reserved", "Use op=reflect for reflection verification and autoresearch tools for research verification.");
  }
  if (provider === "checker" && context.request_class !== "verification") {
    return failGoalWithState(state, "goal_checker_requires_verification_run", "checker verification must be recorded from a verification run.");
  }
  const confidence = parseVerificationConfidenceArg(args.confidence) ?? (provider === "command" ? "hard" : "soft");
  const record = recordGoalVerification(context.store, context.session_id, {
    provider,
    verdict,
    confidence,
    goal_id: state.goal.id,
    horizon_generation: state.goal.horizon_generation,
    run_id: context.run_id,
    evidence: objectArg(args.evidence) ?? objectArg(args.verification_evidence),
    evidence_resource_uri: stringArg(args.evidence_resource_uri),
    metrics: objectArg(args.metrics),
    summary: stringArg(args.summary),
    failure_reason: stringArg(args.failure_reason) ?? stringArg(args.blocker),
  }, context.run_id);
  if (provider === "command" || provider === "checker" || provider === "connector") {
    appendSkillRuleApplied(context, state.goal, WORKSPACE_SKILL_ID, {
      target: "workspace_skill",
      rule_id: provider === "command" ? "workspace-command-verifier-used" : "workspace-verifier-used",
      rule_summary: "Workspace Skill guided verifier selection for workspace validation.",
      decision: verdict,
      evidence: {
        provider,
        confidence,
        verification_id: record.verification_id,
        evidence: record.evidence,
      },
    });
  }
  return ok(`Recorded ${provider} verification: ${verdict}`, { verification: record as unknown as JsonObject });
}

function reviewGoalDecision(args: JsonObject, context: ToolExecutionContext): ToolResult {
  const state = readGoalState(context.store, context.session_id);
  if (!state) {
    return fail("goal_missing", "No goal to review.");
  }
  const pending = state.goal.pending_review_decision;
  if (!pending) {
    return failGoalWithState(state, "goal_review_missing", "No pending goal review decision.");
  }
  const decision = parseReviewDecisionArg(args.review_decision ?? args.decision);
  if (!decision) {
    return failGoalWithState(state, "goal_review_decision_required", "review_decision must be approve, reject, revise, or block");
  }
  const feedback = stringArg(args.feedback) ?? stringArg(args.summary);
  try {
    if (decision === "approve") {
      return approveGoalReviewDecision(state, context);
    }
    const next =
      decision === "block"
        ? blockGoalForReview(state, feedback)
        : clearGoalPendingReviewDecision(state, feedback);
    const saved = writeGoalState(context.store, context.session_id, next, context.run_id);
    appendGoalReviewResolvedEvent(context, state, decision, feedback);
    return describeGoal(saved, decision === "block" ? "Goal review blocked" : "Goal review revised", context);
  } catch (error) {
    return failGoalWithState(state, "goal_review_failed", error instanceof Error ? error.message : String(error));
  }
}

function approveGoalReviewDecision(state: GoalState, context: ToolExecutionContext): ToolResult {
  const pending = state.goal.pending_review_decision;
  if (!pending) {
    return failGoalWithState(state, "goal_review_missing", "No pending goal review decision.");
  }
  const reflectionInput = {
    decision: pending.action,
    summary: pending.summary,
    verification_evidence: pending.verification_evidence,
    blocker: pending.blocker,
    steps: pending.steps,
    active_step_id: pending.active_step_id,
  };
  const reflected = completeGoalReflection(state, reflectionInput, pending.source_run_id ?? context.run_id ?? "");
  if (pending.action === "done") {
    if (reflected.goal.kind === "research") {
      const researchMessage = researchCompletionBlockMessage(readAutoresearchState(context.store, context.session_id));
      if (researchMessage) {
        return failGoalWithState(state, "goal_research_evidence_required", researchMessage);
      }
    }
    const verifierMessage = goalVerifierPolicyCompletionBlockMessage(context.store, context.session_id, reflected.goal, {
      request_class: context.request_class,
    });
    if (verifierMessage) {
      return failGoalWithState(state, "goal_verifier_policy_required", verifierMessage);
    }
    const skillPolicyMessage = goalSkillPolicyCompletionBlockMessage(context, reflected.goal);
    if (skillPolicyMessage) {
      return failGoalWithState(state, "goal_skill_policy_required", skillPolicyMessage);
    }
    appendSkillRuleApplied(context, reflected.goal, LOOP_SKILL_ID, {
      target: "loop_skill",
      rule_id: "loop-completion-gate-satisfied",
      rule_summary: "Loop Skill body was loaded before allowing goal completion.",
      decision: "complete",
      evidence: {
        summary: reflected.goal.last_reflection_summary,
      },
    });
    const completed = completeGoalAfterReflection(reflected, reflected.goal.last_reflection_summary);
    const saved = writeGoalState(context.store, context.session_id, completed, context.run_id);
    appendApprovedReflectionEvents(context, state, saved, pending);
    appendGoalReviewResolvedEvent(context, state, "approve");
    if (saved.goal.kind === "research") {
      setAutoresearchMode(context.store, context.session_id, { mode: "off", goal: saved.goal.objective }, context.run_id);
    }
    recordGoalCompletionReport(context.store, context.session_id, context.run_id ?? pending.source_run_id ?? "");
    return describeGoal(saved, "Loop complete", context);
  }
  if (pending.action === "blocked") {
    const blocked = blockGoalForReview(reflected, pending.blocker ?? pending.summary);
    const saved = writeGoalState(context.store, context.session_id, blocked, context.run_id);
    appendApprovedReflectionEvents(context, state, saved, pending);
    appendGoalReviewResolvedEvent(context, state, "approve");
    return describeGoal(saved, "Goal blocked", context);
  }
  reflected.enabled = true;
  reflected.goal.status = "active";
  const saved = writeGoalState(context.store, context.session_id, reflected, context.run_id);
  appendApprovedReflectionEvents(context, state, saved, pending);
  appendGoalReviewResolvedEvent(context, state, "approve");
  return describeGoal(saved, "Loop task expanded", context);
}

function appendApprovedReflectionEvents(
  context: ToolExecutionContext,
  previous: GoalState,
  saved: GoalState,
  pending: NonNullable<GoalRecord["pending_review_decision"]>,
): void {
  context.store.appendEvent({
    session_id: context.session_id,
    run_id: context.run_id,
    type: "goal.reflection.completed",
    data: {
      goal_id: saved.goal.id,
      source_horizon_generation: pending.source_horizon_generation,
      horizon_generation: saved.goal.horizon_generation,
      decision: pending.action,
      summary: saved.goal.last_reflection_summary,
      verification_evidence: saved.goal.verification_evidence,
      blocker: saved.goal.blocker,
      reviewed: true,
      source_run_id: pending.source_run_id,
    },
  });
  if (pending.action === "expand") {
    context.store.appendEvent({
      session_id: context.session_id,
      run_id: context.run_id,
      type: "goal.horizon.expanded",
      data: {
        goal_id: saved.goal.id,
        previous_horizon_generation: previous.goal.horizon_generation,
        horizon_generation: saved.goal.horizon_generation,
        step_count: saved.goal.planning?.steps.length ?? 0,
        active_step_id: saved.goal.planning?.active_step_id,
        reviewed: true,
      },
    });
  }
}

function appendGoalReviewResolvedEvent(
  context: ToolExecutionContext,
  state: GoalState,
  decision: "approve" | "reject" | "revise" | "block",
  feedback?: string,
): void {
  const pending = state.goal.pending_review_decision;
  context.store.appendEvent({
    session_id: context.session_id,
    run_id: context.run_id,
    type: "goal.review.resolved",
    data: {
      goal_id: state.goal.id,
      pending_decision_id: pending?.id,
      action: pending?.action,
      decision,
      feedback,
    },
  });
  const verdict = humanReviewVerificationVerdict(decision, pending?.action);
  recordGoalVerification(context.store, context.session_id, {
    provider: "human",
    verdict,
    confidence: "hard",
    goal_id: state.goal.id,
    horizon_generation: pending?.source_horizon_generation ?? state.goal.horizon_generation,
    run_id: context.run_id,
    source_run_id: pending?.source_run_id,
    evidence: {
      pending_decision_id: pending?.id,
      proposed_action: pending?.action,
      decision,
      feedback,
    },
    summary: feedback,
    failure_reason: decision === "approve" ? undefined : feedback,
  }, context.run_id);
}

function appendReflectionVerificationRecord(
  context: ToolExecutionContext,
  previous: GoalState,
  saved: GoalState,
  input: GoalVerificationReflectionInput,
): void {
  recordGoalVerification(context.store, context.session_id, {
    provider: "reflection",
    verdict: reflectionVerificationVerdict(input.decision),
    confidence: "soft",
    goal_id: saved.goal.id,
    horizon_generation: previous.goal.horizon_generation,
    run_id: context.run_id,
    evidence: input.verification_evidence,
    summary: input.summary,
    failure_reason: input.blocker,
  }, context.run_id);
}

interface SkillRuleApplicationInput {
  target: "loop_skill" | "workspace_skill";
  rule_id: string;
  rule_summary: string;
  decision?: string;
  evidence?: JsonObject;
}

function appendSkillRuleApplied(
  context: ToolExecutionContext,
  goal: GoalRecord,
  skillId: string,
  input: SkillRuleApplicationInput,
): void {
  const bodyLoad = latestSkillBodyLoadEvent(context, goal.id, skillId);
  if (!bodyLoad) {
    return;
  }
  const alreadyRecorded = context.store.listEvents(context.session_id).some((event) =>
    event.type === "skill.rule.applied"
    && event.run_id === context.run_id
    && event.data.goal_id === goal.id
    && event.data.skill_id === skillId
    && event.data.rule_id === input.rule_id
  );
  if (alreadyRecorded) {
    return;
  }
  context.store.appendEvent({
    session_id: context.session_id,
    run_id: context.run_id,
    type: "skill.rule.applied",
    data: {
      goal_id: goal.id,
      horizon_generation: goal.horizon_generation,
      skill_id: skillId,
      target: input.target,
      body_hash: stringArg(bodyLoad.data.body_hash),
      body_load_run_id: bodyLoad.run_id,
      rule_id: input.rule_id,
      rule_summary: input.rule_summary,
      decision: input.decision,
      evidence: input.evidence,
    },
  });
}

function latestSkillBodyLoadEvent(
  context: ToolExecutionContext,
  goalId: string,
  skillId: string,
): ReturnType<ToolExecutionContext["store"]["listEvents"]>[number] | undefined {
  const loads = context.store
    .listEvents(context.session_id)
    .filter((event) =>
      event.type === "skill.body.loaded"
      && event.data.skill_id === skillId
      && stringArg(event.data.body_hash)
    );
  return loads.filter((event) => event.data.goal_id === goalId).at(-1)
    ?? loads.filter((event) => !event.data.goal_id).at(-1);
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
  if (state.goal.pending_review_decision) {
    return failGoalWithState(state, "goal_review_pending", "Resolve the pending goal review decision before resuming.");
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
  if (status === "complete" && state.goal.pending_review_decision) {
    return failGoalWithState(state, "goal_review_pending", "Resolve the pending goal review decision before completing the goal.");
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
    if (state.goal.kind === "research") {
      const researchMessage = researchCompletionBlockMessage(readAutoresearchState(context.store, context.session_id));
      if (researchMessage) {
        return failGoalWithState(state, "goal_research_evidence_required", researchMessage);
      }
    }
    const verifierMessage = goalVerifierPolicyCompletionBlockMessage(context.store, context.session_id, state.goal, {
      request_class: context.request_class,
    });
    if (verifierMessage) {
      return failGoalWithState(state, "goal_verifier_policy_required", verifierMessage);
    }
    const skillPolicyMessage = goalSkillPolicyCompletionBlockMessage(context, state.goal);
    if (skillPolicyMessage) {
      return failGoalWithState(state, "goal_skill_policy_required", skillPolicyMessage);
    }
    appendSkillRuleApplied(context, state.goal, LOOP_SKILL_ID, {
      target: "loop_skill",
      rule_id: "loop-completion-gate-satisfied",
      rule_summary: "Loop Skill body was loaded before allowing goal completion.",
      decision: "complete",
      evidence: {
        summary,
      },
    });
  }
  const next = cloneGoalState(state);
  if (summary) {
    next.goal.summary = summary;
  }
  next.enabled = false;
  next.goal.status = status;
  next.goal.updated_at = new Date().toISOString();
  const saved = writeGoalState(context.store, context.session_id, next, context.run_id);
  if (saved.goal.kind === "research") {
    setAutoresearchMode(context.store, context.session_id, { mode: "off", goal: saved.goal.objective }, context.run_id);
  }
  return describeGoal(saved, status === "complete" ? "Loop complete" : "Loop dropped", context);
}

function isInternalReflectionContext(context: ToolExecutionContext): boolean {
  return context.request_class === "reflection" && context.visibility === "internal";
}

function goalSkillPolicyCompletionBlockMessage(context: ToolExecutionContext, goal: GoalRecord): string | undefined {
  if (!isSkillEnabled(context, LOOP_SKILL_ID, "Inferoa Loop Skill")) {
    return undefined;
  }
  const load = latestSkillBodyLoadEvent(context, goal.id, LOOP_SKILL_ID);
  if (load) {
    return undefined;
  }
  return "Cannot complete goal while Inferoa Loop Skill is enabled until the Loop Skill body has been read with skill_read for this goal.";
}

function isSkillEnabled(context: ToolExecutionContext, skillId: string, skillName: string): boolean {
  const enabled = new Set(context.config.skills.enabled);
  return enabled.has(skillId) || enabled.has(skillName);
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
    return ok("No loop set.", { goal: null });
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
  const lines = [`${prefix}: ${goal.objective}`, `Type: ${goal.kind}`, `Status: ${goal.status}`];
  if (goal.owner) {
    lines.push(`Owner: ${goal.owner}`);
  }
  if (goal.review_owner) {
    lines.push(`Review owner: ${goal.review_owner}`);
  }
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
    lines.push(`Loop task: ${goal.horizon_generation}`);
    lines.push(`Task plan: ${goalPlanningProgressSummary(goal.planning)}`);
    const active = goal.planning.active_step_id ? goal.planning.steps.find((step) => step.id === goal.planning!.active_step_id) : undefined;
    if (active) {
      lines.push(`Active step: ${active.id} ${active.title}`);
    }
  }
  if (goal.last_reflection_decision) {
    lines.push(`Last decision: ${goal.last_reflection_decision}${goal.last_reflection_summary ? ` - ${goal.last_reflection_summary}` : ""}`);
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
  const publicMode = goalStrategyModeFromPublicName(value);
  if (publicMode) {
    return publicMode;
  }
  return value === "surgical" || value === "opportunistic" || value === "campaign" ? value : undefined;
}

function parseGoalKindArg(value: unknown): GoalKind | undefined {
  return value === "task" || value === "research" ? value : undefined;
}

function parseReviewDecisionArg(value: unknown): "approve" | "reject" | "revise" | "block" | undefined {
  return value === "approve" || value === "reject" || value === "revise" || value === "block" ? value : undefined;
}

function parseVerificationProviderArg(value: unknown): GoalLoopVerificationProvider | undefined {
  return value === "checker" || value === "human" || value === "command" || value === "reflection" || value === "research" ? value : undefined;
}

function parseVerificationVerdictArg(value: unknown): GoalLoopVerificationVerdict | undefined {
  return value === "pass" || value === "fail" || value === "partial" || value === "blocked" || value === "unknown" ? value : undefined;
}

function parseVerificationConfidenceArg(value: unknown): GoalLoopVerificationConfidence | undefined {
  return value === "hard" || value === "soft" || value === "mixed" ? value : undefined;
}

function commandVerifiersArg(value: unknown): GoalCommandVerifierInput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const verifiers: GoalCommandVerifierInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const data = item as Record<string, unknown>;
    const command = stringArg(data.command)?.trim();
    if (!command) {
      continue;
    }
    verifiers.push({
      id: stringArg(data.id),
      command,
      cwd: stringArg(data.cwd),
      required: data.required === false ? false : true,
    });
  }
  return verifiers;
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
