import type { GoalRecord, LoopPreference } from "./state.js";

export function buildLoopExecutionPrompt(goalOrObjective: GoalRecord | string): string {
  const objective = typeof goalOrObjective === "string" ? goalOrObjective : goalOrObjective.objective;
  const preference = typeof goalOrObjective === "string" ? "deliver" : goalOrObjective.preference;
  if (preference === "discover") {
    return [
      `Loop objective: ${objective}`,
      "Execution turn for a Discover loop.",
      "Choose the highest-leverage research move for the objective: inspect, benchmark, compare, hypothesize, or run the experiment that best improves evidence.",
      "The agent decides the benchmark, metric, harness, controls, and comparison shape from the workspace and task evidence.",
      "Execute enough to produce concrete evidence, then interpret what changed and what remains uncertain.",
      "Before ending, update the loop step, ledger, or decomposition with evidence and the next research slice.",
      "Do not treat local checklist completion as research completion.",
    ].join("\n");
  }
  return [
    `Loop objective: ${objective}`,
    "Execution turn for a Deliver loop.",
    "Choose the highest-leverage next action for the top-level objective: inspect, edit, test, compare, or plan only when it improves confidence.",
    "Execute toward an end-to-end outcome, not just the current local checklist.",
    "Verify the change or finding with the strongest practical evidence available this turn.",
    "Before ending, update the loop step, ledger, or decomposition with evidence and the next execution slice.",
    "Do not treat local checklist completion as objective completion.",
  ].join("\n");
}

export function buildLoopDecisionPrompt(goalOrObjective: GoalRecord | string): string {
  const objective = typeof goalOrObjective === "string" ? goalOrObjective : goalOrObjective.objective;
  const preference = typeof goalOrObjective === "string" ? "deliver" : goalOrObjective.preference;
  if (preference === "discover") {
    return [
      `Loop objective: ${objective}`,
      "Decision turn for a Discover loop.",
      "Independently judge whether to expand, complete, or block; inspect narrowly only if missing evidence can change the decision.",
      "Call goal op=reflect exactly once with decision=expand, done, or blocked.",
      "If expanding, include concrete next steps in steps; never use bare expand.",
      "Use done only when completion gates are satisfied and the conclusion follows from concrete evidence; use blocked only when meaningful progress requires user input or external state change.",
      "Use expand when a benchmark, comparison, ablation, failure analysis, guardrail, or alternative hypothesis could materially change the conclusion; if At least runtime is pending, expand with meaningful research work, not filler.",
    ].join("\n");
  }
  return [
    `Loop objective: ${objective}`,
    "Decision turn for a Deliver loop.",
    "Independently judge whether to expand, complete, or block; inspect narrowly only if missing evidence can change the decision.",
    "Call goal op=reflect exactly once with decision=expand, done, or blocked.",
    "If expanding, include concrete next steps in steps; never use bare expand.",
    "Use done only when completion gates are satisfied and no material frontier remains; use blocked only when meaningful progress requires user input or external state change.",
    "Use expand when verification is weak, integration or user-visible behavior is unproven, or the loop only solved a local slice; if At least runtime is pending, expand with meaningful delivery work, not filler.",
  ].join("\n");
}

export function buildGoalWorkPrompt(goalOrObjective: GoalRecord | string): string {
  return buildLoopExecutionPrompt(goalOrObjective);
}

export function buildGoalReflectionPrompt(goalOrObjective: GoalRecord | string): string {
  return buildLoopDecisionPrompt(goalOrObjective);
}

export function loopPreferenceDescription(preference: LoopPreference): string {
  if (preference === "discover") return "Explore, experiment, and learn with evidence";
  if (preference === "replay") return "Repeat one visible prompt for fixed attempts";
  return "Close an end-to-end objective with verification";
}
