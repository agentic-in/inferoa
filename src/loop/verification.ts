import type { SessionStore } from "../session/store.js";
import type { GoalRecord } from "../goals/state.js";
import type { JsonObject, SessionEvent } from "../types.js";
import { randomId } from "../util/hash.js";
import type {
  GoalLoopVerification,
  GoalLoopVerificationConfidence,
  GoalLoopVerificationProvider,
  GoalLoopVerificationVerdict,
} from "./types.js";

export interface GoalVerificationInput {
  provider: GoalLoopVerificationProvider;
  verdict: GoalLoopVerificationVerdict;
  confidence: GoalLoopVerificationConfidence;
  goal_id: string;
  horizon_generation?: number;
  run_id?: string;
  source_run_id?: string;
  verifier_role?: string;
  evidence?: JsonObject;
  evidence_resource_uri?: string;
  metrics?: JsonObject;
  summary?: string;
  failure_reason?: string;
}

export interface CommandVerifierResultInput {
  command: string;
  cwd?: string;
  code: number | null;
  timed_out?: boolean;
  run_id?: string;
  tool_call_id?: string;
  resource_uri?: string;
  output_excerpt?: string;
}

export interface GoalVerifierPolicyCompletionOptions {
  request_class?: string;
}

export function recordGoalVerification(
  store: SessionStore,
  sessionId: string,
  input: GoalVerificationInput,
  eventRunId?: string,
): GoalLoopVerification {
  const record: GoalLoopVerification = {
    verification_id: randomId("ver"),
    provider: input.provider,
    verdict: input.verdict,
    confidence: input.confidence,
    goal_id: input.goal_id,
    horizon_generation: input.horizon_generation,
    run_id: input.run_id ?? eventRunId,
    source_run_id: input.source_run_id,
    verifier_role: input.verifier_role,
    evidence: input.evidence,
    evidence_resource_uri: input.evidence_resource_uri,
    metrics: input.metrics,
    summary: cleanOptionalString(input.summary),
    failure_reason: cleanOptionalString(input.failure_reason),
  };
  store.appendEvent({
    session_id: sessionId,
    run_id: eventRunId ?? record.run_id,
    type: "goal.verification.recorded",
    data: verificationToEventData(record),
  });
  return record;
}

export function readGoalVerificationRecords(
  store: SessionStore,
  sessionId: string,
  goalId?: string,
): GoalLoopVerification[] {
  const events = store.listEvents(sessionId);
  const verifierRoles = verificationRequestRoles(events);
  return events
    .filter((event) => event.type === "goal.verification.recorded")
    .map(parseVerificationEvent)
    .map((record) => record ? withVerifierRole(record, verifierRoles) : undefined)
    .filter((record): record is GoalLoopVerification => Boolean(record && (!goalId || record.goal_id === goalId)))
    .sort(compareVerifications);
}

export function recordCommandVerificationFromPolicy(
  store: SessionStore,
  sessionId: string,
  goal: GoalRecord,
  input: CommandVerifierResultInput,
): GoalLoopVerification | undefined {
  const verifier = goal.verifier_policy?.command_verifiers.find((item) => {
    if (item.command !== input.command) {
      return false;
    }
    return !item.cwd || normalizeVerifierCwd(item.cwd) === normalizeVerifierCwd(input.cwd);
  });
  if (!verifier) {
    return undefined;
  }
  const passed = input.code === 0 && input.timed_out !== true;
  return recordGoalVerification(store, sessionId, {
    provider: "command",
    verdict: passed ? "pass" : "fail",
    confidence: "hard",
    goal_id: goal.id,
    horizon_generation: goal.horizon_generation,
    run_id: input.run_id,
    evidence_resource_uri: input.resource_uri,
    evidence: {
      verifier_id: verifier.id,
      command: input.command,
      cwd: normalizeVerifierCwd(input.cwd) ?? ".",
      required: verifier.required,
      exit_code: input.code,
      timed_out: Boolean(input.timed_out),
      tool_call_id: input.tool_call_id,
      output_excerpt: input.output_excerpt,
    },
    summary: `${verifier.id} exited ${input.code}${input.timed_out ? " after timeout" : ""}`,
    failure_reason: passed ? undefined : `${verifier.id} command verifier failed`,
  }, input.run_id);
}

export function goalVerifierPolicyCompletionBlockMessage(
  store: SessionStore,
  sessionId: string,
  goal: GoalRecord,
  options: GoalVerifierPolicyCompletionOptions = {},
): string | undefined {
  const required = goal.verifier_policy?.command_verifiers.filter((item) => item.required) ?? [];
  const records = readGoalVerificationRecords(store, sessionId, goal.id).filter(
    (record) => record.horizon_generation === goal.horizon_generation,
  );
  if (!required.length) {
    const unattendedBlock = unattendedCompletionBlockMessage(goal, records, options);
    if (unattendedBlock) {
      return unattendedBlock;
    }
    return undefined;
  }
  const missingOrFailed = requiredCommandVerifiersMissingOrFailed(records, required);
  const visible = missingOrFailed.slice(0, 6).map((item) => item.id).join(", ");
  const suffix = missingOrFailed.length > 6 ? `, and ${missingOrFailed.length - 6} more` : "";
  if (missingOrFailed.length) {
    return `Cannot complete goal until required command verifiers pass for horizon ${goal.horizon_generation}: ${visible}${suffix}`;
  }
  return unattendedCompletionBlockMessage(goal, records, options);
}

export function reflectionVerificationVerdict(decision: string): GoalLoopVerificationVerdict {
  if (decision === "done") {
    return "pass";
  }
  if (decision === "blocked") {
    return "blocked";
  }
  if (decision === "expand") {
    return "partial";
  }
  return "unknown";
}

