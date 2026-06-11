import { readGoalLoopView } from "./projection.js";
import type { SessionStore } from "../session/store.js";
import type { JsonObject, SessionEvent, WorkspaceIdentity } from "../types.js";
import { shortHash, stableJson } from "../util/hash.js";
import type {
  GoalLoopLearningSignal,
  GoalLoopLearningSignalCategory,
  GoalLoopLearningSignalPolarity,
  GoalLoopVerification,
  GoalLoopView,
} from "./types.js";

export function recordGoalLearningSignals(store: SessionStore, workspace: WorkspaceIdentity): GoalLoopLearningSignal[] {
  const recorded: GoalLoopLearningSignal[] = [];
  for (const session of store.listSessions(workspace.id, { includeArchived: true })) {
    const view = readGoalLoopView(store, session.session_id);
    if (!view.goal) {
      continue;
    }
    const events = store.listEvents(session.session_id);
    const existing = new Set(
      events
        .filter((event) => event.type === "goal.learning_signal.recorded")
        .map((event) => cleanString(event.data.signal_id))
        .filter((signalId): signalId is string => Boolean(signalId)),
    );
    for (const signal of goalLearningSignalCandidates(session.session_id, view, events)) {
      if (existing.has(signal.signal_id)) {
        continue;
      }
      existing.add(signal.signal_id);
      store.appendEvent({
        session_id: session.session_id,
        run_id: signal.source_run_id,
        type: "goal.learning_signal.recorded",
        data: learningSignalToEventData(signal),
      });
      recorded.push(signal);
    }
  }
  return recorded;
}

function goalLearningSignalCandidates(sessionId: string, view: GoalLoopView, events: SessionEvent[]): GoalLoopLearningSignal[] {
  if (!view.goal) {
    return [];
  }
  return [
    ...view.verifications.map((verification) => verificationLearningSignal(sessionId, view.goal!.id, verification)),
    ...events.flatMap((event) => humanFeedbackLearningSignal(sessionId, view.goal!.id, event)),
  ].sort(compareLearningSignals);
}

function verificationLearningSignal(sessionId: string, goalId: string, verification: GoalLoopVerification): GoalLoopLearningSignal {
  const polarity = verificationPolarity(verification);
  const summary = [
    "verification",
    verification.provider,
    verification.verdict,
    verification.confidence,
    verification.horizon_generation !== undefined ? `horizon ${verification.horizon_generation}` : undefined,
    verification.verifier_role ? `role ${verification.verifier_role}` : undefined,
    metricSummary(verification.metrics),
    verification.summary,
    verification.failure_reason,
  ].filter((item): item is string => Boolean(item)).join(" · ");
  const seed = {
    session_id: sessionId,
    category: "verification",
    goal_id: goalId,
    provider: verification.provider,
    verdict: verification.verdict,
    confidence: verification.confidence,
    horizon_generation: verification.horizon_generation,
    run_id: verification.run_id,
    source_run_id: verification.source_run_id,
    verification_id: verification.verification_id,
    summary: verification.summary,
    failure_reason: verification.failure_reason,
    evidence_resource_uri: verification.evidence_resource_uri,
    metrics: verification.metrics,
  };
  return {
    signal_id: learningSignalId(seed),
    category: "verification",
    polarity,
    goal_id: goalId,
    horizon_generation: verification.horizon_generation,
    source_event_type: "goal.verification.recorded",
    source_run_id: verification.run_id ?? verification.source_run_id,
    summary,
    evidence: compactObject({
      provider: verification.provider,
      verdict: verification.verdict,
      confidence: verification.confidence,
      verifier_role: verification.verifier_role,
      metrics: verification.metrics,
      evidence_resource_uri: verification.evidence_resource_uri,
      failure_reason: verification.failure_reason,
    }),
  };
}

function humanFeedbackLearningSignal(sessionId: string, goalId: string, event: SessionEvent): GoalLoopLearningSignal[] {
  if (event.type !== "goal.review.resolved") {
    return [];
  }
  const feedback = cleanString(event.data.feedback);
  if (!feedback) {
    return [];
  }
  const decision = cleanString(event.data.decision);
  const action = cleanString(event.data.action);
  const signal: GoalLoopLearningSignal = {
    signal_id: learningSignalId({
      session_id: sessionId,
      category: "human_feedback",
      event_id: event.id,
      goal_id: goalId,
      run_id: event.run_id,
      decision,
      action,
      feedback,
    }),
    category: "human_feedback",
    polarity: humanFeedbackPolarity(decision),
    goal_id: goalId,
    source_event_id: event.id,
    source_event_type: event.type,
    source_run_id: event.run_id,
    summary: ["human review", decision, action ? `for ${action}` : undefined, feedback].filter((item): item is string => Boolean(item)).join(" · "),
    evidence: compactObject({
      pending_decision_id: cleanString(event.data.pending_decision_id),
      proposed_action: action,
      decision,
      feedback,
    }),
  };
  return [signal];
}

function verificationPolarity(verification: GoalLoopVerification): GoalLoopLearningSignalPolarity {
  if (verification.verdict === "pass") {
    return "positive";
  }
  if (verification.verdict === "fail" || verification.verdict === "blocked") {
    return "negative";
  }
  return "constraint";
}

function humanFeedbackPolarity(decision: string | undefined): GoalLoopLearningSignalPolarity {
  if (decision === "approve") {
    return "positive";
  }
  if (decision === "reject" || decision === "block") {
    return "negative";
  }
  return "constraint";
}

function learningSignalId(seed: JsonObject): string {
  return `sig_${shortHash(stableJson(seed), 12)}`;
}

function learningSignalToEventData(signal: GoalLoopLearningSignal): JsonObject {
  return compactObject({
    signal_id: signal.signal_id,
    category: signal.category,
    polarity: signal.polarity,
    goal_id: signal.goal_id,
    horizon_generation: signal.horizon_generation,
    source_event_id: signal.source_event_id,
    source_event_type: signal.source_event_type,
    source_run_id: signal.source_run_id,
    summary: signal.summary,
    evidence: signal.evidence,
  });
}

function metricSummary(metrics: JsonObject | undefined): string | undefined {
  if (!metrics) {
    return undefined;
  }
  const primary = typeof metrics.primary_metric === "string" ? metrics.primary_metric : undefined;
  const metric = typeof metrics.metric === "number" || typeof metrics.metric === "string" ? String(metrics.metric) : undefined;
  return primary && metric ? `${primary}=${metric}` : metric;
}

function compactObject(input: Record<string, unknown>): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    output[key] = value as JsonObject[string];
  }
  return output;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compareLearningSignals(a: GoalLoopLearningSignal, b: GoalLoopLearningSignal): number {
  return a.signal_id.localeCompare(b.signal_id);
}
