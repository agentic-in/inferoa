import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { Runtime, type RuntimeStatusEvent } from "../src/runtime.js";
import { SessionStore } from "../src/session/store.js";
import { completeGoalReflection, createGoalState, markGoalReflectionStarted, readGoalState, replaceGoalPlanning, writeGoalState } from "../src/goals/state.js";
import { readGoalLoopView } from "../src/loop/projection.js";
import type { VllmAgentConfig, WorkspaceIdentity } from "../src/types.js";

test("runtime records first-class model step ids across model and tool events", async () => {
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
          id: "resp_step_1",
          model: "long-horizon-test",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_step_1",
                    type: "function",
                    function: { name: "read_file", arguments: JSON.stringify({ path: "missing-step-file.txt" }) },
                  },
                ],
              },
            },
          ],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 11, completion_tokens: 2 } });
      } else {
        writeSse(res, { id: "resp_step_2", model: "long-horizon-test", choices: [{ delta: { content: "step trace complete" } }] });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 13, completion_tokens: 3 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-step-trace-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_step_trace", root: dir, alias: "step-trace" };
    const runtime = new Runtime(config(`http://127.0.0.1:${address.port}/v1`), workspace, store);

    const result = await runtime.run({ prompt: "record model step boundaries" });

    assert.equal(result.content, "step trace complete");
    const events = store.listEvents(result.session.session_id);
    const requests = events.filter((event) => event.type === "model.request.started");
    const responses = events.filter((event) => event.type === "model.response.settled");
    assert.equal(requests.length, 2);
    assert.equal(responses.length, 2);
    assert.equal(requests[0]?.data.step_index, 1);
    assert.equal(requests[1]?.data.step_index, 2);
    assert.equal(typeof requests[0]?.data.step_id, "string");
    assert.equal(typeof requests[1]?.data.step_id, "string");
    assert.notEqual(requests[0]?.data.step_id, requests[1]?.data.step_id);
    assert.equal(responses[0]?.data.step_id, requests[0]?.data.step_id);
    assert.equal(responses[1]?.data.step_id, requests[1]?.data.step_id);
    const toolCall = events.find((event) => event.type === "tool.call" && event.data.tool_call_id === "call_step_1");
    const toolResult = events.find((event) => event.type === "tool.result" && event.data.tool_call_id === "call_step_1");
    assert.equal(toolCall?.data.step_id, requests[0]?.data.step_id);
    assert.equal(toolCall?.data.step_index, 1);
    assert.equal(toolResult?.data.step_id, requests[0]?.data.step_id);
    assert.equal(toolResult?.data.step_index, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

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

test("runtime keeps tool schema stable across interactive and reflection request classes", async () => {
  let chatCalls = 0;
  const requestBodies: Array<{ tools?: Array<{ function?: { name?: string } }> }> = [];
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
      chatCalls += 1;
      requestBodies.push(JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeSse(res, {
        id: `resp_schema_${chatCalls}`,
        model: "long-horizon-test",
        choices: [{ delta: { content: chatCalls === 1 ? "interactive" : "reflection" } }],
      });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20 + chatCalls, completion_tokens: 1 } });
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-request-class-schema-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_request_class_schema", root: dir, alias: "request-class-schema" };
    const runtime = new Runtime(config(`http://127.0.0.1:${address.port}/v1`), workspace, store);
    const session = store.createSession(workspace, "request-class-schema");

    await runtime.run({ prompt: "normal turn", session_id: session.session_id });
    await runtime.run({
      prompt: "internal reflection turn",
      session_id: session.session_id,
      request_class: "reflection",
      visibility: "internal",
    });

    assert.equal(requestBodies.length, 2);
    const namesByRequest = requestBodies.map((body) => ((body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean)).sort());
    assert.deepEqual(namesByRequest[1], namesByRequest[0]);
    assert.ok(namesByRequest[0]?.includes("subagent"));

    const started = store.listEvents(session.session_id).filter((event) => event.type === "model.request.started");
    assert.equal(started.length, 2);
    assert.equal(started[0]?.data.tool_schema_hash, started[1]?.data.tool_schema_hash);
    assert.equal(started[0]?.data.prompt_epoch_id, started[1]?.data.prompt_epoch_id);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("runtime freezes session prompt surface across mode and config changes until compaction", async () => {
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
      chatCalls += 1;
      requestBodies.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeSse(res, { id: `resp_frozen_surface_${chatCalls}`, model: "long-horizon-test", choices: [{ delta: { content: `turn ${chatCalls}` } }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30 + chatCalls, completion_tokens: 1 } });
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-session-prompt-freeze-"));
  const previousStateDir = process.env.INFEROA_STATE_DIR;
  process.env.INFEROA_STATE_DIR = path.join(dir, "user-state");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const runtimeConfig = config(`http://127.0.0.1:${address.port}/v1`);
    runtimeConfig.omni.enabled = false;
    runtimeConfig.skills.enabled = [];
    const workspace: WorkspaceIdentity = { id: "w_session_prompt_freeze", root: dir, alias: "session-prompt-freeze" };
    const runtime = new Runtime(runtimeConfig, workspace, store);
    const session = store.createSession(workspace, "session prompt freeze");

    await runtime.run({ prompt: "first prompt freezes session surface", session_id: session.session_id });

    const skillDir = path.join(dir, ".inferoa", "skills", "late");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: Late Skill\ndescription: Should not enter frozen system prompt.\n---\n\nLate body.", "utf8");
    runtimeConfig.omni.enabled = true;
    runtimeConfig.omni.endpoints.image_generation = { base_url: "http://localhost:8001/v1", model: "image-model" };
    runtimeConfig.skills.enabled = ["late-skill"];
    runtimeConfig.permissions.mode = "ask";
    writeGoalState(store, session.session_id, createGoalState({ objective: "Goal state must stay in tail" }), "run_goal_state");

    await runtime.run({
      prompt: "reflection after config and goal changes",
      session_id: session.session_id,
      request_class: "reflection",
      visibility: "internal",
    });

    const eventsBeforeCompaction = store.listEvents(session.session_id);
    store.appendEvent({
      session_id: session.session_id,
      type: "context.compacted",
      data: {
        reason: "test-compaction",
        summary: "Compaction is the only allowed system prompt mutation.",
        compacted_through_event_id: eventsBeforeCompaction.at(-1)?.id ?? 0,
      },
    });
    await runtime.run({ prompt: "after compaction", session_id: session.session_id });

    assert.equal(requestBodies.length, 3);
    const toolNames = requestBodies.map((body) =>
      (((body.tools as Array<{ function?: { name?: string } }> | undefined) ?? []).map((tool) => tool.function?.name).filter(Boolean)).sort(),
    );
    assert.deepEqual(toolNames[1], toolNames[0]);
    assert.deepEqual(toolNames[2], toolNames[0]);
    assert.equal(toolNames[0]?.includes("image_generation"), false);

    const systemPrompts = requestBodies.map((body) => {
      const messages = (body.messages as Array<{ role?: string; content?: string }> | undefined) ?? [];
      return String(messages.find((message) => message.role === "system")?.content ?? "");
    });
    assert.equal(systemPrompts[1], systemPrompts[0]);
    assert.doesNotMatch(systemPrompts[1] ?? "", /Late Skill|image_generation/);
    assert.notEqual(systemPrompts[2], systemPrompts[0]);
    assert.match(systemPrompts[2] ?? "", /<epoch\.memory>/);

    const started = store.listEvents(session.session_id).filter((event) => event.type === "model.request.started");
    assert.equal(started.length, 3);
    assert.equal(started[0]?.data.tool_schema_hash, started[1]?.data.tool_schema_hash);
    assert.equal(started[0]?.data.prompt_epoch_id, started[1]?.data.prompt_epoch_id);
    assert.equal(started[0]?.data.tool_schema_hash, started[2]?.data.tool_schema_hash);
    assert.notEqual(started[0]?.data.prompt_epoch_id, started[2]?.data.prompt_epoch_id);
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

test("runtime appends tool-loop prompt changes without rewriting the previous prefix", async () => {
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
      chatCalls += 1;
      requestBodies.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (chatCalls === 1) {
        writeSse(res, {
          id: "resp_prefix_first",
          model: "long-horizon-test",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_prefix_read",
                    type: "function",
                    function: { name: "read_file", arguments: JSON.stringify({ path: "missing-prefix-file.txt" }) },
                  },
                ],
              },
            },
          ],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 41, completion_tokens: 2 } });
      } else {
        writeSse(res, { id: "resp_prefix_second", model: "long-horizon-test", choices: [{ delta: { content: "prefix preserved" } }] });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 42, completion_tokens: 2 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-append-only-prefix-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_append_only_prefix", root: dir, alias: "append-only-prefix" };
    const runtime = new Runtime(config(`http://127.0.0.1:${address.port}/v1`), workspace, store);
    const session = store.createSession(workspace, "append-only-prefix");
    writeGoalState(store, session.session_id, createGoalState({ objective: "Keep goal mode fixed before user prompt" }), "run_goal_state");

    const result = await runtime.run({ prompt: "use one tool then finish", session_id: session.session_id });

    assert.equal(result.content, "prefix preserved");
    assert.equal(requestBodies.length, 2);
    const firstMessages = ((requestBodies[0]?.messages as unknown[]) ?? []).map((message) => JSON.stringify(message));
    const secondMessages = ((requestBodies[1]?.messages as unknown[]) ?? []).map((message) => JSON.stringify(message));
    assert.deepEqual(secondMessages.slice(0, firstMessages.length), firstMessages);
    assert.ok(secondMessages.length > firstMessages.length);
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

test("goal runs record enabled skill snapshots in the loop view", async () => {
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeSse(res, { id: "resp_skill_snapshot", model: "long-horizon-test", choices: [{ delta: { content: "goal used enabled skill" } }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 3 } });
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-skill-snapshot-"));
  const previousStateDir = process.env.INFEROA_STATE_DIR;
  process.env.INFEROA_STATE_DIR = path.join(dir, "user-state");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const skillDir = path.join(dir, ".inferoa", "skills", "demo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: Demo Skill\ndescription: Demonstrates auditable skill policy.\n---\n\nUse this when the goal asks for demo policy.\n",
      "utf8",
    );
    const runtimeConfig = config(`http://127.0.0.1:${address.port}/v1`);
    runtimeConfig.skills.enabled = ["demo-skill"];
    const workspace: WorkspaceIdentity = { id: "w_goal_skill_snapshot", root: dir, alias: "goal-skill-snapshot" };
    const runtime = new Runtime(runtimeConfig, workspace, store);
    const session = store.createSession(workspace, "goal skill snapshot");
    const goal = createGoalState({ objective: "Audit skill policy" });
    writeGoalState(store, session.session_id, goal, "run_goal");

    const result = await runtime.run({ prompt: "use the enabled demo skill", session_id: session.session_id });

    assert.equal(result.content, "goal used enabled skill");
    const snapshotEvent = store.listEvents(session.session_id).find((event) => event.type === "skill.snapshot.created");
    assert.equal(snapshotEvent?.data.goal_id, goal.goal.id);
    assert.equal(snapshotEvent?.data.skill_count, 1);
    assert.equal(Array.isArray(snapshotEvent?.data.skills), true);
    const view = readGoalLoopView(store, session.session_id);
    assert.equal(view.skill_snapshots.length, 1);
    assert.equal(view.skill_snapshots[0]?.skills[0]?.id, "demo-skill");
    assert.match(view.skill_snapshots[0]?.skills[0]?.body_hash ?? "", /^[a-f0-9]{64}$/);
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

test("runtime yields after visible work exhausts the active goal horizon", async () => {
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
          id: "resp_finish_horizon",
          model: "long-horizon-test",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_finish_horizon",
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

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-horizon-yield-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_goal_horizon_yield", root: dir, alias: "goal-horizon-yield" };
    const runtime = new Runtime(config(`http://127.0.0.1:${address.port}/v1`), workspace, store);
    const session = store.createSession(workspace, "horizon-yield");
    const goal = replaceGoalPlanning(createGoalState({ objective: "Finish visible horizon then reflection" }), {
      steps: [{ id: "final", title: "Final visible horizon", status: "in_progress" }],
    });
    writeGoalState(store, session.session_id, goal);

    const result = await runtime.run({ prompt: "finish the visible horizon", session_id: session.session_id });

    assert.equal(chatCalls, 1);
    assert.equal(result.tool_rounds, 1);
    assert.equal(result.tool_calls, 1);
    const current = readGoalState(store, session.session_id)?.goal;
    assert.equal(current?.status, "active");
    assert.equal(current?.last_reflection_decision, undefined);
    assert.equal(current?.planning?.steps[0]?.status, "completed");
    const events = store.listEvents(session.session_id);
    assert.equal(events.filter((event) => event.type === "model.request.started").length, 1);
    assert.ok(events.some((event) => event.type === "goal.horizon.exhausted" && event.run_id === result.run_id));
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
                        summary: "No remaining horizon.",
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
      steps: [{ id: "final", title: "Final horizon", status: "completed" }],
    });
    writeGoalState(store, session.session_id, markGoalReflectionStarted(goal, reflectionRunId), reflectionRunId);

    const result = await runtime.run({
      prompt: "reflect on the completed horizon",
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

test("runtime rejects model-facing loop completion control-plane calls", async () => {
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
          id: "resp_complete_goal",
          model: "long-horizon-test",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_goal_complete",
                    type: "function",
                    function: { name: "goal", arguments: JSON.stringify({ op: "complete", summary: "Finished the goal." }) },
                  },
                ],
              },
            },
          ],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 11, completion_tokens: 2 } });
      } else {
        writeSse(res, { id: "resp_final_goal", model: "long-horizon-test", choices: [{ delta: { content: "loop still active" } }] });
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
        replaceGoalPlanning(createGoalState({ objective: "Finish with a report" }), {
          steps: [{ id: "done", title: "Validated completion evidence", status: "completed" }],
        }),
        { decision: "done", summary: "Pre-run reflection found no remaining horizon.", verification_evidence: { checked: true } },
        "run_pre_reflection",
      ),
    );

    const result = await runtime.run({
      prompt: "finish the active goal",
      session_id: session.session_id,
    });

    assert.equal(chatCalls, 1);
    assert.equal(result.tool_rounds, 1);
    assert.equal(result.tool_calls, 1);
    assert.equal(result.content, "");
    const goal = readGoalState(store, session.session_id)?.goal;
    assert.equal(goal?.status, "active");
    const events = store.listEvents(session.session_id);
    const toolResult = events.find((event) => event.type === "tool.result" && event.data.tool_call_id === "call_goal_complete");
    assert.equal((toolResult?.data.result as { error?: { code?: string } } | undefined)?.error?.code, "invalid_tool_arguments");
    assert.equal(events.some((event) => event.type === "goal.completion_report"), false);
    const completed = events.find((event) => event.type === "run.completed");
    assert.equal(completed?.data.tool_rounds, 1);
    assert.equal(completed?.data.tool_calls, 1);
    assert.equal(result.duration_ms, completed?.data.duration_ms);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