export function researchVerificationVerdict(status: string): GoalLoopVerificationVerdict {
  if (status === "keep") {
    return "pass";
  }
  if (status === "crash" || status === "checks_failed") {
    return "fail";
  }
  if (status === "discard") {
    return "partial";
  }
  return "unknown";
}

export function humanReviewVerificationVerdict(decision: string, proposedAction?: string): GoalLoopVerificationVerdict {
  if (decision === "block") {
    return "blocked";
  }
  if (decision === "reject" || decision === "revise") {
    return "fail";
  }
  return reflectionVerificationVerdict(proposedAction ?? "");
}

function parseVerificationEvent(event: SessionEvent): GoalLoopVerification | undefined {
  const provider = parseProvider(event.data.provider);
  const verdict = parseVerdict(event.data.verdict);
  const confidence = parseConfidence(event.data.confidence);
  const goalId = stringValue(event.data.goal_id);
  if (!provider || !verdict || !confidence || !goalId) {
    return undefined;
  }
  return {
    verification_id: stringValue(event.data.verification_id),
    provider,
    verdict,
    confidence,
    goal_id: goalId,
    horizon_generation: numberValue(event.data.horizon_generation),
    run_id: stringValue(event.data.run_id) ?? event.run_id,
    source_run_id: stringValue(event.data.source_run_id),
    verifier_role: stringValue(event.data.verifier_role) ?? stringValue(event.data.role),
    evidence: objectValue(event.data.evidence),
    evidence_resource_uri: stringValue(event.data.evidence_resource_uri),
    metrics: objectValue(event.data.metrics),
    summary: stringValue(event.data.summary),
    failure_reason: stringValue(event.data.failure_reason),
    created_at: event.created_at,
  };
}

function verificationToEventData(record: GoalLoopVerification): JsonObject {
  return {
    verification_id: record.verification_id,
    provider: record.provider,
    verdict: record.verdict,
    confidence: record.confidence,
    goal_id: record.goal_id,
    horizon_generation: record.horizon_generation,
    run_id: record.run_id,
    source_run_id: record.source_run_id,
    verifier_role: record.verifier_role,
    evidence: record.evidence,
    evidence_resource_uri: record.evidence_resource_uri,
    metrics: record.metrics,
    summary: record.summary,
    failure_reason: record.failure_reason,
  };
}

function verificationRequestRoles(events: SessionEvent[]): Map<string, string> {
  const roles = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "goal.verification.requested" || !event.run_id) {
      continue;
    }
    const role = stringValue(event.data.verifier_role) ?? stringValue(event.data.role);
    if (role) {
      roles.set(event.run_id, role);
    }
  }
  return roles;
}

function withVerifierRole(record: GoalLoopVerification, verifierRoles: Map<string, string>): GoalLoopVerification {
  if (record.verifier_role || !record.run_id) {
    return record;
  }
  const role = verifierRoles.get(record.run_id);
  return role ? { ...record, verifier_role: role } : record;
}

function compareVerifications(a: GoalLoopVerification, b: GoalLoopVerification): number {
  return (a.created_at ?? "").localeCompare(b.created_at ?? "") || (a.verification_id ?? "").localeCompare(b.verification_id ?? "");
}

function requiredCommandVerifiersMissingOrFailed(
  records: GoalLoopVerification[],
  required: NonNullable<GoalRecord["verifier_policy"]>["command_verifiers"],
): NonNullable<GoalRecord["verifier_policy"]>["command_verifiers"] {
  const commandRecords = records.filter((record) => record.provider === "command");
  return required.filter((verifier) => {
    const latest = commandRecords
      .filter((record) => record.evidence?.verifier_id === verifier.id)
      .at(-1);
    return latest?.verdict !== "pass";
  });
}

function unattendedCompletionBlockMessage(
  goal: GoalRecord,
  records: GoalLoopVerification[],
  options: GoalVerifierPolicyCompletionOptions,
): string | undefined {
  if (options.request_class !== "background" || goal.hil_policy === "review") {
    return undefined;
  }
  if (records.some(isStrongCompletionVerification)) {
    return undefined;
  }
  const providers = goal.kind === "research"
    ? "research metric, command, human review, or checker"
    : "command, human review, or checker";
  return `Cannot auto-complete unattended ${goal.kind} goal until horizon ${goal.horizon_generation} has a pass verification from ${providers}. Reflection-only evidence is not enough for background completion.`;
}

function isStrongCompletionVerification(record: GoalLoopVerification): boolean {
  if (record.verdict !== "pass") {
    return false;
  }
  if (record.provider === "command") {
    return record.confidence === "hard";
  }
  if (record.provider === "research") {
    return record.confidence === "hard" || record.confidence === "mixed";
  }
  if (record.provider === "human") {
    return record.confidence === "hard";
  }
  return record.provider === "checker";
}

function parseProvider(value: unknown): GoalLoopVerificationProvider | undefined {
  return value === "reflection" || value === "research" || value === "human" || value === "checker" || value === "command" ? value : undefined;
}

function normalizeVerifierCwd(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === ".") {
    return undefined;
  }
  return trimmed.replace(/\\/g, "/").replace(/\/+$/, "") || undefined;
}

function parseVerdict(value: unknown): GoalLoopVerificationVerdict | undefined {
  return value === "pass" || value === "fail" || value === "partial" || value === "blocked" || value === "unknown" ? value : undefined;
}

function parseConfidence(value: unknown): GoalLoopVerificationConfidence | undefined {
  return value === "hard" || value === "soft" || value === "mixed" ? value : undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}
