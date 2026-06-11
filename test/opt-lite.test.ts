import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { completeGoalReflection, createGoalState, writeGoalState, type GoalReflectionDecision } from "../src/goals/state.js";
import { readGoalLoopView } from "../src/loop/projection.js";
import { optLiteAdopt, optLitePropose, optLiteReplay, optLiteReport, optLiteRun, optLiteStatus } from "../src/opt/opt-lite.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";
import type { WorkspaceIdentity } from "../src/types.js";

const execFileAsync = promisify(execFile);

test("self-improve proposes and adopts a workspace learned skill from verified loop evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-self-improve-"));
  const previousStateDir = process.env.INFEROA_STATE_DIR;
  process.env.INFEROA_STATE_DIR = path.join(dir, "user-state");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_self_improve_lite", root: dir, alias: "self-improve" };
    const session = store.createSession(workspace, "verified goal");
    let goal = createGoalState({ objective: "Ship verified loop policy" });
    writeGoalState(store, session.session_id, goal, "run_goal");
    goal = completeGoalReflection(
      goal,
      {
        decision: "done",
        summary: "Verified with tests.",
        verification_evidence: { command: "npm test", status: "pass" },
      },
      "run_reflect",
    );
    writeGoalState(store, session.session_id, goal, "run_reflect");
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_reflect",
      type: "goal.reflection.completed",
      data: {
        goal_id: goal.goal.id,
        source_horizon_generation: 0,
        horizon_generation: 0,
        decision: "done",
        summary: goal.goal.last_reflection_summary,
        verification_evidence: goal.goal.verification_evidence,
      },
    });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_review",
      type: "goal.review.resolved",
      data: {
        goal_id: goal.goal.id,
        decision: "revise",
        action: "done",
        feedback: "Keep regression coverage before claiming done.",
      },
    });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_skill",
      type: "skill.body.loaded",
      data: {
        goal_id: goal.goal.id,
        skill_id: "inferoa-loop-skill",
        name: "Inferoa Loop Skill",
        body_hash: "a".repeat(64),
        total_lines: 12,
        returned_lines: 12,
      },
    });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_reflect",
      type: "skill.rule.applied",
      data: {
        goal_id: goal.goal.id,
        horizon_generation: goal.goal.horizon_generation,
        skill_id: "inferoa-loop-skill",
        target: "loop_skill",
        body_hash: "a".repeat(64),
        body_load_run_id: "run_skill",
        rule_id: "loop-reflection-verification-used",
        rule_summary: "Loop Skill guided reflection verification.",
        decision: "done",
      },
    });

    const before = await optLiteStatus(store, workspace);
    assert.equal(before.eligible_goal_sessions, 1);
    assert.equal(before.proposal_count, 0);
    assert.equal(before.human_feedback_records, 1);
    assert.equal(before.learning_signal_records, 0);

    const proposal = await optLitePropose(store, workspace);
    assert.match(proposal.id, /^self_improve_/);
    assert.equal(proposal.status, "staged");
    assert.match(proposal.staged_skill_path, /\.inferoa\/self-improve\/proposals\/self_improve_[^/]+\/proposed\.loop\.SKILL\.md$/);
    assert.equal(proposal.evidence.goal_sessions, 1);
    assert.equal(proposal.evidence.learning_signal_records, 2);
    assert.equal((proposal.evidence as unknown as { skill_body_load_records?: number }).skill_body_load_records, 1);
    assert.equal((proposal.evidence as unknown as { skill_rule_application_records?: number }).skill_rule_application_records, 1);
    const skillTargets = (proposal as unknown as {
      skill_targets?: Array<{ target?: string; skill_id?: string; staged_skill_path?: string; body?: string }>;
    }).skill_targets ?? [];
    assert.equal(skillTargets.length, 2);
    const loopTarget = skillTargets.find((target) => target.target === "loop_skill");
    const workspaceTarget = skillTargets.find((target) => target.target === "workspace_skill");
    assert.equal(loopTarget?.skill_id, "inferoa-loop-skill");
    assert.equal(workspaceTarget?.skill_id, "inferoa-workspace-skill");
    assert.match(loopTarget?.body ?? "", /Inferoa Loop Skill/);
    assert.match(loopTarget?.body ?? "", /soft-only completion/i);
    assert.match(workspaceTarget?.body ?? "", /Inferoa Workspace Skill/);
    assert.match(workspaceTarget?.body ?? "", /npm test/);
    assert.match(loopTarget?.staged_skill_path ?? "", /proposed\.loop\.SKILL\.md$/);
    assert.match(workspaceTarget?.staged_skill_path ?? "", /proposed\.workspace\.SKILL\.md$/);
    assert.match(await readFile(loopTarget!.staged_skill_path!, "utf8"), /Inferoa Loop Skill/);
    assert.match(await readFile(workspaceTarget!.staged_skill_path!, "utf8"), /npm test/);
    assert.match(proposal.skill_body, /Inferoa Loop Skill/);
    assert.match(proposal.skill_body, /Ship verified loop policy/);
    assert.match(proposal.skill_body, /Learning signals: 2/);
    const stagedEvents = store.listEvents(session.session_id).filter((event) => event.type === "skill.proposal.staged");
    assert.equal(stagedEvents.length, 1);
    assert.equal(stagedEvents[0]?.data.proposal_id, proposal.id);
    assert.equal(stagedEvents[0]?.data.skill_id, "inferoa-loop-skill");
    assert.deepEqual(stagedEvents[0]?.data.skill_target_ids, ["inferoa-loop-skill", "inferoa-workspace-skill"]);
    assert.deepEqual(stagedEvents[0]?.data.source_session_ids, [session.session_id]);
    const signalEvents = store.listEvents(session.session_id).filter((event) => event.type === "goal.learning_signal.recorded");
    assert.equal(signalEvents.length, 2);
    assert.equal(new Set(signalEvents.map((event) => event.data.signal_id)).size, 2);
    const view = readGoalLoopView(store, session.session_id);
    assert.equal(view.learning_signals.length, 2);
    assert.equal(view.learning_signals.some((signal) => signal.category === "human_feedback" && signal.polarity === "constraint"), true);
    const repeated = await optLitePropose(store, workspace);
    assert.equal(repeated.id, proposal.id);
    assert.equal(store.listEvents(session.session_id).filter((event) => event.type === "goal.learning_signal.recorded").length, 2);
    assert.equal(store.listEvents(session.session_id).filter((event) => event.type === "skill.proposal.staged").length, 1);

    const config = structuredClone(DEFAULT_CONFIG);
    const adopted = await optLiteAdopt(store, workspace, config, proposal.id);
    assert.equal(adopted.status, "adopted");
    assert.equal(config.skills.enabled.includes("inferoa-loop-skill"), true);
    assert.equal(config.skills.enabled.includes("inferoa-workspace-skill"), true);
    assert.match(await readFile(path.join(dir, ".inferoa", "skills", "inferoa-loop-skill", "SKILL.md"), "utf8"), /soft-only completion/i);
    assert.match(await readFile(path.join(dir, ".inferoa", "skills", "inferoa-workspace-skill", "SKILL.md"), "utf8"), /npm test/);
    const savedConfig = await readFile(path.join(process.env.INFEROA_STATE_DIR!, "config.yaml"), "utf8");
    assert.match(savedConfig, /inferoa-loop-skill/);
    assert.match(savedConfig, /inferoa-workspace-skill/);
    const adoptedEvents = store.listEvents(session.session_id).filter((event) => event.type === "skill.proposal.adopted");
    assert.equal(adoptedEvents.length, 1);
    assert.equal(adoptedEvents[0]?.data.proposal_id, proposal.id);
    assert.equal(adoptedEvents[0]?.data.skill_path, adopted.skill_path);
    assert.deepEqual(adoptedEvents[0]?.data.skill_target_ids, ["inferoa-loop-skill", "inferoa-workspace-skill"]);

    const after = await optLiteStatus(store, workspace);
    assert.equal(after.proposal_count, 1);
    assert.equal(after.adopted_count, 1);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.INFEROA_STATE_DIR;
    } else {
      process.env.INFEROA_STATE_DIR = previousStateDir;
    }
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("self-improve replay accepts a candidate when validation improves and heldout does not regress", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-self-improve-replay-pass-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_self_improve_replay_pass", root: dir, alias: "self-improve-replay-pass" };
    addVerifiedGoal(store, workspace, "First verified goal", "done");
    addVerifiedGoal(store, workspace, "Second verified goal", "done");
    addVerifiedGoal(store, workspace, "Third verified goal", "done");

    const proposal = await optLitePropose(store, workspace);
    const run = await optLiteRun(store, workspace, { replay: true, proposal_id: proposal.id });
    const replay = run.replay;

    assert.equal(run.kind, "replay");
    assert.equal(replay.status, "accepted");
    assert.equal(replay.sample_count, 3);
    assert.equal(replay.gate.validation_improved, true);
    assert.equal(replay.gate.heldout_not_regressed, true);
    assert.equal(replay.gate.hard_failures, 0);
    assert.ok(replay.candidate_score > replay.baseline_score);
    const replayEvents = store
      .listEvents(proposal.source_sessions[0]!.session_id)
      .filter((event) => event.type === "self_improve.replay.recorded");
    assert.equal(replayEvents.length, 1);
    assert.equal(replayEvents[0]?.data.replay_id, replay.id);
    assert.equal(replayEvents[0]?.data.proposal_id, proposal.id);
    assert.deepEqual(replayEvents[0]?.data.split_counts, { train: 1, validation: 1, heldout: 1 });

    const status = await optLiteStatus(store, workspace);
    assert.equal(status.replay_count, 1);
    assert.equal(status.latest_replay?.status, "accepted");
    const report = await optLiteReport(workspace, replay.id);
    assert.equal(report.id, replay.id);
    assert.equal(report.status, "accepted");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("self-improve run rejects implicit training mode", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-self-improve-run-mode-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_self_improve_run_mode", root: dir, alias: "self-improve-run-mode" };
    await assert.rejects(
      () => optLiteRun(store, workspace, {}),
      /requires an explicit training mode/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("self-improve run and report commands expose replay/gating flow as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-self-improve-run-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    addVerifiedGoal(store, workspace, "First verified cli goal", "done");
    addVerifiedGoal(store, workspace, "Second verified cli goal", "done");
    addVerifiedGoal(store, workspace, "Third verified cli goal", "done");
  } finally {
    store.close();
  }

  try {
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const proposeOutput = await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "self-improve",
      "propose",
    ], { maxBuffer: 1024 * 1024 });
    const parsedProposal = JSON.parse(proposeOutput.stdout) as {
      id?: string;
      status?: string;
      staged_skill_path?: string;
      skill_targets?: Array<{ target?: string; skill_id?: string; staged_skill_path?: string }>;
    };
    assert.equal(parsedProposal.status, "staged");
    assert.match(parsedProposal.id ?? "", /^self_improve_/);
    assert.match(parsedProposal.staged_skill_path ?? "", /\.inferoa\/self-improve\/proposals\/self_improve_[^/]+\/proposed\.loop\.SKILL\.md$/);
    assert.deepEqual(parsedProposal.skill_targets?.map((target) => target.skill_id).sort(), ["inferoa-loop-skill", "inferoa-workspace-skill"]);
    const runOutput = await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "self-improve",
      "run",
      "--replay",
    ], { maxBuffer: 1024 * 1024 });
    const parsedRun = JSON.parse(runOutput.stdout) as {
      kind?: string;
      replay?: { id?: string; status?: string; sample_count?: number; gate?: { validation_improved?: boolean; heldout_not_regressed?: boolean } };
    };
    assert.equal(parsedRun.kind, "replay");
    assert.equal(parsedRun.replay?.status, "accepted");
    assert.equal(parsedRun.replay?.sample_count, 3);
    assert.equal(parsedRun.replay?.gate?.validation_improved, true);
    assert.equal(parsedRun.replay?.gate?.heldout_not_regressed, true);

    const reportOutput = await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "self-improve",
      "report",
    ], { maxBuffer: 1024 * 1024 });
    const parsedReport = JSON.parse(reportOutput.stdout) as {
      id?: string;
      status?: string;
      proposal_id?: string;
      sample_count?: number;
      splits?: { train?: unknown[]; validation?: unknown[]; heldout?: unknown[] };
    };
    assert.equal(parsedReport.id, parsedRun.replay?.id);
    assert.equal(parsedReport.status, "accepted");
    assert.equal(parsedReport.sample_count, 3);
    assert.equal(parsedReport.splits?.train?.length, 1);
    assert.equal(parsedReport.splits?.validation?.length, 1);
    assert.equal(parsedReport.splits?.heldout?.length, 1);

    const adoptOutput = await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "self-improve",
      "adopt",
      parsedProposal.id ?? "",
    ], { maxBuffer: 1024 * 1024 });
    const parsedAdopt = JSON.parse(adoptOutput.stdout) as { id?: string; status?: string; skill_path?: string };
    assert.equal(parsedAdopt.id, parsedProposal.id);
    assert.equal(parsedAdopt.status, "adopted");
    assert.match(parsedAdopt.skill_path ?? "", /\.inferoa\/skills\/inferoa-loop-skill\/SKILL\.md$/);
    assert.match(await readFile(path.join(workspaceRoot, ".inferoa", "skills", "inferoa-loop-skill", "SKILL.md"), "utf8"), /Inferoa Loop Skill/);
    assert.match(await readFile(path.join(workspaceRoot, ".inferoa", "skills", "inferoa-workspace-skill", "SKILL.md"), "utf8"), /Inferoa Workspace Skill/);
    const savedConfig = await readFile(path.join(stateDir, "config.yaml"), "utf8");
    assert.match(savedConfig, /inferoa-loop-skill/);
    assert.match(savedConfig, /inferoa-workspace-skill/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("self-improve replay rejects a candidate when validation or heldout has hard failures", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-self-improve-replay-fail-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_self_improve_replay_fail", root: dir, alias: "self-improve-replay-fail" };
    addVerifiedGoal(store, workspace, "First verified goal", "done");
    addVerifiedGoal(store, workspace, "Second blocked goal", "blocked");
    addVerifiedGoal(store, workspace, "Third blocked goal", "blocked");

    const proposal = await optLitePropose(store, workspace);
    const replay = await optLiteReplay(store, workspace, proposal.id);

    assert.equal(replay.status, "rejected");
    assert.ok(replay.gate.hard_failures > 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function addVerifiedGoal(store: SessionStore, workspace: WorkspaceIdentity, objective: string, decision: GoalReflectionDecision): void {
  const session = store.createSession(workspace, objective);
  let goal = createGoalState({ objective });
  writeGoalState(store, session.session_id, goal, `run_goal_${session.session_id}`);
  goal = completeGoalReflection(
    goal,
    decision === "done"
      ? {
          decision,
          summary: "Verified with tests.",
          verification_evidence: { command: "npm test", status: "pass" },
        }
      : {
          decision,
          summary: "Blocked during verification.",
          blocker: "test failure",
        },
    `run_reflect_${session.session_id}`,
  );
  writeGoalState(store, session.session_id, goal, `run_reflect_${session.session_id}`);
  store.appendEvent({
    session_id: session.session_id,
    run_id: `run_reflect_${session.session_id}`,
    type: "goal.reflection.completed",
    data: {
      goal_id: goal.goal.id,
      source_horizon_generation: 0,
      horizon_generation: 0,
      decision,
      summary: goal.goal.last_reflection_summary,
      verification_evidence: goal.goal.verification_evidence,
      blocker: goal.goal.blocker,
    },
  });
}
