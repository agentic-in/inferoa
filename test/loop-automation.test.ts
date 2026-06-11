import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  createLoopAutomationSchedule,
  enqueueDueAutomationSchedules,
  parseAutomationInterval,
  pauseLoopAutomationSchedule,
  removeLoopAutomationSchedule,
  resumeLoopAutomationSchedule,
} from "../src/loop/automation.js";
import { promoteLoopInboxItem, readLoopInbox } from "../src/loop/inbox.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("loop automation schedules enqueue due daemon jobs and avoid active-job pileups", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-automation-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T00:00:00.000Z");
    const schedule = createLoopAutomationSchedule(store, workspace, {
      prompt: "Review loop inbox",
      interval_ms: parseAutomationInterval("15m"),
      next_run_at: new Date(now.getTime() - 60_000).toISOString(),
      config_path: path.join(workspaceRoot, ".inferoa", "config.yaml"),
    });

    const first = await enqueueDueAutomationSchedules(store, { now });
    assert.equal(first.enqueued.length, 1);
    assert.equal(first.skipped.length, 0);
    assert.equal(first.enqueued[0]?.job.metadata.automation_schedule_id, schedule.schedule_id);
    const updated = store.getAutomationSchedule(schedule.schedule_id);
    assert.ok(updated?.last_job_id);
    assert.ok(Date.parse(updated.next_run_at) > now.getTime());

    store.updateAutomationSchedule(schedule.schedule_id, {
      next_run_at: new Date(now.getTime() - 30_000).toISOString(),
    });
    const second = await enqueueDueAutomationSchedules(store, { now });
    assert.equal(second.enqueued.length, 0);
    assert.equal(second.skipped.length, 1);
    assert.equal(second.skipped[0]?.reason, "previous_job_active");

    const paused = pauseLoopAutomationSchedule(store, schedule.schedule_id);
    assert.equal(paused.status, "paused");
    const resumed = resumeLoopAutomationSchedule(store, schedule.schedule_id, now);
    assert.equal(resumed.status, "enabled");
    const removed = removeLoopAutomationSchedule(store, schedule.schedule_id);
    assert.equal(removed.schedule_id, schedule.schedule_id);
    assert.equal(store.getAutomationSchedule(schedule.schedule_id), undefined);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop automation can enqueue recurring jobs in managed worktrees", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-automation-worktree-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: workspaceRoot });
    await writeFile(path.join(workspaceRoot, "README.md"), "automation worktree\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: workspaceRoot });
    await execFileAsync("git", ["-c", "user.name=Inferoa Test", "-c", "user.email=inferoa@example.test", "commit", "-m", "Initial"], { cwd: workspaceRoot });
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T00:00:00.000Z");
    const schedule = createLoopAutomationSchedule(store, workspace, {
      prompt: "Review isolated automation",
      interval_ms: parseAutomationInterval("15m"),
      next_run_at: new Date(now.getTime() - 60_000).toISOString(),
      isolation: "worktree",
    });

    const result = await enqueueDueAutomationSchedules(store, { now });
    assert.equal(result.skipped.length, 0);
    assert.equal(result.enqueued.length, 1);
    const job = result.enqueued[0]?.job;
    assert.ok(job);
    assert.equal(job.metadata.automation_schedule_id, schedule.schedule_id);
    assert.equal(job.metadata.isolation, "worktree");
    assert.equal(typeof job.metadata.worktree_id, "string");
    assert.notEqual(job.workspace_root, workspace.root);
    assert.match(job.workspace_root, /\.inferoa-worktrees/);
    const worktree = store.getManagedWorktree(String(job.metadata.worktree_id));
    assert.ok(worktree);
    assert.equal(worktree.session_id, schedule.session_id);
    assert.equal(worktree.job_id, job.job_id);
    assert.equal(worktree.metadata.purpose, "automation_run");
    assert.equal(worktree.metadata.automation_schedule_id, schedule.schedule_id);
    assert.equal(store.getAutomationSchedule(schedule.schedule_id)?.last_job_id, job.job_id);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("review-gated automation schedules surface in inbox before enqueue", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-automation-review-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date();
    const schedule = createLoopAutomationSchedule(store, workspace, {
      prompt: "Review recurring automation before running",
      interval_ms: parseAutomationInterval("15m"),
      next_run_at: new Date(now.getTime() - 60_000).toISOString(),
      review_policy: "review",
    });

    const due = await enqueueDueAutomationSchedules(store, { now });
    assert.equal(due.enqueued.length, 0);
    assert.equal(due.skipped.length, 1);
    assert.equal(due.skipped[0]?.reason, "review_required");
    assert.equal(store.listSupervisorJobs().length, 0);
    assert.equal(store.getAutomationSchedule(schedule.schedule_id)?.metadata.review_requested_for, schedule.next_run_at);

    const inbox = await readLoopInbox(store, workspace, {
      stalePolicy: { now },
    });
    const item = inbox.items.find((candidate) => candidate.kind === "automation_review");
    assert.ok(item);
    assert.equal(item.schedule_id, schedule.schedule_id);
    assert.equal(item.prompt, schedule.prompt);

    const promoted = await promoteLoopInboxItem(store, workspace, item.id);
    assert.equal(promoted.job.prompt, schedule.prompt);
    assert.equal(promoted.job.metadata.automation_schedule_id, schedule.schedule_id);
    assert.equal(promoted.job.metadata.review_policy, "review");
    const updated = store.getAutomationSchedule(schedule.schedule_id);
    assert.equal(updated?.last_job_id, promoted.job.job_id);
    assert.ok(updated?.next_run_at && Date.parse(updated.next_run_at) > now.getTime());
    assert.equal(updated?.metadata.review_requested_for, undefined);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("automation command can add and list recurring schedules", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-automation-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  try {
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const baseArgs = [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "automation",
    ];
    const added = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add", "1h", "Review loop inbox"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      prompt: string;
    };
    assert.ok(added.schedule_id.startsWith("auto_"));
    assert.equal(added.interval_ms, 3_600_000);
    assert.equal(added.prompt, "Review loop inbox");

    const worktreeAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add", "2h", "--worktree", "Review isolated loop inbox"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      prompt: string;
      metadata: { isolation?: string };
    };
    assert.ok(worktreeAdded.schedule_id.startsWith("auto_"));
    assert.equal(worktreeAdded.interval_ms, 7_200_000);
    assert.equal(worktreeAdded.prompt, "Review isolated loop inbox");
    assert.equal(worktreeAdded.metadata.isolation, "worktree");

    const reviewAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add", "3h", "--review", "Review before running"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      prompt: string;
      metadata: { review_policy?: string };
    };
    assert.ok(reviewAdded.schedule_id.startsWith("auto_"));
    assert.equal(reviewAdded.interval_ms, 10_800_000);
    assert.equal(reviewAdded.prompt, "Review before running");
    assert.equal(reviewAdded.metadata.review_policy, "review");

    const listed = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "list"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedules: { schedule_id: string; prompt: string }[];
    };
    assert.equal(listed.schedules.length, 3);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === added.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === worktreeAdded.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === reviewAdded.schedule_id), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("automation command uses configured default background worktree isolation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-automation-cli-policy-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await execFileAsync("git", ["init"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.email", "inferoa-test@example.com"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.name", "Inferoa Test"], { cwd: workspaceRoot });
  await writeFile(path.join(workspaceRoot, "README.md"), "# automation policy\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: workspaceRoot });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: workspaceRoot });
  const config = structuredClone(DEFAULT_CONFIG);
  config.loop.default_background_isolation = "worktree";
  await writeFile(configPath, YAML.stringify(config), "utf8");
  try {
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const baseArgs = [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "automation",
    ];
    const added = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add", "1h", "Review default-isolated loop"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      metadata: { isolation?: string };
    };
    assert.equal(added.metadata.isolation, "worktree");
    const store = await SessionStore.open(stateDir);
    try {
      store.updateAutomationSchedule(added.schedule_id, {
        next_run_at: "2000-01-01T00:00:00.000Z",
      });
    } finally {
      store.close();
    }
    const due = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "run-due"], { maxBuffer: 1024 * 1024 })).stdout) as {
      enqueued: { job: { workspace_root: string; metadata: { isolation?: string; worktree_id?: string } } }[];
      skipped: unknown[];
    };
    assert.equal(due.skipped.length, 0);
    assert.equal(due.enqueued.length, 1);
    assert.equal(due.enqueued[0]?.job.metadata.isolation, "worktree");
    assert.equal(typeof due.enqueued[0]?.job.metadata.worktree_id, "string");
    assert.notEqual(due.enqueued[0]?.job.workspace_root, workspaceRoot);
    assert.match(due.enqueued[0]?.job.workspace_root ?? "", /\.inferoa-worktrees/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
