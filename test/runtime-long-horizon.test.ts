import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { PromptBuilder } from "../src/context/prompt.js";
import { Runtime, type RuntimeStatusEvent } from "../src/runtime.js";
import { SessionStore } from "../src/session/store.js";
import { completeGoalReflection, createGoalState, goalDurationMs, markGoalReflectionStarted, readGoalState, replaceGoalPlanning, writeGoalState } from "../src/goals/state.js";
import { CORE_TOOL_DEFINITIONS } from "../src/tools/schemas.js";
import type { VllmAgentConfig, WorkspaceIdentity } from "../src/types.js";

test("runtime defaults to an unbounded tool loop for long horizon tasks", async () => {
  let chatCalls = 0;
  const toolRoundsBeforeFinal = 70;
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      chatCalls += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (chatCalls <= toolRoundsBeforeFinal) {
        writeSse(res, {
          id: `resp_tool_${chatCalls}`,
          model: "long-horizon-test",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: `call_${chatCalls}`,
                    type: "function",
                    function: { name: "read_file", arguments: JSON.stringify({ path: `missing-${chatCalls}.txt` }) },
                  },
                ],
              },
            },
          ],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 2 } });
      } else {
        writeSse(res, { id: "resp_final", model: "long-horizon-test", choices: [{ delta: { content: "finished long horizon loop" } }] });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 3 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-long-horizon-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_long_horizon", root: dir, alias: "long-horizon" };
    const runtime = new Runtime(config(`http://127.0.0.1:${address.port}/v1`), workspace, store);

    const result = await runtime.run({ prompt: "keep working until the long task is complete" });

    assert.equal(result.content, "finished long horizon loop");
    assert.equal(result.tool_rounds, toolRoundsBeforeFinal);
    assert.equal(chatCalls, toolRoundsBeforeFinal + 1);
    const events = store.listEvents(result.session.session_id);
    assert.equal(events.filter((event) => event.type === "run.stopped").length, 0);
    assert.ok(events.some((event) => event.type === "run.completed"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("runtime freezes available tool schemas for a run", async () => {
  let chatCalls = 0;
  const requestBodies: Array<Record<string, unknown>> = [];
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestBodies.push(JSON.parse(body) as Record<string, unknown>);
      chatCalls += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (chatCalls === 1) {
        writeSse(res, {
          id: "resp_before_tool_change",
          model: "long-horizon-test",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_before_tool_change",
                    type: "function",
                    function: { name: "read_file", arguments: JSON.stringify({ path: "missing-before-tool-change.txt" }) },
                  },
                ],
              },
            },
          ],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 2 } });
      } else {
        writeSse(res, { id: "resp_after_tool_change", model: "long-horizon-test", choices: [{ delta: { content: "stable tool snapshot" } }] });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 3 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-tool-snapshot-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const runtimeConfig = config(`http://127.0.0.1:${address.port}/v1`);
    const workspace: WorkspaceIdentity = { id: "w_tool_snapshot", root: dir, alias: "tool-snapshot" };
    const runtime = new Runtime(runtimeConfig, workspace, store);

    const result = await runtime.run({
      prompt: "keep the same tools available throughout this run",
      onStatus: (event) => {
        if (event.type === "tool_end") {
          runtimeConfig.omni.enabled = true;
          runtimeConfig.omni.endpoints.image_generation = { base_url: "http://localhost:8001/v1", model: "image-model" };
        }
      },
    });

    assert.equal(result.content, "stable tool snapshot");
    assert.equal(requestBodies.length, 2);
    const namesByRequest = requestBodies.map((body) =>
      ((body.tools as Array<{ function?: { name?: string } }> | undefined) ?? []).map((tool) => tool.function?.name),
    );
    assert.equal(namesByRequest[0]?.includes("image_generation"), false);
    assert.equal(namesByRequest[1]?.includes("image_generation"), false);
    const started = store.listEvents(result.session.session_id).filter((event) => event.type === "model.request.started");
    assert.equal(started[0]?.data.tool_schema_hash, started[1]?.data.tool_schema_hash);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("runtime tool start summaries name concrete Omni actions", async () => {
  let chatCalls = 0;
  const statuses: RuntimeStatusEvent[] = [];
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: Buffer.from("fake-image").toString("base64") }] }));
      return;
    }
    req.resume();
    req.on("end", () => {
      chatCalls += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (chatCalls === 1) {
        writeSse(res, {
          id: "resp_image_generation",
          model: "long-horizon-test",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_image_generation",
                    type: "function",
                    function: { name: "image_generation", arguments: JSON.stringify({ prompt: "tiny mascot" }) },
                  },
                ],
              },
            },
          ],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 2 } });
      } else {
        writeSse(res, { id: "resp_final", model: "long-horizon-test", choices: [{ delta: { content: "generated image" } }] });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 3 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-omni-tool-summary-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const runtimeConfig = config(baseUrl);
    runtimeConfig.omni.enabled = true;
    runtimeConfig.omni.endpoints.image_generation = { base_url: baseUrl, model: "image-model" };
    const workspace: WorkspaceIdentity = { id: "w_omni_tool_summary", root: dir, alias: "omni-tool-summary" };
    const runtime = new Runtime(runtimeConfig, workspace, store);

    const result = await runtime.run({
      prompt: "generate an image",
      onStatus: (event) => statuses.push(event),
    });

    assert.equal(result.content, "generated image");
    assert.ok(statuses.some((event) => event.type === "tool_start" && event.tool_name === "image_generation" && event.summary === "Image generation"));
    assert.equal(statuses.some((event) => event.type === "tool_start" && event.summary === "Calling Omni endpoint"), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("runtime freezes enabled skill prompt state for a run", async () => {
  let chatCalls = 0;
  const requestBodies: Array<Record<string, unknown>> = [];
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestBodies.push(JSON.parse(body) as Record<string, unknown>);
      chatCalls += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (chatCalls === 1) {
        writeSse(res, {
          id: "resp_enable_skill",
          model: "long-horizon-test",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_enable_skill",
                    type: "function",
                    function: { name: "skill_enable", arguments: JSON.stringify({ ids: ["demo-skill"] }) },
                  },
                ],
              },
            },
          ],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 2 } });
      } else {
        writeSse(res, { id: "resp_after_skill_enable", model: "long-horizon-test", choices: [{ delta: { content: "stable skill snapshot" } }] });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 3 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-skill-snapshot-"));
  const previousStateDir = process.env.INFEROA_STATE_DIR;
  process.env.INFEROA_STATE_DIR = path.join(dir, "user-state");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const skillDir = path.join(dir, ".inferoa", "skills", "demo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: Demo Skill\ndescription: Demonstrates stable skill prompt state.\n---\n\nUse this when explicitly enabled.\n",
      "utf8",
    );
    const runtimeConfig = config(`http://127.0.0.1:${address.port}/v1`);
    runtimeConfig.skills.enabled = [];
    const workspace: WorkspaceIdentity = { id: "w_skill_snapshot", root: dir, alias: "skill-snapshot" };
    const runtime = new Runtime(runtimeConfig, workspace, store);

    const result = await runtime.run({ prompt: "enable a skill and continue with the same prompt layout" });

    assert.equal(result.content, "stable skill snapshot");
    assert.equal(requestBodies.length, 2);
    const systemMessages = requestBodies.map((body) => {
      const messages = body.messages as Array<{ role?: string; content?: string }>;
      return String(messages.find((message) => message.role === "system")?.content ?? "");
    });
    assert.match(systemMessages[0]!, /Enabled skills: none\./);
    assert.match(systemMessages[0]!, /- demo-skill \| available/);
    assert.match(systemMessages[1]!, /Enabled skills: none\./);
    assert.match(systemMessages[1]!, /- demo-skill \| available/);
    assert.doesNotMatch(systemMessages[1]!, /- demo-skill \| enabled/);
    const started = store.listEvents(result.session.session_id).filter((event) => event.type === "model.request.started");
    assert.equal(started[0]?.data.prompt_epoch_id, started[1]?.data.prompt_epoch_id);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.INFEROA_STATE_DIR;
    } else {
      process.env.INFEROA_STATE_DIR = previousStateDir;
    }
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("runtime retries transient provider failures and continues the same run", async () => {
  let chatCalls = 0;
  const statuses: RuntimeStatusEvent[] = [];
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      chatCalls += 1;
      if (chatCalls <= 2) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("temporarily overloaded");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-request-id": "req_after_retries" });
      writeSse(res, { id: "resp_after_retries", model: "long-horizon-test", choices: [{ delta: { content: "recovered from provider flake" } }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-model-retry-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_model_retry", root: dir, alias: "model-retry" };
    const runtime = new Runtime(retryConfig(`http://127.0.0.1:${address.port}/v1`), workspace, store);

    const result = await runtime.run({
      prompt: "answer after a transient model failure",
      onStatus: (event) => statuses.push(event),
    });

    assert.equal(result.content, "recovered from provider flake");
    assert.equal(chatCalls, 3);
    assert.equal(statuses.filter((event) => event.type === "model_retry").length, 2);
    const events = store.listEvents(result.session.session_id);
    const started = events.find((event) => event.type === "model.request.started");
    const retries = events.filter((event) => event.type === "model.request.retry");
    assert.equal(retries.length, 2);
    assert.equal(started?.data.request_class, "interactive");
    for (const retry of retries) {
      assert.equal(retry.data.request_class, "interactive");
      assert.equal(retry.data.prompt_hash, started?.data.prompt_hash);
      assert.equal(retry.data.tool_schema_hash, started?.data.tool_schema_hash);
      assert.equal(retry.data.prompt_epoch_id, started?.data.prompt_epoch_id);
    }
    assert.equal(events.filter((event) => event.type === "model.response.settled").length, 1);
    assert.ok(events.some((event) => event.type === "run.completed"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("runtime times out a stuck provider request and retries the same run", async () => {
  let chatCalls = 0;
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      chatCalls += 1;
      if (chatCalls === 1) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-request-id": "req_after_timeout" });
      writeSse(res, { id: "resp_after_timeout", model: "long-horizon-test", choices: [{ delta: { content: "recovered from stuck provider" } }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-model-timeout-retry-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_model_timeout_retry", root: dir, alias: "model-timeout-retry" };
    const runtime = new Runtime(timeoutRetryConfig(`http://127.0.0.1:${address.port}/v1`), workspace, store);

    const result = await runtime.run({ prompt: "answer after a stuck model request" });

    assert.equal(result.content, "recovered from stuck provider");
    assert.equal(chatCalls, 2);
    const events = store.listEvents(result.session.session_id);
    const retry = events.find((event) => event.type === "model.request.retry");
    assert.match(String(retry?.data.error ?? ""), /timed out/);
    assert.ok(events.some((event) => event.type === "run.completed"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("runtime records failed long-horizon runs and accounts active goal usage", async () => {
  let chatCalls = 0;
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      chatCalls += 1;
      if (chatCalls === 1) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        writeSse(res, {
          id: "resp_tool_before_failure",
          model: "long-horizon-test",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_before_failure",
                    type: "function",
                    function: { name: "read_file", arguments: JSON.stringify({ path: "missing-before-failure.txt" }) },
                  },
                ],
              },
            },
          ],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 30, completion_tokens: 4 } });
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("permanent model failure");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-failed-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_goal_failed_run", root: dir, alias: "goal-failed-run" };
    const runtime = new Runtime(noRetryConfig(`http://127.0.0.1:${address.port}/v1`), workspace, store);
    const session = store.createSession(workspace, "failed-goal");
    writeGoalState(store, session.session_id, createGoalState({ objective: "Finish a long task even when failures happen" }));

    await assert.rejects(() => runtime.run({ prompt: "start a goal that will fail after a tool", session_id: session.session_id }), /permanent model failure/);

    const events = store.listEvents(session.session_id);
    assert.ok(events.some((event) => event.type === "run.failed"));
    const goal = readGoalState(store, session.session_id)?.goal;
    assert.ok((goal?.tokens_used ?? 0) >= 34);
    assert.ok((goal?.time_used_seconds ?? 0) >= 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("runtime accounts active goal usage when a run is stopped by tool-round limit", async () => {
  let chatCalls = 0;
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      chatCalls += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeSse(res, {
        id: "resp_stopped",
        model: "long-horizon-test",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "call_stopped",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "missing-stopped.txt" }) },
                },
              ],
            },
          },
        ],
      });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 17, completion_tokens: 6 } });
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-stopped-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_goal_stopped_run", root: dir, alias: "goal-stopped-run" };
    const runtime = new Runtime(config(`http://127.0.0.1:${address.port}/v1`), workspace, store);
    const session = store.createSession(workspace, "stopped-goal");
    writeGoalState(store, session.session_id, createGoalState({ objective: "Track usage even when stopped" }));

    const result = await runtime.run({ prompt: "start a goal that will hit the tool cap", session_id: session.session_id, max_tool_rounds: 0 });

    assert.equal(result.tool_rounds, 0);
    assert.equal(chatCalls, 1);
    const events = store.listEvents(session.session_id);
    assert.ok(events.some((event) => event.type === "run.stopped"));
    assert.equal(readGoalState(store, session.session_id)?.goal.tokens_used, 23);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("runtime yields after visible work exhausts the active goal frontier", async () => {
  let chatCalls = 0;
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      chatCalls += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (chatCalls === 1) {
        writeSse(res, {
          id: "resp_finish_frontier",
          model: "long-horizon-test",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_finish_frontier",
                    type: "function",
                    function: {
                      name: "goal",
                      arguments: JSON.stringify({ op: "update_step", step_id: "final", status: "completed", notes: "Final visible step completed." }),
                    },
                  },
                ],
              },
            },
          ],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 11, completion_tokens: 4 } });
      } else {
        writeSse(res, {
          id: "resp_unwanted_visible_continuation",
          model: "long-horizon-test",
          choices: [{ delta: { content: "visible continuation should not run" } }],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 13, completion_tokens: 5 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-frontier-yield-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_goal_frontier_yield", root: dir, alias: "goal-frontier-yield" };
    const runtime = new Runtime(config(`http://127.0.0.1:${address.port}/v1`), workspace, store);
    const session = store.createSession(workspace, "frontier-yield");
    const goal = replaceGoalPlanning(createGoalState({ objective: "Finish visible frontier then reflection" }), {
      steps: [{ id: "final", title: "Final visible frontier", status: "in_progress" }],
    });
    writeGoalState(store, session.session_id, goal);

    const result = await runtime.run({ prompt: "finish the visible frontier", session_id: session.session_id });

    assert.equal(chatCalls, 1);
    assert.equal(result.tool_rounds, 1);
    assert.equal(result.tool_calls, 1);
    const current = readGoalState(store, session.session_id)?.goal;
    assert.equal(current?.status, "active");
    assert.equal(current?.last_reflection_decision, undefined);
    assert.equal(current?.planning?.steps[0]?.status, "completed");
    const events = store.listEvents(session.session_id);
    assert.equal(events.filter((event) => event.type === "model.request.started").length, 1);
    assert.ok(events.some((event) => event.type === "goal.frontier.exhausted" && event.run_id === result.run_id));
    assert.ok(events.some((event) => event.type === "run.completed" && event.run_id === result.run_id));
    assert.equal(events.some((event) => event.type === "run.stopped" && event.run_id === result.run_id), false);
    assert.equal(store.getSession(session.session_id)?.status, "idle");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("runtime yields immediately after an internal reflection decision is recorded", async () => {
  let chatCalls = 0;
  const reflectionRunId = "run_runtime_reflection_yield";
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      chatCalls += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (chatCalls === 1) {
        writeSse(res, {
          id: "resp_reflection_done",
          model: "long-horizon-test",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_reflection_done",
                    type: "function",
                    function: {
                      name: "goal",
                      arguments: JSON.stringify({
                        op: "reflect",
                        decision: "done",
                        summary: "No remaining frontier.",
                        verification_evidence: { checked: true },
                      }),
                    },
                  },
                  {
                    index: 1,
                    id: "call_unwanted_complete",
                    type: "function",
                    function: { name: "goal", arguments: JSON.stringify({ op: "complete", summary: "Reflection run should not complete directly." }) },
                  },
                ],
              },
            },
          ],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 11, completion_tokens: 4 } });
      } else {
        writeSse(res, {
          id: "resp_unwanted_reflection_continuation",
          model: "long-horizon-test",
          choices: [{ delta: { content: "reflection continuation should not run" } }],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 13, completion_tokens: 5 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-reflection-yield-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_goal_reflection_yield", root: dir, alias: "goal-reflection-yield" };
    const runtime = new Runtime(config(`http://127.0.0.1:${address.port}/v1`), workspace, store);
    const session = store.createSession(workspace, "reflection-yield");
    const goal = replaceGoalPlanning(createGoalState({ objective: "Reflect then let supervisor complete" }), {
      steps: [{ id: "final", title: "Final frontier", status: "completed" }],
    });
    writeGoalState(store, session.session_id, markGoalReflectionStarted(goal, reflectionRunId), reflectionRunId);

    const result = await runtime.run({
      prompt: "reflect on the completed frontier",
      session_id: session.session_id,
      request_class: "reflection",
      visibility: "internal",
      run_id: reflectionRunId,
    });

    assert.equal(chatCalls, 1);
    assert.equal(result.tool_rounds, 1);
    assert.equal(result.tool_calls, 1);
    const current = readGoalState(store, session.session_id)?.goal;
    assert.equal(current?.status, "active");
    assert.equal(current?.reflection_status, "completed");
    assert.equal(current?.last_reflection_decision, "done");
    const events = store.listEvents(session.session_id);
    assert.equal(events.some((event) => event.type === "tool.call" && event.data.tool_call_id === "call_unwanted_complete"), false);
    assert.ok(events.some((event) => event.type === "goal.reflection.decision_recorded" && event.run_id === reflectionRunId));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("runtime reports goal completion metrics after a completing tool loop", async () => {
  let chatCalls = 0;
  const streamed: string[] = [];
  const statuses: RuntimeStatusEvent[] = [];
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      chatCalls += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (chatCalls === 1) {
        writeSse(res, {
          id: "resp_complete_goal",
          model: "long-horizon-test",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_goal_complete",
                    type: "function",
                    function: { name: "goal", arguments: JSON.stringify({ op: "complete", summary: "Finished the goal.", force: true }) },
                  },
                ],
              },
            },
          ],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 11, completion_tokens: 2 } });
      } else {
        writeSse(res, { id: "resp_final_goal", model: "long-horizon-test", choices: [{ delta: { content: "goal finished" } }] });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 17, completion_tokens: 4 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-completion-report-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_goal_completion_report", root: dir, alias: "goal-completion-report" };
    const runtime = new Runtime(config(`http://127.0.0.1:${address.port}/v1`), workspace, store);
    const session = store.createSession(workspace, "completion-report");
    writeGoalState(
      store,
      session.session_id,
      completeGoalReflection(
        createGoalState({ objective: "Finish with a report" }),
        { decision: "done", summary: "Pre-run reflection found no remaining frontier.", verification_evidence: { checked: true } },
        "run_pre_reflection",
      ),
    );

    const result = await runtime.run({
      prompt: "finish the active goal",
      session_id: session.session_id,
      onDelta: (text) => streamed.push(text),
      onStatus: (event) => statuses.push(event),
    });

    assert.equal(result.tool_rounds, 1);
    assert.equal(result.tool_calls, 1);
    assert.equal(result.tokens_used, 34);
    assert.match(result.content, /goal finished/);
    assert.match(result.content, /Goal: Finish with a report/);
    assert.doesNotMatch(result.content, /Goal report/);
    assert.match(result.content, /1 loop · 1 tool call/);
    assert.match(streamed.join(""), /Goal: Finish with a report/);
    assert.doesNotMatch(streamed.join(""), /Goal report/);
    assert.ok(statuses.some((event) => event.type === "tool_start" && event.tool_name === "goal" && event.summary === "Completing goal"));
    const goal = readGoalState(store, session.session_id)?.goal;
    assert.equal(goal?.status, "complete");
    assert.equal(goal?.tokens_used, 34);
    assert.equal(goal?.tool_rounds_used, 1);
    assert.equal(goal?.tool_calls_used, 1);
    const events = store.listEvents(session.session_id);
    const report = events.find((event) => event.type === "goal.completion_report");
    assert.equal(report?.data.goal_objective, "Finish with a report");
    assert.equal(report?.data.tool_rounds, goal?.tool_rounds_used);
    assert.equal(report?.data.tool_calls, goal?.tool_calls_used);
    assert.equal(report?.data.tokens, goal?.tokens_used);
    assert.equal(report?.data.duration_ms, goal ? goalDurationMs(goal) : 0);
    assert.match(String(report?.data.report ?? ""), /34 tokens used/);
    assert.equal(report?.data.completion_summary, "Finished the goal.");
    const completed = events.find((event) => event.type === "run.completed");
    assert.equal(completed?.data.tool_rounds, 1);
    assert.equal(completed?.data.tool_calls, 1);
    assert.equal(completed?.data.tokens, 34);
    assert.equal(result.duration_ms, completed?.data.duration_ms);
    const nextPrompt = new PromptBuilder(config(`http://127.0.0.1:${address.port}/v1`), store, workspace).build(
      store.getSession(session.session_id)!,
      "continue after goal completion",
      CORE_TOOL_DEFINITIONS,
    );
    const assistantContext = nextPrompt.messages.filter((message) => message.role === "assistant").map((message) => String(message.content)).join("\n");
    assert.match(assistantContext, /Goal: Finish with a report/);
    assert.doesNotMatch(assistantContext, /Goal report/);
    assert.match(assistantContext, /Summary: Finished the goal\./);
    assert.match(assistantContext, /34 tokens used/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("runtime preserves goal completion report when final response fails", async () => {
  let chatCalls = 0;
  const streamed: string[] = [];
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      chatCalls += 1;
      if (chatCalls === 1) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        writeSse(res, {
          id: "resp_goal_complete_before_failure",
          model: "long-horizon-test",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_goal_complete_before_failure",
                    type: "function",
                    function: { name: "goal", arguments: JSON.stringify({ op: "complete", summary: "Finished before final response.", force: true }) },
                  },
                ],
              },
            },
          ],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9, completion_tokens: 4 } });
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("final response failed");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-report-failed-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_goal_report_failed_run", root: dir, alias: "goal-report-failed-run" };
    const runtime = new Runtime(noRetryConfig(`http://127.0.0.1:${address.port}/v1`), workspace, store);
    const session = store.createSession(workspace, "goal-report-failed-run");
    writeGoalState(
      store,
      session.session_id,
      completeGoalReflection(
        createGoalState({ objective: "Complete before provider failure" }),
        { decision: "done", summary: "Pre-run reflection found no remaining frontier.", verification_evidence: { checked: true } },
        "run_pre_reflection",
      ),
    );

    await assert.rejects(
      () => runtime.run({ prompt: "complete goal then fail", session_id: session.session_id, onDelta: (text) => streamed.push(text) }),
      /final response failed/,
    );

    assert.match(streamed.join(""), /Goal: Complete before provider failure/);
    assert.doesNotMatch(streamed.join(""), /Goal report/);
    assert.match(streamed.join(""), /13 tokens used/);
    const goal = readGoalState(store, session.session_id)?.goal;
    assert.equal(goal?.status, "complete");
    assert.equal(goal?.tokens_used, 13);
    assert.equal(goal?.tool_rounds_used, 1);
    assert.equal(goal?.tool_calls_used, 1);
    const events = store.listEvents(session.session_id);
    assert.equal(events.filter((event) => event.type === "goal.completion_report").length, 1);
    assert.ok(events.some((event) => event.type === "run.failed"));
    const report = events.find((event) => event.type === "goal.completion_report");
    assert.equal(report?.data.goal_objective, "Complete before provider failure");
    assert.equal(report?.data.tool_rounds, goal?.tool_rounds_used);
    assert.equal(report?.data.tool_calls, goal?.tool_calls_used);
    assert.equal(report?.data.tokens, goal?.tokens_used);
    assert.equal(report?.data.duration_ms, goal ? goalDurationMs(goal) : 0);
    assert.equal(report?.data.completion_summary, "Finished before final response.");
    const started = events.filter((event) => event.type === "model.request.started").at(-1);
    const requestFailed = events.find((event) => event.type === "model.request.failed");
    assert.equal(requestFailed?.data.request_class, "interactive");
    assert.equal(requestFailed?.data.prompt_hash, started?.data.prompt_hash);
    assert.equal(requestFailed?.data.tool_schema_hash, started?.data.tool_schema_hash);
    assert.equal(requestFailed?.data.prompt_epoch_id, started?.data.prompt_epoch_id);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

