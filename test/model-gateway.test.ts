import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { normalizeUsage } from "../src/model/endpoint-signals.js";
import { ModelGateway } from "../src/model/gateway.js";
import { buildPromptCacheKey } from "../src/model/prompt-cache.js";
import { CORE_TOOL_DEFINITIONS } from "../src/tools/schemas.js";
import type { ToolDefinition, VllmAgentConfig } from "../src/types.js";

function config(baseUrl: string): VllmAgentConfig {
  const next = structuredClone(DEFAULT_CONFIG);
  next.model_setup.base_url = baseUrl;
  next.model_setup.model = "tool-stream-test";
  return next;
}

function anthropicConfig(baseUrl: string): VllmAgentConfig {
  const next = config(baseUrl);
  next.model_setup.provider = "external";
  next.model_setup.profile = "anthropic";
  next.model_setup.api_key = "test-key";
  return next;
}

test("Codex Responses requests send system prompt as instructions", async () => {
  let requestPath = "";
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    requestPath = req.url ?? "";
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      writeSse(res, {
        type: "response.created",
        response: { id: "resp_codex", model: "gpt-5.4", usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } },
      });
      writeSse(res, { type: "response.output_text.delta", delta: "ok" });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const next = config(`http://127.0.0.1:${address!.port}/backend-api/codex`);
    next.model_setup.provider = "external";
    next.model_setup.provider_id = "openai-codex";
    next.model_setup.profile = "openai_responses";
    next.model_setup.api_key = "codex-token";
    next.model_setup.model = "gpt-5.4";
    const gateway = new ModelGateway(next);
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "openai-codex",
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "ping" },
      ],
      tools: [],
      max_tokens: 16,
      prompt_epoch_id: "pe_cache_epoch",
    });
    assert.equal(response.content, "ok");
    assert.equal(requestPath, "/backend-api/codex/responses");
    assert.equal(requestBody?.instructions, "Be concise.");
    assert.equal(requestBody?.store, false);
    assert.equal(Object.hasOwn(requestBody ?? {}, "prompt_cache_key"), false);
    assert.equal(Object.hasOwn(requestBody ?? {}, "prompt_cache_retention"), false);
    assert.equal(Object.hasOwn(requestBody ?? {}, "temperature"), false);
    assert.equal(Object.hasOwn(requestBody ?? {}, "max_output_tokens"), false);
    const input = requestBody?.input as Array<Record<string, unknown>>;
    assert.equal(input.length, 1);
    assert.equal(input[0]?.role, "user");
  } finally {
    server.close();
  }
});

test("first-party OpenAI Responses requests include extended prompt cache retention", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      writeSse(res, {
        type: "response.created",
        response: { id: "resp_openai", model: "gpt-5.5", usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } },
      });
      writeSse(res, { type: "response.output_text.delta", delta: "ok" });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const next = config(`http://127.0.0.1:${address!.port}`);
    next.model_setup.provider = "external";
    next.model_setup.provider_id = "openai";
    next.model_setup.profile = "openai_responses";
    next.model_setup.api_key = "openai-token";
    next.model_setup.model = "gpt-5.5";
    const gateway = new ModelGateway(next);
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "openai",
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "ping" },
      ],
      tools: [],
      prompt_epoch_id: "pe_openai_cache_epoch",
    });
    assert.equal(response.content, "ok");
    assert.equal(requestBody?.prompt_cache_retention, "24h");
    assert.equal(
      requestBody?.prompt_cache_key,
      buildPromptCacheKey({ provider_id: "openai", model: "gpt-5.5", session_id: "s", prompt_epoch_id: "pe_openai_cache_epoch" }),
    );
  } finally {
    server.close();
  }
});

