export function buildGoalWorkPrompt(objective: string): string {
  return [
    `Goal objective: ${objective}`,
    "Continue the active goal horizon.",
    "If this is Horizon 0 orientation, inspect enough context to infer the goal strategy, call goal op=set_strategy, seed the candidate ledger with goal op=update_ledger, and complete the orientation steps.",
    "Keep step status, notes, and evidence current with goal op=update_step. Do not complete the goal merely because the current horizon is empty.",
  ].join("\n");
}

export function buildGoalReflectionPrompt(objective: string): string {
  return [
    `Goal objective: ${objective}`,
    "Run an internal reflection for the active goal.",
    "Step back from the just-finished turn, the current plan, and the current evidence.",
    "Use available tools as needed to pursue the best-effort version of the objective: as complete, polished, and semantically faithful as the current session can reasonably make it.",
    "Treat the current plan as a hypothesis, not as the boundary of the objective.",
    "Use the candidate ledger as the durable search space. Add, complete, or reject candidates with goal op=update_ledger when reflection changes what remains.",
    "Look for better decomposition, missing verification, rough edges, or unfinished work implied by the top-level objective, even if all listed steps are complete.",
    "Hard stop condition: only accept new work when it has substantive impact on the original objective; otherwise choose decision=done.",
    "Finish by calling goal op=reflect exactly once.",
    "Do not call goal op=complete from a reflection run; completion happens after the reflection decision is recorded.",
    "Use decision=expand only with concrete new horizon steps whose impact on the original objective is substantive.",
    "Use decision=done when no visible completion, verification, decomposition, or polish work with substantive impact remains, and include verification_evidence.",
    "Use decision=blocked with blocker details when completion cannot proceed without user input or an external state change.",
  ].join("\n");
}
