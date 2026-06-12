import { promises as fs } from "node:fs";
import path from "node:path";
import { readGoalLoopView } from "./projection.js";
import type { GoalLoopVerification } from "./types.js";
import type { AutomationSchedule, ManagedWorktree, SessionStore, SupervisorJob } from "../session/store.js";
import type { JsonObject, SessionEvent, SessionRecord, WorkspaceIdentity } from "../types.js";
import { readGoalState, type GoalRecord } from "../goals/state.js";
import { buildGoalWorkPrompt } from "../goals/supervisor-prompts.js";
import { createLoopWorktree, loopWorktreeRunTarget } from "./worktree.js";

export type LoopInboxItemKind =
  | "goal_review"
  | "goal_blocker"
  | "goal_paused"
  | "verification_failure"
  | "stale_work"
  | "automation_review"
  | "external_action_approval"
  | "discovery_candidate"
  | "daemon_job"
  | "skill_proposal"
  | "self_improve_replay";

export type LoopInboxPriority = "high" | "medium" | "low";
export type LoopInboxStatus = "open" | "waiting" | "running" | "done";
export type LoopInboxDisposition = "resolved" | "dismissed";
export type LoopInboxAction = "resolve" | "dismiss" | "reopen";

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
  state_updated_at?: string;
  assignee?: string;
  assignment_note?: string;
  assigned_at?: string;
  assignment_updated_at?: string;
  stale?: boolean;
  stale_reason?: string;
  stale_age_ms?: number;
  stale_since?: string;
}

export interface LoopInboxVerificationHint {
  verifier_id: string;
  params?: JsonObject;
}

export interface LoopInboxSummary {
  total: number;
  open: number;
  high: number;
  by_kind: Record<string, number>;
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
  updated_at: string;
}

export interface LoopInboxActionRequest {
  action: LoopInboxAction;
  item_id: string;
  note?: string;
}

export interface LoopInboxActionResult {
  item: LoopInboxItem;
  state?: LoopInboxStoredItemState;
  action: LoopInboxAction;
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
    items.push(...externalActionApprovalInboxItems(store, session, stalePolicy));
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
  const sorted = (await applyInboxState(workspace.root, items, options)).sort(compareInboxItems);
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
  const inbox = await readLoopInbox(store, workspace, { includeDone: true });
  const item = inbox.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new Error(`No inbox item matches ${itemId}`);
  }
  const file = await readInboxStateFile(workspace.root);
  let nextState: LoopInboxStoredItemState | undefined;
  if (request.action === "reopen") {
    delete file.items[itemId];
  } else {
    const disposition = actionDisposition(request.action);
    nextState = {
      item_id: itemId,
      disposition,
      note: cleanOptionalString(request.note),
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
        note: nextState?.note,
      },
    });
  }
  return {
    action: request.action,
    state: nextState,
    item: nextState ? applyStoredItemState(item, nextState, { includeDone: true }) ?? item : item,
  };
}

