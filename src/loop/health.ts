import type { SessionStore, SupervisorJob } from "../session/store.js";
import type { WorkspaceIdentity } from "../types.js";
import { readGoalState } from "../goals/state.js";
import { readLoopInbox } from "./inbox.js";
import { readGoalVerificationRecords } from "./verification.js";
import { readLoopWorktreeHealth } from "./worktree.js";

export type LoopHealthSeverity = "ok" | "watch" | "attention";

export interface LoopHealthCountSummary {
  total: number;
  by_status: Record<string, number>;
}

export interface LoopScheduleHealthSummary extends LoopHealthCountSummary {
  due: number;
  last_error: number;
  worktree_isolated: number;
  active_checkout: number;
  review_gated: number;
  review_pending: number;
}

export interface LoopGoalHealthSummary extends LoopHealthCountSummary {
  by_kind: Record<string, number>;
  pending_review: number;
}

export interface LoopVerificationHealthSummary {
  total: number;
  by_provider: Record<string, number>;
  by_verdict: Record<string, number>;
  hard_pass: number;
  latest_at?: string;
}

export interface LoopLearningSignalHealthSummary {
  total: number;
  by_category: Record<string, number>;
  by_polarity: Record<string, number>;
  latest_at?: string;
}

export interface LoopHealthReport {
  workspace_id: string;
  workspace_root: string;
  generated_at: string;
  severity: LoopHealthSeverity;
  reasons: string[];
  goals: LoopGoalHealthSummary;
  jobs: LoopHealthCountSummary & {
    active: number;
  };
  automation: LoopScheduleHealthSummary;
  discovery: LoopScheduleHealthSummary & {
    candidates_open: number;
    candidates_promoted: number;
  };
  inbox: {
    total: number;
    open: number;
    high: number;
    by_kind: Record<string, number>;
  };
  worktrees: {
    total: number;
    active: number;
    attention: number;
    cleanup_due: number;
    active_stale: number;
    by_status: Record<string, number>;
  };
  verification: LoopVerificationHealthSummary;
  learning_signals: LoopLearningSignalHealthSummary;
}

