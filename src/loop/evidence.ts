import type { GoalStepStatus } from "../goals/state.js";
import type { SessionStore } from "../session/store.js";
import type { JsonObject, SessionRecord } from "../types.js";
import { readGoalLoopView } from "./projection.js";
import type {
  GoalLoopAttempt,
  GoalLoopLearningSignal,
  GoalLoopLearningSignalCategory,
  GoalLoopLearningSignalPolarity,
  GoalLoopRunStatus,
  GoalLoopSkillSnapshot,
  GoalLoopVerification,
  GoalLoopVerificationConfidence,
  GoalLoopVerificationProvider,
  GoalLoopVerificationVerdict,
} from "./types.js";

export interface LoopEvidenceReport {
  generated_at: string;
  session: {
    session_id: string;
    title?: string;
    status: SessionRecord["status"];
  };
  has_goal: boolean;
  goal?: {
    goal_id: string;
    objective: string;
    kind: string;
    status: string;
    horizon_generation: number;
    hil_policy: string;
    owner?: string;
    review_owner?: string;
  };
  current_horizon?: {
    generation: number;
    title?: string;
    summary?: string;
    active_step_id?: string;
    step_count: number;
    steps_by_status: Record<GoalStepStatus, number>;
    current: boolean;
  };
  summary: {
    attempts: number;
    completed_attempts: number;
    failed_attempts: number;
    verifications: number;
    hard_pass_verifications: number;
    failed_verifications: number;
    blocked_verifications: number;
    skill_snapshots: number;
    learning_signals: number;
    pending_review: boolean;
    blocker?: string;
  };
  attempts: {
    total: number;
    by_status: Partial<Record<GoalLoopRunStatus, number>>;
    by_request_class: Record<string, number>;
    latest?: LoopEvidenceAttempt;
  };
  verification: {
    total: number;
    by_verdict: Partial<Record<GoalLoopVerificationVerdict, number>>;
    by_provider: Partial<Record<GoalLoopVerificationProvider, number>>;
    by_confidence: Partial<Record<GoalLoopVerificationConfidence, number>>;
    current_horizon: {
      total: number;
      latest?: LoopEvidenceVerification;
    };
    latest?: LoopEvidenceVerification;
  };
  skills: {
    snapshot_count: number;
    latest?: LoopEvidenceSkillSnapshot;
  };
  learning_signals: {
    total: number;
    by_category: Partial<Record<GoalLoopLearningSignalCategory, number>>;
    by_polarity: Partial<Record<GoalLoopLearningSignalPolarity, number>>;
    latest: LoopEvidenceLearningSignal[];
  };
}

export interface LoopEvidenceAttempt {
  run_id: string;
  status: GoalLoopRunStatus;
  request_class?: string;
  visibility?: string;
  started_at?: string;
  completed_at?: string;
}

export interface LoopEvidenceVerification {
  verification_id?: string;
  provider: GoalLoopVerificationProvider;
  verdict: GoalLoopVerificationVerdict;
  confidence: GoalLoopVerificationConfidence;
  horizon_generation?: number;
  run_id?: string;
  source_session_id?: string;
  source_run_id?: string;
  verifier_role?: string;
  summary?: string;
  failure_reason?: string;
  evidence?: JsonObject;
  metrics?: JsonObject;
  created_at?: string;
}

export interface LoopEvidenceSkillSnapshot {
  run_id?: string;
  skill_count: number;
  enabled_config: string[];
  skill_ids: string[];
  snapshot_hash?: string;
  created_at?: string;
}

export interface LoopEvidenceLearningSignal {
  signal_id: string;
  category: GoalLoopLearningSignalCategory;
  polarity: GoalLoopLearningSignalPolarity;
  horizon_generation?: number;
  source_run_id?: string;
  source_event_type?: string;
  summary: string;
  evidence?: JsonObject;
  created_at?: string;
}

