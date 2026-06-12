import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createGoalState, stageGoalReviewDecision, writeGoalState } from "../src/goals/state.js";
import { promoteLoopInboxItem, readLoopInbox, updateLoopInboxItemState } from "../src/loop/inbox.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("loop inbox projects pending review, external approvals, daemon, and staged proposal items", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(path.join(workspaceRoot, ".inferoa", "self-improve", "proposals"), { recursive: true });
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "loop inbox goal");
    let goal = createGoalState({ objective: "Ship inbox projection", hil_policy: "review" });
    goal = stageGoalReviewDecision(goal, {
      decision: "done",
      summary: "Implementation appears ready.",
      verification_evidence: { check: "module" },
    }, "run_review");
    writeGoalState(store, session.session_id, goal, "run_review");
    const job = store.createSupervisorJob(session.session_id, workspace.root, "continue background goal", {
      kind: "goal",
      goal_id: goal.goal.id,
    });
    store.updateSupervisorJob(job.job_id, { status: "paused", metadata: { pause_reason: "goal_review_pending" } });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_external",
      type: "permission.denied",
      data: {
        tool_call_id: "call_external",
        request_class: "background",
        tool_name: "run_command",
        arguments: { command: "gh pr merge 17 --repo owner/repo" },
        decision: {
          policy_kind: "external_mutation",
          external_system: "github",
          external_surface: "cli",
          external_action: "mutation",
          external_area: "pr",
          external_operation: "merge",
        },
      },
    });
    await writeFile(path.join(workspaceRoot, ".inferoa", "self-improve", "proposals", "self_improve_test.json"), JSON.stringify({
      id: "self_improve_test",
      status: "staged",
      created_at: "2026-06-11T00:00:00.000Z",
      skill_id: "workspace-learned-loop-policy",
      staged_skill_path: path.join(workspaceRoot, ".inferoa", "self-improve", "proposals", "self_improve_test.SKILL.md"),
      evidence: {
        goal_sessions: 1,
        verification_records: 1,
        human_feedback_records: 0,
        skill_snapshots: 1,
      },
    }, null, 2), "utf8");

    const inbox = await readLoopInbox(store, workspace);
    const kinds = inbox.items.map((item) => item.kind);
    assert.ok(kinds.includes("goal_review"));
    assert.ok(kinds.includes("external_action_approval"));
    assert.ok(kinds.includes("daemon_job"));
    assert.ok(kinds.includes("skill_proposal"));
    assert.equal(inbox.summary.open, 4);
    assert.equal(inbox.summary.high, 2);
    const external = inbox.items.find((item) => item.kind === "external_action_approval");
    assert.equal(external?.source, "policy");
    assert.equal(external?.source_label, "github");
    assert.match(external?.detail ?? "", /operation github\.pr\.merge/);
    assert.match(external?.detail ?? "", /command: gh pr merge 17/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop inbox lifecycle state hides, shows, and reopens projected items", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-state-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "loop inbox lifecycle");
    let goal = createGoalState({ objective: "Review lifecycle", hil_policy: "review" });
    goal = stageGoalReviewDecision(goal, {
      decision: "done",
      summary: "Ready for review.",
      verification_evidence: { check: "lifecycle" },
    }, "run_lifecycle");
    writeGoalState(store, session.session_id, goal, "run_lifecycle");
    const itemId = (await readLoopInbox(store, workspace)).items[0]?.id;
    assert.ok(itemId);

    const dismissed = await updateLoopInboxItemState(store, workspace, {
      action: "dismiss",
      item_id: itemId,
      note: "handled outside Inferoa",
    });
    assert.equal(dismissed.state?.disposition, "dismissed");
    assert.equal((await readLoopInbox(store, workspace)).summary.open, 0);
    const all = await readLoopInbox(store, workspace, { includeDone: true });
    assert.equal(all.items[0]?.status, "done");
    assert.equal(all.items[0]?.disposition, "dismissed");
    assert.equal(all.items[0]?.disposition_note, "handled outside Inferoa");

    await updateLoopInboxItemState(store, workspace, { action: "reopen", item_id: itemId });
    assert.equal((await readLoopInbox(store, workspace)).summary.open, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("inbox command exposes only show, resolve, dismiss, reopen, and promote", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "cli inbox goal");
    let goal = createGoalState({ objective: "Expose inbox command", hil_policy: "review" });
    goal = stageGoalReviewDecision(goal, {
      decision: "blocked",
      summary: "Needs a human scope decision.",
      blocker: "Scope decision required.",
    }, "run_cli_review");
    writeGoalState(store, session.session_id, goal, "run_cli_review");
  } finally {
    store.close();
  }

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
      "inbox",
    ];
    const listed = JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout) as { summary: { open: number; high: number }; items: { id: string; kind: string; action?: string }[] };
    assert.equal(listed.summary.open, 1);
    assert.equal(listed.summary.high, 1);
    assert.equal(listed.items[0]?.kind, "goal_review");
    assert.equal(listed.items[0]?.action, "/loop review");
    const itemId = listed.items[0]!.id;

    const dismissed = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "dismiss", itemId, "not actionable"], { maxBuffer: 1024 * 1024 })).stdout) as {
      state?: { disposition?: string; note?: string };
    };
    assert.equal(dismissed.state?.disposition, "dismissed");
    assert.equal(dismissed.state?.note, "not actionable");
    assert.equal(JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout).summary.open, 0);
    await execFileAsync(process.execPath, [...baseArgs, "reopen", itemId], { maxBuffer: 1024 * 1024 });
    assert.equal(JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout).summary.open, 1);

    for (const removed of [["assign", itemId, "alice"], ["unassign", itemId], ["snooze", itemId, "2h"], ["mute", itemId], ["unmute", itemId], ["routes"], ["route", "add", "alice", "--source", "github-issues"]]) {
      await assert.rejects(
        execFileAsync(process.execPath, [...baseArgs, ...removed], { maxBuffer: 1024 * 1024 }),
        /Usage: inferoa inbox/,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop inbox promotion queues runnable goal items and rejects review-gated items", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-promote-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const pausedSession = store.createSession(workspace, "paused goal");
    const pausedGoal = createGoalState({ objective: "Continue paused goal" });
    pausedGoal.enabled = false;
    pausedGoal.goal.status = "paused";
    pausedGoal.goal.last_reflection_summary = "waiting for promotion";
    writeGoalState(store, pausedSession.session_id, pausedGoal, "run_paused");
    const item = (await readLoopInbox(store, workspace)).items.find((candidate) => candidate.kind === "goal_paused");
    assert.ok(item);
    const promoted = await promoteLoopInboxItem(store, workspace, item.id, {
      config_path: path.join(workspaceRoot, ".inferoa", "config.yaml"),
      isolation: "active_checkout",
    });
    assert.equal(promoted.item.id, item.id);
    assert.equal(promoted.job.kind, "goal");
    assert.equal(promoted.job.session_id, pausedSession.session_id);

    const reviewSession = store.createSession(workspace, "review goal");
    let reviewGoal = createGoalState({ objective: "Needs review", hil_policy: "review" });
    reviewGoal = stageGoalReviewDecision(reviewGoal, {
      decision: "done",
      summary: "Needs human.",
      verification_evidence: { check: "review" },
    }, "run_review");
    writeGoalState(store, reviewSession.session_id, reviewGoal, "run_review");
    const reviewItem = (await readLoopInbox(store, workspace)).items.find((candidate) => candidate.kind === "goal_review");
    assert.ok(reviewItem);
    await assert.rejects(
      promoteLoopInboxItem(store, workspace, reviewItem.id),
      /needs human review/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