test("OpenAI Responses preserves debug diagnostics for empty successful streams", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-request-id": "req_empty_debug",
    });
    writeSse(res, {
      type: "response.completed",
      response: {
        id: "resp_empty_debug",
        model: "gpt-5.5",
        status: "completed",
        usage: { input_tokens: 270_000, output_tokens: 0, total_tokens: 270_000 },
        output: [],
      },
    });
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const next = config(`http://127.0.0.1:${address!.port}`);
    next.model_setup.provider = "external";
    next.model_setup.provider_id = "openai";
    next.model_setup.profile = "openai_responses";
    next.model_setup.api_key = "openai-token";
    next.model_setup.model = "gpt-5.5";
    const gateway = new ModelGateway(next);
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "ping" }],
      tools: [],
      prompt_epoch_id: "pe_empty_debug",
    });

    assert.equal(response.http_status, 200);
    assert.equal(response.content, "");
    assert.deepEqual(response.tool_calls, []);
    assert.equal(response.diagnostics?.http_status, 200);
    assert.equal(response.diagnostics?.response_status, "completed");
    assert.deepEqual(response.diagnostics?.stream_event_types, { "response.completed": 1 });
    assert.equal((response.diagnostics?.terminal_raw_event as Record<string, unknown> | undefined)?.type, "response.completed");
    assert.equal((response.raw as Record<string, unknown> | undefined)?.type, "response.completed");
  } finally {
    server.close();
  }
});

test("OpenAI Responses turns incomplete streams into diagnostic errors", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    writeSse(res, {
      type: "response.incomplete",
      response: {
        id: "resp_incomplete_debug",
        model: "gpt-5.5",
        status: "incomplete",
        incomplete_details: { reason: "max_prompt_tokens" },
        usage: { input_tokens: 274_000, output_tokens: 0, total_tokens: 274_000 },
      },
    });
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const next = config(`http://127.0.0.1:${address!.port}`);
    next.model_setup.provider = "external";
    next.model_setup.provider_id = "openai";
    next.model_setup.profile = "openai_responses";
    next.model_setup.api_key = "openai-token";
    next.model_setup.model = "gpt-5.5";
    const gateway = new ModelGateway(next);
    let caught: unknown;
    try {
      await gateway.stream({
        session_id: "s",
        run_id: "r",
        mode: "direct",
        provider_id: "openai",
        model: "gpt-5.5",
        messages: [{ role: "user", content: "ping" }],
        tools: [],
        prompt_epoch_id: "pe_incomplete_debug",
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Error);
    assert.match(caught.message, /Responses stream ended with response\.incomplete/);
    const diagnostics = (caught as { diagnostics?: Record<string, unknown> }).diagnostics;
    assert.equal(diagnostics?.http_status, 200);
    assert.equal(diagnostics?.response_status, "incomplete");
    assert.deepEqual(diagnostics?.incomplete_details, { reason: "max_prompt_tokens" });
    assert.equal((diagnostics?.abnormal_raw_event as Record<string, unknown> | undefined)?.type, "response.incomplete");
  } finally {
    server.close();
  }
});

test("Copilot Claude models use Anthropic Messages with Copilot bearer auth", async () => {
  let requestPath = "";
  let authorization = "";
  let anthropicVersion = "";
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    requestPath = req.url ?? "";
    authorization = String(req.headers.authorization ?? "");
    anthropicVersion = String(req.headers["anthropic-version"] ?? "");
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      if (requestPath === "/v1/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_copilot_claude",
            model: "claude-sonnet-4.6",
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 4, output_tokens: 1 },
          }),
        );
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      writeSse(res, { id: "wrong_route", model: "claude-sonnet-4.6", choices: [{ delta: { content: "wrong" } }] });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const next = config(`http://127.0.0.1:${address!.port}`);
    next.model_setup.provider = "external";
    next.model_setup.provider_id = "copilot";
    next.model_setup.profile = "openai_compatible";
    next.model_setup.api_key = "copilot-token";
    next.model_setup.model = "claude-sonnet-4.6";
    const gateway = new ModelGateway(next);
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "copilot",
      model: "claude-sonnet-4.6",
      messages: [
        { role: "system", content: "System prompt." },
        { role: "user", content: "ping" },
      ],
      tools: [],
    });
    assert.equal(response.content, "ok");
    assert.equal(requestPath, "/v1/messages");
    assert.equal(authorization, "Bearer copilot-token");
    assert.equal(anthropicVersion, "2023-06-01");
    assert.equal(requestBody?.system, "System prompt.");
  } finally {
    server.close();
  }
});