export function readLoopEvidence(store: SessionStore, session: SessionRecord): LoopEvidenceReport {
  const view = readGoalLoopView(store, session.session_id);
  const currentGeneration = view.current_horizon?.generation;
  const currentHorizonVerifications = currentGeneration === undefined
    ? []
    : view.verifications.filter((verification) => verification.horizon_generation === currentGeneration);
  const latestVerification = latest(view.verifications);
  const latestCurrentHorizonVerification = latest(currentHorizonVerifications);
  const latestSkillSnapshot = latest(view.skill_snapshots);
  const latestAttempt = latestBy(view.attempts, (attempt) => attempt.completed_at ?? attempt.started_at ?? "");
  const hardPassVerifications = view.verifications.filter((verification) => verification.verdict === "pass" && verification.confidence === "hard").length;
  const failedVerifications = view.verifications.filter((verification) => verification.verdict === "fail").length;
  const blockedVerifications = view.verifications.filter((verification) => verification.verdict === "blocked").length;

  return {
    generated_at: new Date().toISOString(),
    session: {
      session_id: session.session_id,
      title: session.title,
      status: session.status,
    },
    has_goal: Boolean(view.goal),
    goal: view.goal ? {
      goal_id: view.goal.id,
      objective: view.goal.objective,
      kind: view.goal.kind,
      status: view.goal.status,
      horizon_generation: view.goal.horizon_generation,
      hil_policy: view.goal.hil_policy,
      owner: view.goal.owner,
      review_owner: view.goal.review_owner,
    } : undefined,
    current_horizon: view.current_horizon ? {
      generation: view.current_horizon.generation,
      title: view.current_horizon.title,
      summary: view.current_horizon.summary,
      active_step_id: view.current_horizon.active_step_id,
      step_count: view.current_horizon.steps.length,
      steps_by_status: countByFixed(view.current_horizon.steps.map((step) => step.status), ["pending", "in_progress", "completed", "blocked", "skipped"]),
      current: view.current_horizon.current,
    } : undefined,
    summary: {
      attempts: view.attempts.length,
      completed_attempts: view.attempts.filter((attempt) => attempt.status === "completed").length,
      failed_attempts: view.attempts.filter((attempt) => attempt.status === "failed").length,
      verifications: view.verifications.length,
      hard_pass_verifications: hardPassVerifications,
      failed_verifications: failedVerifications,
      blocked_verifications: blockedVerifications,
      skill_snapshots: view.skill_snapshots.length,
      learning_signals: view.learning_signals.length,
      pending_review: Boolean(view.pending_review_decision),
      blocker: view.blocker,
    },
    attempts: {
      total: view.attempts.length,
      by_status: countBy(view.attempts.map((attempt) => attempt.status)),
      by_request_class: countByRecord(view.attempts.map((attempt) => attempt.request_class ?? "unknown")),
      latest: latestAttempt ? summarizeAttempt(latestAttempt) : undefined,
    },
    verification: {
      total: view.verifications.length,
      by_verdict: countBy(view.verifications.map((verification) => verification.verdict)),
      by_provider: countBy(view.verifications.map((verification) => verification.provider)),
      by_confidence: countBy(view.verifications.map((verification) => verification.confidence)),
      current_horizon: {
        total: currentHorizonVerifications.length,
        latest: latestCurrentHorizonVerification ? summarizeVerification(latestCurrentHorizonVerification) : undefined,
      },
      latest: latestVerification ? summarizeVerification(latestVerification) : undefined,
    },
    skills: {
      snapshot_count: view.skill_snapshots.length,
      latest: latestSkillSnapshot ? summarizeSkillSnapshot(latestSkillSnapshot) : undefined,
    },
    learning_signals: {
      total: view.learning_signals.length,
      by_category: countBy(view.learning_signals.map((signal) => signal.category)),
      by_polarity: countBy(view.learning_signals.map((signal) => signal.polarity)),
      latest: view.learning_signals.slice(-5).reverse().map(summarizeLearningSignal),
    },
  };
}

function summarizeAttempt(attempt: GoalLoopAttempt): LoopEvidenceAttempt {
  return {
    run_id: attempt.run_id,
    status: attempt.status,
    request_class: attempt.request_class,
    visibility: attempt.visibility,
    started_at: attempt.started_at,
    completed_at: attempt.completed_at,
  };
}

function summarizeVerification(verification: GoalLoopVerification): LoopEvidenceVerification {
  return {
    verification_id: verification.verification_id,
    provider: verification.provider,
    verdict: verification.verdict,
    confidence: verification.confidence,
    horizon_generation: verification.horizon_generation,
    run_id: verification.run_id,
    source_session_id: verification.source_session_id,
    source_run_id: verification.source_run_id,
    verifier_role: verification.verifier_role,
    summary: verification.summary,
    failure_reason: verification.failure_reason,
    evidence: verification.evidence,
    metrics: verification.metrics,
    created_at: verification.created_at,
  };
}

function summarizeSkillSnapshot(snapshot: GoalLoopSkillSnapshot): LoopEvidenceSkillSnapshot {
  return {
    run_id: snapshot.run_id,
    skill_count: snapshot.skill_count,
    enabled_config: [...snapshot.enabled_config],
    skill_ids: snapshot.skills.map((skill) => skill.id),
    snapshot_hash: snapshot.snapshot_hash,
    created_at: snapshot.created_at,
  };
}

function summarizeLearningSignal(signal: GoalLoopLearningSignal): LoopEvidenceLearningSignal {
  return {
    signal_id: signal.signal_id,
    category: signal.category,
    polarity: signal.polarity,
    horizon_generation: signal.horizon_generation,
    source_run_id: signal.source_run_id,
    source_event_type: signal.source_event_type,
    summary: signal.summary,
    evidence: signal.evidence,
    created_at: signal.created_at,
  };
}

function latest<T>(items: T[]): T | undefined {
  return items.at(-1);
}

function latestBy<T>(items: T[], value: (item: T) => string): T | undefined {
  return [...items].sort((a, b) => value(a).localeCompare(value(b))).at(-1);
}

function countBy<T extends string>(values: T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function countByRecord(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function countByFixed<T extends string>(values: T[], keys: T[]): Record<T, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const value of values) {
    counts[value] += 1;
  }
  return counts;
}
