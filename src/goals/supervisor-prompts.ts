export function buildGoalWorkPrompt(objective: string): string {
  return [
    `Goal objective: ${objective}`,
    "Continue the active goal frontier. If no frontier exists, decompose it with the goal tool first.",
    "Keep step status, notes, and evidence current with goal op=update_step. Do not complete the goal merely because the current frontier is empty.",
  ].join("\n");
}

export function buildGoalAuditPrompt(objective: string): string {
  return [
    `Goal objective: ${objective}`,
    "Run an internal read-only frontier exhaustion audit for the active goal.",
    "Use available read/search/git/code-intelligence/verification tools as needed to decide whether the top-level objective has more undiscovered frontier.",
    "Treat the current plan as a hypothesis, not as the boundary of the objective.",
    "Actively look for missing work implied by the top-level objective, even if all listed steps are complete.",
    "Do not edit files or execute new business work in this audit.",
    "Finish by calling goal op=audit exactly once.",
    "Use decision=expand with concrete new steps if more frontier exists.",
    "Use decision=done only if no new frontier exists and include verification_evidence.",
    "Use decision=blocked or retry with blocker details when completion cannot be determined.",
  ].join("\n");
}