test("Copilot GPT-5 models use Responses payload shape", async () => {
  let requestPath = "";
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    requestPath = req.url ?? "";
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      if (requestPath === "/responses") {
        writeSse(res, {
          type: "response.created",
          response: { id: "resp_copilot_gpt", model: "gpt-5.4", usage: { input_tokens: 4, output_tokens: 1 } },
        });
        writeSse(res, { type: "response.output_text.delta", delta: "ok" });
      } else {
        writeSse(res, { id: "wrong_route", model: "gpt-5.4", choices: [{ delta: { content: "wrong" } }] });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const next = config(`http://127.0.0.1:${address!.port}`);
    next.model_setup.provider = "external";
    next.model_setup.provider_id = "copilot";
    next.model_setup.profile = "openai_compatible";
    next.model_setup.api_key = "copilot-token";
    next.model_setup.model = "gpt-5.4";
    const gateway = new ModelGateway(next);
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "copilot",
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "System prompt." },
        { role: "user", content: "ping" },
      ],
      tools: [],
      prompt_epoch_id: "pe_copilot_cache_epoch",
    });
    assert.equal(response.content, "ok");
    assert.equal(requestPath, "/responses");
    assert.equal(requestBody?.instructions, "System prompt.");
    assert.equal(Object.hasOwn(requestBody ?? {}, "prompt_cache_key"), false);
    assert.equal(Object.hasOwn(requestBody ?? {}, "prompt_cache_retention"), false);
  } finally {
    server.close();
  }
});

test("OpenAI-compatible streaming tool calls survive chunks without index fields", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    writeSse(res, {
      id: "resp_tool",
      model: "tool-stream-test",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "list_dir", arguments: "{\"path\":\"" },
              },
            ],
          },
        },
      ],
    });
    writeSse(res, { choices: [{ delta: { tool_calls: [{ function: { name: "", arguments: "." } }] } }] });
    writeSse(res, { choices: [{ delta: { tool_calls: [{ function: { name: "", arguments: "\"}" } }] } }] });
    writeSse(res, {
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, prompt_tokens_details: { cached_tokens: 8 } },
    });
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway(config(`http://127.0.0.1:${address!.port}/v1`));
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "vllm:test",
      model: "tool-stream-test",
      messages: [{ role: "user", content: "list files" }],
      tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.name === "list_dir"),
    });
    assert.equal(response.tool_calls.length, 1);
    assert.equal(response.tool_calls[0]?.id, "call_1");
    assert.equal(response.tool_calls[0]?.name, "list_dir");
    assert.deepEqual(response.tool_calls[0]?.arguments, { path: "." });
    assert.equal(response.usage?.cached_prompt_tokens, 8);
  } finally {
    server.close();
  }
});

test("OpenAI-compatible requests serialize assistant tool-call arguments stably", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      writeSse(res, { id: "resp_stable_args", model: "tool-stream-test", choices: [{ delta: { content: "ok" } }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway(config(`http://127.0.0.1:${address!.port}/v1`));
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "vllm:test",
      model: "tool-stream-test",
      messages: [
        { role: "user", content: "continue" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", name: "demo_tool", arguments: { z: 2, a: 1, nested: { b: 2, a: 1 } } }],
        },
      ],
      tools: [],
    });
    assert.equal(response.content, "ok");
    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    const assistant = messages[1]!;
    const toolCalls = assistant.tool_calls as Array<Record<string, unknown>>;
    const fn = toolCalls[0]!.function as Record<string, unknown>;
    assert.equal(fn.arguments, '{"a":1,"nested":{"a":1,"b":2},"z":2}');
  } finally {
    server.close();
  }
});

