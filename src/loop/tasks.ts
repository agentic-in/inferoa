import type { GoalKind, GoalStatus, GoalStepStatus } from "../goals/state.js";
import type { SessionStore } from "../session/store.js";
import type { JsonObject, SessionEvent, WorkspaceIdentity } from "../types.js";
import { readGoalLoopView } from "./projection.js";
import type { GoalLoopAttempt, GoalLoopVerification, GoalLoopVerificationConfidence, GoalLoopVerificationVerdict } from "./types.js";

export type LoopTaskState =
  | "active"
  | "paused"
  | "pending_review"
  | "blocked"
  | "ready_for_verification"
  | "verified"
  | "verification_failed"
  | "closed"
  | "dropped";

export interface LoopTaskStepSummary {
  total: number;
  by_status: Record<GoalStepStatus, number>;
  active_step_id?: string;
}

export interface LoopTaskAttemptSummary {
  total: number;
  running: number;
  completed: number;
  failed: number;
  stopped: number;
}

export interface LoopTaskVerificationSummary {
  total: number;
  pass: number;
  fail: number;
  partial: number;
  blocked: number;
  hard_pass: number;
  latest?: {
    provider: string;
    verdict: GoalLoopVerificationVerdict;
    confidence: GoalLoopVerificationConfidence;
    run_id?: string;
    verifier_role?: string;
    summary?: string;
    failure_reason?: string;
    created_at?: string;
  };
}

export interface LoopTaskItem {
  id: string;
  session_id: string;
  session_title: string;
  goal_id: string;
  goal_objective: string;
  goal_kind: GoalKind;
  goal_status: GoalStatus;
  owner?: string;
  review_owner?: string;
  horizon_generation: number;
  current: boolean;
  state: LoopTaskState;
  title?: string;
  summary?: string;
  updated_at: string;
  blocker?: string;
  review_pending: boolean;
  steps: LoopTaskStepSummary;
  attempts: LoopTaskAttemptSummary;
  verification: LoopTaskVerificationSummary;
}

export interface LoopTaskReport {
  generated_at: string;
  summary: {
    total: number;
    current: number;
    by_state: Record<LoopTaskState, number>;
    by_kind: Record<GoalKind, number>;
    pending_review: number;
    blocked: number;
    ready_for_verification: number;
    verified: number;
    verification_failed: number;
  };
  tasks: LoopTaskItem[];
}

const LOOP_TASK_STATES: LoopTaskState[] = [
  "active",
  "paused",
  "pending_review",
  "blocked",
  "ready_for_verification",
  "verified",
  "verification_failed",
  "closed",
  "dropped",
];

const GOAL_KINDS: GoalKind[] = ["task", "research"];
const STEP_STATUSES: GoalStepStatus[] = ["pending", "in_progress", "completed", "blocked", "skipped"];

export function readLoopTasks(store: SessionStore, workspace: WorkspaceIdentity): LoopTaskReport {
  const tasks: LoopTaskItem[] = [];
  for (const session of store.listSessions(workspace.id, { includeArchived: true })) {
    const view = readGoalLoopView(store, session.session_id);
    if (!view.goal || !view.horizons.length) {
      continue;
    }
    const events = store.listEvents(session.session_id);
    for (const horizon of view.horizons) {
      const verifications = horizonVerifications(view.verifications, horizon.generation, horizon.current);
      const attempts = horizonAttempts(view.attempts, events, horizon.generation);
      const reviewPending = view.pending_review_decision?.source_horizon_generation === horizon.generation;
      const blocker = horizon.current ? view.blocker : undefined;
      const steps = stepSummary(horizon.steps, horizon.active_step_id);
      const verification = verificationSummary(verifications);
      const state = loopTaskState({
        goal_status: view.goal.status,
        current: horizon.current,
        review_pending: reviewPending,
        blocker,
        steps,
        verification,
      });
      tasks.push({
        id: `${session.session_id}:horizon:${horizon.generation}`,
        session_id: session.session_id,
        session_title: session.title,
        goal_id: view.goal.id,
        goal_objective: view.goal.objective,
        goal_kind: view.goal.kind,
        goal_status: view.goal.status,
        owner: view.goal.owner,
        review_owner: view.goal.review_owner,
        horizon_generation: horizon.generation,
        current: horizon.current,
        state,
        title: horizon.title,
        summary: horizon.summary,
        updated_at: horizon.updated_at,
        blocker,
        review_pending: reviewPending,
        steps,
        attempts: attemptSummary(attempts),
        verification,
      });
    }
  }
  tasks.sort(compareLoopTasks);
  const byState = zeroRecord(LOOP_TASK_STATES);
  const byKind = zeroRecord(GOAL_KINDS);
  for (const task of tasks) {
    byState[task.state] += 1;
    byKind[task.goal_kind] += 1;
  }
  return {
    generated_at: new Date().toISOString(),
    summary: {
      total: tasks.length,
      current: tasks.filter((task) => task.current).length,
      by_state: byState,
      by_kind: byKind,
      pending_review: byState.pending_review,
      blocked: byState.blocked,
      ready_for_verification: byState.ready_for_verification,
      verified: byState.verified,
      verification_failed: byState.verification_failed,
    },
    tasks,
  };
}