test("runtime yields after rejected model-facing completion before a follow-up provider call", async () => {
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
                    function: { name: "goal", arguments: JSON.stringify({ op: "complete", summary: "Finished before final response." }) },
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
        replaceGoalPlanning(createGoalState({ objective: "Complete before provider failure" }), {
          steps: [{ id: "done", title: "Validated completion evidence", status: "completed" }],
        }),
        { decision: "done", summary: "Pre-run reflection found no remaining horizon.", verification_evidence: { checked: true } },
        "run_pre_reflection",
      ),
    );

    const result = await runtime.run({ prompt: "complete goal then fail", session_id: session.session_id, onDelta: (text) => streamed.push(text) });

    assert.equal(chatCalls, 1);
    assert.equal(result.tool_rounds, 1);
    assert.equal(result.tool_calls, 1);
    assert.equal(result.content, "");
    assert.equal(streamed.join(""), "");
    const goal = readGoalState(store, session.session_id)?.goal;
    assert.equal(goal?.status, "active");
    const events = store.listEvents(session.session_id);
    assert.equal(events.filter((event) => event.type === "goal.completion_report").length, 0);
    assert.equal(events.some((event) => event.type === "run.failed"), false);
    assert.ok(events.some((event) => event.type === "run.completed"));
    const toolResult = events.find((event) => event.type === "tool.result" && event.data.tool_call_id === "call_goal_complete_before_failure");
    assert.equal((toolResult?.data.result as { error?: { code?: string } } | undefined)?.error?.code, "invalid_tool_arguments");
    assert.equal(events.filter((event) => event.type === "model.request.started").length, 1);
    assert.equal(events.some((event) => event.type === "model.request.failed"), false);
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