test("OpenAI-compatible requests omit empty assistant tool call arrays", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      writeSse(res, { id: "resp_empty_calls", model: "tool-stream-test", choices: [{ delta: { content: "ok" } }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway(config(`http://127.0.0.1:${address!.port}/v1`));
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "vllm:test",
      model: "tool-stream-test",
      messages: [
        { role: "user", content: "continue" },
        { role: "assistant", content: "no tools here", tool_calls: [] },
      ],
      tools: [],
    });
    assert.equal(response.content, "ok");
    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    assert.equal(Object.hasOwn(messages[1]!, "tool_calls"), false);
  } finally {
    server.close();
  }
});

test("OpenAI-compatible requests send tool schemas in deterministic name order", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      writeSse(res, { id: "resp_stable_tools", model: "tool-stream-test", choices: [{ delta: { content: "ok" } }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway(config(`http://127.0.0.1:${address!.port}/v1`));
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "vllm:test",
      model: "tool-stream-test",
      messages: [{ role: "user", content: "continue" }],
      tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.name === "read_file" || tool.name === "list_dir").reverse(),
    });
    assert.equal(response.content, "ok");
    const tools = requestBody?.tools as Array<{ function?: { name?: string } }>;
    assert.deepEqual(tools.map((tool) => tool.function?.name), ["list_dir", "read_file"]);
  } finally {
    server.close();
  }
});

test("OpenAI-compatible requests serialize tool parameters stably", async () => {
  let rawRequestBody = "";
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      rawRequestBody = body;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      writeSse(res, { id: "resp_stable_schema", model: "tool-stream-test", choices: [{ delta: { content: "ok" } }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway(config(`http://127.0.0.1:${address!.port}/v1`));
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "vllm:test",
      model: "tool-stream-test",
      messages: [{ role: "user", content: "continue" }],
      tools: [unorderedSchemaTool()],
    });
    assert.equal(response.content, "ok");
    assert.match(
      rawRequestBody,
      /"parameters":\{"properties":\{"a":\{"properties":\{"a":\{"type":"string"\},"b":\{"type":"string"\}\},"type":"object"\},"z":\{"type":"string"\}\},"required":\["z","a"\],"type":"object"\}/,
    );
  } finally {
    server.close();
  }
});

test("OpenAI-compatible requests serialize array message content stably without changing shape", async () => {
  let rawRequestBody = "";
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      rawRequestBody = body;
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      writeSse(res, { id: "resp_stable_content", model: "tool-stream-test", choices: [{ delta: { content: "ok" } }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway(config(`http://127.0.0.1:${address!.port}/v1`));
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "vllm:test",
      model: "tool-stream-test",
      messages: [{ role: "user", content: [{ z: 2, a: 1, nested: { b: 2, a: 1 } }] }],
      tools: [],
    });
    assert.equal(response.content, "ok");
    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(messages[0]?.content));
    assert.match(rawRequestBody, /"content":\[\{"a":1,"nested":\{"a":1,"b":2\},"z":2\}\]/);
  } finally {
    server.close();
  }
});

test("Anthropic requests serialize structured message content stably", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1", model: "tool-stream-test", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 4, output_tokens: 1 } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway(anthropicConfig(`http://127.0.0.1:${address!.port}/v1`));
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "anthropic:test",
      model: "tool-stream-test",
      messages: [{ role: "user", content: [{ z: 2, a: 1, nested: { b: 2, a: 1 } }] }],
      tools: [],
    });
    assert.equal(response.content, "ok");
    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.content, '[{"a":1,"nested":{"a":1,"b":2},"z":2}]');
  } finally {
    server.close();
  }
});

test("Anthropic requests send tool schemas in deterministic name order", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1", model: "tool-stream-test", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 4, output_tokens: 1 } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway(anthropicConfig(`http://127.0.0.1:${address!.port}/v1`));
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "anthropic:test",
      model: "tool-stream-test",
      messages: [{ role: "user", content: "continue" }],
      tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.name === "read_file" || tool.name === "list_dir").reverse(),
    });
    assert.equal(response.content, "ok");
    const tools = requestBody?.tools as Array<{ name?: string }>;
    assert.deepEqual(tools.map((tool) => tool.name), ["list_dir", "read_file"]);
  } finally {
    server.close();
  }
});

