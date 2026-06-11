import { promises as fs } from "node:fs";
import path from "node:path";
import { readGoalLoopView } from "./projection.js";
import type { GoalLoopVerification } from "./types.js";
import type { AutomationSchedule, ManagedWorktree, SessionStore, SupervisorJob } from "../session/store.js";
import type { JsonObject, SessionEvent, SessionRecord, WorkspaceIdentity } from "../types.js";
import { readGoalState, type GoalRecord } from "../goals/state.js";
import { buildGoalWorkPrompt } from "../goals/supervisor-prompts.js";
import { createLoopWorktree, loopWorktreeRunTarget } from "./worktree.js";
import { getConnectorVerifierDefinition } from "./connector-verifiers.js";

export type LoopInboxItemKind =
  | "goal_review"
  | "goal_blocker"
  | "goal_paused"
  | "verification_failure"
  | "stale_work"
  | "automation_review"
  | "action_review"
  | "discovery_candidate"
  | "daemon_job"
  | "skill_proposal"
  | "self_improve_replay";

export type LoopInboxPriority = "high" | "medium" | "low";
export type LoopInboxStatus = "open" | "waiting" | "running" | "snoozed" | "muted" | "done";
export type LoopInboxDisposition = "resolved" | "dismissed" | "snoozed";
export type LoopInboxAction = "resolve" | "dismiss" | "snooze" | "reopen";

export interface LoopInboxItem {
  id: string;
  kind: LoopInboxItemKind;
  priority: LoopInboxPriority;
  status: LoopInboxStatus;
  source?: string;
  source_label?: string;
  title: string;
  detail?: string;
  action?: string;
  session_id?: string;
  session_title?: string;
  goal_id?: string;
  goal_kind?: string;
  run_id?: string;
  job_id?: string;
  schedule_id?: string;
  candidate_id?: string;
  prompt?: string;
  verification_hint?: LoopInboxVerificationHint;
  artifact_path?: string;
  created_at?: string;
  updated_at?: string;
  disposition?: LoopInboxDisposition;
  disposition_note?: string;
  snoozed_until?: string;
  state_updated_at?: string;
  assignee?: string;
  assignment_note?: string;
  assigned_at?: string;
  assignment_updated_at?: string;
  routed_by?: string;
  routing_note?: string;
  muted?: boolean;
  mute_key?: string;
  mute_note?: string;
  muted_at?: string;
  muted_until?: string;
  stale?: boolean;
  stale_reason?: string;
  stale_age_ms?: number;
  stale_since?: string;
}

export interface LoopInboxVerificationHint {
  verifier_id: string;
  params?: JsonObject;
  command?: string;
}

export interface LoopInboxSummary {
  total: number;
  open: number;
  high: number;
  assigned: number;
  routed: number;
  muted: number;
  by_kind: Record<string, number>;
  by_assignee: Record<string, number>;
}

export interface LoopInbox {
  workspace_id: string;
  workspace_root: string;
  generated_at: string;
  summary: LoopInboxSummary;
  items: LoopInboxItem[];
}

export interface LoopInboxOptions {
  includeDone?: boolean;
  includeSnoozed?: boolean;
  includeMuted?: boolean;
  assignee?: string;
  onlyUnassigned?: boolean;
  stalePolicy?: Partial<LoopInboxStalePolicy>;
}

export interface LoopInboxStalePolicy {
  now: Date;
  session_ms: number;
  goal_ms: number;
  review_ms: number;
  job_ms: number;
}

export interface LoopInboxStoredItemState {
  item_id: string;
  disposition?: LoopInboxDisposition;
  note?: string;
  snoozed_until?: string;
  assignee?: string;
  assignment_note?: string;
  assigned_at?: string;
  assignment_updated_at?: string;
  updated_at: string;
}

export interface LoopInboxStoredMuteState {
  mute_key: string;
  item_id?: string;
  note?: string;
  muted_until?: string;
  created_at: string;
  updated_at: string;
}

export interface LoopInboxRoutingRule {
  route_id: string;
  assignee: string;
  note?: string;
  kind?: LoopInboxItemKind;
  source?: string;
  priority?: LoopInboxPriority;
  created_at: string;
  updated_at: string;
}

export interface LoopInboxActionRequest {
  action: LoopInboxAction;
  item_id: string;
  note?: string;
  snoozed_until?: string;
}

export interface LoopInboxActionResult {
  item: LoopInboxItem;
  state?: LoopInboxStoredItemState;
  action: LoopInboxAction;
}

export interface LoopInboxAssignmentRequest {
  item_id: string;
  assignee?: string;
  note?: string;
}

export interface LoopInboxAssignmentResult {
  item: LoopInboxItem;
  state?: LoopInboxStoredItemState;
  action: "assign" | "unassign";
}

export interface LoopInboxMuteRequest {
  action: "mute" | "unmute";
  item_id: string;
  note?: string;
  muted_until?: string;
}

export interface LoopInboxMuteResult {
  item?: LoopInboxItem;
  state?: LoopInboxStoredMuteState;
  action: "mute" | "unmute";
  mute_key: string;
}

export interface LoopInboxRoutingRequest {
  action: "add" | "remove";
  route_id?: string;
  assignee?: string;
  note?: string;
  kind?: LoopInboxItemKind;
  source?: string;
  priority?: LoopInboxPriority;
}

export interface LoopInboxRoutingResult {
  action: "add" | "remove";
  route?: LoopInboxRoutingRule;
  routes: LoopInboxRoutingRule[];
}

export interface LoopInboxPromoteOptions {
  config_path?: string;
  prompt?: string;
  isolation?: LoopInboxPromotionIsolation;
}

export type LoopInboxPromotionIsolation = "active_checkout" | "worktree";

export interface LoopInboxPromoteResult {
  item: LoopInboxItem;
  job: SupervisorJob;
  worktree?: ManagedWorktree;
}

interface ProposalArtifact {
  id: string;
  status?: string;
  created_at?: string;
  adopted_at?: string;
  skill_id?: string;
  staged_skill_path?: string;
  skill_path?: string;
  evidence?: {
    goal_sessions?: number;
    verification_records?: number;
    human_feedback_records?: number;
    skill_snapshots?: number;
  };
}

interface ReplayArtifact {
  id: string;
  proposal_id?: string;
  status?: string;
  created_at?: string;
  sample_count?: number;
  baseline_score?: number;
  candidate_score?: number;
  report_path?: string;
}

interface LoopInboxStateFile {
  version: 1;
  items: Record<string, LoopInboxStoredItemState>;
  mutes: Record<string, LoopInboxStoredMuteState>;
  routes: Record<string, LoopInboxRoutingRule>;
}

const DEFAULT_STALE_POLICY: Omit<LoopInboxStalePolicy, "now"> = {
  session_ms: 24 * 60 * 60 * 1000,
  goal_ms: 24 * 60 * 60 * 1000,
  review_ms: 24 * 60 * 60 * 1000,
  job_ms: 2 * 60 * 60 * 1000,
};

export async function readLoopInbox(store: SessionStore, workspace: WorkspaceIdentity, options: LoopInboxOptions = {}): Promise<LoopInbox> {
  const items: LoopInboxItem[] = [];
  const stalePolicy = normalizeStalePolicy(options.stalePolicy);
  for (const session of store.listSessions(workspace.id, { includeArchived: true })) {
    items.push(...goalInboxItems(store, session, stalePolicy));
    items.push(...sessionStaleItems(store, session, stalePolicy));
    items.push(...actionReviewInboxItems(store, session, stalePolicy));
  }
  for (const job of store.listSupervisorJobs()) {
    if (jobBelongsToWorkspace(store, job, workspace)) {
      const item = daemonJobInboxItem(job, options, stalePolicy);
      if (item) {
        items.push(item);
      }
    }
  }
  items.push(...automationReviewInboxItems(store, workspace, stalePolicy));
  items.push(...(await optArtifactInboxItems(workspace.root, options)));
  items.push(...discoveryCandidateInboxItems(store, workspace, options));
  const sorted = filterInboxItems(await applyInboxState(workspace.root, items, options), options).sort(compareInboxItems);
  return {
    workspace_id: workspace.id,
    workspace_root: workspace.root,
    generated_at: new Date().toISOString(),
    summary: summarize(sorted),
    items: sorted,
  };
}