function loopTaskState(input: {
  goal_status: GoalStatus;
  current: boolean;
  review_pending: boolean;
  blocker?: string;
  steps: LoopTaskStepSummary;
  verification: LoopTaskVerificationSummary;
}): LoopTaskState {
  if (input.goal_status === "dropped") {
    return "dropped";
  }
  if (input.review_pending) {
    return "pending_review";
  }
  if (input.steps.by_status.blocked > 0 || input.verification.blocked > 0 || (input.current && input.goal_status === "paused" && input.blocker)) {
    return "blocked";
  }
  if (input.verification.fail > 0) {
    return "verification_failed";
  }
  if (input.verification.pass > 0) {
    return "verified";
  }
  if (input.steps.total > 0 && input.steps.by_status.pending === 0 && input.steps.by_status.in_progress === 0 && input.steps.by_status.blocked === 0) {
    return "ready_for_verification";
  }
  if (!input.current || input.goal_status === "complete") {
    return "closed";
  }
  if (input.goal_status === "paused" || input.goal_status === "budget-limited") {
    return "paused";
  }
  return "active";
}

function horizonVerifications(verifications: GoalLoopVerification[], generation: number, current: boolean): GoalLoopVerification[] {
  return verifications.filter((verification) => {
    if (verification.horizon_generation === generation) {
      return true;
    }
    // Research experiment records currently belong to the active research cycle
    // but do not always carry a stored horizon generation.
    return current && verification.horizon_generation === undefined && verification.provider === "research";
  });
}

function horizonAttempts(attempts: GoalLoopAttempt[], events: SessionEvent[], generation: number): GoalLoopAttempt[] {
  const runIds = new Set<string>();
  for (const event of events) {
    if (!event.run_id || eventHorizonGeneration(event) !== generation) {
      continue;
    }
    runIds.add(event.run_id);
  }
  return attempts.filter((attempt) => runIds.has(attempt.run_id));
}

function eventHorizonGeneration(event: SessionEvent): number | undefined {
  return numberValue(event.data.horizon_generation)
    ?? numberValue(event.data.source_horizon_generation)
    ?? numberValue(event.data.previous_horizon_generation)
    ?? numberValue(objectValue(event.data.goal)?.horizon_generation);
}

function stepSummary(steps: Array<{ status: GoalStepStatus }>, activeStepId?: string): LoopTaskStepSummary {
  const byStatus = zeroRecord(STEP_STATUSES);
  for (const step of steps) {
    byStatus[step.status] += 1;
  }
  return {
    total: steps.length,
    by_status: byStatus,
    active_step_id: activeStepId,
  };
}

function attemptSummary(attempts: GoalLoopAttempt[]): LoopTaskAttemptSummary {
  return {
    total: attempts.length,
    running: attempts.filter((attempt) => attempt.status === "running").length,
    completed: attempts.filter((attempt) => attempt.status === "completed").length,
    failed: attempts.filter((attempt) => attempt.status === "failed").length,
    stopped: attempts.filter((attempt) => attempt.status === "stopped").length,
  };
}

function verificationSummary(verifications: GoalLoopVerification[]): LoopTaskVerificationSummary {
  const latest = verifications.at(-1);
  return {
    total: verifications.length,
    pass: verifications.filter((verification) => verification.verdict === "pass").length,
    fail: verifications.filter((verification) => verification.verdict === "fail").length,
    partial: verifications.filter((verification) => verification.verdict === "partial").length,
    blocked: verifications.filter((verification) => verification.verdict === "blocked").length,
    hard_pass: verifications.filter((verification) => verification.verdict === "pass" && verification.confidence === "hard").length,
    latest: latest
      ? {
          provider: latest.provider,
          verdict: latest.verdict,
          confidence: latest.confidence,
          run_id: latest.run_id,
          verifier_role: latest.verifier_role,
          summary: latest.summary,
          failure_reason: latest.failure_reason,
          created_at: latest.created_at,
        }
      : undefined,
  };
}

function compareLoopTasks(a: LoopTaskItem, b: LoopTaskItem): number {
  const stateOrder = stateRank(a.state) - stateRank(b.state);
  if (stateOrder !== 0) {
    return stateOrder;
  }
  return Number(b.current) - Number(a.current)
    || b.updated_at.localeCompare(a.updated_at)
    || a.session_id.localeCompare(b.session_id)
    || a.horizon_generation - b.horizon_generation;
}

function stateRank(state: LoopTaskState): number {
  switch (state) {
    case "pending_review":
      return 0;
    case "blocked":
    case "verification_failed":
      return 1;
    case "active":
    case "paused":
    case "ready_for_verification":
      return 2;
    case "verified":
      return 3;
    case "closed":
      return 4;
    case "dropped":
      return 5;
  }
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function zeroRecord<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}
