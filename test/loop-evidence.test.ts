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
import { createGoalState, writeGoalState } from "../src/goals/state.js";
import { readLoopEvidence } from "../src/loop/evidence.js";
import { recordGoalVerification } from "../src/loop/verification.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("loop evidence summarizes goal memory, verification, and skill state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-evidence-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "loop evidence goal");
    const goalState = createGoalState({ objective: "Close evidence loop", hil_policy: "review" }, new Date("2026-06-11T00:00:00.000Z"));
    goalState.goal.planning!.steps[0]!.status = "completed";
    goalState.goal.planning!.steps[1]!.status = "blocked";
    goalState.goal.pending_review_decision = {
      id: "review_evidence",
      action: "expand",
      source_horizon_generation: 0,
      summary: "needs a new horizon",
      requested_decision: ["approve", "revise"],
      created_at: "2026-06-11T00:05:00.000Z",
    };
    writeGoalState(store, session.session_id, goalState);
    store.appendEvent({ session_id: session.session_id, run_id: "run_a", type: "user.prompt", data: { prompt: "close evidence loop", request_class: "background", visibility: "visible" } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_a", type: "run.failed", data: { error: "tests failed" } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_b", type: "user.prompt", data: { prompt: "verify evidence loop", request_class: "verification", visibility: "hidden" } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_b", type: "run.completed", data: {} });
    recordGoalVerification(store, session.session_id, {
      provider: "command",
      verdict: "pass",
      confidence: "hard",
      goal_id: goalState.goal.id,
      horizon_generation: 0,
      run_id: "run_b",
      summary: "npm test passed",
      evidence: { command: "npm test", exit_code: 0 },
      metrics: { duration_ms: 1200 },
    }, "run_b");
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_b",
      type: "skill.snapshot.created",
      data: {
        goal_id: goalState.goal.id,
        skill_count: 1,
        enabled_config: ["demo-loop"],
        snapshot_hash: "abc123",
        skills: [{
          id: "demo-loop",
          name: "Demo Loop",
          path: ".inferoa/skills/demo-loop/SKILL.md",
          body_hash: "hash",
        }],
      },
    });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_b",
      type: "goal.learning_signal.recorded",
      data: {
        signal_id: "sig_loop_evidence",
        category: "verification",
        polarity: "positive",
        goal_id: goalState.goal.id,
        horizon_generation: 0,
        source_run_id: "run_b",
        source_event_type: "goal.verification.recorded",
        summary: "Verification command passed for this horizon",
        evidence: { verifier: "command" },
      },
    });

    const report = readLoopEvidence(store, session);
    assert.equal(report.has_goal, true);
    assert.equal(report.goal?.hil_policy, "review");
    assert.equal(report.current_horizon?.steps_by_status.completed, 1);
    assert.equal(report.current_horizon?.steps_by_status.blocked, 1);
    assert.equal(report.summary.attempts, 2);
    assert.equal(report.summary.failed_attempts, 1);
    assert.equal(report.summary.hard_pass_verifications, 1);
    assert.equal(report.summary.pending_review, true);
    assert.equal(report.verification.latest?.summary, "npm test passed");
    assert.equal(report.verification.latest?.evidence?.exit_code, 0);
    assert.equal(report.skills.latest?.skill_ids[0], "demo-loop");
    assert.equal(report.learning_signals.by_polarity.positive, 1);
    assert.equal(report.learning_signals.latest[0]?.signal_id, "sig_loop_evidence");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop evidence command returns session evidence as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-evidence-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "cli evidence");
    const goalState = createGoalState({ objective: "Expose evidence report" }, new Date("2026-06-11T00:00:00.000Z"));
    writeGoalState(store, session.session_id, goalState);
    recordGoalVerification(store, session.session_id, {
      provider: "checker",
      verdict: "fail",
      confidence: "soft",
      goal_id: goalState.goal.id,
      horizon_generation: 0,
      run_id: "run_verify",
      summary: "checker found missing evidence",
    }, "run_verify");
    store.close();
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const output = await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "loop",
      "evidence",
      session.session_id.slice(0, 12),
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as { has_goal?: boolean; summary?: { verifications?: number }; verification?: { latest?: { verdict?: string } } };
    assert.equal(parsed.has_goal, true);
    assert.equal(parsed.summary?.verifications, 1);
    assert.equal(parsed.verification?.latest?.verdict, "fail");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
