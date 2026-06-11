import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createGoalState, writeGoalState } from "../src/goals/state.js";
import { queueLoopSubagent } from "../src/loop/subagents.js";
import { queueGoalVerificationSuite } from "../src/loop/verifier-suite.js";
import { readLoopWorkers } from "../src/loop/workers.js";
import { recordGoalVerification } from "../src/loop/verification.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";
import { ToolRegistry } from "../src/tools/registry.js";

const execFileAsync = promisify(execFile);

test("loop workers projects daemon jobs and isolated verifier children", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-workers-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "parent goal");
    const state = createGoalState({ objective: "Coordinate verifier workers" });
    writeGoalState(store, session.session_id, state, "goal_init");
    const goalJob = store.createSupervisorJob(session.session_id, workspace.root, "continue goal", {
      kind: "goal",
      goal_id: state.goal.id,
    });
    store.updateSupervisorJob(goalJob.job_id, { status: "running" });
    const queued = await queueGoalVerificationSuite({
      store,
      workspace,
      session_id: session.session_id,
      goal_state: state,
      roles: ["tests", "security", "tests"],
      source: "cli",
    });
    const first = queued.jobs[0]!;
    recordGoalVerification(store, first.session_id, {
      provider: "checker",
      verdict: "pass",
      confidence: "hard",
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      verifier_role: first.role,
      summary: "Tests verifier passed.",
    });

    const report = readLoopWorkers(store, workspace);
    assert.equal(report.summary.total, 3);
    assert.equal(report.summary.active, 3);
    assert.equal(report.summary.verifiers, 2);
    assert.equal(report.summary.by_kind.verifier, 2);
    assert.equal(report.summary.by_kind.goal_supervisor, 1);
    assert.equal(report.summary.by_role.tests, 1);
    assert.equal(report.summary.by_role.security, 1);
    const verifier = report.workers.find((worker) => worker.kind === "verifier" && worker.role === "tests");
    assert.equal(verifier?.parent_session_id, session.session_id);
    assert.equal(verifier?.parent_session_title, "parent goal");
    assert.equal(verifier?.suite_id, queued.suite_id);
    assert.equal(verifier?.isolation, "session");
    assert.equal(verifier?.verification?.verdict, "pass");
    assert.equal(report.workers[0]?.status, "running");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop workers projects delegated sub-agent jobs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-subagent-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "parent implementation goal");
    const state = createGoalState({ objective: "Coordinate sub-agent work" });
    writeGoalState(store, session.session_id, state, "goal_init");

    const queued = await queueLoopSubagent({
      store,
      workspace,
      parent_session: session,
      task: "Implement the next scoped slice and report evidence.",
      source: "tool",
    });

    const job = store.getSupervisorJob(queued.job_id);
    assert.equal(job?.session_id, queued.child_session_id);
    assert.equal(job?.metadata.loop_subagent, true);
    assert.equal(job?.metadata.subagent_id, queued.subagent_id);
    assert.equal(job?.metadata.parent_session_id, session.session_id);
    assert.equal(job?.metadata.skip_goal_supervisor, true);
    assert.equal(job?.metadata.request_class, "background");
    assert.match(job?.prompt ?? "", /Run this delegated sub-agent task/);

    const report = readLoopWorkers(store, workspace);
    assert.equal(report.summary.total, 1);
    assert.equal(report.summary.subagents, 1);
    assert.equal(report.summary.by_kind.subagent, 1);
    assert.deepEqual(report.summary.by_role, {});
    assert.equal(report.workers[0]?.kind, "subagent");
    assert.equal(report.workers[0]?.role, undefined);
    assert.equal(report.workers[0]?.suite_id, queued.subagent_id);
    assert.equal(report.workers[0]?.parent_session_id, session.session_id);
    assert.equal(report.workers[0]?.parent_session_title, "parent implementation goal");
    assert.equal(report.workers[0]?.isolation, "session");

    const parentEvents = store.listEvents(session.session_id);
    const childEvents = store.listEvents(queued.child_session_id);
    assert.equal(parentEvents.some((event) => event.type === "loop.subagent.queued"), true);
    assert.equal(childEvents.some((event) => event.type === "loop.subagent.parent_linked"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("subagent tool is session-scoped and unavailable to internal controller runs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-subagent-tool-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "subagent tool guards");
    const registry = new ToolRegistry(structuredClone(DEFAULT_CONFIG), workspace, store);
    assert.equal(registry.list().some((tool) => tool.name === "subagent"), true);

    const invalidIsolation = await registry.call(
      { id: "subagent-invalid-isolation", name: "subagent", arguments: { task: "inspect the current slice", isolation: "shared" } },
      { session_id: session.session_id, run_id: "run-subagent-invalid-isolation", request_class: "interactive" },
    );
    assert.equal(invalidIsolation.ok, false);
    assert.equal(invalidIsolation.error?.code, "invalid_tool_arguments");
    assert.match(invalidIsolation.error?.message ?? "", /arguments\.isolation/);

    const reflection = await registry.call(
      { id: "subagent-reflection", name: "subagent", arguments: { task: "inspect the current slice" } },
      { session_id: session.session_id, run_id: "run-subagent-reflection", request_class: "reflection", visibility: "internal" },
    );
    assert.equal(reflection.ok, false);
    assert.equal(reflection.error?.code, "subagent_context_not_allowed");

    const state = createGoalState({ objective: "Coordinate scoped sub-agent work" });
    writeGoalState(store, session.session_id, state, "goal_init");
    const queued = await queueLoopSubagent({
      store,
      workspace,
      parent_session: session,
      task: "Inspect the current slice and report evidence.",
      source: "tool",
    });
    const nested = await registry.call(
      { id: "subagent-nested", name: "subagent", arguments: { task: "try to delegate again" } },
      { session_id: queued.child_session_id, run_id: "run-subagent-nested", request_class: "background" },
    );
    assert.equal(nested.ok, false);
    assert.equal(nested.error?.code, "subagent_nested_not_allowed");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("subagent tool runs a child runtime and records parent evidence", async () => {
  const requestClasses: string[] = [];
  const modelServer = createServer((req, res) => {
    requestClasses.push(String(req.headers["x-inferoa-request-class"] ?? ""));
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeSse(res, {
        id: "resp_subagent_done",
        model: "subagent-test",
        choices: [{ delta: { content: "sub-agent evidence: inspected the delegated slice" } }],
      });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 17, completion_tokens: 5 } });
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-subagent-runtime-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.model_setup.base_url = `http://127.0.0.1:${address.port}/v1`;
    config.model_setup.model = "subagent-test";
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "subagent runtime parent");
    const registry = new ToolRegistry(config, workspace, store);

    const result = await registry.call(
      { id: "subagent-runtime", name: "subagent", arguments: { task: "Inspect the delegated slice and report evidence." } },
      { session_id: session.session_id, run_id: "run-subagent-runtime", request_class: "interactive" },
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(String(result.data?.content ?? ""), /sub-agent evidence/);
    assert.equal(requestClasses[0], "background");
    assert.equal(requestClasses.includes("background"), true);
    const childSessionId = String(result.data?.child_session_id ?? "");
    const jobId = String(result.data?.job_id ?? "");
    assert.ok(childSessionId);
    assert.ok(jobId);
    assert.equal(store.getSupervisorJob(jobId)?.status, "complete");
    const parentEvents = store.listEvents(session.session_id);
    assert.equal(parentEvents.some((event) => event.type === "loop.subagent.started"), true);
    assert.equal(parentEvents.some((event) => event.type === "loop.subagent.completed"), true);
    assert.equal(store.listEvents(childSessionId).some((event) => event.type === "run.completed"), true);
    const report = readLoopWorkers(store, workspace);
    assert.equal(report.summary.subagents, 1);
    assert.equal(report.workers[0]?.kind, "subagent");
    assert.equal(report.workers[0]?.status, "complete");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("loop workers command returns worker projection as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-workers-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "cli worker goal");
    const state = createGoalState({ objective: "Expose worker projection" });
    writeGoalState(store, session.session_id, state, "goal_init");
    await queueGoalVerificationSuite({
      store,
      workspace,
      session_id: session.session_id,
      goal_state: state,
      roles: ["tests", "security"],
      source: "cli",
    });
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
      "workers",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as {
      summary?: { total?: number; verifiers?: number; by_role?: Record<string, number> };
      workers?: Array<{ kind?: string; role?: string; parent_session_title?: string }>;
    };
    assert.equal(parsed.summary?.total, 2);
    assert.equal(parsed.summary?.verifiers, 2);
    assert.equal(parsed.summary?.by_role?.tests, 1);
    assert.equal(parsed.summary?.by_role?.security, 1);
    assert.equal(parsed.workers?.every((worker) => worker.kind === "verifier"), true);
    assert.equal(parsed.workers?.some((worker) => worker.parent_session_title === "cli worker goal"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function writeSse(res: { write: (chunk: string) => void }, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
