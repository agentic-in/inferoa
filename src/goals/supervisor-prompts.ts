import type { GoalRecord } from "./state.js";

export function buildGoalWorkPrompt(goalOrObjective: GoalRecord | string): string {
  const objective = typeof goalOrObjective === "string" ? goalOrObjective : goalOrObjective.objective;
  const kind = typeof goalOrObjective === "string" ? "task" : goalOrObjective.kind;
  if (kind === "research") {
    return [
      `Loop objective: ${objective}`,
      "Continue the active research loop cycle.",
      "Use the loop task as the research cycle: keep loop steps current with goal op=update_step while maintaining research experiments with init_experiment, run_experiment, log_experiment, update_experiment, and update_notes.",
      "If a benchmark run is pending, log it before starting another run. If no experiment exists, identify or create ./autoresearch.sh, establish metrics and guardrails, initialize a baseline experiment, run it, and log the baseline.",
      "For exploratory work, create separate experiments for distinct hypotheses; keep at most one pending run at a time.",
      "Use metric evidence, guardrail checks, failed runs, rejected experiments, and notes to decide the next useful experiment.",
      "If this is research cycle 0 orientation, inspect enough context to infer the approach, call goal op=set_strategy with approach when needed, seed the candidate ledger, and complete the orientation steps.",
    ].join("\n");
  }
  return [
    `Loop objective: ${objective}`,
    "Continue the active loop task.",
    "If this is loop task 0 orientation, inspect enough context to infer the loop approach, call goal op=set_strategy with approach when needed, seed the candidate ledger with goal op=update_ledger, and complete the orientation steps.",
    "Keep step status, notes, and evidence current with goal op=update_step. Do not complete the loop merely because the current loop task is empty.",
  ].join("\n");
}

export function buildGoalReflectionPrompt(goalOrObjective: GoalRecord | string): string {
  const objective = typeof goalOrObjective === "string" ? goalOrObjective : goalOrObjective.objective;
  const kind = typeof goalOrObjective === "string" ? "task" : goalOrObjective.kind;
  if (kind === "research") {
    return [
      `Loop objective: ${objective}`,
      "Run an internal decision pass for the active research loop.",
      "Step back from the current research cycle, experiment ledger, run history, benchmark evidence, guardrail evidence, notes, and loop task plan.",
      "Treat the current experiments as hypotheses, not as the boundary of the research loop.",
      "Use the candidate ledger and experiment ledger as the durable search space. Add, complete, or reject goal candidates with goal op=update_ledger and update experiment lifecycle with update_experiment when reflection changes what remains.",
      "Use decision=expand when a new research cycle should open a distinct experiment, continue a promising experiment, compare candidates, or run guardrail/regression verification with substantive impact.",
      "Use decision=done only when pending runs are logged, metric evidence is sufficient, high-value experiments are completed or rejected, and verification evidence includes run history, best metric, and guardrail evidence.",
      "Use decision=blocked with blocker details when harness, environment, data, or external dependencies prevent meaningful progress.",
      "Do not call goal op=decompose, op=update_plan, or op=update_step from reflection. New work must be returned through goal op=reflect decision=expand with concrete research-cycle steps.",
      "Finish by calling goal op=reflect exactly once.",
      "Do not call goal op=complete from a decision run; completion happens after the loop decision is recorded.",
    ].join("\n");
  }
  return [
    `Loop objective: ${objective}`,
    "Run an internal decision pass for the active loop.",
    "Step back from the just-finished turn, the current plan, and the current evidence.",
    "Use available tools as needed to pursue the best-effort version of the objective: as complete, polished, and semantically faithful as the current session can reasonably make it.",
    "Treat the current plan as a hypothesis, not as the boundary of the objective.",
    "Use the candidate ledger as the durable search space. Add, complete, or reject candidates with goal op=update_ledger when reflection changes what remains.",
    "Look for better decomposition, missing verification, rough edges, or unfinished work implied by the top-level objective, even if all listed steps are complete.",
    "Hard stop condition: only accept new work when it has substantive impact on the original objective; otherwise choose decision=done.",
    "Do not call goal op=decompose, op=update_plan, or op=update_step from the decision pass. New work must be returned through goal op=reflect decision=expand with steps.",
    "Finish by calling goal op=reflect exactly once.",
    "Do not call goal op=complete from a decision run; completion happens after the loop decision is recorded.",
    "Use decision=expand only with concrete new loop task steps whose impact on the original objective is substantive.",
    "Use decision=done when no visible completion, verification, decomposition, or polish work with substantive impact remains, and include verification_evidence.",
    "Use decision=blocked with blocker details when completion cannot proceed without user input or an external state change.",
  ].join("\n");
}
