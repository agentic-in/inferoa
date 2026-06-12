import { readGoalState } from "../goals/state.js";
import type { SessionStore } from "../session/store.js";
import type { JsonObject, WorkspaceIdentity } from "../types.js";
import { randomId } from "../util/hash.js";
import type { GoalLoopVerification, GoalLoopVerificationConfidence, GoalLoopVerificationVerdict } from "./types.js";
import { recordGoalVerification } from "./verification.js";

export interface VerifyHttpHealthOptions {
  session_id: string;
  url: string;
  expected_status?: number;
  timeout_ms?: number;
  run_id?: string;
}

const DEFAULT_HTTP_VERIFIER_TIMEOUT_MS = 15_000;
const DEFAULT_EXPECTED_STATUS = 200;

export async function verifyHttpHealth(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: VerifyHttpHealthOptions,
): Promise<GoalLoopVerification> {
  void workspace;
  const target = normalizeHttpUrl(options.url);
  const expectedStatus = normalizeExpectedStatus(options.expected_status);
  const state = readGoalState(store, options.session_id);
  if (!state || state.goal.status === "dropped") {
    throw new Error(`Session ${options.session_id} has no verifiable goal.`);
  }
  const runId = options.run_id ?? randomId("verify_http");
  store.appendEvent({
    session_id: options.session_id,
    run_id: runId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      provider: "checker",
      system: "http",
      role: "http-health",
      url: target,
      expected_status: expectedStatus,
    },
  });

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), positiveTimeout(options.timeout_ms));
    let response: Response;
    try {
      response = await fetch(target, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const elapsedMs = Date.now() - started;
    const classified = classifyHttpStatus(response.status, expectedStatus);
    return recordHttpHealthVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      ...classified,
      url: target,
      expected_status: expectedStatus,
      status: response.status,
      status_text: response.statusText,
      response_url: response.url,
      elapsed_ms: elapsedMs,
      summary: httpHealthSummary(target, response.status, expectedStatus, classified.verdict),
      failure_reason: classified.verdict === "pass" ? undefined : `HTTP status ${response.status} did not match expected ${expectedStatus}.`,
    });
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    return recordHttpHealthVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "blocked",
      confidence: "soft",
      url: target,
      expected_status: expectedStatus,
      elapsed_ms: elapsedMs,
      summary: `HTTP health check could not read ${target}.`,
      failure_reason: message,
    });
  }
}

function recordHttpHealthVerification(
  store: SessionStore,
  sessionId: string,
  goalId: string,
  horizonGeneration: number,
  runId: string,
  input: {
    verdict: GoalLoopVerificationVerdict;
    confidence: GoalLoopVerificationConfidence;
    url: string;
    expected_status: number;
    status?: number;
    status_text?: string;
    response_url?: string;
    elapsed_ms: number;
    summary: string;
    failure_reason?: string;
  },
): GoalLoopVerification {
  return recordGoalVerification(store, sessionId, {
    provider: "checker",
    verifier_role: "http-health",
    verdict: input.verdict,
    confidence: input.confidence,
    goal_id: goalId,
    horizon_generation: horizonGeneration,
    run_id: runId,
    evidence: compactJsonObject({
      system: "http",
      verifier: "http-health",
      url: input.url,
      expected_status: input.expected_status,
      status: input.status,
      status_text: input.status_text,
      response_url: input.response_url,
      elapsed_ms: input.elapsed_ms,
    }),
    metrics: {
      reachable: input.status === undefined ? 0 : 1,
      status: input.status ?? 0,
      expected_status: input.expected_status,
      status_match: input.status === input.expected_status ? 1 : 0,
      elapsed_ms: input.elapsed_ms,
    },
    summary: input.summary,
    failure_reason: input.failure_reason,
  }, runId);
}

function classifyHttpStatus(status: number, expectedStatus: number): { verdict: GoalLoopVerificationVerdict; confidence: GoalLoopVerificationConfidence } {
  return status === expectedStatus
    ? { verdict: "pass", confidence: "hard" }
    : { verdict: "fail", confidence: "hard" };
}

function httpHealthSummary(url: string, status: number, expectedStatus: number, verdict: GoalLoopVerificationVerdict): string {
  if (verdict === "pass") {
    return `HTTP health check passed for ${url} with status ${status}.`;
  }
  return `HTTP health check for ${url} returned status ${status}; expected ${expectedStatus}.`;
}

function normalizeHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("HTTP verifier requires a URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("HTTP verifier URL must be absolute.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("HTTP verifier URL must use http or https.");
  }
  return parsed.toString();
}

function normalizeExpectedStatus(value: number | undefined): number {
  const status = value ?? DEFAULT_EXPECTED_STATUS;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error("Expected HTTP status must be an integer from 100 to 599.");
  }
  return status;
}

function positiveTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_HTTP_VERIFIER_TIMEOUT_MS;
}

function compactJsonObject(input: Record<string, string | number | undefined>): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}
