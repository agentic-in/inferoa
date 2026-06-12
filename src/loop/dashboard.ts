import type { SessionStore } from "../session/store.js";
import type { WorkspaceIdentity } from "../types.js";
import { readLoopHealth, type LoopHealthSeverity } from "./health.js";
import { readLoopInbox, type LoopInboxItem, type LoopInboxItemKind, type LoopInboxPriority } from "./inbox.js";
import { readLoopMetrics } from "./metrics.js";
import { readLoopRoadmap, type LoopRoadmapStatus } from "./roadmap.js";

export interface LoopDashboardReport {
  generated_at: string;
  workspace_id: string;
  workspace_root: string;
  status: {
    severity: LoopHealthSeverity;
    reasons: string[];
    open_inbox_items: number;
    high_inbox_items: number;
    active_jobs: number;
    pending_reviews: number;
    worktree_attention: number;
  };
  totals: {
    sessions: number;
    goals: number;
    runs: number;
    model_calls: number;
    total_tokens: number;
    verifications: number;
    learning_signals: number;
  };
  verification: {
    pass: number;
    fail: number;
    partial: number;
    blocked: number;
    hard_pass: number;
    pass_rate?: number;
    hard_pass_rate?: number;
    checker_pass_rate?: number;
    latest_at?: string;
  };
  operations: {
    automation_due: number;
    automation_review_pending: number;
    discovery_due: number;
    discovery_errors: number;
    discovery_candidates_open: number;
    worktrees_active: number;
    worktrees_cleanup_due: number;
  };
  top: {
    goal?: LoopDashboardTopItem;
    source?: LoopDashboardTopItem;
    system?: LoopDashboardTopItem;
    request_class?: LoopDashboardTopItem;
  };
  attention: {
    inbox_items: LoopDashboardInboxItem[];
    roadmap_edges: LoopDashboardRoadmapEdge[];
  };
}

export interface LoopDashboardTopItem {
  key: string;
  label?: string;
  tokens: number;
  verifications: number;
}

export interface LoopDashboardInboxItem {
  id: string;
  kind: LoopInboxItemKind;
  priority: LoopInboxPriority;
  status: string;
  title: string;
  assignee?: string;
  source?: string;
  action?: string;
}

export interface LoopDashboardRoadmapEdge {
  id: string;
  name: string;
  status: LoopRoadmapStatus;
  roadmap_position: string;
}

export async function readLoopDashboard(store: SessionStore, workspace: WorkspaceIdentity): Promise<LoopDashboardReport> {
  const [health, inbox] = await Promise.all([
    readLoopHealth(store, workspace),
    readLoopInbox(store, workspace),
  ]);
  const metrics = readLoopMetrics(store, workspace);
  const roadmap = readLoopRoadmap();
  const generatedAt = new Date().toISOString();
  return {
    generated_at: generatedAt,
    workspace_id: workspace.id,
    workspace_root: workspace.root,
    status: {
      severity: health.severity,
      reasons: [...health.reasons],
      open_inbox_items: health.inbox.open,
      high_inbox_items: health.inbox.high,
      active_jobs: health.jobs.active,
      pending_reviews: health.goals.pending_review,
      worktree_attention: health.worktrees.attention,
    },
    totals: {
      sessions: metrics.totals.sessions,
      goals: metrics.totals.goals,
      runs: metrics.totals.runs,
      model_calls: metrics.totals.model_calls,
      total_tokens: metrics.tokens.total_tokens,
      verifications: metrics.totals.verifications,
      learning_signals: metrics.learning_signals.total,
    },
    verification: {
      pass: metrics.verification.summary.pass,
      fail: metrics.verification.summary.fail,
      partial: metrics.verification.summary.partial,
      blocked: metrics.verification.summary.blocked,
      hard_pass: metrics.verification.summary.hard_pass,
      pass_rate: metrics.verification.summary.pass_rate,
      hard_pass_rate: metrics.verification.summary.hard_pass_rate,
      checker_pass_rate: metrics.verification.checker_effectiveness.pass_rate,
      latest_at: metrics.verification.summary.latest_at,
    },
    operations: {
      automation_due: health.automation.due,
      automation_review_pending: health.automation.review_pending,
      discovery_due: health.discovery.due,
      discovery_errors: health.discovery.last_error,
      discovery_candidates_open: health.discovery.candidates_open,
      worktrees_active: health.worktrees.active,
      worktrees_cleanup_due: health.worktrees.cleanup_due,
    },
    top: {
      goal: topGroup(metrics.by_goal, (item) => item.key !== "no_goal"),
      source: topGroup(metrics.by_source),
      system: topGroup(metrics.by_system, (item) => item.key !== "none"),
      request_class: topGroup(metrics.by_request_class),
    },
    attention: {
      inbox_items: inbox.items
        .filter((item) => item.status === "open" || item.status === "running" || item.status === "waiting")
        .slice(0, 8)
        .map(summarizeInboxItem),
      roadmap_edges: roadmap.capabilities
        .filter((capability) => capability.status !== "implemented")
        .map((capability) => ({
          id: capability.id,
          name: capability.name,
          status: capability.status,
          roadmap_position: capability.roadmap_position,
        })),
    },
  };
}

function topGroup(
  groups: Array<{ key: string; label?: string; tokens: { total_tokens: number }; verification: { total: number } }>,
  predicate: (item: { key: string }) => boolean = () => true,
): LoopDashboardTopItem | undefined {
  const item = groups.find(predicate);
  if (!item) {
    return undefined;
  }
  return {
    key: item.key,
    label: item.label,
    tokens: item.tokens.total_tokens,
    verifications: item.verification.total,
  };
}

function summarizeInboxItem(item: LoopInboxItem): LoopDashboardInboxItem {
  return {
    id: item.id,
    kind: item.kind,
    priority: item.priority,
    status: item.status,
    title: item.title,
    assignee: item.assignee,
    source: item.source,
    action: item.action,
  };
}
