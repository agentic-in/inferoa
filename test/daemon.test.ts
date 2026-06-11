import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { attachDaemonJob, cancelDaemonJob, daemonStatus, detachDaemonJob, queueDaemonGoal, queueDaemonRun, serveDaemon } from "../src/daemon/supervisor.js";
import { completeGoalReflection, createGoalState, readGoalState, replaceGoalPlanning, setGoalVerifierPolicy, writeGoalState } from "../src/goals/state.js";
import { readGoalVerificationRecords } from "../src/loop/verification.js";
import { SessionStore } from "../src/session/store.js";
import type { VllmAgentConfig, WorkspaceIdentity } from "../src/types.js";

test("daemon queue, detach, status, and cancel persist job state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-daemon-"));
  const workspace = path.join(dir, "workspace");
  const state = path.join(dir, "state");
  try {
    await mkdir(path.join(workspace, ".inferoa"), { recursive: true });
    await writeFile(path.join(workspace, ".inferoa", "config.yaml"), YAML.stringify(DEFAULT_CONFIG), "utf8");
    const job = await queueDaemonRun({ stateDir: state, workspaceRoot: workspace, prompt: "hello daemon" });
    assert.equal(job.status, "queued");
    const detached = await detachDaemonJob(state, job.job_id);
    assert.equal(detached.status, "detached");
    const attached = await attachDaemonJob(state, job.job_id);
    assert.equal(attached.job.status, "running");
    const detachedAgain = await detachDaemonJob(state, job.job_id);
    assert.equal(detachedAgain.status, "detached");
    const cancelled = await cancelDaemonJob(state, job.job_id);
    assert.equal(cancelled.status, "cancel_requested");
    const status = await daemonStatus(state);
    assert.equal(status.jobs.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon cancel preserves terminal job states", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-daemon-terminal-"));
  const workspace = path.join(dir, "workspace");
  const state = path.join(dir, "state");
  try {
    await mkdir(path.join(workspace, ".inferoa"), { recursive: true });
    await writeFile(path.join(workspace, ".inferoa", "config.yaml"), YAML.stringify(DEFAULT_CONFIG), "utf8");
    const job = await queueDaemonRun({ stateDir: state, workspaceRoot: workspace, prompt: "cancel before run" });
    const cancelled = await cancelDaemonJob(state, job.job_id);
    assert.equal(cancelled.status, "cancelled");
    const observed = await cancelDaemonJob(state, job.job_id);
    assert.equal(observed.status, "cancelled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon run jobs can execute as isolated verification jobs", async () => {
  let verificationModelCalls = 0;
  const server = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      const requestClass = typeof req.headers["x-inferoa-request-class"] === "string" ? req.headers["x-inferoa-request-class"] : "interactive";
      assert.equal(requestClass, "verification");
      verificationModelCalls += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (verificationModelCalls === 1) {
        writeSse(res, {
          id: "resp_verify_tool",
          model: "daemon-goal-test",
          choices: [{
            delta: {
              tool_calls: [{
                id: "call_goal_verify",
                type: "function",
                function: {
                  name: "goal",
                  arguments: JSON.stringify({
                    op: "verify",
                    verdict: "pass",
                    confidence: "soft",
                    summary: "Isolated verifier passed.",
                  }),
                },
              }],
            },
          }],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 4 } });
      } else {
        writeSse(res, { id: "resp_verify_done", model: "daemon-goal-test", choices: [{ delta: { content: "verification recorded" } }] });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-daemon-verification-job-"));
  const workspaceRoot = path.join(dir, "workspace");
  const state = path.join(dir, "state");
  const store = await SessionStore.open(state);
  try {
    await mkdir(path.join(workspaceRoot, ".inferoa"), { recursive: true });
    const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
    await writeFile(configPath, YAML.stringify(testConfig(`http://127.0.0.1:${address.port}/v1`)), "utf8");
    const workspace: WorkspaceIdentity = { id: "w_daemon_verifier", root: workspaceRoot, alias: "daemon-verifier" };
    const session = store.createSession(workspace, "daemon verifier");
    const goal = writeGoalState(store, session.session_id, createGoalState({ objective: "Verify from daemon metadata" }));
    const job = store.createSupervisorJob(session.session_id, workspaceRoot, "verify goal", {
      goal_id: goal.goal.id,
      metadata: {
        config_path: configPath,
        request_class: "verification",
        skip_goal_supervisor: true,
        goal_id: goal.goal.id,
        horizon_generation: goal.goal.horizon_generation,
        verifier_role: "tests",
      },
    });

    await serveDaemon({ stateDir: state, once: true });

    const finished = store.getSupervisorJob(job.job_id);
    assert.equal(finished?.status, "complete");
    assert.equal(verificationModelCalls, 2);
    const records = readGoalVerificationRecords(store, session.session_id, goal.goal.id);
    assert.equal(records[0]?.provider, "checker");
    assert.equal(records[0]?.verdict, "pass");
    assert.equal(records[0]?.verifier_role, "tests");
    assert.equal(store.listEvents(session.session_id).some((event) => event.type === "goal.supervisor.paused"), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("daemon goal supervisor expands horizon through internal reflection and completes after done reflection", async () => {
  let reflectionCalls = 0;
  let backgroundCalls = 0;
  const verifierCommand = `"${process.execPath}" -e "process.exit(0)"`;
  const server = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      const requestClass = typeof req.headers["x-inferoa-request-class"] === "string" ? req.headers["x-inferoa-request-class"] : "interactive";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (requestClass === "reflection") {
        reflectionCalls += 1;
        const toolCall =
          reflectionCalls === 1
            ? {
                id: "call_reflection_expand",
                type: "function",
                function: {
                  name: "goal",
                  arguments: JSON.stringify({
                    op: "reflect",
                    decision: "expand",
                    summary: "Hidden horizon discovered.",
                    steps: [{ id: "hidden-horizon", title: "Handle hidden horizon", status: "pending" }],
                  }),
                },
              }
            : reflectionCalls === 2
              ? {
                  id: "call_reflection_done",
                  type: "function",
                  function: {
                    name: "goal",
                    arguments: JSON.stringify({
                      op: "reflect",
                      decision: "done",
                      summary: "No additional horizon remains.",
                      verification_evidence: { git_status: "checked", hidden_horizon: "complete" },
                    }),
                  },
                }
              : undefined;
        if (toolCall) {
          writeSse(res, { id: `resp_reflection_${reflectionCalls}`, model: "daemon-goal-test", choices: [{ delta: { tool_calls: [toolCall] } }] });
          writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 3 } });
        } else {
          writeSse(res, { id: `resp_reflection_final_${reflectionCalls}`, model: "daemon-goal-test", choices: [{ delta: { content: "reflection settled" } }] });
          writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 4 } });
        }
      } else {
        backgroundCalls += 1;
        if (backgroundCalls === 1) {
          writeSse(res, {
            id: "resp_work_complete_hidden",
            model: "daemon-goal-test",
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: "call_verify_hidden",
                      type: "function",
                      function: {
                        name: "run_command",
                        arguments: JSON.stringify({ command: verifierCommand, timeout_ms: 10_000 }),
                      },
                    },
                    {
                      id: "call_complete_hidden",
                      type: "function",
                      function: {
                        name: "goal",
                        arguments: JSON.stringify({ op: "update_step", step_id: "hidden-horizon", status: "completed", notes: "Handled hidden horizon." }),
                      },
                    },
                  ],
                },
              },
            ],
          });
          writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 22, completion_tokens: 3 } });
        } else {
          writeSse(res, { id: `resp_work_final_${backgroundCalls}`, model: "daemon-goal-test", choices: [{ delta: { content: "work settled" } }] });
          writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 23, completion_tokens: 4 } });
        }
      }
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-daemon-goal-"));
  const workspaceRoot = path.join(dir, "workspace");
  const state = path.join(dir, "state");
  const store = await SessionStore.open(state);
  try {
    await mkdir(path.join(workspaceRoot, ".inferoa"), { recursive: true });
    const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
    await writeFile(configPath, YAML.stringify(testConfig(`http://127.0.0.1:${address.port}/v1`)), "utf8");
    const workspace: WorkspaceIdentity = { id: "w_daemon_goal", root: workspaceRoot, alias: "daemon-goal" };
    const session = store.createSession(workspace, "daemon-goal");
    let goal = createGoalState({ objective: "Complete long horizon goal" });
    goal = replaceGoalPlanning(goal, {
      steps: [{ id: "initial", title: "Initial horizon", status: "completed" }],
    });
    goal = setGoalVerifierPolicy(goal, { command_verifiers: [{ id: "daemon-unit", command: verifierCommand, required: true }] });
    writeGoalState(store, session.session_id, goal);

    const job = await queueDaemonGoal({ stateDir: state, workspaceRoot, sessionId: session.session_id, maxIterations: 6, configPath });
    assert.equal(job.kind, "goal");
    await serveDaemon({ stateDir: state, once: true });

    const finished = readGoalState(store, session.session_id)?.goal;
    assert.equal(finished?.status, "complete");
    assert.equal(finished?.last_reflection_decision, "done");
    assert.equal(finished?.horizon_generation, 1);
    assert.equal(store.getSupervisorJob(job.job_id)?.status, "complete");
    const events = store.listEvents(session.session_id);
    assert.ok(events.some((event) => event.type === "goal.reflection.started"));
    assert.ok(events.some((event) => event.type === "goal.horizon.expanded"));
    assert.ok(events.some((event) => event.type === "goal.completion_report"));
    assert.ok(events.some((event) => event.type === "user.prompt" && event.data.visibility === "internal" && event.data.request_class === "reflection"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("daemon goal supervisor pauses when reflection omits a decision instead of reusing stale reflection state", async () => {
  let reflectionCalls = 0;
  const server = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      const requestClass = typeof req.headers["x-inferoa-request-class"] === "string" ? req.headers["x-inferoa-request-class"] : "interactive";
      if (requestClass === "reflection") {
        reflectionCalls += 1;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeSse(res, {
        id: `resp_${requestClass}_${reflectionCalls}`,
        model: "daemon-goal-test",
        choices: [{ delta: { content: requestClass === "reflection" ? "reflection without decision" : "work settled" } }],
      });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 4 } });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-daemon-goal-stale-reflection-"));
  const workspaceRoot = path.join(dir, "workspace");
  const state = path.join(dir, "state");
  const store = await SessionStore.open(state);
  try {
    await mkdir(path.join(workspaceRoot, ".inferoa"), { recursive: true });
    const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
    await writeFile(configPath, YAML.stringify(testConfig(`http://127.0.0.1:${address.port}/v1`)), "utf8");
    const workspace: WorkspaceIdentity = { id: "w_daemon_stale_reflection", root: workspaceRoot, alias: "daemon-stale-reflection" };
    const session = store.createSession(workspace, "daemon stale reflection");
    let goal = createGoalState({ objective: "Do not reuse stale reflection decisions" });
    goal = replaceGoalPlanning(goal, { steps: [{ id: "done", title: "Already done horizon", status: "completed" }] });
    goal = completeGoalReflection(goal, {
      decision: "done",
      summary: "Old reflection should not count.",
      verification_evidence: { old: true },
    }, "run_old_reflection");
    writeGoalState(store, session.session_id, goal);

    const job = await queueDaemonGoal({ stateDir: state, workspaceRoot, sessionId: session.session_id, maxIterations: 2, configPath });
    await serveDaemon({ stateDir: state, once: true });

    assert.equal(reflectionCalls, 1);
    const current = readGoalState(store, session.session_id)?.goal;
    assert.equal(current?.status, "paused");
    assert.equal(current?.last_reflection_run_id === "run_old_reflection", false);
    assert.notEqual(current?.last_reflection_decision, "done");
    const finishedJob = store.getSupervisorJob(job.job_id);
    assert.equal(finishedJob?.status, "paused");
    assert.equal(finishedJob?.metadata.pause_reason, "reflection_missing_decision");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("daemon run with an active goal pauses hidden supervision without strong verification", async () => {
  let reflectionCalls = 0;
  let backgroundCalls = 0;
  let verificationCalls = 0;
  const server = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      const requestClass = typeof req.headers["x-inferoa-request-class"] === "string" ? req.headers["x-inferoa-request-class"] : "interactive";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (requestClass === "reflection") {
        reflectionCalls += 1;
        if (reflectionCalls === 1) {
          writeSse(res, {
            id: "resp_hidden_reflection_done",
            model: "daemon-goal-test",
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: "call_hidden_reflection_done",
                      type: "function",
                      function: {
                        name: "goal",
                        arguments: JSON.stringify({
                          op: "reflect",
                          decision: "done",
                          summary: "The post-turn supervisor found no remaining horizon.",
                          verification_evidence: { post_turn_reflection: true },
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          });
          writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 22, completion_tokens: 3 } });
        } else {
          writeSse(res, { id: "resp_hidden_reflection_final", model: "daemon-goal-test", choices: [{ delta: { content: "reflection settled" } }] });
          writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 4 } });
        }
      } else if (requestClass === "verification") {
        verificationCalls += 1;
        writeSse(res, { id: "resp_hidden_verification_no_record", model: "daemon-goal-test", choices: [{ delta: { content: "verification did not record a verdict" } }] });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 24, completion_tokens: 4 } });
      } else {
        backgroundCalls += 1;
        writeSse(res, { id: "resp_visible_turn", model: "daemon-goal-test", choices: [{ delta: { content: "visible turn settled" } }] });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 4 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-daemon-run-goal-supervisor-"));
  const workspaceRoot = path.join(dir, "workspace");
  const state = path.join(dir, "state");
  const store = await SessionStore.open(state);
  try {
    await mkdir(path.join(workspaceRoot, ".inferoa"), { recursive: true });
    const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
    await writeFile(configPath, YAML.stringify(testConfig(`http://127.0.0.1:${address.port}/v1`)), "utf8");
    const workspace: WorkspaceIdentity = { id: "w_daemon_run_goal", root: workspaceRoot, alias: "daemon-run-goal" };
    const session = store.createSession(workspace, "daemon run goal");
    let goal = createGoalState({ objective: "Finish after visible daemon turn" });
    goal = replaceGoalPlanning(goal, { steps: [{ id: "visible", title: "Visible turn horizon", status: "completed" }] });
    writeGoalState(store, session.session_id, goal);

    const job = await queueDaemonRun({ stateDir: state, workspaceRoot, sessionId: session.session_id, prompt: "visible daemon work", configPath });
    await serveDaemon({ stateDir: state, once: true });

    assert.equal(backgroundCalls, 1);
    assert.equal(reflectionCalls, 1);
    assert.equal(verificationCalls, 1);
    const current = readGoalState(store, session.session_id)?.goal;
    assert.equal(current?.status, "paused");
    assert.equal(current?.last_reflection_decision, "done");
    const finishedJob = store.getSupervisorJob(job.job_id);
    assert.equal(finishedJob?.status, "paused");
    assert.match(String(finishedJob?.metadata.pause_reason ?? ""), /Reflection-only evidence is not enough/);
    const prompts = store.listEvents(session.session_id).filter((event) => event.type === "user.prompt");
    assert.ok(prompts.some((event) => event.data.prompt === "visible daemon work" && event.data.visibility === "normal"));
    assert.ok(prompts.some((event) => event.data.request_class === "reflection" && event.data.visibility === "internal"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function testConfig(baseUrl: string): VllmAgentConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.model_setup.base_url = baseUrl;
  config.model_setup.model = "daemon-goal-test";
  config.rtk.enabled = false;
  return config;
}

function serveEndpointSignal(url: string | undefined, res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (chunk?: string) => void }): boolean {
  if (url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "daemon-goal-test" }] }));
    return true;
  }
  if (url === "/load") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ waiting: 0, running: 0 }));
    return true;
  }
  if (url === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("vllm:prefix_cache_queries_total 2\nvllm:prefix_cache_hits_total 1\n");
    return true;
  }
  return false;
}

function writeSse(res: { write: (chunk: string) => void }, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
