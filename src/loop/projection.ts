import { readAutoresearchState } from "../autoresearch/state.js";
import { readGoalHorizons, readGoalReflections, readGoalState } from "../goals/state.js";
import type { SessionStore } from "../session/store.js";
import type { JsonObject, SessionEvent } from "../types.js";
import type {
  GoalLoopAttempt,
  GoalLoopLearningSignal,
  GoalLoopLearningSignalCategory,
  GoalLoopLearningSignalPolarity,
  GoalLoopRunStatus,
  GoalLoopSkillSnapshot,
  GoalLoopSkillSnapshotItem,
  GoalLoopVerification,
  GoalLoopView,
} from "./types.js";
import { readGoalVerificationRecords, reflectionVerificationVerdict, researchVerificationVerdict } from "./verification.js";

export function readGoalLoopView(store: SessionStore, sessionId: string): GoalLoopView {
  const state = readGoalState(store, sessionId);
  const goal = state?.goal;
  const horizons = goal ? readGoalHorizons(store, sessionId, goal.id) : [];
  const reflections = goal ? readGoalReflections(store, sessionId, goal.id) : [];
  const events = store.listEvents(sessionId);
  const childVerificationSessions = goal ? linkedVerificationSessions(events, goal.id) : [];
  const verifications = goal
    ? mergeVerificationRecords([
        ...readGoalVerificationRecords(store, sessionId, goal.id),
        ...childVerificationRecords(store, childVerificationSessions, goal.id),
        ...reflectionVerifications(reflections, goal.id),
        ...researchVerifications(store, sessionId, goal.id),
      ]).sort(compareVerifications)
    : [];
  return {
    session_id: sessionId,
    goal,
    kind: goal?.kind,
    current_horizon: horizons.find((horizon) => horizon.current),
    horizons,
    reflections,
    attempts: runAttempts(events),
    verifications,
    skill_snapshots: goal ? skillSnapshots(events, goal.id) : [],
    learning_signals: goal ? learningSignals(events, goal.id) : [],
    pending_review_decision: goal?.pending_review_decision,
    blocker: goal?.blocker,
  };
}

interface LinkedVerificationSession {
  session_id: string;
  role?: string;
}

function linkedVerificationSessions(events: SessionEvent[], goalId: string): LinkedVerificationSession[] {
  const output: LinkedVerificationSession[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== "goal.verification.child_session.created" || stringValue(event.data.goal_id) !== goalId) {
      continue;
    }
    const sessionId = stringValue(event.data.child_session_id);
    if (!sessionId || seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    output.push({ session_id: sessionId, role: stringValue(event.data.role) });
  }
  return output;
}

function childVerificationRecords(store: SessionStore, sessions: LinkedVerificationSession[], goalId: string): GoalLoopVerification[] {
  const records: GoalLoopVerification[] = [];
  for (const session of sessions) {
    if (!store.getSession(session.session_id)) {
      continue;
    }
    records.push(...readGoalVerificationRecords(store, session.session_id, goalId).map((record) => ({
      ...record,
      source_session_id: session.session_id,
      verifier_role: record.verifier_role ?? session.role,
    })));
  }
  return records;
}

function runAttempts(events: SessionEvent[]): GoalLoopAttempt[] {
  const attempts = new Map<string, GoalLoopAttempt>();
  for (const event of events) {
    if (!event.run_id) {
      continue;
    }
    const current = attempts.get(event.run_id) ?? { run_id: event.run_id, status: "unknown" };
    if (event.type === "user.prompt") {
      current.prompt = stringValue(event.data.prompt);
      current.request_class = stringValue(event.data.request_class);
      current.visibility = stringValue(event.data.visibility);
      current.started_at = current.started_at ?? event.created_at;
      if (current.status === "unknown") {
        current.status = "running";
      }
    } else if (event.type === "run.completed") {
      current.status = "completed";
      current.completed_at = event.created_at;
    } else if (event.type === "run.stopped") {
      current.status = "stopped";
      current.completed_at = event.created_at;
    } else if (event.type === "run.failed") {
      current.status = "failed";
      current.completed_at = event.created_at;
    }
    attempts.set(event.run_id, current);
  }
  return [...attempts.values()].sort(compareAttempts);
}

function reflectionVerifications(reflections: ReturnType<typeof readGoalReflections>, goalId: string): GoalLoopVerification[] {
  return reflections.map((reflection) => ({
    provider: "reflection",
    verdict: reflectionVerificationVerdict(reflection.decision),
    confidence: "soft",
    goal_id: goalId,
    horizon_generation: reflection.generation,
    run_id: reflection.run_id,
    evidence: reflection.verification_evidence,
    failure_reason: reflection.blocker,
    created_at: reflection.created_at,
  }));
}

function researchVerifications(store: SessionStore, sessionId: string, goalId: string): GoalLoopVerification[] {
  const state = readAutoresearchState(store, sessionId);
  const records: GoalLoopVerification[] = [];
  for (const experiment of state.experiments) {
    for (const result of experiment.results) {
      records.push({
        provider: "research",
        verdict: researchVerificationVerdict(result.status),
        confidence: typeof result.metric === "number" ? "hard" : "mixed",
        goal_id: goalId,
        run_id: String(result.run_id),
        metrics: {
          primary_metric: experiment.primary_metric,
          metric: result.metric,
          ...result.metrics,
        },
        evidence: {
          experiment: experiment.name,
          run_id: result.run_id,
          status: result.status,
          description: result.description,
          asi: result.asi,
        },
        created_at: result.logged_at,
      });
    }
  }
  return records;
}

