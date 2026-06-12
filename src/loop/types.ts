import type { JsonObject } from "../types.js";
import type { GoalHorizonSnapshot, GoalKind, GoalPendingReviewDecision, GoalRecord, GoalReflectionSnapshot } from "../goals/state.js";

export type GoalLoopRunStatus = "running" | "completed" | "stopped" | "failed" | "unknown";
export type GoalLoopVerificationProvider = "reflection" | "research" | "human" | "checker" | "command";
export type GoalLoopVerificationVerdict = "pass" | "fail" | "partial" | "blocked" | "unknown";
export type GoalLoopVerificationConfidence = "hard" | "soft" | "mixed";
export type GoalLoopLearningSignalCategory = "verification" | "human_feedback";
export type GoalLoopLearningSignalPolarity = "positive" | "negative" | "constraint";

export interface GoalLoopAttempt {
  run_id: string;
  request_class?: string;
  visibility?: string;
  prompt?: string;
  status: GoalLoopRunStatus;
  started_at?: string;
  completed_at?: string;
}

export interface GoalLoopVerification {
  verification_id?: string;
  provider: GoalLoopVerificationProvider;
  verdict: GoalLoopVerificationVerdict;
  confidence: GoalLoopVerificationConfidence;
  goal_id?: string;
  source_session_id?: string;
  horizon_generation?: number;
  run_id?: string;
  source_run_id?: string;
  verifier_role?: string;
  evidence?: JsonObject;
  evidence_resource_uri?: string;
  metrics?: JsonObject;
  summary?: string;
  failure_reason?: string;
  created_at?: string;
}

export interface GoalLoopSkillSnapshotItem {
  id: string;
  name: string;
  description?: string;
  trust?: string;
  source?: string;
  path?: string;
  body_hash?: string;
  required_tools?: string[];
  activation?: string[];
}

export interface GoalLoopSkillSnapshot {
  run_id?: string;
  goal_id?: string;
  skill_count: number;
  enabled_config: string[];
  skills: GoalLoopSkillSnapshotItem[];
  snapshot_hash?: string;
  created_at?: string;
}

export interface GoalLoopSkillBodyLoad {
  run_id?: string;
  goal_id?: string;
  horizon_generation?: number;
  skill_id: string;
  name?: string;
  trust?: string;
  source?: string;
  path?: string;
  body_hash?: string;
  total_lines?: number;
  returned_lines?: number;
  resource_uri?: string;
  created_at?: string;
}

export interface GoalLoopSkillRuleApplication {
  run_id?: string;
  goal_id?: string;
  horizon_generation?: number;
  skill_id: string;
  target?: "loop_skill" | "workspace_skill";
  body_hash?: string;
  body_load_run_id?: string;
  rule_id: string;
  rule_summary?: string;
  decision?: string;
  evidence?: JsonObject;
  created_at?: string;
}

export interface GoalLoopLearningSignal {
  signal_id: string;
  category: GoalLoopLearningSignalCategory;
  polarity: GoalLoopLearningSignalPolarity;
  goal_id?: string;
  horizon_generation?: number;
  source_event_id?: number;
  source_event_type?: string;
  source_run_id?: string;
  summary: string;
  evidence?: JsonObject;
  created_at?: string;
}

export interface GoalLoopView {
  session_id: string;
  goal?: GoalRecord;
  kind?: GoalKind;
  current_horizon?: GoalHorizonSnapshot;
  horizons: GoalHorizonSnapshot[];
  reflections: GoalReflectionSnapshot[];
  attempts: GoalLoopAttempt[];
  verifications: GoalLoopVerification[];
  skill_snapshots: GoalLoopSkillSnapshot[];
  skill_body_loads: GoalLoopSkillBodyLoad[];
  skill_rule_applications: GoalLoopSkillRuleApplication[];
  learning_signals: GoalLoopLearningSignal[];
  pending_review_decision?: GoalPendingReviewDecision;
  blocker?: string;
}
