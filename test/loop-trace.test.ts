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
import { readLoopTrace } from "../src/loop/trace.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("loop trace projects structured run, step, tool, and verification boundaries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-trace-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "trace session");
    store.appendEvent({ session_id: session.session_id, run_id: "run_a", type: "user.prompt", data: { prompt: "fix", request_class: "background", visibility: "visible" } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_a", type: "model.request.started", data: { step_id: "step_a_1", step_index: 1, model: "m1", request_class: "background", visibility: "visible", estimated_tokens: 120, prompt_epoch_id: "epoch_1" } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_a", type: "model.response.settled", data: { step_id: "step_a_1", step_index: 1, model: "m1", tool_calls: [{ id: "tool_1", name: "run_command", arguments: {} }], usage: { prompt_tokens: 100, completion_tokens: 20 } } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_a", type: "tool.call", data: { step_id: "step_a_1", step_index: 1, tool_call_id: "tool_1", tool_name: "run_command", arguments: { command: "npm test" } } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_a", type: "tool.result", data: { step_id: "step_a_1", step_index: 1, tool_call_id: "tool_1", tool_name: "run_command", result: { ok: false, error: { code: "exit_1" } } } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_a", type: "goal.horizon.expanded", data: { previous_horizon_generation: 0, horizon_generation: 1 } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_a", type: "goal.verification.recorded", data: { provider: "command", verdict: "fail", confidence: "hard", goal_id: "goal_1", horizon_generation: 1 } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_a", type: "run.failed", data: { error: "failed", tool_rounds: 1, tool_calls: 1, tokens: 120, duration_ms: 1500 } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_b", type: "model.request.started", data: { model: "m1", request_class: "interactive" } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_b", type: "run.completed", data: { tool_rounds: 0, tool_calls: 0, tokens: 10, duration_ms: 20 } });

    const trace = readLoopTrace(store, session);
    assert.equal(trace.summary.runs, 2);
    assert.equal(trace.summary.steps, 2);
    assert.equal(trace.summary.tool_calls, 1);
    assert.equal(trace.summary.verifications, 1);
    assert.equal(trace.summary.failed, 1);
    const failed = trace.runs.find((run) => run.run_id === "run_a");
    assert.ok(failed);
    assert.equal(failed.status, "failed");
    assert.equal(failed.request_class, "background");
    assert.equal(failed.steps[0]?.step_id, "step_a_1");
    assert.equal(failed.steps[0]?.index, 1);
    assert.equal(failed.steps[0]?.estimated_tokens, 120);
    assert.equal(failed.steps[0]?.tool_call_count, 1);
    assert.equal(failed.tools[0]?.tool_name, "run_command");
    assert.equal(failed.tools[0]?.step_id, "step_a_1");
    assert.equal(failed.tools[0]?.step_index, 1);
    assert.equal(failed.tools[0]?.ok, false);
    assert.equal(failed.tools[0]?.error_code, "exit_1");
    assert.equal(failed.goal_events.some((event) => event.type === "goal.horizon.expanded" && event.horizon_generation === 1), true);
    assert.equal(failed.verification_count, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop trace command returns session trace as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-trace-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "cli trace");
    store.appendEvent({ session_id: session.session_id, run_id: "run_cli", type: "model.request.started", data: { model: "m1", request_class: "interactive" } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_cli", type: "run.completed", data: { tool_rounds: 0, tool_calls: 0, tokens: 5, duration_ms: 10 } });
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
      "trace",
      session.session_id.slice(0, 12),
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as { summary?: { runs?: number }; runs?: Array<{ run_id?: string; status?: string }> };
    assert.equal(parsed.summary?.runs, 1);
    assert.equal(parsed.runs?.[0]?.run_id, "run_cli");
    assert.equal(parsed.runs?.[0]?.status, "completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
