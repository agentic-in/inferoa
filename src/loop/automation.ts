import path from "node:path";
import type { AutomationSchedule, SessionStore, SupervisorJob } from "../session/store.js";
import type { JsonObject, WorkspaceIdentity } from "../types.js";
import { createLoopWorktree, loopWorktreeRunTarget } from "./worktree.js";

export interface CreateLoopAutomationScheduleOptions {
  prompt: string;
  interval_ms: number;
  next_run_at?: string;
  session_id?: string;
  title?: string;
  config_path?: string;
  isolation?: AutomationIsolation;
  review_policy?: AutomationReviewPolicy;
  metadata?: JsonObject;
}

export type AutomationIsolation = "active_checkout" | "worktree";
export type AutomationReviewPolicy = "auto" | "review";

export interface DueAutomationResult {
  enqueued: { schedule: AutomationSchedule; job: SupervisorJob }[];
  skipped: { schedule: AutomationSchedule; reason: string }[];
}

export function parseAutomationInterval(value: string): number {
  const trimmed = value.trim();
  const match = /^(\d+)(m|h|d)$/i.exec(trimmed);
  if (!match) {
    throw new Error("Interval must look like 15m, 2h, or 1d.");
  }
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const interval = amount * multiplier;
  if (!Number.isFinite(interval) || interval < 60_000) {
    throw new Error("Automation interval must be at least 1m.");
  }
  return interval;
}

export function createLoopAutomationSchedule(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: CreateLoopAutomationScheduleOptions,
): AutomationSchedule {
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw new Error("Automation prompt must not be empty.");
  }
  const session = options.session_id
    ? store.getSession(options.session_id) ?? store.findSessionByPrefix(workspace.id, options.session_id)
    : store.createSession(workspace, options.title ?? `auto:${prompt.slice(0, 48)}`);
  if (!session) {
    throw new Error(`Unknown session for automation: ${options.session_id}`);
  }
  const metadata = {
    ...(options.metadata ?? {}),
    ...(options.config_path ? { config_path: options.config_path } : {}),
    ...(options.isolation ? { isolation: options.isolation } : {}),
    ...(options.review_policy === "review" ? { review_policy: "review" } : {}),
  };
  return store.createAutomationSchedule(workspace, session.session_id, prompt, {
    interval_ms: options.interval_ms,
    next_run_at: options.next_run_at ?? new Date(Date.now() + options.interval_ms).toISOString(),
    metadata,
  });
}

export async function enqueueDueAutomationSchedules(store: SessionStore, options: { now?: Date; limit?: number } = {}): Promise<DueAutomationResult> {
  const now = options.now ?? new Date();
  const due = store.listAutomationSchedules({ status: "enabled", dueAt: now.toISOString() }).slice(0, options.limit ?? 25);
  const enqueued: DueAutomationResult["enqueued"] = [];
  const skipped: DueAutomationResult["skipped"] = [];
  for (const schedule of due) {
    if (automationReviewPolicy(schedule) === "review") {
      const alreadyRequested = schedule.metadata.review_requested_for === schedule.next_run_at;
      if (!alreadyRequested) {
        store.updateAutomationSchedule(schedule.schedule_id, {
          metadata: {
            ...schedule.metadata,
            review_requested_for: schedule.next_run_at,
            review_requested_at: now.toISOString(),
          },
        });
        store.appendEvent({
          session_id: schedule.session_id,
          type: "automation.schedule.review_requested",
          data: {
            schedule_id: schedule.schedule_id,
            due_at: schedule.next_run_at,
            prompt: schedule.prompt,
          },
        });
      }
      skipped.push({ schedule: store.getAutomationSchedule(schedule.schedule_id) ?? schedule, reason: "review_required" });
      continue;
    }
    if (schedule.last_job_id) {
      const lastJob = store.getSupervisorJob(schedule.last_job_id);
      if (lastJob && isActiveJob(lastJob)) {
        const nextRunAt = nextScheduleRunAt(schedule, now);
        store.updateAutomationSchedule(schedule.schedule_id, { next_run_at: nextRunAt });
        store.appendEvent({
          session_id: schedule.session_id,
          type: "automation.schedule.skipped",
          data: {
            schedule_id: schedule.schedule_id,
            reason: "previous_job_active",
            job_id: lastJob.job_id,
            next_run_at: nextRunAt,
          },
        });
        skipped.push({ schedule, reason: "previous_job_active" });
        continue;
      }
    }
    let workspaceRoot = schedule.workspace_root;
    let metadata: JsonObject = {
      ...schedule.metadata,
      automation_schedule_id: schedule.schedule_id,
    };
    let assignedWorktree: Awaited<ReturnType<typeof createLoopWorktree>> | undefined;
    if (automationIsolation(schedule) === "worktree") {
      try {
        const workspace = automationWorkspace(schedule);
        assignedWorktree = await createLoopWorktree(store, workspace, {
          metadata: {
            purpose: schedule.kind === "goal" ? "automation_goal" : "automation_run",
            automation_schedule_id: schedule.schedule_id,
            goal_id: schedule.goal_id,
          },
        });
        const target = loopWorktreeRunTarget(assignedWorktree, workspace);
        workspaceRoot = target.workspace_root;
        metadata = {
          ...metadata,
          isolation: "worktree",
          worktree_id: assignedWorktree.worktree_id,
          worktree_path: assignedWorktree.path,
          worktree_branch: assignedWorktree.branch,
          base_ref: assignedWorktree.base_ref,
        };
      } catch (error) {
        const nextRunAt = nextScheduleRunAt(schedule, now);
        store.updateAutomationSchedule(schedule.schedule_id, { next_run_at: nextRunAt });
        const reason = `worktree_isolation_failed: ${error instanceof Error ? error.message : String(error)}`;
        store.appendEvent({
          session_id: schedule.session_id,
          type: "automation.schedule.skipped",
          data: {
            schedule_id: schedule.schedule_id,
            reason,
            next_run_at: nextRunAt,
          },
        });
        skipped.push({ schedule, reason });
        continue;
      }
    }
    const job = store.createSupervisorJob(schedule.session_id, workspaceRoot, schedule.prompt, {
      kind: schedule.kind,
      goal_id: schedule.goal_id,
      metadata,
    });
    if (assignedWorktree) {
      store.updateManagedWorktree(assignedWorktree.worktree_id, {
        session_id: schedule.session_id,
        job_id: job.job_id,
        metadata: {
          ...assignedWorktree.metadata,
          session_id: schedule.session_id,
          job_id: job.job_id,
        },
      });
      store.appendEvent({
        session_id: schedule.session_id,
        type: "loop.worktree.assigned",
        data: {
          worktree_id: assignedWorktree.worktree_id,
          worktree_path: assignedWorktree.path,
          worktree_branch: assignedWorktree.branch,
          base_ref: assignedWorktree.base_ref,
          job_id: job.job_id,
          job_kind: job.kind,
          automation_schedule_id: schedule.schedule_id,
        },
      });
    }
    const nextRunAt = nextScheduleRunAt(schedule, now);
    store.updateAutomationSchedule(schedule.schedule_id, {
      last_job_id: job.job_id,
      last_run_at: now.toISOString(),
      next_run_at: nextRunAt,
    });
    store.appendEvent({
      session_id: schedule.session_id,
      type: "automation.schedule.enqueued",
      data: {
        schedule_id: schedule.schedule_id,
        job_id: job.job_id,
        next_run_at: nextRunAt,
      },
    });
    enqueued.push({ schedule: store.getAutomationSchedule(schedule.schedule_id) ?? schedule, job });
  }
  return { enqueued, skipped };
}

