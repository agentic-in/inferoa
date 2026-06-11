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
import { parseConnectorActionPreflightInput, recordConnectorActionPreflight } from "../src/loop/action-preflight.js";
import { parseLoopInboxSnoozeUntil, promoteLoopInboxItem, readLoopInbox, updateLoopInboxAssignment, updateLoopInboxItemState, updateLoopInboxMute, updateLoopInboxRouting } from "../src/loop/inbox.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("loop inbox projects pending review, daemon, and staged proposal items", async () => {
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
    assert.ok(kinds.includes("daemon_job"));
    assert.ok(kinds.includes("skill_proposal"));
    assert.equal(inbox.summary.open, 3);
    assert.equal(inbox.summary.high, 1);
    assert.equal(inbox.items[0]?.kind, "goal_review");
    assert.equal(inbox.items.find((item) => item.kind === "goal_review")?.action, "/loop review");
    const proposalItem = inbox.items.find((item) => item.kind === "skill_proposal");
    assert.equal(proposalItem?.source, "self-improve");
    assert.equal(proposalItem?.action, "inferoa self-improve replay && inferoa self-improve adopt");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop action preflight records blocked first-class connector mutations for inbox review", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-preflight-"));
  const stateDir = path.join(dir, "state");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "action preflight");
    const result = recordConnectorActionPreflight(
      store,
      session,
      parseConnectorActionPreflightInput(["github", "pull_request", "merge", "--request-class", "background"]),
    );

    assert.equal(result.status, "deny");
    assert.equal(result.recorded, true);
    assert.equal(result.policy_id, "first-class-connector-mutation");

    const inbox = await readLoopInbox(store, workspace);
    const actionItems = inbox.items.filter((item) => item.kind === "action_review");
    assert.equal(actionItems.length, 1);
    assert.equal(inbox.summary.by_kind.action_review, 1);
    assert.equal(actionItems[0]?.source_label, "github");
    assert.match(actionItems[0]?.detail ?? "", /preflight/);
    assert.match(actionItems[0]?.detail ?? "", /request background/);
    assert.match(actionItems[0]?.detail ?? "", /operation github\.pull-request\.merge/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("inbox command returns current workspace loop items as json", async () => {
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
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "inbox",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout) as { summary: { open: number; high: number }; items: { kind: string; action?: string }[] };
    assert.equal(parsed.summary.open, 1);
    assert.equal(parsed.summary.high, 1);
    assert.equal(parsed.items[0]?.kind, "goal_review");
    assert.equal(parsed.items[0]?.action, "/loop review");
  } finally {
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

    const snoozedUntil = parseLoopInboxSnoozeUntil("2h");
    await updateLoopInboxItemState(store, workspace, {
      action: "snooze",
      item_id: itemId,
      snoozed_until: snoozedUntil,
    });
    assert.equal((await readLoopInbox(store, workspace)).summary.open, 0);
    const withSnoozed = await readLoopInbox(store, workspace, { includeSnoozed: true });
    assert.equal(withSnoozed.items[0]?.status, "snoozed");
    assert.equal(withSnoozed.items[0]?.snoozed_until, snoozedUntil);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop inbox assignment overlays projected items without hiding them", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-assignment-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "loop inbox assignment");
    let goal = createGoalState({ objective: "Review assignment", hil_policy: "review" });
    goal = stageGoalReviewDecision(goal, {
      decision: "done",
      summary: "Needs owner.",
      verification_evidence: { check: "assignment" },
    }, "run_assignment");
    writeGoalState(store, session.session_id, goal, "run_assignment");
    const itemId = (await readLoopInbox(store, workspace)).items[0]?.id;
    assert.ok(itemId);

    const assigned = await updateLoopInboxAssignment(store, workspace, {
      item_id: itemId,
      assignee: "alice",
      note: "primary reviewer",
    });
    assert.equal(assigned.action, "assign");
    assert.equal(assigned.state?.assignee, "alice");
    assert.equal(assigned.item.assignee, "alice");

    const inbox = await readLoopInbox(store, workspace);
    assert.equal(inbox.summary.open, 1);
    assert.equal(inbox.summary.assigned, 1);
    assert.equal(inbox.summary.by_assignee.alice, 1);
    assert.equal(inbox.items[0]?.assignee, "alice");
    assert.equal(inbox.items[0]?.assignment_note, "primary reviewer");
    assert.equal((await readLoopInbox(store, workspace, { assignee: "alice" })).summary.open, 1);
    assert.equal((await readLoopInbox(store, workspace, { assignee: "bob" })).summary.open, 0);
    assert.equal((await readLoopInbox(store, workspace, { onlyUnassigned: true })).summary.open, 0);

    await updateLoopInboxItemState(store, workspace, { action: "dismiss", item_id: itemId, note: "not now" });
    assert.equal((await readLoopInbox(store, workspace)).summary.open, 0);
    await updateLoopInboxItemState(store, workspace, { action: "reopen", item_id: itemId });
    const reopened = await readLoopInbox(store, workspace);
    assert.equal(reopened.summary.open, 1);
    assert.equal(reopened.items[0]?.assignee, "alice");

    const unassigned = await updateLoopInboxAssignment(store, workspace, { item_id: itemId });
    assert.equal(unassigned.action, "unassign");
    assert.equal((await readLoopInbox(store, workspace)).summary.assigned, 0);
    assert.equal((await readLoopInbox(store, workspace, { onlyUnassigned: true })).summary.open, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("goal owner assigns projected goal inbox items without text inference", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-goal-owner-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "loop inbox goal owner");
    let goal = createGoalState({ objective: "Review owned loop", owner: "alice", review_owner: "carol", hil_policy: "review" });
    goal = stageGoalReviewDecision(goal, {
      decision: "done",
      summary: "Needs owner review.",
      verification_evidence: { check: "owner" },
    }, "run_goal_owner");
    writeGoalState(store, session.session_id, goal, "run_goal_owner");

    const inbox = await readLoopInbox(store, workspace);
    assert.equal(inbox.summary.open, 1);
    assert.equal(inbox.summary.assigned, 1);
    assert.equal(inbox.summary.by_assignee.carol, 1);
    const item = inbox.items[0];
    assert.equal(item?.kind, "goal_review");
    assert.equal(item?.assignee, "carol");
    assert.equal(item?.assignment_note, "goal review owner");
    assert.equal((await readLoopInbox(store, workspace, { assignee: "carol" })).summary.open, 1);
    assert.equal((await readLoopInbox(store, workspace, { assignee: "alice" })).summary.open, 0);
    assert.equal((await readLoopInbox(store, workspace, { onlyUnassigned: true })).summary.open, 0);

    const itemId = item?.id;
    assert.ok(itemId);
    await updateLoopInboxAssignment(store, workspace, {
      item_id: itemId,
      assignee: "bob",
      note: "temporary reviewer",
    });
    const overridden = await readLoopInbox(store, workspace);
    assert.equal(overridden.items[0]?.assignee, "bob");
    assert.equal(overridden.items[0]?.assignment_note, "temporary reviewer");
    assert.equal((await readLoopInbox(store, workspace, { assignee: "carol" })).summary.open, 0);
    assert.equal((await readLoopInbox(store, workspace, { assignee: "bob" })).summary.open, 1);

    await updateLoopInboxAssignment(store, workspace, { item_id: itemId });
    const reverted = await readLoopInbox(store, workspace);
    assert.equal(reverted.items[0]?.assignee, "carol");
    assert.equal(reverted.items[0]?.assignment_note, "goal review owner");

    const pausedSession = store.createSession(workspace, "loop inbox paused owner");
    const paused = createGoalState({ objective: "Paused owned loop", owner: "alice", review_owner: "carol" });
    paused.enabled = false;
    paused.goal.status = "paused";
    writeGoalState(store, pausedSession.session_id, paused, "run_paused_owner");
    const withPaused = await readLoopInbox(store, workspace);
    const pausedItem = withPaused.items.find((entry) => entry.kind === "goal_paused");
    assert.equal(pausedItem?.assignee, "alice");
    assert.equal(pausedItem?.assignment_note, "goal owner");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop inbox routing assigns matching structured sources without text inference", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-routing-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "loop inbox routing");
    const schedule = store.createDiscoverySchedule(workspace, session.session_id, "json-discovery", {
      interval_ms: 60_000,
      next_run_at: "2026-06-11T00:00:00.000Z",
    });
    store.upsertDiscoveryCandidate({
      candidate_id: "github_issue_candidate",
      schedule_id: schedule.schedule_id,
      workspace_id: workspace.id,
      session_id: session.session_id,
      title: "Issue needs triage",
      prompt: "Inspect structured issue candidate.",
      priority: "medium",
      dedupe_key: "github-issue:repo:1",
      source: { kind: "github-issues", provider: "github", repo: "owner/repo" },
    });
    store.upsertDiscoveryCandidate({
      candidate_id: "git_candidate",
      schedule_id: schedule.schedule_id,
      workspace_id: workspace.id,
      session_id: session.session_id,
      title: "Local changes need triage",
      prompt: "Inspect structured git candidate.",
      priority: "medium",
      dedupe_key: "git-changes:abc",
      source: { kind: "git-changes" },
    });

    const routed = await updateLoopInboxRouting(workspace, {
      action: "add",
      route_id: "github-issues-owner",
      assignee: "triage",
      source: "github-issues",
      note: "github queue",
    });
    assert.equal(routed.route?.route_id, "github-issues-owner");
    assert.equal(routed.route?.source, "github-issues");

    const inbox = await readLoopInbox(store, workspace);
    const issue = inbox.items.find((item) => item.candidate_id === "github_issue_candidate");
    const git = inbox.items.find((item) => item.candidate_id === "git_candidate");
    assert.ok(issue);
    assert.ok(git);
    assert.equal(issue.source, "github-issues");
    assert.equal(issue.assignee, "triage");
    assert.equal(issue.routed_by, "github-issues-owner");
    assert.equal(issue.assignment_note, "github queue");
    assert.equal(git.assignee, undefined);
    assert.equal(inbox.summary.routed, 1);
    assert.equal((await readLoopInbox(store, workspace, { assignee: "triage" })).summary.open, 1);
    assert.equal((await readLoopInbox(store, workspace, { onlyUnassigned: true })).summary.open, 1);

    const manual = await updateLoopInboxAssignment(store, workspace, {
      item_id: issue.id,
      assignee: "alice",
      note: "manual override",
    });
    assert.equal(manual.item.assignee, "alice");
    const overridden = (await readLoopInbox(store, workspace)).items.find((item) => item.id === issue.id);
    assert.equal(overridden?.assignee, "alice");
    assert.equal(overridden?.routed_by, undefined);
    assert.equal(overridden?.assignment_note, "manual override");

    await updateLoopInboxRouting(workspace, { action: "remove", route_id: "github-issues-owner" });
    assert.equal((await readLoopInbox(store, workspace)).summary.routed, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop inbox mute hides recurring discovery candidates by stable dedupe key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-mute-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "loop inbox mute");
    const schedule = store.createDiscoverySchedule(workspace, session.session_id, "json-discovery", {
      interval_ms: 60_000,
      next_run_at: "2026-06-11T00:00:00.000Z",
    });
    store.upsertDiscoveryCandidate({
      candidate_id: "candidate_one",
      schedule_id: schedule.schedule_id,
      workspace_id: workspace.id,
      session_id: session.session_id,
      title: "Recurring flaky check",
      prompt: "Inspect the typed candidate.",
      priority: "medium",
      dedupe_key: "typed-source:flaky-check",
      source: { source: "typed-test" },
    });
    const first = await readLoopInbox(store, workspace);
    const item = first.items.find((candidate) => candidate.kind === "discovery_candidate");
    assert.ok(item);
    assert.equal(first.summary.open, 1);

    const muted = await updateLoopInboxMute(store, workspace, {
      action: "mute",
      item_id: item.id,
      note: "too noisy",
    });
    assert.equal(muted.action, "mute");
    assert.equal(muted.mute_key, "discovery:typed-source:flaky-check");
    assert.equal(muted.state?.note, "too noisy");
    assert.equal((await readLoopInbox(store, workspace)).summary.open, 0);
    const mutedView = await readLoopInbox(store, workspace, { includeMuted: true });
    assert.equal(mutedView.summary.open, 0);
    assert.equal(mutedView.summary.muted, 1);
    assert.equal(mutedView.items[0]?.status, "muted");
    assert.equal(mutedView.items[0]?.mute_key, "discovery:typed-source:flaky-check");

    store.upsertDiscoveryCandidate({
      candidate_id: "candidate_two",
      schedule_id: schedule.schedule_id,
      workspace_id: workspace.id,
      session_id: session.session_id,
      title: "Recurring flaky check again",
      prompt: "Inspect the typed candidate again.",
      priority: "high",
      dedupe_key: "typed-source:flaky-check",
      source: { source: "typed-test" },
    });
    assert.equal((await readLoopInbox(store, workspace)).summary.open, 0);
    const bothMuted = await readLoopInbox(store, workspace, { includeMuted: true });
    assert.equal(bothMuted.summary.muted, 2);

    const unmuted = await updateLoopInboxMute(store, workspace, {
      action: "unmute",
      item_id: "discovery:typed-source:flaky-check",
    });
    assert.equal(unmuted.action, "unmute");
    assert.equal((await readLoopInbox(store, workspace)).summary.open, 2);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop inbox projects discovery verifier hints from structured source metadata", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-verifier-hint-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "loop inbox verifier hint");
    const schedule = store.createDiscoverySchedule(workspace, session.session_id, "github-issues", {
      interval_ms: 60_000,
      next_run_at: "2026-06-11T00:00:00.000Z",
      metadata: { source: "github-issues" },
    });
    store.upsertDiscoveryCandidate({
      candidate_id: "candidate_verify_hint",
      schedule_id: schedule.schedule_id,
      workspace_id: workspace.id,
      session_id: session.session_id,
      title: "GitHub issue #7: tighten loop verification",
      prompt: "Inspect the structured candidate.",
      detail: "issue #7 in owner/repo",
      priority: "medium",
      dedupe_key: "github-issue:owner/repo:7",
      source: {
        kind: "github-issues",
        provider: "github",
        repo: "owner/repo",
        number: 7,
        suggested_verifier: {
          id: "github-issue-status",
          params: { issue: "7", repo: "owner/repo" },
        },
      },
    });

    const inbox = await readLoopInbox(store, workspace);
    const item = inbox.items.find((candidate) => candidate.kind === "discovery_candidate");
    assert.ok(item);
    assert.equal(item.verification_hint?.verifier_id, "github-issue-status");
    assert.deepEqual(item.verification_hint?.params, { issue: "7", repo: "owner/repo" });
    assert.equal(item.verification_hint?.command, `inferoa verify-github-issue-status ${session.session_id} 7 --repo owner/repo`);
    assert.match(item.detail ?? "", /verify: inferoa verify-github-issue-status/);

    const promoted = await promoteLoopInboxItem(store, workspace, item.id);
    assert.deepEqual(promoted.job.metadata.verification_hint, item.verification_hint);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("inbox command can dismiss and reopen a projected item", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-cli-state-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "cli inbox lifecycle");
    let goal = createGoalState({ objective: "Dismiss from CLI", hil_policy: "review" });
    goal = stageGoalReviewDecision(goal, {
      decision: "done",
      summary: "Needs CLI dismissal.",
      verification_evidence: { check: "cli" },
    }, "run_cli_lifecycle");
    writeGoalState(store, session.session_id, goal, "run_cli_lifecycle");
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
    const listed = JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout) as { items: { id: string }[] };
    const itemId = listed.items[0]?.id;
    assert.ok(itemId);
    const assigned = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "assign", itemId, "alice", "cli owner"], { maxBuffer: 1024 * 1024 })).stdout) as {
      state?: { assignee?: string; assignment_note?: string };
      item?: { assignee?: string };
    };
    assert.equal(assigned.state?.assignee, "alice");
    assert.equal(assigned.state?.assignment_note, "cli owner");
    assert.equal(assigned.item?.assignee, "alice");
    const assignedList = JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout) as { summary: { assigned: number }; items: { assignee?: string }[] };
    assert.equal(assignedList.summary.assigned, 1);
    assert.equal(assignedList.items[0]?.assignee, "alice");
    const assignedFiltered = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "--assignee", "alice"], { maxBuffer: 1024 * 1024 })).stdout) as { summary: { open: number }; items: { assignee?: string }[] };
    assert.equal(assignedFiltered.summary.open, 1);
    assert.equal(assignedFiltered.items[0]?.assignee, "alice");
    const unassignedFiltered = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "--unassigned"], { maxBuffer: 1024 * 1024 })).stdout) as { summary: { open: number } };
    assert.equal(unassignedFiltered.summary.open, 0);
    const dismissed = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "dismiss", itemId, "not actionable"], { maxBuffer: 1024 * 1024 })).stdout) as {
      state?: { disposition?: string; assignee?: string };
    };
    assert.equal(dismissed.state?.disposition, "dismissed");
    assert.equal(dismissed.state?.assignee, "alice");
    const hidden = JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout) as { summary: { open: number } };
    assert.equal(hidden.summary.open, 0);
    await execFileAsync(process.execPath, [...baseArgs, "reopen", itemId], { maxBuffer: 1024 * 1024 });
    const reopened = JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout) as { summary: { open: number; assigned: number }; items: { assignee?: string }[] };
    assert.equal(reopened.summary.open, 1);
    assert.equal(reopened.summary.assigned, 1);
    assert.equal(reopened.items[0]?.assignee, "alice");
    const unassigned = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "unassign", itemId], { maxBuffer: 1024 * 1024 })).stdout) as { action?: string; state?: { assignee?: string } };
    assert.equal(unassigned.action, "unassign");
    assert.equal(unassigned.state?.assignee, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inbox command can mute and unmute a recurring discovery item", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-cli-mute-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "cli inbox mute");
    const schedule = store.createDiscoverySchedule(workspace, session.session_id, "json-discovery", {
      interval_ms: 60_000,
      next_run_at: "2026-06-11T00:00:00.000Z",
    });
    store.upsertDiscoveryCandidate({
      candidate_id: "cli_candidate",
      schedule_id: schedule.schedule_id,
      workspace_id: workspace.id,
      session_id: session.session_id,
      title: "CLI noisy candidate",
      prompt: "Inspect the CLI candidate.",
      priority: "medium",
      dedupe_key: "typed-source:cli-noise",
      source: { source: "typed-test" },
    });
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
    const listed = JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout) as { items: { id: string }[] };
    const itemId = listed.items[0]?.id;
    assert.ok(itemId);
    const muted = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "mute", itemId, "too noisy"], { maxBuffer: 1024 * 1024 })).stdout) as {
      action?: string;
      mute_key?: string;
      state?: { note?: string };
      item?: { status?: string };
    };
    assert.equal(muted.action, "mute");
    assert.equal(muted.mute_key, "discovery:typed-source:cli-noise");
    assert.equal(muted.state?.note, "too noisy");
    assert.equal(muted.item?.status, "muted");
    const hidden = JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout) as { summary: { open: number; muted: number } };
    assert.equal(hidden.summary.open, 0);
    assert.equal(hidden.summary.muted, 0);
    const mutedList = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "--muted"], { maxBuffer: 1024 * 1024 })).stdout) as {
      summary: { open: number; muted: number };
      items: { status?: string; mute_key?: string }[];
    };
    assert.equal(mutedList.summary.open, 0);
    assert.equal(mutedList.summary.muted, 1);
    assert.equal(mutedList.items[0]?.status, "muted");
    assert.equal(mutedList.items[0]?.mute_key, "discovery:typed-source:cli-noise");
    const unmuted = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "unmute", "discovery:typed-source:cli-noise"], { maxBuffer: 1024 * 1024 })).stdout) as {
      action?: string;
      mute_key?: string;
    };
    assert.equal(unmuted.action, "unmute");
    assert.equal(unmuted.mute_key, "discovery:typed-source:cli-noise");
    const visible = JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout) as { summary: { open: number } };
    assert.equal(visible.summary.open, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inbox command can add and remove structured routing rules", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-cli-route-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "cli inbox route");
    const schedule = store.createDiscoverySchedule(workspace, session.session_id, "json-discovery", {
      interval_ms: 60_000,
      next_run_at: "2026-06-11T00:00:00.000Z",
    });
    store.upsertDiscoveryCandidate({
      candidate_id: "cli_route_candidate",
      schedule_id: schedule.schedule_id,
      workspace_id: workspace.id,
      session_id: session.session_id,
      title: "CLI routed GitHub issue",
      prompt: "Inspect the routed candidate.",
      priority: "medium",
      dedupe_key: "github-issue:owner/repo:7",
      source: { kind: "github-issues", provider: "github", repo: "owner/repo" },
    });
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
    const added = JSON.parse((await execFileAsync(process.execPath, [
      ...baseArgs,
      "route",
      "add",
      "triage",
      "--id",
      "github-issues-owner",
      "--source",
      "github-issues",
      "github queue",
    ], { maxBuffer: 1024 * 1024 })).stdout) as {
      route?: { route_id?: string; assignee?: string; source?: string; note?: string };
    };
    assert.equal(added.route?.route_id, "github-issues-owner");
    assert.equal(added.route?.assignee, "triage");
    assert.equal(added.route?.source, "github-issues");
    assert.equal(added.route?.note, "github queue");

    const listed = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "routes"], { maxBuffer: 1024 * 1024 })).stdout) as {
      route_id?: string;
    }[];
    assert.equal(listed[0]?.route_id, "github-issues-owner");

    const routed = JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout) as {
      summary: { routed: number; assigned: number };
      items: { assignee?: string; routed_by?: string; source?: string }[];
    };
    assert.equal(routed.summary.routed, 1);
    assert.equal(routed.summary.assigned, 1);
    assert.equal(routed.items[0]?.assignee, "triage");
    assert.equal(routed.items[0]?.routed_by, "github-issues-owner");
    assert.equal(routed.items[0]?.source, "github-issues");

    const removed = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "route", "remove", "github-issues-owner"], { maxBuffer: 1024 * 1024 })).stdout) as {
      action?: string;
      route?: { route_id?: string };
      routes: unknown[];
    };
    assert.equal(removed.action, "remove");
    assert.equal(removed.route?.route_id, "github-issues-owner");
    assert.equal(removed.routes.length, 0);
    const plain = JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout) as {
      summary: { routed: number; assigned: number };
      items: { assignee?: string; routed_by?: string }[];
    };
    assert.equal(plain.summary.routed, 0);
    assert.equal(plain.summary.assigned, 0);
    assert.equal(plain.items[0]?.assignee, undefined);
    assert.equal(plain.items[0]?.routed_by, undefined);
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

    const promoted = await promoteLoopInboxItem(store, workspace, item.id, { config_path: path.join(workspaceRoot, ".inferoa", "config.yaml") });
    assert.equal(promoted.job.kind, "goal");
    assert.equal(promoted.job.goal_id, pausedGoal.goal.id);
    assert.equal(promoted.job.metadata.inbox_item_id, item.id);
    assert.equal(promoted.job.metadata.config_path, path.join(workspaceRoot, ".inferoa", "config.yaml"));

    const reviewSession = store.createSession(workspace, "review goal");
    let reviewGoal = createGoalState({ objective: "Needs human review", hil_policy: "review" });
    reviewGoal = stageGoalReviewDecision(reviewGoal, {
      decision: "done",
      summary: "Ready.",
      verification_evidence: { check: "review" },
    }, "run_review_promote");
    writeGoalState(store, reviewSession.session_id, reviewGoal, "run_review_promote");
    const reviewItem = (await readLoopInbox(store, workspace)).items.find((candidate) => candidate.kind === "goal_review");
    assert.ok(reviewItem);
    await assert.rejects(
      () => promoteLoopInboxItem(store, workspace, reviewItem.id),
      /needs human review before promotion/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop inbox promotion can queue runnable items in managed worktrees", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-promote-worktree-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const store = await SessionStore.open(stateDir);
  try {
    await initGitRepo(workspaceRoot);
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "worktree promote goal");
    const goal = createGoalState({ objective: "Promote in a worktree" });
    goal.enabled = false;
    goal.goal.status = "paused";
    goal.goal.last_reflection_summary = "needs isolated continuation";
    writeGoalState(store, session.session_id, goal, "run_worktree_promote");
    const item = (await readLoopInbox(store, workspace)).items.find((candidate) => candidate.kind === "goal_paused");
    assert.ok(item);

    const promoted = await promoteLoopInboxItem(store, workspace, item.id, { isolation: "worktree" });
    assert.equal(promoted.job.kind, "goal");
    assert.equal(promoted.job.goal_id, goal.goal.id);
    assert.equal(promoted.job.metadata.isolation, "worktree");
    assert.equal(promoted.job.metadata.worktree_id, promoted.worktree?.worktree_id);
    assert.ok(promoted.worktree);
    assert.equal(promoted.worktree.session_id, session.session_id);
    assert.equal(promoted.worktree.job_id, promoted.job.job_id);
    assert.equal(promoted.job.workspace_root, promoted.worktree.path);
    assert.equal(store.getManagedWorktree(promoted.worktree.worktree_id)?.metadata.job_id, promoted.job.job_id);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop inbox surfaces stale active goals from explicit goal timestamps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-stale-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "stale active goal");
    const goal = createGoalState({ objective: "Continue stale active goal" });
    goal.goal.updated_at = "2000-01-01T00:00:00.000Z";
    writeGoalState(store, session.session_id, goal, "run_stale_goal");

    const inbox = await readLoopInbox(store, workspace, {
      stalePolicy: {
        now: new Date("2000-01-02T00:00:00.000Z"),
        goal_ms: 60_000,
      },
    });
    const stale = inbox.items.find((item) => item.kind === "stale_work");
    assert.ok(stale);
    assert.equal(stale.stale, true);
    assert.equal(stale.stale_reason, "active goal");
    assert.equal(stale.goal_id, goal.goal.id);

    const promoted = await promoteLoopInboxItem(store, workspace, stale.id);
    assert.equal(promoted.job.kind, "goal");
    assert.equal(promoted.job.goal_id, goal.goal.id);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("inbox command can promote a paused goal item in a managed worktree", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-cli-promote-worktree-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await initGitRepo(workspaceRoot);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "cli worktree promote goal");
    const goal = createGoalState({ objective: "Promote from CLI into worktree" });
    goal.enabled = false;
    goal.goal.status = "paused";
    goal.goal.last_reflection_summary = "manual pause";
    writeGoalState(store, session.session_id, goal, "run_cli_worktree_promote");
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
    const listed = JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout) as { items: { id: string; kind: string }[] };
    const itemId = listed.items.find((item) => item.kind === "goal_paused")?.id;
    assert.ok(itemId);
    const promoted = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "promote", "--worktree", itemId], { maxBuffer: 1024 * 1024 })).stdout) as {
      job: { kind: string; status: string; workspace_root: string; metadata: { isolation?: string; worktree_id?: string; inbox_item_id?: string } };
      worktree?: { worktree_id?: string; path?: string; job_id?: string };
    };
    assert.equal(promoted.job.kind, "goal");
    assert.equal(promoted.job.status, "queued");
    assert.equal(promoted.job.metadata.inbox_item_id, itemId);
    assert.equal(promoted.job.metadata.isolation, "worktree");
    assert.equal(promoted.job.metadata.worktree_id, promoted.worktree?.worktree_id);
    assert.equal(promoted.job.workspace_root, promoted.worktree?.path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inbox promote uses configured default background worktree isolation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-cli-default-worktree-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await initGitRepo(workspaceRoot);
  await mkdir(path.dirname(configPath), { recursive: true });
  const config = structuredClone(DEFAULT_CONFIG);
  config.loop.default_background_isolation = "worktree";
  await writeFile(configPath, YAML.stringify(config), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), config, workspaceRoot);
    const session = store.createSession(workspace, "cli default worktree promote goal");
    const goal = createGoalState({ objective: "Promote from CLI using default worktree" });
    goal.enabled = false;
    goal.goal.status = "paused";
    goal.goal.last_reflection_summary = "manual pause";
    writeGoalState(store, session.session_id, goal, "run_cli_default_worktree_promote");
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
    const listed = JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout) as { items: { id: string; kind: string }[] };
    const itemId = listed.items.find((item) => item.kind === "goal_paused")?.id;
    assert.ok(itemId);
    const promoted = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "promote", itemId], { maxBuffer: 1024 * 1024 })).stdout) as {
      job: { kind: string; status: string; workspace_root: string; metadata: { isolation?: string; worktree_id?: string; inbox_item_id?: string } };
      worktree?: { worktree_id?: string; path?: string; job_id?: string };
    };
    assert.equal(promoted.job.kind, "goal");
    assert.equal(promoted.job.status, "queued");
    assert.equal(promoted.job.metadata.inbox_item_id, itemId);
    assert.equal(promoted.job.metadata.isolation, "worktree");
    assert.equal(promoted.job.metadata.worktree_id, promoted.worktree?.worktree_id);
    assert.equal(promoted.job.workspace_root, promoted.worktree?.path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inbox command can promote a paused goal item", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-inbox-cli-promote-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "cli promote goal");
    const goal = createGoalState({ objective: "Promote from CLI" });
    goal.enabled = false;
    goal.goal.status = "paused";
    goal.goal.last_reflection_summary = "manual pause";
    writeGoalState(store, session.session_id, goal, "run_cli_promote");
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
    const listed = JSON.parse((await execFileAsync(process.execPath, baseArgs, { maxBuffer: 1024 * 1024 })).stdout) as { items: { id: string; kind: string }[] };
    const itemId = listed.items.find((item) => item.kind === "goal_paused")?.id;
    assert.ok(itemId);
    const promoted = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "promote", itemId], { maxBuffer: 1024 * 1024 })).stdout) as {
      job: { kind: string; status: string; metadata: { inbox_item_id?: string; config_path?: string } };
    };
    assert.equal(promoted.job.kind, "goal");
    assert.equal(promoted.job.status, "queued");
    assert.equal(promoted.job.metadata.inbox_item_id, itemId);
    assert.equal(promoted.job.metadata.config_path, configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function initGitRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "inferoa-test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Inferoa Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# test\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
}