function config(baseUrl: string): VllmAgentConfig {
  const next = structuredClone(DEFAULT_CONFIG);
  next.model_setup.base_url = baseUrl;
  next.model_setup.model = "long-horizon-test";
  return next;
}

function retryConfig(baseUrl: string): VllmAgentConfig {
  const next = config(baseUrl);
  next.model_retry = {
    initial_delay_ms: 1,
    max_delay_ms: 1,
    backoff_factor: 1,
  };
  return next;
}

function timeoutRetryConfig(baseUrl: string): VllmAgentConfig {
  const next = retryConfig(baseUrl);
  next.model_retry = {
    ...next.model_retry,
    request_timeout_ms: 20,
  };
  return next;
}

function noRetryConfig(baseUrl: string): VllmAgentConfig {
  const next = config(baseUrl);
  next.model_retry = {
    max_attempts: 1,
    initial_delay_ms: 1,
    max_delay_ms: 1,
    backoff_factor: 1,
  };
  return next;
}

function serveEndpointSignal(url: string | undefined, res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (chunk?: string) => void }): boolean {
  if (url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "long-horizon-test" }] }));
    return true;
  }
  if (url === "/load") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ waiting: 0, running: 0 }));
    return true;
  }
  if (url === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("vllm:prefix_cache_queries_total 4\nvllm:prefix_cache_hits_total 3\n");
    return true;
  }
  return false;
}

function writeSse(res: { write: (chunk: string) => void }, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