export function pauseLoopAutomationSchedule(store: SessionStore, scheduleId: string): AutomationSchedule {
  store.updateAutomationSchedule(scheduleId, { status: "paused" });
  const schedule = requireAutomationSchedule(store, scheduleId);
  store.appendEvent({
    session_id: schedule.session_id,
    type: "automation.schedule.paused",
    data: { schedule_id: schedule.schedule_id },
  });
  return schedule;
}

export function resumeLoopAutomationSchedule(store: SessionStore, scheduleId: string, now = new Date()): AutomationSchedule {
  const schedule = requireAutomationSchedule(store, scheduleId);
  store.updateAutomationSchedule(scheduleId, {
    status: "enabled",
    next_run_at: nextScheduleRunAt(schedule, now),
  });
  const resumed = requireAutomationSchedule(store, scheduleId);
  store.appendEvent({
    session_id: resumed.session_id,
    type: "automation.schedule.resumed",
    data: { schedule_id: resumed.schedule_id, next_run_at: resumed.next_run_at },
  });
  return resumed;
}

export function removeLoopAutomationSchedule(store: SessionStore, scheduleId: string): AutomationSchedule {
  const removed = store.deleteAutomationSchedule(scheduleId);
  if (!removed) {
    throw new Error(`Unknown automation schedule: ${scheduleId}`);
  }
  return removed;
}

function requireAutomationSchedule(store: SessionStore, scheduleId: string): AutomationSchedule {
  const schedule = store.getAutomationSchedule(scheduleId);
  if (!schedule) {
    throw new Error(`Unknown automation schedule: ${scheduleId}`);
  }
  return schedule;
}

function nextScheduleRunAt(schedule: AutomationSchedule, now: Date): string {
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

function isActiveJob(job: SupervisorJob): boolean {
  return job.status === "queued" || job.status === "running" || job.status === "detached" || job.status === "cancel_requested";
}

function automationIsolation(schedule: AutomationSchedule): AutomationIsolation {
  return schedule.metadata.isolation === "worktree" ? "worktree" : "active_checkout";
}

function automationReviewPolicy(schedule: AutomationSchedule): AutomationReviewPolicy {
  return schedule.metadata.review_policy === "review" ? "review" : "auto";
}

function automationWorkspace(schedule: AutomationSchedule): WorkspaceIdentity {
  return {
    id: schedule.workspace_id,
    root: schedule.workspace_root,
    alias: path.basename(schedule.workspace_root) || "workspace",
  };
}