export async function updateLoopInboxItemState(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  request: LoopInboxActionRequest,
): Promise<LoopInboxActionResult> {
  const itemId = request.item_id.trim();
  if (!itemId) {
    throw new Error("Inbox item id is required.");
  }
  const inbox = await readLoopInbox(store, workspace, { includeDone: true, includeSnoozed: true, includeMuted: true });
  const item = inbox.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new Error(`No inbox item matches ${itemId}`);
  }
  if (request.action === "snooze" && !request.snoozed_until) {
    throw new Error("Snooze requires snoozed_until.");
  }
  const file = await readInboxStateFile(workspace.root);
  let nextState: LoopInboxStoredItemState | undefined;
  if (request.action === "reopen") {
    const existing = file.items[itemId];
    if (existing?.assignee) {
      nextState = {
        item_id: itemId,
        assignee: existing.assignee,
        assignment_note: existing.assignment_note,
        assigned_at: existing.assigned_at,
        assignment_updated_at: existing.assignment_updated_at,
        updated_at: new Date().toISOString(),
      };
      file.items[itemId] = nextState;
    } else {
      delete file.items[itemId];
    }
  } else {
    const disposition = actionDisposition(request.action);
    const existing = file.items[itemId];
    nextState = {
      item_id: itemId,
      disposition,
      note: cleanOptionalString(request.note),
      snoozed_until: disposition === "snoozed" ? request.snoozed_until : undefined,
      assignee: existing?.assignee,
      assignment_note: existing?.assignment_note,
      assigned_at: existing?.assigned_at,
      assignment_updated_at: existing?.assignment_updated_at,
      updated_at: new Date().toISOString(),
    };
    file.items[itemId] = nextState;
  }
  await writeInboxStateFile(workspace.root, file);
  if (item.session_id) {
    store.appendEvent({
      session_id: item.session_id,
      run_id: item.run_id,
      type: "loop.inbox.item.updated",
      data: {
        item_id: itemId,
        action: request.action,
        disposition: nextState?.disposition,
        snoozed_until: nextState?.snoozed_until,
        note: nextState?.note,
        assignee: nextState?.assignee,
      },
    });
  }
  return {
    action: request.action,
    state: nextState,
    item: nextState ? applyStoredItemState(item, nextState, { includeDone: true, includeSnoozed: true, includeMuted: true }, Date.now()) ?? item : item,
  };
}

export async function updateLoopInboxAssignment(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  request: LoopInboxAssignmentRequest,
): Promise<LoopInboxAssignmentResult> {
  const itemId = request.item_id.trim();
  if (!itemId) {
    throw new Error("Inbox item id is required.");
  }
  const inbox = await readLoopInbox(store, workspace, { includeDone: true, includeSnoozed: true, includeMuted: true });
  const item = inbox.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new Error(`No inbox item matches ${itemId}`);
  }
  const file = await readInboxStateFile(workspace.root);
  const existing = file.items[itemId];
  const assignee = cleanOptionalString(request.assignee);
  const now = new Date().toISOString();
  let nextState: LoopInboxStoredItemState | undefined;
  const action: "assign" | "unassign" = assignee ? "assign" : "unassign";
  if (assignee) {
    nextState = {
      item_id: itemId,
      disposition: existing?.disposition,
      note: existing?.note,
      snoozed_until: existing?.snoozed_until,
      assignee,
      assignment_note: cleanOptionalString(request.note),
      assigned_at: existing?.assignee === assignee ? existing.assigned_at ?? now : now,
      assignment_updated_at: now,
      updated_at: now,
    };
    file.items[itemId] = nextState;
  } else if (existing?.disposition) {
    nextState = {
      item_id: itemId,
      disposition: existing.disposition,
      note: existing.note,
      snoozed_until: existing.snoozed_until,
      updated_at: now,
    };
    file.items[itemId] = nextState;
  } else {
    delete file.items[itemId];
  }
  await writeInboxStateFile(workspace.root, file);
  if (item.session_id) {
    store.appendEvent({
      session_id: item.session_id,
      run_id: item.run_id,
      type: "loop.inbox.item.assigned",
      data: {
        item_id: itemId,
        action,
        assignee: nextState?.assignee,
        note: nextState?.assignment_note,
      },
    });
  }
  return {
    action,
    state: nextState,
    item: nextState ? applyStoredItemState(item, nextState, { includeDone: true, includeSnoozed: true, includeMuted: true }, Date.now()) ?? item : item,
  };
}