export async function promoteLoopInboxItem(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  itemId: string,
  options: LoopInboxPromoteOptions = {},
): Promise<LoopInboxPromoteResult> {
  const inbox = await readLoopInbox(store, workspace, { includeDone: true });
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

function externalActionApprovalInboxItems(store: SessionStore, session: SessionRecord, stalePolicy: LoopInboxStalePolicy): LoopInboxItem[] {
  return store
    .listEvents(session.session_id)
    .filter((event) => event.type === "permission.denied" && permissionDecisionPolicyKind(event) === "external_mutation")
    .map((event) => {
      const toolCallId = cleanOptionalString(event.data.tool_call_id);
      const requestClass = cleanOptionalString(event.data.request_class);
      const toolName = cleanOptionalString(event.data.tool_name);
      const system = permissionDecisionExternalSystem(event) ?? "external";
      const operation = permissionDecisionExternalOperation(event);
      const command = permissionEventCommand(event);
      const detail = [
        toolName ? `tool ${toolName}` : undefined,
        requestClass ? `request ${requestClass}` : undefined,
        operation ? `operation ${operation}` : undefined,
        command ? `command: ${command}` : undefined,
      ].filter((item): item is string => Boolean(item)).join(" · ");
      const createdAt = event.created_at ?? session.updated_at;
      return withStaleMetadata({
        id: `external-action:${session.session_id}:${toolCallId ?? event.id ?? createdAt}`,
        kind: "external_action_approval",
        priority: "high",
        status: "open",
        source: "policy",
        source_label: system,
        title: "Approve external mutation",
        detail,
        action: "review interactively or dismiss",
        session_id: session.session_id,
        session_title: session.title,
        run_id: event.run_id,
        created_at: createdAt,
        updated_at: createdAt,
      } satisfies LoopInboxItem, createdAt, stalePolicy.review_ms, stalePolicy, "blocked external mutation");
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
      action: proposal.status === "staged" ? "inferoa self-improve adopt" : "inferoa self-improve status",
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
        action: replay.proposal_id ? "inferoa self-improve learn" : "inferoa self-improve status",
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
  const output: LoopInboxItem[] = [];
  for (const item of items) {
    const stored = state.items[item.id];
    const overlaid = stored ? applyStoredItemState(item, stored, options) : item;
    if (!overlaid) {
      continue;
    }
    output.push(overlaid);
  }
  return output;
}

function applyStoredItemState(
  item: LoopInboxItem,
  stored: LoopInboxStoredItemState,
  options: LoopInboxOptions,
): LoopInboxItem | undefined {
  if (!stored.disposition) {
    return item;
  }
  const done: LoopInboxItem = {
    ...item,
    priority: "low",
    status: "done",
    disposition: stored.disposition,
    disposition_note: stored.note,
    state_updated_at: stored.updated_at,
    action: "inferoa inbox reopen",
  };
  return options.includeDone ? done : undefined;
}

async function readInboxStateFile(workspaceRoot: string): Promise<LoopInboxStateFile> {
  const target = inboxStatePath(workspaceRoot);
  try {
    const parsed = JSON.parse(await fs.readFile(target, "utf8")) as Partial<LoopInboxStateFile>;
    return {
      version: 1,
      items: sanitizeInboxStateItems(parsed.items),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { version: 1, items: {} };
    }
    throw error;
  }
}

async function writeInboxStateFile(workspaceRoot: string, state: LoopInboxStateFile): Promise<void> {
  const target = inboxStatePath(workspaceRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({ version: 1, items: state.items }, null, 2)}\n`, "utf8");
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
    if (!disposition || !updatedAt) {
      continue;
    }
    output[itemId] = {
      item_id: itemId,
      disposition,
      note: cleanOptionalString(candidate.note),
      updated_at: updatedAt,
    };
  }
  return output;
}

function parseDisposition(value: unknown): LoopInboxDisposition | undefined {
  return value === "resolved" || value === "dismissed" ? value : undefined;
}

function parseInboxKind(value: unknown): LoopInboxItemKind | undefined {
  return value === "goal_review"
    || value === "goal_blocker"
    || value === "goal_paused"
    || value === "verification_failure"
    || value === "stale_work"
    || value === "automation_review"
    || value === "external_action_approval"
    || value === "discovery_candidate"
    || value === "daemon_job"
    || value === "skill_proposal"
    || value === "self_improve_replay"
    ? value
    : undefined;
}

function actionDisposition(action: LoopInboxAction): LoopInboxDisposition {
  if (action === "resolve") {
    return "resolved";
  }
  if (action === "dismiss") {
    return "dismissed";
  }
  throw new Error(`Unsupported inbox action: ${action}`);
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function permissionDecisionPolicyKind(event: SessionEvent): string | undefined {
  return cleanOptionalString(jsonObject(event.data.decision)?.policy_kind);
}

function permissionDecisionExternalSystem(event: SessionEvent): string | undefined {
  return cleanOptionalString(jsonObject(event.data.decision)?.external_system);
}

function permissionDecisionExternalOperation(event: SessionEvent): string | undefined {
  const decision = jsonObject(event.data.decision);
  const system = cleanOptionalString(decision?.external_system);
  const area = cleanOptionalString(decision?.external_area);
  const operation = cleanOptionalString(decision?.external_operation);
  return [system, area, operation].filter((item): item is string => Boolean(item)).join(".") || undefined;
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

function discoveryCandidateVerificationHint(candidate: { source: JsonObject }): LoopInboxVerificationHint | undefined {
  const suggested = jsonObject(candidate.source.suggested_verifier);
  const verifierId = cleanOptionalString(suggested?.id);
  if (!verifierId) {
    return undefined;
  }
  const params = jsonObject(suggested?.params) ?? {};
  return {
    verifier_id: verifierId,
    params,
  };
}

function appendVerificationHintDetail(detail: string | undefined, hint: LoopInboxVerificationHint | undefined): string | undefined {
  if (!hint) {
    return detail;
  }
  const verify = "verification: use CLI/skill checks, then record structured goal.verify evidence";
  return detail ? `${detail}; ${verify}` : verify;
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
  for (const item of items) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  }
  return {
    total: items.length,
    open: items.filter((item) => item.status !== "done").length,
    high: items.filter((item) => item.priority === "high").length,
    by_kind: byKind,
  };
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
  return 3;
}