export async function readLoopHealth(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: { now?: Date } = {},
): Promise<LoopHealthReport> {
  const now = options.now ?? new Date();
  const sessions = store.listSessions(workspace.id, { includeArchived: true });
  const sessionIds = new Set(sessions.map((session) => session.session_id));
  const goals = sessions.map((session) => readGoalState(store, session.session_id)?.goal).filter((goal): goal is NonNullable<typeof goal> => Boolean(goal));
  const jobs = store.listSupervisorJobs().filter((job) => sessionIds.has(job.session_id));
  const automationSchedules = store.listAutomationSchedules({ workspaceId: workspace.id });
  const discoverySchedules = store.listDiscoverySchedules({ workspaceId: workspace.id });
  const discoveryCandidates = store.listDiscoveryCandidates({ workspaceId: workspace.id });
  const inbox = await readLoopInbox(store, workspace);
  const worktreeHealth = readLoopWorktreeHealth(store, workspace);
  const verifications = sessions.flatMap((session) => readGoalVerificationRecords(store, session.session_id));
  const learningSignals = sessions.flatMap((session) =>
    store.listEvents(session.session_id).filter((event) => event.type === "goal.learning_signal.recorded"),
  );

  const goalSummary: LoopGoalHealthSummary = {
    total: goals.length,
    by_status: countBy(goals, (goal) => goal.status),
    by_kind: countBy(goals, (goal) => goal.kind),
    pending_review: goals.filter((goal) => goal.pending_review_decision).length,
  };
  const jobStatus = countBy(jobs, (job) => job.status);
  const automationSummary: LoopScheduleHealthSummary = {
    total: automationSchedules.length,
    by_status: countBy(automationSchedules, (schedule) => schedule.status),
    due: store.listAutomationSchedules({ workspaceId: workspace.id, status: "enabled", dueAt: now.toISOString() }).length,
    last_error: 0,
    worktree_isolated: automationSchedules.filter((schedule) => schedule.metadata.isolation === "worktree").length,
    active_checkout: automationSchedules.filter((schedule) => schedule.metadata.isolation !== "worktree").length,
    review_gated: automationSchedules.filter((schedule) => schedule.metadata.review_policy === "review").length,
    review_pending: automationSchedules.filter((schedule) => schedule.status === "enabled" && schedule.metadata.review_policy === "review" && Date.parse(schedule.next_run_at) <= now.getTime()).length,
  };
  const discoverySummary = {
    total: discoverySchedules.length,
    by_status: countBy(discoverySchedules, (schedule) => schedule.status),
    due: store.listDiscoverySchedules({ workspaceId: workspace.id, status: "enabled", dueAt: now.toISOString() }).length,
    last_error: discoverySchedules.filter((schedule) => Boolean(schedule.last_error)).length,
    worktree_isolated: 0,
    active_checkout: discoverySchedules.length,
    review_gated: 0,
    review_pending: 0,
    candidates_open: discoveryCandidates.filter((candidate) => candidate.status === "open").length,
    candidates_promoted: discoveryCandidates.filter((candidate) => candidate.status === "promoted").length,
  };
  const verificationSummary: LoopVerificationHealthSummary = {
    total: verifications.length,
    by_provider: countBy(verifications, (record) => record.provider),
    by_verdict: countBy(verifications, (record) => record.verdict),
    hard_pass: verifications.filter((record) => record.verdict === "pass" && record.confidence === "hard").length,
    latest_at: verifications.map((record) => record.created_at).filter((value): value is string => Boolean(value)).sort().at(-1),
  };
  const learningSignalSummary: LoopLearningSignalHealthSummary = {
    total: learningSignals.length,
    by_category: countBy(learningSignals, (event) => stringValue(event.data.category)),
    by_polarity: countBy(learningSignals, (event) => stringValue(event.data.polarity)),
    latest_at: learningSignals.map((event) => event.created_at).filter((value): value is string => Boolean(value)).sort().at(-1),
  };
  const reasons = healthReasons({
    inboxHigh: inbox.summary.high,
    inboxOpen: inbox.summary.open,
    jobs,
    automationDue: automationSummary.due,
    discoveryDue: discoverySummary.due,
    discoveryErrors: discoverySummary.last_error,
    worktreeAttention: worktreeHealth.attention_count,
    verificationFailures: verificationSummary.by_verdict.fail ?? 0,
    pendingReview: goalSummary.pending_review,
  });
  return {
    workspace_id: workspace.id,
    workspace_root: workspace.root,
    generated_at: now.toISOString(),
    severity: reasons.some((reason) => reason.endsWith("_attention")) ? "attention" : reasons.length ? "watch" : "ok",
    reasons,
    goals: goalSummary,
    jobs: {
      total: jobs.length,
      by_status: jobStatus,
      active: jobs.filter(isActiveJob).length,
    },
    automation: automationSummary,
    discovery: discoverySummary,
    inbox: inbox.summary,
    worktrees: {
      total: worktreeHealth.items.length,
      active: worktreeHealth.counts.active,
      attention: worktreeHealth.attention_count,
      cleanup_due: worktreeHealth.cleanup_due_count,
      active_stale: worktreeHealth.active_stale_count,
      by_status: worktreeHealth.counts,
    },
    verification: verificationSummary,
    learning_signals: learningSignalSummary,
  };
}

function healthReasons(input: {
  inboxHigh: number;
  inboxOpen: number;
  jobs: SupervisorJob[];
  automationDue: number;
  discoveryDue: number;
  discoveryErrors: number;
  worktreeAttention: number;
  verificationFailures: number;
  pendingReview: number;
}): string[] {
  const reasons: string[] = [];
  if (input.inboxHigh > 0) {
    reasons.push("inbox_high_attention");
  }
  if (input.jobs.some((job) => job.status === "failed" || job.status === "blocked")) {
    reasons.push("job_attention");
  }
  if (input.discoveryErrors > 0) {
    reasons.push("discovery_error_attention");
  }
  if (input.worktreeAttention > 0) {
    reasons.push("worktree_attention");
  }
  if (input.verificationFailures > 0) {
    reasons.push("verification_failure_attention");
  }
  if (input.pendingReview > 0) {
    reasons.push("pending_review");
  }
  if (input.inboxOpen > 0) {
    reasons.push("inbox_open");
  }
  if (input.jobs.some(isActiveJob)) {
    reasons.push("job_active");
  }
  if (input.automationDue > 0) {
    reasons.push("automation_due");
  }
  if (input.discoveryDue > 0) {
    reasons.push("discovery_due");
  }
  return reasons;
}

function isActiveJob(job: SupervisorJob): boolean {
  return job.status === "queued" || job.status === "running" || job.status === "detached" || job.status === "cancel_requested";
}

function countBy<T>(items: T[], getKey: (item: T) => string | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = getKey(item);
    if (!key) {
      continue;
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