export async function updateLoopInboxMute(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  request: LoopInboxMuteRequest,
): Promise<LoopInboxMuteResult> {
  const itemIdOrKey = request.item_id.trim();
  if (!itemIdOrKey) {
    throw new Error("Inbox item id or mute key is required.");
  }
  const file = await readInboxStateFile(workspace.root);
  const inbox = await readLoopInbox(store, workspace, { includeDone: true, includeSnoozed: true, includeMuted: true });
  const item = inbox.items.find((candidate) => candidate.id === itemIdOrKey);
  const muteKey = item ? inboxMuteKey(item) : itemIdOrKey;
  const now = new Date().toISOString();
  if (request.action === "mute") {
    if (!item) {
      throw new Error(`No inbox item matches ${itemIdOrKey}`);
    }
    const existing = file.mutes[muteKey];
    const nextState: LoopInboxStoredMuteState = {
      mute_key: muteKey,
      item_id: item.id,
      note: cleanOptionalString(request.note),
      muted_until: cleanOptionalString(request.muted_until),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    file.mutes[muteKey] = nextState;
    await writeInboxStateFile(workspace.root, file);
    appendInboxMuteEvent(store, item, request.action, nextState);
    return {
      action: "mute",
      mute_key: muteKey,
      state: nextState,
      item: applyMuteState(item, nextState, { includeDone: true, includeSnoozed: true, includeMuted: true }, Date.now()) ?? item,
    };
  }
  const existing = file.mutes[muteKey];
  if (!existing) {
    throw new Error(`No inbox mute matches ${itemIdOrKey}`);
  }
  delete file.mutes[muteKey];
  await writeInboxStateFile(workspace.root, file);
  if (item) {
    appendInboxMuteEvent(store, item, request.action, existing);
  }
  return {
    action: "unmute",
    mute_key: muteKey,
    state: existing,
    item,
  };
}

export async function readLoopInboxRouting(workspace: WorkspaceIdentity): Promise<LoopInboxRoutingRule[]> {
  const file = await readInboxStateFile(workspace.root);
  return sortRoutingRules(Object.values(file.routes));
}

export async function updateLoopInboxRouting(
  workspace: WorkspaceIdentity,
  request: LoopInboxRoutingRequest,
): Promise<LoopInboxRoutingResult> {
  const file = await readInboxStateFile(workspace.root);
  const now = new Date().toISOString();
  if (request.action === "remove") {
    const routeId = cleanOptionalString(request.route_id);
    if (!routeId) {
      throw new Error("Inbox route id is required.");
    }
    const existing = file.routes[routeId];
    if (!existing) {
      throw new Error(`No inbox route matches ${routeId}`);
    }
    delete file.routes[routeId];
    await writeInboxStateFile(workspace.root, file);
    return { action: "remove", route: existing, routes: sortRoutingRules(Object.values(file.routes)) };
  }
  const assignee = cleanOptionalString(request.assignee);
  if (!assignee) {
    throw new Error("Inbox route owner is required.");
  }
  const kind = parseInboxKind(request.kind);
  const source = cleanOptionalString(request.source);
  const priority = parseInboxPriority(request.priority);
  if (!kind && !source && !priority) {
    throw new Error("Inbox route requires at least one structured selector: kind, source, or priority.");
  }
  const routeId = cleanOptionalString(request.route_id) ?? defaultRouteId({ assignee, kind, source, priority }, now);
  const existing = file.routes[routeId];
  const route: LoopInboxRoutingRule = {
    route_id: routeId,
    assignee,
    note: cleanOptionalString(request.note),
    kind,
    source,
    priority,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  file.routes[routeId] = route;
  await writeInboxStateFile(workspace.root, file);
  return { action: "add", route, routes: sortRoutingRules(Object.values(file.routes)) };
}

export function parseLoopInboxSnoozeUntil(value: string, now = new Date()): string {
  const trimmed = value.trim();
  const duration = /^(\d+)(m|h|d)$/i.exec(trimmed);
  if (duration) {
    const amount = Number.parseInt(duration[1]!, 10);
    const unit = duration[2]!.toLowerCase();
    const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() + amount * multiplier).toISOString();
  }
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  throw new Error("Snooze duration must look like 30m, 2h, 1d, or an ISO timestamp.");
}

export async function promoteLoopInboxItem(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  itemId: string,
  options: LoopInboxPromoteOptions = {},
): Promise<LoopInboxPromoteResult> {
  const inbox = await readLoopInbox(store, workspace, { includeDone: true, includeSnoozed: true });
  const item = inbox.items.find((candidate) => candidate.id === itemId.trim());
  if (!item) {
    throw new Error(`No inbox item matches ${itemId}`);
  }
  if (!item.session_id) {
    throw new Error(`Inbox item ${item.id} cannot be promoted because it is not tied to a session.`);
  }
  const metadata = promotionMetadata(item, options);
  let queued: { job: SupervisorJob; worktree?: ManagedWorktree };
  if (item.kind === "goal_paused" || item.kind === "verification_failure" || (item.kind === "stale_work" && item.goal_id)) {
    const state = readGoalState(store, item.session_id);
    if (!state || state.goal.status === "complete" || state.goal.status === "dropped") {
      throw new Error(`Inbox item ${item.id} has no active goal to continue.`);
    }
    if (state.goal.pending_review_decision) {
      throw new Error(`Inbox item ${item.id} requires goal review before promotion.`);
    }
    if (state.goal.blocker) {
      throw new Error(`Inbox item ${item.id} is blocked and needs feedback before promotion.`);
    }
    queued = await queuePromotedInboxJob(store, workspace, item, options, {
      session_id: item.session_id,
      prompt: options.prompt ?? buildGoalWorkPrompt(state.goal),
      kind: "goal",
      goal_id: state.goal.id,
      metadata,
    });
  } else if (item.kind === "stale_work") {
    queued = await queuePromotedInboxJob(store, workspace, item, options, {
      session_id: item.session_id,
      prompt: options.prompt ?? "Continue this stale session. Inspect recent events, summarize the current state, and take the next safe step.",
      metadata,
    });
  } else if (item.kind === "discovery_candidate") {
    if (!item.candidate_id) {
      throw new Error(`Inbox item ${item.id} has no discovery candidate to promote.`);
    }
    const candidate = store.getDiscoveryCandidate(item.candidate_id);
    if (!candidate) {
      throw new Error(`Inbox item ${item.id} has no discovery candidate to promote.`);
    }
    if (candidate.status !== "open") {
      throw new Error(`Inbox item ${item.id} is already ${candidate.status}.`);
    }
    queued = await queuePromotedInboxJob(store, workspace, item, options, {
      session_id: candidate.session_id,
      prompt: options.prompt ?? candidate.prompt,
      metadata: {
        ...metadata,
        discovery_candidate_id: candidate.candidate_id,
        discovery_schedule_id: candidate.schedule_id,
      },
    });
    store.updateDiscoveryCandidate(candidate.candidate_id, {
      status: "promoted",
      source: { ...candidate.source, promoted_job_id: queued.job.job_id },
    });
  } else if (item.kind === "automation_review") {
    if (!item.schedule_id) {
      throw new Error(`Inbox item ${item.id} has no automation schedule to promote.`);
    }
    const schedule = store.getAutomationSchedule(item.schedule_id);
    if (!schedule) {
      throw new Error(`Inbox item ${item.id} has no automation schedule to promote.`);
    }
    if (schedule.status !== "enabled") {
      throw new Error(`Inbox item ${item.id} schedule is ${schedule.status}.`);
    }
    if (automationReviewPolicy(schedule) !== "review") {
      throw new Error(`Inbox item ${item.id} schedule does not require review.`);
    }
    if (!isAutomationDue(schedule, new Date())) {
      throw new Error(`Inbox item ${item.id} schedule is not due.`);
    }
    if (schedule.last_job_id) {
      const lastJob = store.getSupervisorJob(schedule.last_job_id);
      if (lastJob && isActiveJob(lastJob)) {
        throw new Error(`Inbox item ${item.id} already has an active automation job.`);
      }
    }
    const scheduleIsolation = schedule.metadata.isolation === "worktree" ? "worktree" : "active_checkout";
    queued = await queuePromotedInboxJob(store, workspace, item, {
      ...options,
      isolation: options.isolation ?? scheduleIsolation,
    }, {
      session_id: schedule.session_id,
      prompt: options.prompt ?? schedule.prompt,
      kind: schedule.kind,
      goal_id: schedule.goal_id,
      metadata: {
        ...metadata,
        ...schedule.metadata,
        automation_schedule_id: schedule.schedule_id,
      },
    });
    const now = new Date();
    store.updateAutomationSchedule(schedule.schedule_id, {
      last_job_id: queued.job.job_id,
      last_run_at: now.toISOString(),
      next_run_at: nextAutomationRunAt(schedule, now),
      metadata: clearAutomationReviewRequest(schedule.metadata),
    });
    store.appendEvent({
      session_id: schedule.session_id,
      type: "automation.schedule.enqueued",
      data: {
        schedule_id: schedule.schedule_id,
        job_id: queued.job.job_id,
        review_approved: true,
        next_run_at: store.getAutomationSchedule(schedule.schedule_id)?.next_run_at,
      },
    });
  } else if (item.kind === "daemon_job") {
    const previous = item.job_id ? store.getSupervisorJob(item.job_id) : undefined;
    if (!previous) {
      throw new Error(`Inbox item ${item.id} has no daemon job to retry.`);
    }
    if (previous.status === "queued" || previous.status === "running" || previous.status === "detached" || previous.status === "cancel_requested") {
      throw new Error(`Inbox item ${item.id} already has an active daemon job.`);
    }
    queued = await queuePromotedInboxJob(store, workspace, item, options, {
      session_id: previous.session_id,
      workspace_root: previous.workspace_root,
      prompt: options.prompt ?? previous.prompt,
      kind: previous.kind,
      goal_id: previous.goal_id,
      metadata: { ...previous.metadata, ...metadata },
    });
  } else if (item.kind === "goal_review") {
    throw new Error(`Inbox item ${item.id} needs human review before promotion.`);
  } else if (item.kind === "goal_blocker") {
    throw new Error(`Inbox item ${item.id} is blocked and needs feedback before promotion.`);
  } else {
    throw new Error(`Inbox item ${item.id} is not a runnable work item.`);
  }
  store.appendEvent({
    session_id: item.session_id,
    run_id: item.run_id,
    type: "loop.inbox.item.promoted",
    data: {
      item_id: item.id,
      item_kind: item.kind,
      job_id: queued.job.job_id,
      job_kind: queued.job.kind,
      goal_id: queued.job.goal_id,
      isolation: options.isolation,
      worktree_id: queued.worktree?.worktree_id,
    },
  });
  return { item, job: queued.job, worktree: queued.worktree };
}

async function queuePromotedInboxJob(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  item: LoopInboxItem,
  options: LoopInboxPromoteOptions,
  request: {
    session_id: string;
    prompt: string;
    metadata: JsonObject;
    workspace_root?: string;
    kind?: "run" | "goal";
    goal_id?: string;
  },
): Promise<{ job: SupervisorJob; worktree?: ManagedWorktree }> {
  let workspaceRoot = request.workspace_root ?? workspace.root;
  let metadata = { ...request.metadata };
  let worktree: ManagedWorktree | undefined;
  if (options.isolation === "worktree") {
    worktree = await createLoopWorktree(store, workspace, {
      metadata: {
        purpose: "inbox_promote",
        inbox_item_id: item.id,
        inbox_item_kind: item.kind,
        goal_id: request.goal_id,
      },
    });
    const target = loopWorktreeRunTarget(worktree, workspace);
    workspaceRoot = target.workspace_root;
    metadata = {
      ...metadata,
      isolation: "worktree",
      worktree_id: worktree.worktree_id,
      worktree_path: worktree.path,
      worktree_branch: worktree.branch,
      base_ref: worktree.base_ref,
    };
  }
  const job = store.createSupervisorJob(request.session_id, workspaceRoot, request.prompt, {
    kind: request.kind,
    goal_id: request.goal_id,
    metadata,
  });
  if (worktree) {
    store.updateManagedWorktree(worktree.worktree_id, {
      session_id: request.session_id,
      job_id: job.job_id,
      metadata: {
        ...worktree.metadata,
        session_id: request.session_id,
        job_id: job.job_id,
      },
    });
    const assigned = store.getManagedWorktree(worktree.worktree_id) ?? worktree;
    store.appendEvent({
      session_id: request.session_id,
      type: "loop.worktree.assigned",
      data: {
        worktree_id: assigned.worktree_id,
        worktree_path: assigned.path,
        worktree_branch: assigned.branch,
        base_ref: assigned.base_ref,
        job_id: job.job_id,
        job_kind: job.kind,
        inbox_item_id: item.id,
        inbox_item_kind: item.kind,
      },
    });
    return { job, worktree: assigned };
  }
  return { job };
}

function goalInboxItems(store: SessionStore, session: SessionRecord, stalePolicy: LoopInboxStalePolicy): LoopInboxItem[] {
  const view = readGoalLoopView(store, session.session_id);
  if (!view.goal) {
    return [];
  }
  const goal = view.goal;
  const items: LoopInboxItem[] = [];
  const base = {
    session_id: session.session_id,
    session_title: session.title,
    goal_id: goal.id,
    goal_kind: goal.kind,
  };
  if (view.pending_review_decision) {
    items.push(withStaleMetadata({
      ...base,
      ...goalAssignment(goal, "review"),
      id: `goal-review:${session.session_id}:${view.pending_review_decision.id}`,
      kind: "goal_review",
      priority: "high",
      status: "open",
      source: "goal",
      title: `Review loop decision: ${view.pending_review_decision.action}`,
      detail: view.pending_review_decision.summary ?? goal.objective,
      action: "/loop review",
      run_id: view.pending_review_decision.source_run_id,
      created_at: view.pending_review_decision.created_at,
      updated_at: goal.updated_at,
    }, view.pending_review_decision.created_at, stalePolicy.review_ms, stalePolicy, "pending review"));
  }
  if (view.pending_review_decision) {
    return items;
  }
  if (goal.blocker) {
    items.push(withStaleMetadata({
      ...base,
      ...goalAssignment(goal, "review"),
      id: `goal-blocker:${session.session_id}:${goal.id}`,
      kind: "goal_blocker",
      priority: "high",
      status: "open",
      source: "goal",
      title: "Resolve blocked loop",
      detail: goal.blocker,
      action: "/loop review revise",
      updated_at: goal.updated_at,
    }, goal.updated_at, stalePolicy.goal_ms, stalePolicy, "blocked goal"));
  } else if (goal.status === "paused" || goal.status === "budget-limited") {
    items.push(withStaleMetadata({
      ...base,
      ...goalAssignment(goal, "owner"),
      id: `goal-paused:${session.session_id}:${goal.id}`,
      kind: "goal_paused",
      priority: goal.status === "budget-limited" ? "high" : "medium",
      status: "waiting",
      source: "goal",
      title: goal.status === "budget-limited" ? "Loop reached its budget" : "Paused loop",
      detail: goal.last_reflection_summary ?? goal.objective,
      action: "/loop resume",
      updated_at: goal.updated_at,
    }, goal.updated_at, stalePolicy.goal_ms, stalePolicy, goal.status === "budget-limited" ? "budget-limited goal" : "paused goal"));
  } else if (goal.status === "active") {
    const stale = staleMetadata(goal.updated_at, stalePolicy.goal_ms, stalePolicy, "active goal");
    if (stale) {
      items.push({
        ...base,
        ...goalAssignment(goal, "owner"),
        ...stale,
        id: `stale-goal:${session.session_id}:${goal.id}`,
        kind: "stale_work",
        priority: "medium",
        status: "open",
        source: "goal",
        title: "Stale active loop",
        detail: goal.last_reflection_summary ?? goal.objective,
        action: "/inbox promote",
        updated_at: goal.updated_at,
      });
    }
  }
  const latestVerification = view.verifications.at(-1);
  if (latestVerification && goal.status !== "complete" && goal.status !== "dropped" && isFailedVerification(latestVerification)) {
    items.push({
      ...base,
      ...goalAssignment(goal, "review"),
      id: `verification:${session.session_id}:${latestVerification.provider}:${latestVerification.run_id ?? latestVerification.created_at ?? "latest"}`,
      kind: "verification_failure",
      priority: latestVerification.verdict === "blocked" ? "high" : "medium",
      status: "open",
      source: latestVerification.provider,
      title: `${latestVerification.provider} verification ${latestVerification.verdict}`,
      detail: verificationDetail(latestVerification),
      action: goal.hil_policy === "review" ? "/loop review" : "/loop status",
      run_id: latestVerification.run_id,
      created_at: latestVerification.created_at,
      updated_at: latestVerification.created_at ?? goal.updated_at,
    });
  }
  return items;
}

function goalAssignment(goal: GoalRecord, purpose: "owner" | "review"): Partial<Pick<LoopInboxItem, "assignee" | "assignment_note" | "assigned_at" | "assignment_updated_at">> {
  const reviewOwner = purpose === "review" ? cleanOptionalString(goal.review_owner) : undefined;
  const owner = reviewOwner ?? cleanOptionalString(goal.owner);
  if (!owner) {
    return {};
  }
  return {
    assignee: owner,
    assignment_note: reviewOwner ? "goal review owner" : "goal owner",
    assigned_at: goal.created_at,
    assignment_updated_at: goal.updated_at,
  };
}

function sessionStaleItems(store: SessionStore, session: SessionRecord, stalePolicy: LoopInboxStalePolicy): LoopInboxItem[] {
  if (session.status === "archived") {
    return [];
  }
  const state = readGoalState(store, session.session_id);
  if (state?.goal) {
    return [];
  }
  if (!isStaleSessionStatus(session.status)) {
    return [];
  }
  const stale = staleMetadata(session.updated_at, stalePolicy.session_ms, stalePolicy, `session ${session.status}`);
  if (!stale) {
    return [];
  }
  return [{
    ...stale,
    id: `stale-session:${session.session_id}`,
    kind: "stale_work",
    priority: session.status === "failed" || session.status === "waiting_permission" ? "high" : "medium",
    status: "open",
    source: "session",
    title: `Stale session: ${session.status}`,
    detail: session.title,
    action: "/inbox promote",
    session_id: session.session_id,
    session_title: session.title,
    updated_at: session.updated_at,
  }];
}

function actionReviewInboxItems(store: SessionStore, session: SessionRecord, stalePolicy: LoopInboxStalePolicy): LoopInboxItem[] {
  return store
    .listEvents(session.session_id)
    .filter((event) => event.type === "permission.denied" && permissionDecisionPolicyKind(event) === "connector_mutation")
    .map((event) => {
      const toolCallId = cleanOptionalString(event.data.tool_call_id);
      const requestClass = cleanOptionalString(event.data.request_class);
      const toolName = cleanOptionalString(event.data.tool_name);
      const isPreflight = event.data.preflight === true;
      const connector = permissionDecisionConnector(event) ?? "connector";
      const operation = permissionDecisionConnectorOperation(event);
      const command = permissionEventCommand(event);
      const detail = [
        isPreflight ? "preflight" : undefined,
        toolName ? `tool ${toolName}` : undefined,
        requestClass ? `request ${requestClass}` : undefined,
        operation ? `operation ${operation}` : undefined,
        command ? `command: ${command}` : undefined,
      ].filter((item): item is string => Boolean(item)).join(" · ");
      const createdAt = event.created_at ?? session.updated_at;
      return withStaleMetadata({
        id: `action-review:${session.session_id}:${toolCallId ?? event.id ?? createdAt}`,
        kind: "action_review",
        priority: "high",
        status: "open",
        source: "policy",
        source_label: connector,
        title: "Review blocked connector action",
        detail,
        action: "review interactively or dismiss",
        session_id: session.session_id,
        session_title: session.title,
        run_id: event.run_id,
        created_at: createdAt,
        updated_at: createdAt,
      } satisfies LoopInboxItem, createdAt, stalePolicy.review_ms, stalePolicy, "blocked connector action");
    });
}

function isStaleSessionStatus(status: string): boolean {
  return status === "active" || status === "running_tool" || status === "waiting_permission" || status === "failed" || status === "stopped";
}

function isFailedVerification(verification: GoalLoopVerification): boolean {
  return verification.verdict === "fail" || verification.verdict === "blocked";
}

function verificationDetail(verification: GoalLoopVerification): string | undefined {
  const parts = [
    verification.failure_reason,
    verification.horizon_generation !== undefined ? `horizon ${verification.horizon_generation}` : undefined,
    verification.confidence ? `${verification.confidence} confidence` : undefined,
  ];
  return parts.filter((item): item is string => Boolean(item)).join(" · ") || undefined;
}

function jobBelongsToWorkspace(store: SessionStore, job: SupervisorJob, workspace: WorkspaceIdentity): boolean {
  if (path.resolve(job.workspace_root) === path.resolve(workspace.root)) {
    return true;
  }
  const session = store.getSession(job.session_id);
  return session?.workspace_id === workspace.id;
}

function daemonJobInboxItem(job: SupervisorJob, options: LoopInboxOptions, stalePolicy: LoopInboxStalePolicy): LoopInboxItem | undefined {
  const terminal = job.status === "complete" || job.status === "cancelled";
  if (terminal && !options.includeDone) {
    return undefined;
  }
  const stale = staleMetadata(job.updated_at, stalePolicy.job_ms, stalePolicy, `daemon job ${job.status}`);
  const priority: LoopInboxPriority =
    stale && (job.status === "queued" || job.status === "running" || job.status === "detached" || job.status === "cancel_requested")
      ? "medium"
      :
    job.status === "failed" || job.status === "blocked"
      ? "high"
      : job.status === "paused" || job.status === "cancel_requested"
        ? "medium"
        : "low";
  return {
    ...stale,
    id: `daemon:${job.job_id}`,
    kind: "daemon_job",
    priority,
    status: daemonInboxStatus(job),
    source: "daemon",
    title: `Daemon ${job.kind} ${job.status}`,
    detail: jobDetail(job),
    action: job.status === "queued" || job.status === "running" || job.status === "detached" ? "/daemon attach" : "/daemon status",
    session_id: job.session_id,
    goal_id: job.goal_id,
    job_id: job.job_id,
    run_id: job.run_id,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function automationReviewInboxItems(store: SessionStore, workspace: WorkspaceIdentity, stalePolicy: LoopInboxStalePolicy): LoopInboxItem[] {
  const now = stalePolicy.now;
  return store
    .listAutomationSchedules({ workspaceId: workspace.id, status: "enabled", dueAt: now.toISOString() })
    .filter((schedule) => automationReviewPolicy(schedule) === "review")
    .filter((schedule) => {
      if (!schedule.last_job_id) {
        return true;
      }
      const lastJob = store.getSupervisorJob(schedule.last_job_id);
      return !lastJob || !isActiveJob(lastJob);
    })
    .map((schedule) => {
      const overdueMs = Math.max(0, now.getTime() - Date.parse(schedule.next_run_at));
      return {
        id: `automation-review:${schedule.schedule_id}:${schedule.next_run_at}`,
        kind: "automation_review",
        priority: overdueMs >= schedule.interval_ms ? "high" : "medium",
        status: "open",
        source: "automation",
        title: "Review recurring automation",
        detail: schedule.prompt,
        action: "/inbox promote",
        session_id: schedule.session_id,
        schedule_id: schedule.schedule_id,
        prompt: schedule.prompt,
        created_at: typeof schedule.metadata.review_requested_at === "string" ? schedule.metadata.review_requested_at : schedule.next_run_at,
        updated_at: schedule.updated_at,
      } satisfies LoopInboxItem;
    });
}

function daemonInboxStatus(job: SupervisorJob): LoopInboxStatus {
  if (job.status === "running" || job.status === "detached") {
    return "running";
  }
  if (job.status === "queued" || job.status === "cancel_requested") {
    return "waiting";
  }
  if (job.status === "complete" || job.status === "cancelled") {
    return "done";
  }
  return "open";
}

function isActiveJob(job: SupervisorJob): boolean {
  return job.status === "queued" || job.status === "running" || job.status === "detached" || job.status === "cancel_requested";
}

function automationReviewPolicy(schedule: AutomationSchedule): "auto" | "review" {
  return schedule.metadata.review_policy === "review" ? "review" : "auto";
}

function isAutomationDue(schedule: AutomationSchedule, now: Date): boolean {
  const dueAt = Date.parse(schedule.next_run_at);
  return Number.isFinite(dueAt) && dueAt <= now.getTime();
}

function nextAutomationRunAt(schedule: AutomationSchedule, now: Date): string {
  let next = Date.parse(schedule.next_run_at);
  const nowMs = now.getTime();
  if (!Number.isFinite(next)) {
    next = nowMs;
  }
  while (next <= nowMs) {
    next += schedule.interval_ms;
  }
  return new Date(next).toISOString();
}

function clearAutomationReviewRequest(metadata: JsonObject): JsonObject {
  const output: JsonObject = { ...metadata };
  delete output.review_requested_for;
  delete output.review_requested_at;
  return output;
}

function jobDetail(job: SupervisorJob): string {
  const pauseReason = typeof job.metadata.pause_reason === "string" && job.metadata.pause_reason.trim() ? ` · ${job.metadata.pause_reason}` : "";
  const worktree = typeof job.metadata.worktree_id === "string" && job.metadata.worktree_id.trim() ? ` · wt ${job.metadata.worktree_id.slice(0, 12)}` : "";
  return `${job.prompt}${worktree}${pauseReason}`;
}

async function optArtifactInboxItems(workspaceRoot: string, options: LoopInboxOptions): Promise<LoopInboxItem[]> {
  const proposals = await readJsonArtifacts<ProposalArtifact>(path.join(workspaceRoot, ".inferoa", "self-improve", "proposals"));
  const replays = await readJsonArtifacts<ReplayArtifact>(path.join(workspaceRoot, ".inferoa", "self-improve", "replays"));
  const items: LoopInboxItem[] = [];
  for (const proposal of proposals) {
    if (proposal.status === "adopted" && !options.includeDone) {
      continue;
    }
    items.push({
      id: `skill-proposal:${proposal.id}`,
      kind: "skill_proposal",
      priority: proposal.status === "staged" ? "medium" : "low",
      status: proposal.status === "adopted" ? "done" : "open",
      source: "self-improve",
      title: proposal.status === "adopted" ? `Adopted skill proposal ${proposal.id}` : `Review skill proposal ${proposal.id}`,
      detail: proposal.evidence ? proposalEvidenceDetail(proposal) : proposal.skill_id,
      action: proposal.status === "staged" ? "inferoa self-improve replay && inferoa self-improve adopt" : "inferoa self-improve status",
      artifact_path: proposal.staged_skill_path ?? proposal.skill_path,
      created_at: proposal.created_at,
      updated_at: proposal.adopted_at ?? proposal.created_at,
    });
  }
  for (const replay of replays) {
    if (replay.status === "accepted") {
      items.push({
        id: `self-improve-replay:${replay.id}`,
        kind: "self_improve_replay",
        priority: "medium",
        status: "open",
        source: "self-improve",
        title: `Self-improve replay accepted ${replay.proposal_id ?? replay.id}`,
        detail: replayDetail(replay),
        action: replay.proposal_id ? `inferoa self-improve adopt ${replay.proposal_id}` : "inferoa self-improve adopt",
        artifact_path: replay.report_path,
        created_at: replay.created_at,
        updated_at: replay.created_at,
      });
    } else if (replay.status === "rejected") {
      items.push({
        id: `self-improve-replay:${replay.id}`,
        kind: "self_improve_replay",
        priority: "medium",
        status: "open",
        source: "self-improve",
        title: `Self-improve replay rejected ${replay.proposal_id ?? replay.id}`,
        detail: replayDetail(replay),
        action: replay.proposal_id ? `inferoa self-improve propose` : "inferoa self-improve status",
        artifact_path: replay.report_path,
        created_at: replay.created_at,
        updated_at: replay.created_at,
      });
    }
  }
  return items;
}

function discoveryCandidateInboxItems(store: SessionStore, workspace: WorkspaceIdentity, options: LoopInboxOptions): LoopInboxItem[] {
  return store
    .listDiscoveryCandidates({ workspaceId: workspace.id })
    .filter((candidate) => options.includeDone || candidate.status === "open")
    .map((candidate) => {
      const verificationHint = discoveryCandidateVerificationHint(candidate);
      return {
        id: `discovery:${candidate.candidate_id}`,
        kind: "discovery_candidate",
        priority: candidate.priority,
        status: candidate.status === "open" ? "open" : "done",
        source: discoveryCandidateSource(candidate),
        source_label: discoveryCandidateSourceLabel(candidate),
        title: `Discovered: ${candidate.title}`,
        detail: appendVerificationHintDetail(candidate.detail, verificationHint),
        action: candidate.status === "open" ? "/inbox promote" : "inferoa inbox reopen",
        session_id: candidate.session_id,
        candidate_id: candidate.candidate_id,
        mute_key: `discovery:${candidate.dedupe_key}`,
        prompt: candidate.prompt,
        verification_hint: verificationHint,
        created_at: candidate.created_at,
        updated_at: candidate.updated_at,
      } satisfies LoopInboxItem;
    });
}

async function readJsonArtifacts<T>(dir: string): Promise<T[]> {
  const entries = await fs.readdir(dir).catch(() => []);
  const artifacts: T[] = [];
  for (const entry of entries.filter((item) => item.endsWith(".json")).sort()) {
    try {
      artifacts.push(JSON.parse(await fs.readFile(path.join(dir, entry), "utf8")) as T);
    } catch {
      // Ignore malformed local artifacts; the inbox should remain usable.
    }
  }
  return artifacts;
}

async function applyInboxState(workspaceRoot: string, items: LoopInboxItem[], options: LoopInboxOptions): Promise<LoopInboxItem[]> {
  const state = await readInboxStateFile(workspaceRoot);
  const now = Date.now();
  const routes = sortRoutingRules(Object.values(state.routes));
  const output: LoopInboxItem[] = [];
  for (const item of items) {
    const stored = state.items[item.id];
    const overlaid = stored ? applyStoredItemState(item, stored, options, now) : item;
    if (!overlaid) {
      continue;
    }
    const routed = applyRoutingRules(overlaid, routes);
    const muted = applyMuteState(routed, activeMuteState(state.mutes[inboxMuteKey(routed)], now), options, now);
    if (muted) {
      output.push(muted);
    }
  }
  return output;
}

function applyStoredItemState(
  item: LoopInboxItem,
  stored: LoopInboxStoredItemState,
  options: LoopInboxOptions,
  nowMs: number,
): LoopInboxItem | undefined {
  const assigned = applyAssignmentState(item, stored);
  if (!stored.disposition) {
    return assigned;
  }
  if (stored.disposition === "snoozed") {
    const untilMs = stored.snoozed_until ? Date.parse(stored.snoozed_until) : NaN;
    if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
      return assigned;
    }
    const snoozed: LoopInboxItem = {
      ...assigned,
      status: "snoozed",
      disposition: stored.disposition,
      disposition_note: stored.note,
      snoozed_until: stored.snoozed_until,
      state_updated_at: stored.updated_at,
      action: `snoozed until ${stored.snoozed_until}`,
    };
    return options.includeSnoozed || options.includeDone ? snoozed : undefined;
  }
  const done: LoopInboxItem = {
    ...assigned,
    priority: "low",
    status: "done",
    disposition: stored.disposition,
    disposition_note: stored.note,
    state_updated_at: stored.updated_at,
    action: "inferoa inbox reopen",
  };
  return options.includeDone ? done : undefined;
}

function applyAssignmentState(item: LoopInboxItem, stored: LoopInboxStoredItemState): LoopInboxItem {
  if (!stored.assignee) {
    return item;
  }
  return {
    ...item,
    assignee: stored.assignee,
    assignment_note: stored.assignment_note,
    assigned_at: stored.assigned_at,
    assignment_updated_at: stored.assignment_updated_at,
    state_updated_at: stored.updated_at,
  };
}

function applyRoutingRules(item: LoopInboxItem, routes: LoopInboxRoutingRule[]): LoopInboxItem {
  if (item.assignee) {
    return item;
  }
  const route = routes.find((candidate) => routeMatchesItem(candidate, item));
  if (!route) {
    return item;
  }
  return {
    ...item,
    assignee: route.assignee,
    assignment_note: route.note,
    assigned_at: route.created_at,
    assignment_updated_at: route.updated_at,
    routed_by: route.route_id,
    routing_note: route.note,
    state_updated_at: route.updated_at,
  };
}

function routeMatchesItem(route: LoopInboxRoutingRule, item: LoopInboxItem): boolean {
  if (route.kind && item.kind !== route.kind) {
    return false;
  }
  if (route.source && item.source !== route.source) {
    return false;
  }
  if (route.priority && item.priority !== route.priority) {
    return false;
  }
  return true;
}

function applyMuteState(
  item: LoopInboxItem,
  stored: LoopInboxStoredMuteState | undefined,
  options: LoopInboxOptions,
  nowMs: number,
): LoopInboxItem | undefined {
  if (!stored) {
    return item;
  }
  const muted: LoopInboxItem = {
    ...item,
    priority: "low",
    status: "muted",
    muted: true,
    mute_key: stored.mute_key,
    mute_note: stored.note,
    muted_at: stored.created_at,
    muted_until: stored.muted_until,
    state_updated_at: stored.updated_at,
    action: stored.muted_until ? `muted until ${stored.muted_until}` : "inferoa inbox unmute",
  };
  return options.includeMuted || options.includeDone ? muted : undefined;
}

function activeMuteState(stored: LoopInboxStoredMuteState | undefined, nowMs: number): LoopInboxStoredMuteState | undefined {
  if (!stored) {
    return undefined;
  }
  if (!stored.muted_until) {
    return stored;
  }
  const untilMs = Date.parse(stored.muted_until);
  return Number.isFinite(untilMs) && untilMs > nowMs ? stored : undefined;
}

function inboxMuteKey(item: LoopInboxItem): string {
  return item.mute_key && item.mute_key.trim() ? item.mute_key.trim() : `item:${item.id}`;
}

async function readInboxStateFile(workspaceRoot: string): Promise<LoopInboxStateFile> {
  const target = inboxStatePath(workspaceRoot);
  try {
    const parsed = JSON.parse(await fs.readFile(target, "utf8")) as Partial<LoopInboxStateFile>;
    return {
      version: 1,
      items: sanitizeInboxStateItems(parsed.items),
      mutes: sanitizeInboxMuteStates(parsed.mutes),
      routes: sanitizeInboxRoutingRules(parsed.routes),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { version: 1, items: {}, mutes: {}, routes: {} };
    }
    throw error;
  }
}

async function writeInboxStateFile(workspaceRoot: string, state: LoopInboxStateFile): Promise<void> {
  const target = inboxStatePath(workspaceRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({ version: 1, items: state.items, mutes: state.mutes, routes: state.routes }, null, 2)}\n`, "utf8");
}

function inboxStatePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".inferoa", "inbox", "state.json");
}

function sanitizeInboxStateItems(value: unknown): Record<string, LoopInboxStoredItemState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, LoopInboxStoredItemState> = {};
  for (const [itemId, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const disposition = parseDisposition(candidate.disposition);
    const updatedAt = typeof candidate.updated_at === "string" ? candidate.updated_at : undefined;
    const assignee = cleanOptionalString(candidate.assignee);
    if ((!disposition && !assignee) || !updatedAt) {
      continue;
    }
    output[itemId] = {
      item_id: itemId,
      disposition,
      note: cleanOptionalString(candidate.note),
      snoozed_until: typeof candidate.snoozed_until === "string" ? candidate.snoozed_until : undefined,
      assignee,
      assignment_note: cleanOptionalString(candidate.assignment_note),
      assigned_at: typeof candidate.assigned_at === "string" ? candidate.assigned_at : undefined,
      assignment_updated_at: typeof candidate.assignment_updated_at === "string" ? candidate.assignment_updated_at : undefined,
      updated_at: updatedAt,
    };
  }
  return output;
}

function sanitizeInboxMuteStates(value: unknown): Record<string, LoopInboxStoredMuteState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, LoopInboxStoredMuteState> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const muteKey = cleanOptionalString(candidate.mute_key) ?? cleanOptionalString(key);
    const createdAt = typeof candidate.created_at === "string" ? candidate.created_at : undefined;
    const updatedAt = typeof candidate.updated_at === "string" ? candidate.updated_at : undefined;
    if (!muteKey || !createdAt || !updatedAt) {
      continue;
    }
    output[muteKey] = {
      mute_key: muteKey,
      item_id: cleanOptionalString(candidate.item_id),
      note: cleanOptionalString(candidate.note),
      muted_until: typeof candidate.muted_until === "string" ? candidate.muted_until : undefined,
      created_at: createdAt,
      updated_at: updatedAt,
    };
  }
  return output;
}

function sanitizeInboxRoutingRules(value: unknown): Record<string, LoopInboxRoutingRule> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, LoopInboxRoutingRule> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const routeId = cleanOptionalString(candidate.route_id) ?? cleanOptionalString(key);
    const assignee = cleanOptionalString(candidate.assignee);
    const createdAt = typeof candidate.created_at === "string" ? candidate.created_at : undefined;
    const updatedAt = typeof candidate.updated_at === "string" ? candidate.updated_at : undefined;
    if (!routeId || !assignee || !createdAt || !updatedAt) {
      continue;
    }
    const kind = parseInboxKind(candidate.kind);
    const source = cleanOptionalString(candidate.source);
    const priority = parseInboxPriority(candidate.priority);
    if (!kind && !source && !priority) {
      continue;
    }
    output[routeId] = {
      route_id: routeId,
      assignee,
      note: cleanOptionalString(candidate.note),
      kind,
      source,
      priority,
      created_at: createdAt,
      updated_at: updatedAt,
    };
  }
  return output;
}

function parseDisposition(value: unknown): LoopInboxDisposition | undefined {
  return value === "resolved" || value === "dismissed" || value === "snoozed" ? value : undefined;
}

function parseInboxKind(value: unknown): LoopInboxItemKind | undefined {
  return value === "goal_review"
    || value === "goal_blocker"
    || value === "goal_paused"
    || value === "verification_failure"
    || value === "stale_work"
    || value === "automation_review"
    || value === "action_review"
    || value === "discovery_candidate"
    || value === "daemon_job"
    || value === "skill_proposal"
    || value === "self_improve_replay"
    ? value
    : undefined;
}

function parseInboxPriority(value: unknown): LoopInboxPriority | undefined {
  return value === "high" || value === "medium" || value === "low" ? value : undefined;
}

function actionDisposition(action: LoopInboxAction): LoopInboxDisposition {
  if (action === "resolve") {
    return "resolved";
  }
  if (action === "dismiss") {
    return "dismissed";
  }
  if (action === "snooze") {
    return "snoozed";
  }
  throw new Error(`Unsupported inbox action: ${action}`);
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function permissionDecisionPolicyKind(event: SessionEvent): string | undefined {
  return cleanOptionalString(jsonObject(event.data.decision)?.policy_kind);
}

function permissionDecisionConnector(event: SessionEvent): string | undefined {
  return cleanOptionalString(jsonObject(event.data.decision)?.connector);
}

function permissionDecisionConnectorOperation(event: SessionEvent): string | undefined {
  const decision = jsonObject(event.data.decision);
  const connector = cleanOptionalString(decision?.connector);
  const area = cleanOptionalString(decision?.connector_area);
  const operation = cleanOptionalString(decision?.connector_operation);
  return [connector, area, operation].filter((item): item is string => Boolean(item)).join(".") || undefined;
}

function permissionEventCommand(event: SessionEvent): string | undefined {
  const command = cleanOptionalString(jsonObject(event.data.arguments)?.command);
  return command ? redactCommandForInbox(command) : undefined;
}

function jsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function redactCommandForInbox(command: string): string {
  return command.replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi, "$1=<redacted>");
}

function defaultRouteId(
  input: Pick<LoopInboxRoutingRule, "assignee" | "kind" | "source" | "priority">,
  now: string,
): string {
  const parts = [
    input.assignee,
    input.kind,
    input.source,
    input.priority,
    now.replace(/[^0-9A-Za-z]/g, "").slice(0, 14),
  ].filter((part): part is string => Boolean(part));
  return `route-${parts.join("-").replace(/[^0-9A-Za-z_-]+/g, "-").slice(0, 96)}`;
}

function sortRoutingRules(routes: LoopInboxRoutingRule[]): LoopInboxRoutingRule[] {
  return [...routes].sort((left, right) => left.created_at.localeCompare(right.created_at) || left.route_id.localeCompare(right.route_id));
}

function discoveryCandidateSource(candidate: { source: JsonObject }): string {
  return cleanOptionalString(candidate.source.kind)
    ?? cleanOptionalString(candidate.source.source)
    ?? cleanOptionalString(candidate.source.provider)
    ?? "discovery";
}

function discoveryCandidateSourceLabel(candidate: { source: JsonObject }): string | undefined {
  const source = discoveryCandidateSource(candidate);
  const repo = cleanOptionalString(candidate.source.repo);
  return repo ? `${source}:${repo}` : source;
}

function discoveryCandidateVerificationHint(candidate: { session_id: string; source: JsonObject }): LoopInboxVerificationHint | undefined {
  const suggested = jsonObject(candidate.source.suggested_verifier);
  const verifierId = cleanOptionalString(suggested?.id);
  if (!verifierId) {
    return undefined;
  }
  const definition = getConnectorVerifierDefinition(verifierId);
  if (!definition) {
    return undefined;
  }
  const params = jsonObject(suggested?.params) ?? {};
  const command = connectorVerifierCommand(definition.cli_command, candidate.session_id, verifierId, params);
  return {
    verifier_id: verifierId,
    params,
    command,
  };
}

function appendVerificationHintDetail(detail: string | undefined, hint: LoopInboxVerificationHint | undefined): string | undefined {
  if (!hint?.command) {
    return detail;
  }
  const verify = `verify: ${hint.command}`;
  return detail ? `${detail}; ${verify}` : verify;
}

function connectorVerifierCommand(command: string, sessionId: string, verifierId: string, params: JsonObject): string | undefined {
  const args = ["inferoa", command, sessionId];
  switch (verifierId) {
    case "github-pr-checks":
    case "github-pr-status":
    case "github-review-request": {
      const pr = cleanOptionalString(params.pr);
      if (!pr) {
        return undefined;
      }
      args.push(pr);
      appendOptionalFlag(args, "--repo", cleanOptionalString(params.repo));
      appendOptionalFlag(args, "--reviewer", verifierId === "github-review-request" ? cleanOptionalString(params.reviewer) : undefined);
      return args.map(shellArg).join(" ");
    }
    case "github-issue-status": {
      const issue = cleanOptionalString(params.issue);
      if (!issue) {
        return undefined;
      }
      args.push(issue);
      appendOptionalFlag(args, "--repo", cleanOptionalString(params.repo));
      return args.map(shellArg).join(" ");
    }
    case "github-notification-status": {
      const thread = cleanOptionalString(params.thread);
      if (!thread) {
        return undefined;
      }
      args.push(thread);
      return args.map(shellArg).join(" ");
    }
    case "github-actions-run": {
      const run = cleanOptionalString(params.run);
      if (!run) {
        return undefined;
      }
      args.push(run);
      appendOptionalFlag(args, "--repo", cleanOptionalString(params.repo));
      appendOptionalFlag(args, "--attempt", numberParamString(params.attempt));
      return args.map(shellArg).join(" ");
    }
    case "github-deployment-status": {
      const repo = cleanOptionalString(params.repo);
      const deploymentId = cleanOptionalString(params.deployment_id);
      const environment = cleanOptionalString(params.environment);
      if (!repo || (!deploymentId && !environment)) {
        return undefined;
      }
      appendOptionalFlag(args, "--repo", repo);
      appendOptionalFlag(args, "--deployment-id", deploymentId);
      appendOptionalFlag(args, "--environment", deploymentId ? undefined : environment);
      appendOptionalFlag(args, "--ref", cleanOptionalString(params.ref));
      appendOptionalFlag(args, "--expect", cleanOptionalString(params.expect));
      return args.map(shellArg).join(" ");
    }
    case "github-release-status": {
      const tag = cleanOptionalString(params.tag);
      if (!tag) {
        return undefined;
      }
      args.push(tag);
      appendOptionalFlag(args, "--repo", cleanOptionalString(params.repo));
      appendOptionalFlag(args, "--expect", cleanOptionalString(params.expect));
      return args.map(shellArg).join(" ");
    }
    case "git-clean":
      return args.map(shellArg).join(" ");
    case "http-health": {
      const url = cleanOptionalString(params.url);
      if (!url) {
        return undefined;
      }
      args.push(url);
      appendOptionalFlag(args, "--status", numberParamString(params.expected_status));
      appendOptionalFlag(args, "--timeout-ms", numberParamString(params.timeout_ms));
      return args.map(shellArg).join(" ");
    }
    case "npm-package-status": {
      const packageName = cleanOptionalString(params.package_name);
      const version = cleanOptionalString(params.version);
      if (!packageName || !version) {
        return undefined;
      }
      args.push(packageName);
      appendOptionalFlag(args, "--version", version);
      appendOptionalFlag(args, "--tag", cleanOptionalString(params.tag));
      appendOptionalFlag(args, "--timeout-ms", numberParamString(params.timeout_ms));
      return args.map(shellArg).join(" ");
    }
    default:
      return undefined;
  }
}

function appendOptionalFlag(args: string[], flag: string, value: string | undefined): void {
  if (!value) {
    return;
  }
  args.push(flag, value);
}

function numberParamString(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : undefined;
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function appendInboxMuteEvent(
  store: SessionStore,
  item: LoopInboxItem,
  action: "mute" | "unmute",
  state: LoopInboxStoredMuteState,
): void {
  if (!item.session_id) {
    return;
  }
  store.appendEvent({
    session_id: item.session_id,
    run_id: item.run_id,
    type: "loop.inbox.item.muted",
    data: {
      item_id: item.id,
      action,
      mute_key: state.mute_key,
      muted_until: state.muted_until,
      note: state.note,
    },
  });
}

function promotionMetadata(item: LoopInboxItem, options: LoopInboxPromoteOptions): JsonObject {
  return {
    ...(options.config_path ? { config_path: options.config_path } : {}),
    inbox_item_id: item.id,
    inbox_item_kind: item.kind,
    ...(item.verification_hint ? { verification_hint: item.verification_hint as unknown as JsonObject } : {}),
  };
}

function normalizeStalePolicy(policy: Partial<LoopInboxStalePolicy> | undefined): LoopInboxStalePolicy {
  return {
    now: policy?.now ?? new Date(),
    session_ms: positiveDuration(policy?.session_ms, DEFAULT_STALE_POLICY.session_ms),
    goal_ms: positiveDuration(policy?.goal_ms, DEFAULT_STALE_POLICY.goal_ms),
    review_ms: positiveDuration(policy?.review_ms, DEFAULT_STALE_POLICY.review_ms),
    job_ms: positiveDuration(policy?.job_ms, DEFAULT_STALE_POLICY.job_ms),
  };
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function withStaleMetadata<T extends LoopInboxItem>(
  item: T,
  since: string | undefined,
  thresholdMs: number,
  policy: LoopInboxStalePolicy,
  reason: string,
): T {
  const stale = staleMetadata(since, thresholdMs, policy, reason);
  if (!stale) {
    return item;
  }
  return {
    ...item,
    ...stale,
    priority: item.priority === "low" ? "medium" : item.priority,
  };
}

function staleMetadata(
  since: string | undefined,
  thresholdMs: number,
  policy: LoopInboxStalePolicy,
  reason: string,
): Pick<LoopInboxItem, "stale" | "stale_reason" | "stale_age_ms" | "stale_since"> | undefined {
  if (!since) {
    return undefined;
  }
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) {
    return undefined;
  }
  const ageMs = policy.now.getTime() - sinceMs;
  if (ageMs < thresholdMs) {
    return undefined;
  }
  return {
    stale: true,
    stale_reason: reason,
    stale_age_ms: Math.max(0, Math.trunc(ageMs)),
    stale_since: since,
  };
}

function proposalEvidenceDetail(proposal: ProposalArtifact): string {
  const evidence = proposal.evidence ?? {};
  return [
    evidence.goal_sessions !== undefined ? `${evidence.goal_sessions} goal sessions` : undefined,
    evidence.verification_records !== undefined ? `${evidence.verification_records} verification records` : undefined,
    evidence.human_feedback_records !== undefined ? `${evidence.human_feedback_records} feedback records` : undefined,
    evidence.skill_snapshots !== undefined ? `${evidence.skill_snapshots} skill snapshots` : undefined,
  ].filter((item): item is string => Boolean(item)).join(" · ");
}

function replayDetail(replay: ReplayArtifact): string {
  const parts = [
    replay.sample_count !== undefined ? `${replay.sample_count} samples` : undefined,
    replay.baseline_score !== undefined ? `baseline ${roundScore(replay.baseline_score)}` : undefined,
    replay.candidate_score !== undefined ? `candidate ${roundScore(replay.candidate_score)}` : undefined,
  ];
  return parts.filter((item): item is string => Boolean(item)).join(" · ");
}

function roundScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function summarize(items: LoopInboxItem[]): LoopInboxSummary {
  const byKind: Record<string, number> = {};
  const byAssignee: Record<string, number> = {};
  for (const item of items) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    if (item.assignee) {
      byAssignee[item.assignee] = (byAssignee[item.assignee] ?? 0) + 1;
    }
  }
  return {
    total: items.length,
    open: items.filter((item) => item.status !== "done" && item.status !== "snoozed" && item.status !== "muted").length,
    high: items.filter((item) => item.priority === "high").length,
    assigned: items.filter((item) => Boolean(item.assignee)).length,
    routed: items.filter((item) => Boolean(item.routed_by)).length,
    muted: items.filter((item) => item.status === "muted").length,
    by_kind: byKind,
    by_assignee: byAssignee,
  };
}

function filterInboxItems(items: LoopInboxItem[], options: LoopInboxOptions): LoopInboxItem[] {
  const assignee = cleanOptionalString(options.assignee);
  if (assignee) {
    return items.filter((item) => item.assignee === assignee);
  }
  if (options.onlyUnassigned) {
    return items.filter((item) => !item.assignee);
  }
  return items;
}

function compareInboxItems(left: LoopInboxItem, right: LoopInboxItem): number {
  return priorityRank(left.priority) - priorityRank(right.priority)
    || statusRank(left.status) - statusRank(right.status)
    || (right.updated_at ?? "").localeCompare(left.updated_at ?? "")
    || left.id.localeCompare(right.id);
}

function priorityRank(priority: LoopInboxPriority): number {
  if (priority === "high") return 0;
  if (priority === "medium") return 1;
  return 2;
}

function statusRank(status: LoopInboxStatus): number {
  if (status === "open") return 0;
  if (status === "waiting") return 1;
  if (status === "running") return 2;
  if (status === "snoozed") return 3;
  if (status === "muted") return 4;
  return 5;
}
