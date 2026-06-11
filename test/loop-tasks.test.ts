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
import { completeGoalReflection, createGoalState, replaceGoalPlanning, writeGoalState } from "../src/goals/state.js";
import { readLoopTasks } from "../src/loop/tasks.js";
import { recordGoalVerification } from "../src/loop/verification.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("loop tasks projects goal horizons as bounded task units", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-tasks-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "multi-horizon goal");
    let state = replaceGoalPlanning(createGoalState({ objective: "Ship task catalog", owner: "alice" }, new Date("2026-06-11T00:00:00.000Z")), {
      summary: "First horizon",
      steps: [{ id: "first", title: "First horizon work", status: "completed" }],
    }, new Date("2026-06-11T00:01:00.000Z"));
    writeGoalState(store, session.session_id, state, "run_h0");
    appendRun(store, session.session_id, "run_h0", "work first horizon", "completed");
    appendRun(store, session.session_id, "run_verify0", "verify first horizon", "completed");
    recordGoalVerification(store, session.session_id, {
      provider: "command",
      verdict: "pass",
      confidence: "hard",
      goal_id: state.goal.id,
      horizon_generation: 0,
      run_id: "run_verify0",
      summary: "First horizon verification passed.",
    }, "run_verify0");

    state = completeGoalReflection(state, {
      decision: "expand",
      summary: "Second horizon",
      steps: [{ id: "second", title: "Second horizon work", status: "pending" }],
    }, "run_reflect_expand", new Date("2026-06-11T00:02:00.000Z"));
    state.goal.planning!.steps[0]!.status = "blocked";
    state.goal.planning!.steps[0]!.updated_at = "2026-06-11T00:03:00.000Z";
    state.goal.planning!.updated_at = "2026-06-11T00:03:00.000Z";
    state.goal.updated_at = "2026-06-11T00:03:00.000Z";
    state.goal.blocker = "missing fixture";
    writeGoalState(store, session.session_id, state, "run_h1");
    appendRun(store, session.session_id, "run_h1", "work second horizon", "failed");
    appendRun(store, session.session_id, "run_verify1", "verify second horizon", "completed");
    recordGoalVerification(store, session.session_id, {
      provider: "checker",
      verdict: "fail",
      confidence: "soft",
      goal_id: state.goal.id,
      horizon_generation: 1,
      run_id: "run_verify1",
      summary: "Second horizon still blocked.",
      failure_reason: "missing fixture",
    }, "run_verify1");

    const report = readLoopTasks(store, workspace);
    assert.equal(report.summary.total, 2);
    assert.equal(report.summary.current, 1);
    assert.equal(report.summary.by_kind.task, 2);
    assert.equal(report.summary.verified, 1);
    assert.equal(report.summary.blocked, 1);

    const first = report.tasks.find((task) => task.horizon_generation === 0);
    assert.equal(first?.state, "verified");
    assert.equal(first?.current, false);
    assert.equal(first?.steps.by_status.completed, 1);
    assert.equal(first?.attempts.total, 2);
    assert.equal(first?.verification.hard_pass, 1);
    assert.equal(first?.verification.latest?.provider, "command");

    const second = report.tasks.find((task) => task.horizon_generation === 1);
    assert.equal(second?.state, "blocked");
    assert.equal(second?.current, true);
    assert.equal(second?.owner, "alice");
    assert.equal(second?.blocker, "missing fixture");
    assert.equal(second?.steps.by_status.blocked, 1);
    assert.equal(second?.attempts.failed, 1);
    assert.equal(second?.verification.latest?.verdict, "fail");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop tasks command returns horizon task catalog as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-tasks-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "cli loop task goal");
    const state = replaceGoalPlanning(createGoalState({ objective: "Expose loop tasks" }), {
      summary: "Ready for verification",
      steps: [{ id: "done", title: "Done work", status: "completed" }],
    });
    writeGoalState(store, session.session_id, state, "run_goal");
  } finally {
    store.close();
  }
  try {
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
      "tasks",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as {
      summary?: { total?: number; ready_for_verification?: number };
      tasks?: Array<{ state?: string; horizon_generation?: number; steps?: { total?: number } }>;
    };
    assert.equal(parsed.summary?.total, 1);
    assert.equal(parsed.summary?.ready_for_verification, 1);
    assert.equal(parsed.tasks?.[0]?.state, "ready_for_verification");
    assert.equal(parsed.tasks?.[0]?.horizon_generation, 0);
    assert.equal(parsed.tasks?.[0]?.steps?.total, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function appendRun(store: SessionStore, sessionId: string, runId: string, prompt: string, terminal: "completed" | "failed"): void {
  store.appendEvent({ session_id: sessionId, run_id: runId, type: "user.prompt", data: { prompt, request_class: "background", visibility: "normal" } });
  store.appendEvent({ session_id: sessionId, run_id: runId, type: terminal === "completed" ? "run.completed" : "run.failed", data: {} });
}