test("Anthropic requests serialize tool parameters stably", async () => {
  let rawRequestBody = "";
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      rawRequestBody = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1", model: "tool-stream-test", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 4, output_tokens: 1 } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway(anthropicConfig(`http://127.0.0.1:${address!.port}/v1`));
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "anthropic:test",
      model: "tool-stream-test",
      messages: [{ role: "user", content: "continue" }],
      tools: [unorderedSchemaTool()],
    });
    assert.equal(response.content, "ok");
    assert.match(
      rawRequestBody,
      /"input_schema":\{"properties":\{"a":\{"properties":\{"a":\{"type":"string"\},"b":\{"type":"string"\}\},"type":"object"\},"z":\{"type":"string"\}\},"required":\["z","a"\],"type":"object"\}/,
    );
  } finally {
    server.close();
  }
});

test("OpenAI-compatible streaming tolerates malformed SSE chunks and final message tool calls", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write("data: not-json\n\n");
    writeSse(res, {
      id: "resp_message_tool",
      model: "tool-stream-test",
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_final",
                type: "function",
                function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 1, prompt_tokens_cached: 12 },
    });
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway(config(`http://127.0.0.1:${address!.port}/v1`));
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "vllm:test",
      model: "tool-stream-test",
      messages: [{ role: "user", content: "read file" }],
      tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.name === "read_file"),
    });
    assert.equal(response.tool_calls.length, 1);
    assert.equal(response.tool_calls[0]?.id, "call_final");
    assert.equal(response.tool_calls[0]?.name, "read_file");
    assert.deepEqual(response.tool_calls[0]?.arguments, { path: "README.md" });
    assert.equal(response.usage?.cached_prompt_tokens, 12);
    assert.ok(Array.isArray(response.raw?.stream_warnings));
  } finally {
    server.close();
  }
});

test("OpenAI-compatible streaming supports legacy function_call chunks", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    writeSse(res, {
      id: "resp_legacy_tool",
      model: "tool-stream-test",
      choices: [{ delta: { function_call: { name: "glob", arguments: "{\"pattern\":\"" } } }],
    });
    writeSse(res, { choices: [{ delta: { function_call: { arguments: "*.ts\"}" } } }] });
    writeSse(res, { choices: [{ delta: {}, finish_reason: "function_call" }], usage: { prompt_tokens: 7, completion_tokens: 1 } });
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway(config(`http://127.0.0.1:${address!.port}/v1`));
    const response = await gateway.stream({
      session_id: "s",
      run_id: "r",
      mode: "direct",
      provider_id: "vllm:test",
      model: "tool-stream-test",
      messages: [{ role: "user", content: "scan files" }],
      tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.name === "glob"),
    });
    assert.equal(response.tool_calls.length, 1);
    assert.equal(response.tool_calls[0]?.id, "function_call_0");
    assert.equal(response.tool_calls[0]?.name, "glob");
    assert.deepEqual(response.tool_calls[0]?.arguments, { pattern: "*.ts" });
  } finally {
    server.close();
  }
});

test("usage parser recognizes common cached-token evidence fields", () => {
  assert.equal(normalizeUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_cached: 80 })?.cached_prompt_tokens, 80);
  assert.equal(normalizeUsage({ input_tokens: 200, output_tokens: 10, cached_prompt_tokens: 150 })?.cached_prompt_tokens, 150);
  assert.equal(normalizeUsage({ input_tokens: 200, input_tokens_details: { cached_tokens: 160 } })?.cached_prompt_tokens, 160);
});

function unorderedSchemaTool(): ToolDefinition {
  return {
    name: "schema_probe",
    description: "Exercise deterministic schema serialization.",
    permission: "read",
    parameters: {
      type: "object",
      properties: {
        z: { type: "string" },
        a: {
          type: "object",
          properties: {
            b: { type: "string" },
            a: { type: "string" },
          },
        },
      },
      required: ["z", "a"],
    },
  };
}

function writeSse(res: { write: (chunk: string) => void }, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