function skillSnapshots(events: SessionEvent[], goalId: string): GoalLoopSkillSnapshot[] {
  return events
    .filter((event) => event.type === "skill.snapshot.created" && stringValue(event.data.goal_id) === goalId)
    .map((event) => {
      const skills = Array.isArray(event.data.skills)
        ? event.data.skills.map(parseSkillSnapshotItem).filter((item): item is GoalLoopSkillSnapshotItem => Boolean(item))
        : [];
      const enabledConfig = Array.isArray(event.data.enabled_config)
        ? event.data.enabled_config.filter((item): item is string => typeof item === "string")
        : [];
      return {
        run_id: event.run_id,
        goal_id: stringValue(event.data.goal_id),
        skill_count: numberValue(event.data.skill_count) ?? skills.length,
        enabled_config: enabledConfig,
        skills,
        snapshot_hash: stringValue(event.data.snapshot_hash),
        created_at: event.created_at,
      };
    })
    .sort(compareSkillSnapshots);
}

function learningSignals(events: SessionEvent[], goalId: string): GoalLoopLearningSignal[] {
  return events
    .filter((event) => event.type === "goal.learning_signal.recorded" && stringValue(event.data.goal_id) === goalId)
    .map(parseLearningSignalEvent)
    .filter((signal): signal is GoalLoopLearningSignal => Boolean(signal))
    .sort(compareLearningSignals);
}

function parseLearningSignalEvent(event: SessionEvent): GoalLoopLearningSignal | undefined {
  const signalId = stringValue(event.data.signal_id);
  const category = learningSignalCategory(event.data.category);
  const polarity = learningSignalPolarity(event.data.polarity);
  const summary = cleanString(event.data.summary);
  if (!signalId || !category || !polarity || !summary) {
    return undefined;
  }
  return {
    signal_id: signalId,
    category,
    polarity,
    goal_id: stringValue(event.data.goal_id),
    horizon_generation: numberValue(event.data.horizon_generation),
    source_event_id: numberValue(event.data.source_event_id),
    source_event_type: stringValue(event.data.source_event_type),
    source_run_id: stringValue(event.data.source_run_id) ?? event.run_id,
    summary,
    evidence: objectValue(event.data.evidence),
    created_at: event.created_at,
  };
}

function parseSkillSnapshotItem(value: unknown): GoalLoopSkillSnapshotItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const id = stringValue(data.id);
  const name = stringValue(data.name);
  if (!id || !name) {
    return undefined;
  }
  return {
    id,
    name,
    description: stringValue(data.description),
    trust: stringValue(data.trust),
    source: stringValue(data.source),
    path: stringValue(data.path),
    body_hash: stringValue(data.body_hash),
    required_tools: stringArrayValue(data.required_tools),
    activation: stringArrayValue(data.activation),
  };
}

function compareAttempts(a: GoalLoopAttempt, b: GoalLoopAttempt): number {
  return (a.started_at ?? "").localeCompare(b.started_at ?? "") || a.run_id.localeCompare(b.run_id);
}

function compareVerifications(a: GoalLoopVerification, b: GoalLoopVerification): number {
  return (a.created_at ?? "").localeCompare(b.created_at ?? "") || (a.run_id ?? "").localeCompare(b.run_id ?? "");
}

function mergeVerificationRecords(records: GoalLoopVerification[]): GoalLoopVerification[] {
  const output: GoalLoopVerification[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const key = verificationKey(record);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(record);
  }
  return output;
}

function verificationKey(record: GoalLoopVerification): string {
  if (record.provider === "research" && record.run_id) {
    return `${record.source_session_id ?? ""}:${record.provider}:${record.run_id}`;
  }
  if (record.provider === "reflection" && record.run_id) {
    return `${record.source_session_id ?? ""}:${record.provider}:${record.run_id}:${record.horizon_generation ?? ""}`;
  }
  return `${record.source_session_id ?? ""}:${record.provider}:${record.verification_id ?? record.run_id ?? record.created_at ?? ""}:${record.horizon_generation ?? ""}`;
}

function compareSkillSnapshots(a: GoalLoopSkillSnapshot, b: GoalLoopSkillSnapshot): number {
  return (a.created_at ?? "").localeCompare(b.created_at ?? "") || (a.run_id ?? "").localeCompare(b.run_id ?? "");
}

function compareLearningSignals(a: GoalLoopLearningSignal, b: GoalLoopLearningSignal): number {
  return (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.signal_id.localeCompare(b.signal_id);
}

function learningSignalCategory(value: unknown): GoalLoopLearningSignalCategory | undefined {
  return value === "verification" || value === "human_feedback" ? value : undefined;
}

function learningSignalPolarity(value: unknown): GoalLoopLearningSignalPolarity | undefined {
  return value === "positive" || value === "negative" || value === "constraint" ? value : undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}
