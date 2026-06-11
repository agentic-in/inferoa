import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { ContextCompressor } from "../src/context/compressor.js";
import { PromptBuilder } from "../src/context/prompt.js";
import type { PromptContext } from "../src/context/prompt.js";
import { Runtime, type RuntimeStatusEvent } from "../src/runtime.js";
import { SessionStore } from "../src/session/store.js";
import { CORE_TOOL_DEFINITIONS } from "../src/tools/schemas.js";
import { hashJson } from "../src/util/hash.js";
import type { VllmAgentConfig, WorkspaceIdentity } from "../src/types.js";

test("context compression ignores history length at very low token pressure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-compress-low-pressure-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.context.force_compression = false;
    config.context.compression_threshold = 0.8;
    config.context.context_window = 1_024_000;
    config.model_setup.context_window = 1_024_000;
    const workspace: WorkspaceIdentity = { id: "w_low_pressure", root: dir, alias: "low-pressure" };
    const compressor = new ContextCompressor(config, store, workspace, undefined as never);
    const decision = await compressor.assess({
      estimated_tokens: 11_807,
      threshold_tokens: 819_200,
      recent_event_count: 72,
      compactable_event_count: 55,
    } as unknown as PromptContext);

    assert.equal(decision.should_compact, false);
    assert.equal(decision.reason, "below-threshold");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime surfaces context compression and continues after compacting", async () => {
  const serverCalls: { request_class?: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "compression-test" }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/load") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ waiting: 0, running: 0 }));
      return;
    }
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("vllm:prefix_cache_queries_total 2\nvllm:prefix_cache_hits_total 1\n");
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const requestClass = typeof req.headers["x-inferoa-request-class"] === "string" ? req.headers["x-inferoa-request-class"] : undefined;
      serverCalls.push({ request_class: requestClass, body: JSON.parse(body) as unknown });
      const content = requestClass === "compaction" ? "Goal\n- Preserve context across compression." : "continued after compression";
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-request-id": `req_${serverCalls.length}`,
      });
      writeSse(res, {
        id: `resp_${serverCalls.length}`,
        model: "compression-test",
        choices: [{ delta: { content } }],
      });
      writeSse(res, {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 256,
          completion_tokens: 8,
          total_tokens: 264,
          prompt_tokens_details: { cached_tokens: 128 },
        },
      });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-compress-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const config = compressionConfig(`http://127.0.0.1:${address.port}/v1`);
    const workspace: WorkspaceIdentity = { id: "w_compress", root: dir, alias: "compress" };
    const session = store.createSession(workspace, "compress");
    for (let index = 0; index < 18; index += 1) {
      store.appendEvent({
        session_id: session.session_id,
        type: "tool.result",
        data: {
          tool_name: "read_file",
          tool_call_id: `seed_${index}`,
          result: { ok: true, path: `seed-${index}.ts`, lines: [`line ${index}`] },
        },
      });
    }

    const statuses: RuntimeStatusEvent[] = [];
    const runtime = new Runtime(config, workspace, store);
    const result = await runtime.run({
      session_id: session.session_id,
      prompt: "continue after compression",
      onStatus: (event) => statuses.push(event),
    });

    assert.equal(result.content, "continued after compression");
    assert.ok(statuses.some((event) => event.type === "compression_start"));
    const compressionEnd = statuses.find((event) => event.type === "compression_end");
    assert.ok(compressionEnd);
    assert.ok(compressionEnd.archived_events > 0);
    assert.ok(compressionEnd.protected_tail_events > 0);
    assert.match(compressionEnd.summary, /Preserve context/);
    assert.equal(serverCalls[0]?.request_class, "compaction");
    assert.equal(serverCalls[1]?.request_class, "interactive");
    assert.equal((serverCalls[0]?.body as { cache_salt?: unknown } | undefined)?.cache_salt, (serverCalls[1]?.body as { cache_salt?: unknown } | undefined)?.cache_salt);
    assert.match(String((serverCalls[0]?.body as { cache_salt?: unknown } | undefined)?.cache_salt ?? ""), /^cs_/);
    assert.equal("max_tokens" in ((serverCalls[0]?.body as Record<string, unknown> | undefined) ?? {}), false);
    assert.match(JSON.stringify((serverCalls[0]?.body as { messages?: unknown[] } | undefined)?.messages?.at(-1) ?? ""), /Compress wording, not facts/);

    const events = store.listEvents(session.session_id);
    const compactionBody = serverCalls[0]?.body as { messages?: unknown[] } | undefined;
    const compactionEvidence = events.find((event) => event.type === "endpoint.evidence.recorded" && event.data.request_id === "req_1");
    const expectedCompactionPromptHash = hashJson({
      messages: compactionBody?.messages ?? [],
      tool_schema_hash: compactionEvidence?.data.tool_schema_hash,
    });
    assert.equal(compactionEvidence?.data.prompt_hash, expectedCompactionPromptHash);
    assert.equal(compactionEvidence?.data.request_class, "compaction");
    assert.match(String(compactionEvidence?.data.prompt_epoch_id ?? ""), /^pe_/);
    const compactedIndex = events.findIndex((event) => event.type === "context.compacted");
    assert.ok(compactedIndex >= 0);
    const compacted = events[compactedIndex];
    const archiveUri = compacted?.data.archive_resource_uri;
    const archiveEvent = events.find((event) => event.type === "resource.created" && event.data.uri === archiveUri);
    assert.ok(archiveEvent);
    assert.ok(compactionEvidence);
    assert.ok(Number(compacted?.data.compacted_through_event_id ?? 0) >= (archiveEvent.id ?? 0));
    assert.ok(Number(compacted?.data.compacted_through_event_id ?? 0) >= (compactionEvidence.id ?? 0));
    assert.equal(compacted?.data.archived_events, compressionEnd.archived_events);
    assert.equal(compacted?.data.protected_tail_events, compressionEnd.protected_tail_events);
    assert.equal(compacted?.data.protected_prompt_count, compressionEnd.protected_user_prompts?.length ?? 0);
    assert.ok(events.slice(compactedIndex + 1).some((event) => event.type === "model.request.started"));
    assert.ok(events.some((event) => event.type === "evidence.context_compression"));
    const compressionEvidenceEvent = events.find((event) => event.type === "evidence.context_compression");
    assert.ok(compressionEvidenceEvent);
    assert.equal(compressionEvidenceEvent.data.archived_events, compressionEnd.archived_events);
    assert.equal(compressionEvidenceEvent.data.protected_tail_events, compressionEnd.protected_tail_events);
    assert.equal(compressionEvidenceEvent.data.protected_prompt_count, compressionEnd.protected_user_prompts?.length ?? 0);
    const interactiveStarted = events.slice(compactedIndex + 1).find((event) => event.type === "model.request.started");
    const interactiveEvidence = events.find((event) => event.type === "endpoint.evidence.recorded" && event.data.request_id === "req_2");
    assert.equal(interactiveEvidence?.data.request_class, "interactive");
    assert.equal(interactiveEvidence?.data.prompt_epoch_id, interactiveStarted?.data.prompt_epoch_id);
    assert.equal(interactiveEvidence?.data.cache_hit_rate, 0.5);
    const epoch = store.getCurrentPromptEpoch(session.session_id);
    assert.ok(epoch?.section_hashes["runtime.contract"]);
    assert.ok(epoch?.section_hashes["epoch.memory"]);
    assert.equal(epoch?.section_hashes["session.summary"], undefined);
    assert.equal(store.readResource(String(archiveUri))?.kind, "compaction.archive");
    const nextPromptContext = new PromptBuilder(config, store, workspace).build(
      store.getSession(session.session_id)!,
      "next turn after compression",
      CORE_TOOL_DEFINITIONS,
    );
    const system = String(nextPromptContext.messages[0]?.content ?? "");
    assert.match(system, /Preserve context across compression/);
    assert.doesNotMatch(system, /Compression retention:/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runtime compacts and retries after provider context length failure", async () => {
  const serverCalls: { request_class?: string; body: unknown }[] = [];
  let interactiveAttempts = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/backend-api/codex/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.5" }] }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/backend-api/codex/responses") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const requestClass = typeof req.headers["x-inferoa-request-class"] === "string" ? req.headers["x-inferoa-request-class"] : undefined;
      serverCalls.push({ request_class: requestClass, body: JSON.parse(body) as unknown });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-request-id": `req_${serverCalls.length}`,
      });
      if (requestClass === "interactive") {
        interactiveAttempts += 1;
      }
      if (requestClass === "interactive" && interactiveAttempts === 1) {
        writeSse(res, {
          type: "response.created",
          response: { id: "resp_context_limit", model: "gpt-5.5", status: "in_progress" },
        });
        writeSse(res, {
          type: "error",
          error: {
            code: "context_length_exceeded",
            message: "Your input exceeds the context window of this model.",
          },
        });
        writeSse(res, {
          type: "response.failed",
          response: {
            id: "resp_context_limit",
            model: "gpt-5.5",
            status: "failed",
            error: {
              code: "context_length_exceeded",
              message: "Your input exceeds the context window of this model.",
            },
            incomplete_details: null,
          },
        });
        res.end("data: [DONE]\n\n");
        return;
      }
      const content = requestClass === "compaction" ? "Goal\n- Compacted after provider context limit." : "continued after provider context compaction";
      writeSse(res, {
        type: "response.created",
        response: { id: `resp_${serverCalls.length}`, model: "gpt-5.5", status: "in_progress" },
      });
      writeSse(res, { type: "response.output_text.delta", delta: content });
      writeSse(res, {
        type: "response.completed",
        response: {
          id: `resp_${serverCalls.length}`,
          model: "gpt-5.5",
          status: "completed",
          usage: { input_tokens: 512, output_tokens: 8, total_tokens: 520 },
        },
      });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-provider-limit-compress-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.model_setup.base_url = `http://127.0.0.1:${address.port}/backend-api/codex`;
    config.model_setup.model = "gpt-5.5";
    config.model_setup.provider = "external";
    config.model_setup.provider_id = "openai-codex";
    config.model_setup.profile = "openai_responses";
    config.model_setup.api_key = "codex-token";
    config.context.force_compression = false;
    config.context.context_window = 1_024_000;
    config.model_setup.context_window = 1_024_000;
    const workspace: WorkspaceIdentity = { id: "w_provider_limit", root: dir, alias: "provider-limit" };
    const session = store.createSession(workspace, "provider limit");

    const statuses: RuntimeStatusEvent[] = [];
    const runtime = new Runtime(config, workspace, store);
    const result = await runtime.run({
      session_id: session.session_id,
      prompt: "continue after provider context failure",
      onStatus: (event) => statuses.push(event),
    });

    assert.equal(result.content, "continued after provider context compaction");
    assert.deepEqual(
      serverCalls.map((call) => call.request_class),
      ["interactive", "compaction", "interactive"],
    );
    assert.ok(statuses.some((event) => event.type === "compression_start" && event.reason === "provider-context-limit"));
    const events = store.listEvents(session.session_id);
    assert.equal(events.filter((event) => event.type === "model.request.failed").length, 1);
    const compressionEvidence = events.find((event) => event.type === "evidence.context_compression" && event.run_id === result.run_id);
    assert.equal(compressionEvidence?.data.reason, "provider-context-limit");
    assert.equal((compressionEvidence?.data.provider_diagnostics as Record<string, unknown> | undefined)?.response_status, "failed");
    assert.ok(events.some((event) => event.type === "run.completed"));
    assert.equal(events.some((event) => event.type === "run.failed"), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runtime treats OpenAI-compatible HTTP context errors as provider context limit", async () => {
  const serverCalls: { request_class?: string; body: unknown }[] = [];
  let interactiveAttempts = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "context-test" }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/load") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ waiting: 0, running: 0 }));
      return;
    }
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("");
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const requestClass = typeof req.headers["x-inferoa-request-class"] === "string" ? req.headers["x-inferoa-request-class"] : undefined;
      serverCalls.push({ request_class: requestClass, body: JSON.parse(body) as unknown });
      if (requestClass === "interactive") {
        interactiveAttempts += 1;
      }
      if (requestClass === "interactive" && interactiveAttempts === 1) {
        res.writeHead(400, { "content-type": "application/json", "x-request-id": "req_context_http" });
        res.end(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "context_length_exceeded",
              message: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.",
            },
          }),
        );
        return;
      }
      const content = requestClass === "compaction" ? "Goal\n- OpenAI-compatible context limit compacted." : "continued after OpenAI-compatible context compaction";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeSse(res, { id: `resp_${serverCalls.length}`, model: "context-test", choices: [{ delta: { content } }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 128, completion_tokens: 8, total_tokens: 136 } });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-openai-compatible-limit-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const config = compressionConfig(`http://127.0.0.1:${address.port}/v1`);
    config.context.force_compression = false;
    config.context.context_window = 1_024_000;
    config.model_setup.context_window = 1_024_000;
    const workspace: WorkspaceIdentity = { id: "w_openai_compatible_limit", root: dir, alias: "openai-compatible-limit" };
    const session = store.createSession(workspace, "openai compatible limit");
    const runtime = new Runtime(config, workspace, store);
    const result = await runtime.run({
      session_id: session.session_id,
      prompt: "continue after HTTP context failure",
    });

    assert.equal(result.content, "continued after OpenAI-compatible context compaction");
    assert.deepEqual(serverCalls.map((call) => call.request_class), ["interactive", "compaction", "interactive"]);
    const events = store.listEvents(session.session_id);
    const compressionEvidence = events.find((event) => event.type === "evidence.context_compression" && event.run_id === result.run_id);
    assert.equal(compressionEvidence?.data.reason, "provider-context-limit");
    const diagnostics = compressionEvidence?.data.provider_diagnostics as Record<string, unknown> | undefined;
    assert.equal(diagnostics?.http_status, 400);
    assert.equal((diagnostics?.response_error as Record<string, unknown> | undefined)?.code, "context_length_exceeded");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runtime treats Anthropic prompt-too-long errors as provider context limit", async () => {
  const serverCalls: { request_class?: string; body: unknown }[] = [];
  let interactiveAttempts = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/messages") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const requestClass = typeof req.headers["x-inferoa-request-class"] === "string" ? req.headers["x-inferoa-request-class"] : undefined;
      serverCalls.push({ request_class: requestClass, body: JSON.parse(body) as unknown });
      if (requestClass === "interactive") {
        interactiveAttempts += 1;
      }
      if (requestClass === "interactive" && interactiveAttempts === 1) {
        res.writeHead(400, { "content-type": "application/json", "request-id": "req_anthropic_context" });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "prompt is too long: 250000 tokens > 200000 maximum",
            },
          }),
        );
        return;
      }
      const text = requestClass === "compaction" ? "Goal\n- Anthropic prompt limit compacted." : "continued after Anthropic context compaction";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_${serverCalls.length}`,
          model: "claude-sonnet-4-0",
          content: [{ type: "text", text }],
          usage: { input_tokens: 128, output_tokens: 8 },
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-anthropic-limit-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.model_setup.base_url = `http://127.0.0.1:${address.port}`;
    config.model_setup.model = "claude-sonnet-4-0";
    config.model_setup.provider = "external";
    config.model_setup.provider_id = "anthropic";
    config.model_setup.profile = "anthropic";
    config.model_setup.api_key = "anthropic-token";
    config.context.force_compression = false;
    config.context.context_window = 1_024_000;
    config.model_setup.context_window = 1_024_000;
    const workspace: WorkspaceIdentity = { id: "w_anthropic_limit", root: dir, alias: "anthropic-limit" };
    const session = store.createSession(workspace, "anthropic limit");
    const runtime = new Runtime(config, workspace, store);
    const result = await runtime.run({
      session_id: session.session_id,
      prompt: "continue after Anthropic context failure",
    });

    assert.equal(result.content, "continued after Anthropic context compaction");
    assert.deepEqual(serverCalls.map((call) => call.request_class), ["interactive", "compaction", "interactive"]);
    const events = store.listEvents(session.session_id);
    const compressionEvidence = events.find((event) => event.type === "evidence.context_compression" && event.run_id === result.run_id);
    assert.equal(compressionEvidence?.data.reason, "provider-context-limit");
    const diagnostics = compressionEvidence?.data.provider_diagnostics as Record<string, unknown> | undefined;
    assert.equal(diagnostics?.http_status, 400);
    assert.match(String((diagnostics?.response_error as Record<string, unknown> | undefined)?.message ?? ""), /prompt is too long/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runtime does not compact solely from large history length", async () => {
  const serverCalls: { request_class?: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "compression-test" }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/load") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ waiting: 0, running: 0 }));
      return;
    }
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("vllm:prefix_cache_queries_total 2\nvllm:prefix_cache_hits_total 1\n");
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const requestClass = typeof req.headers["x-inferoa-request-class"] === "string" ? req.headers["x-inferoa-request-class"] : undefined;
      serverCalls.push({ request_class: requestClass, body: JSON.parse(body) as Record<string, unknown> });
      const content = requestClass === "compaction" ? "Goal\n- Unexpected compaction." : "continued without history-length compaction";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeSse(res, { id: `resp_${serverCalls.length}`, model: "compression-test", choices: [{ delta: { content } }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-compress-history-length-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const config = compressionConfig(`http://127.0.0.1:${address.port}/v1`);
    config.context.force_compression = false;
    config.context.context_window = 32_768;
    config.model_setup.context_window = 32_768;
    const workspace: WorkspaceIdentity = { id: "w_compress_history_length", root: dir, alias: "compress-history-length" };
    const session = store.createSession(workspace, "compress-history-length");
    for (let index = 0; index < 4; index += 1) {
      store.appendEvent({
        session_id: session.session_id,
        run_id: `run_seed_${index}`,
        type: "user.prompt",
        data: { prompt: `seed prompt ${index}` },
      });
    }

    const statuses: RuntimeStatusEvent[] = [];
    const runtime = new Runtime(config, workspace, store);
    const result = await runtime.run({
      session_id: session.session_id,
      prompt: "continue active long-horizon work",
      onStatus: (event) => statuses.push(event),
    });

    assert.equal(result.content, "continued without history-length compaction");
    assert.equal(statuses.some((event) => event.type === "compression_start"), false);
    assert.equal(serverCalls[0]?.request_class, "interactive");
    assert.equal(serverCalls.filter((call) => call.request_class === "compaction").length, 0);
    const compacted = store.listEvents(session.session_id).find((event) => event.type === "context.compacted");
    assert.equal(compacted, undefined);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("context compression bounds protected user prompts while preserving the archive", async () => {
  const serverCalls: { request_class?: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "compression-test" }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/load") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ waiting: 0, running: 0 }));
      return;
    }
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("vllm:prefix_cache_queries_total 2\nvllm:prefix_cache_hits_total 1\n");
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const requestClass = typeof req.headers["x-inferoa-request-class"] === "string" ? req.headers["x-inferoa-request-class"] : undefined;
      serverCalls.push({ request_class: requestClass, body: JSON.parse(body) as Record<string, unknown> });
      const content = requestClass === "compaction" ? "Goal\n- Bounded protected prompts." : "continued after bounded prompt compression";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeSse(res, { id: `resp_${serverCalls.length}`, model: "compression-test", choices: [{ delta: { content } }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-compress-prompt-limit-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const config = compressionConfig(`http://127.0.0.1:${address.port}/v1`);
    const workspace: WorkspaceIdentity = { id: "w_compress_prompt_limit", root: dir, alias: "compress-prompt-limit" };
    const session = store.createSession(workspace, "compress-prompt-limit");
    const longPrompt = `${"Long protected user prompt remains useful for continuity. ".repeat(120)}protected prompt tail should stay archived only`;
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_seed",
      type: "user.prompt",
      data: { prompt: longPrompt },
    });

    const runtime = new Runtime(config, workspace, store);
    const result = await runtime.run({
      session_id: session.session_id,
      prompt: "continue after bounded prompt compression",
    });

    assert.equal(result.content, "continued after bounded prompt compression");
    const compactionCall = serverCalls.find((call) => call.request_class === "compaction");
    assert.ok(compactionCall);
    const compactionRequest = compactionRequestContent(compactionCall.body);
    assert.match(compactionRequest, /Long protected user prompt remains useful/);
    assert.match(compactionRequest, /\[truncated \d+ chars\]/);
    assert.doesNotMatch(compactionRequest, /protected prompt tail should stay archived only/);

    const compacted = store.listEvents(session.session_id).find((event) => event.type === "context.compacted");
    assert.ok(compacted);
    assert.doesNotMatch(JSON.stringify(compacted.data), /protected prompt tail should stay archived only/);
    const archive = store.readResource(String(compacted.data.archive_resource_uri));
    assert.match(archive?.content ?? "", /protected prompt tail should stay archived only/);

    const rebuilt = new PromptBuilder(config, store, workspace).build(
      store.getSession(session.session_id)!,
      "next compressed turn",
      CORE_TOOL_DEFINITIONS,
    );
    const system = String(rebuilt.messages[0]?.content ?? "");
    assert.doesNotMatch(system, /Protected user prompt excerpts:/);
    assert.doesNotMatch(system, /Long protected user prompt remains useful/);
    assert.doesNotMatch(system, /\[truncated \d+ chars\]/);
    assert.doesNotMatch(system, /protected prompt tail should stay archived only/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("context compression uses the model summary and protects recent user loop prompts", async () => {
  const serverCalls: { request_class?: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "compression-test" }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/load") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ waiting: 0, running: 0 }));
      return;
    }
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("vllm:prefix_cache_queries_total 2\nvllm:prefix_cache_hits_total 1\n");
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const requestClass = typeof req.headers["x-inferoa-request-class"] === "string" ? req.headers["x-inferoa-request-class"] : undefined;
      serverCalls.push({ request_class: requestClass, body: JSON.parse(body) as Record<string, unknown> });
      const content =
        requestClass === "compaction"
          ? "Goal\n- Model-authored compacted memory.\nOpen Objectives\n- preserve exact user prompts"
          : "continued after compression";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeSse(res, {
        id: `resp_${serverCalls.length}`,
        model: "compression-test",
        choices: [{ delta: { content } }],
      });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-compress-loops-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const config = compressionConfig(`http://127.0.0.1:${address.port}/v1`);
    config.context.protected_recent_loops = 2;
    const workspace: WorkspaceIdentity = { id: "w_compress_loops", root: dir, alias: "compress-loops" };
    const session = store.createSession(workspace, "compress-loops");
    appendLoop(store, session.session_id, "run_old", "old exploratory question");
    appendLoop(store, session.session_id, "run_recent", "recent user asks for architecture analysis");
    const activeResource = store.putResource(session.session_id, "tool.read_file.result", "active resource body", { path: "run_active.ts" });
    appendLoop(store, session.session_id, "run_active", "current user asks for long horizon implementation", activeResource.uri);
    for (let index = 0; index < 14; index += 1) {
      store.appendEvent({
        session_id: session.session_id,
        run_id: "run_active",
        type: "tool.result",
        data: {
          tool_call_id: `run_active_extra_${index}`,
          tool_name: "read_file",
          result: { ok: true, summary: `Read active extra ${index}` },
        },
      });
    }
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_active",
      type: "goal.completion_report",
      data: {
        completion_summary: "Finished active implementation with evidence.",
        report: "Loop achieved. 2 tool loops · 3 tool calls · 4s · 55 tokens used.",
        tool_rounds: 2,
        tool_calls: 3,
        tokens: 55,
        duration_ms: 4000,
      },
    });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_active",
      type: "model.request.started",
      data: {
        provider_id: "vllm",
        mode: "direct",
        model: "compression-test",
        request_class: "interactive",
        prompt_hash: "ph_active",
        tool_schema_hash: "th_active",
        prompt_epoch_id: "pe_active",
        estimated_tokens: 12345,
      },
    });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_active",
      type: "endpoint.evidence.recorded",
      data: {
        provider_id: "vllm",
        mode: "direct",
        request_id: "req_active",
        prompt_hash: "ph_active",
        tool_schema_hash: "th_active",
        prompt_tokens: 1000,
        cached_prompt_tokens: 875,
        cache_hit_rate: 0.875,
        model: "compression-test",
      },
    });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_active",
      type: "model.request.retry",
      data: {
        provider_id: "vllm",
        mode: "direct",
        model: "compression-test",
        request_class: "interactive",
        prompt_hash: "ph_active",
        tool_schema_hash: "th_active",
        prompt_epoch_id: "pe_active",
        attempt: 1,
        next_attempt: 2,
        delay_ms: 250,
        max_attempts: 3,
        error: "429 from endpoint",
      },
    });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_active",
      type: "run.failed",
      data: {
        error: "provider timeout",
        tool_rounds: 2,
        tool_calls: 3,
        tokens: 55,
        duration_ms: 4000,
      },
    });

    const runtime = new Runtime(config, workspace, store);
    const result = await runtime.run({
      session_id: session.session_id,
      prompt: "continue current implementation",
      max_tool_rounds: 0,
    });

    assert.equal(result.content, "continued after compression");
    const compactionCall = serverCalls.find((call) => call.request_class === "compaction");
    assert.ok(compactionCall);
    const compactionRequest = compactionRequestContent(compactionCall.body);
    assert.match(compactionRequest, /recent user asks for architecture analysis/);
    assert.match(compactionRequest, /current user asks for long horizon implementation/);
    assert.match(compactionRequest, /Finished active implementation with evidence/);
    assert.match(compactionRequest, /Loop achieved\. 2 tool loops/);
    assert.match(compactionRequest, new RegExp(escapeRegExp(activeResource.uri)));
    assert.match(compactionRequest, /resource_uris/);
    assert.match(compactionRequest, /ph_active/);
    assert.match(compactionRequest, /th_active/);
    assert.match(compactionRequest, /pe_active/);
    assert.match(compactionRequest, /interactive/);
    assert.match(compactionRequest, /cached_prompt_tokens/);
    assert.match(compactionRequest, /875/);
    assert.match(compactionRequest, /cache_hit_rate/);
    assert.match(compactionRequest, /0\.875/);
    assert.match(compactionRequest, /429 from endpoint/);
    assert.match(compactionRequest, /provider timeout/);
    assert.match(compactionRequest, /Read active extra 10/);
    assert.doesNotMatch(compactionRequest, /Read active extra 11/);
    assert.match(compactionRequest, /omitted_tool_results/);
    assert.doesNotMatch(compactionRequest, /old exploratory question/);

    const compacted = store.listEvents(session.session_id).find((event) => event.type === "context.compacted");
    assert.ok(compacted);
    assert.equal(compacted.data.summary, "Goal\n- Model-authored compacted memory.\nOpen Objectives\n- preserve exact user prompts");
    assert.deepEqual(compacted.data.protected_user_prompts, [
      "recent user asks for architecture analysis",
      "current user asks for long horizon implementation",
      "continue current implementation",
    ]);
    assert.equal(compacted.data.protected_tail_events, 23);
    assert.ok(Array.isArray(compacted.data.protected_loops));
    assert.equal(typeof compacted.data.compacted_through_event_id, "number");

    const rebuilt = new PromptBuilder(config, store, workspace).build(
      store.getSession(session.session_id)!,
      "next compressed turn",
      CORE_TOOL_DEFINITIONS,
    );
    const system = String(rebuilt.messages[0]?.content ?? "");
    assert.match(system, /Model-authored compacted memory/);
    assert.doesNotMatch(system, /Protected recent loops:/);
    assert.doesNotMatch(system, /tool read_file ok: Read run_active\.ts/);
    assert.doesNotMatch(system, new RegExp(escapeRegExp(activeResource.uri)));
    assert.doesNotMatch(system, /run failed: provider timeout/);
    assert.doesNotMatch(system, /tool read_file ok: Read run_recent\.ts/);
    assert.doesNotMatch(system, /Read run_old\.ts/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function appendLoop(store: SessionStore, sessionId: string, runId: string, prompt: string, resourceUri?: string): void {
  store.appendEvent({ session_id: sessionId, run_id: runId, type: "user.prompt", data: { prompt } });
  store.appendEvent({
    session_id: sessionId,
    run_id: runId,
    type: "model.response.settled",
    data: {
      content: "",
      tool_calls: [{ id: `${runId}_call`, name: "read_file", arguments: { path: `${runId}.ts` } }],
    },
  });
  store.appendEvent({
    session_id: sessionId,
    run_id: runId,
    type: "tool.result",
    data: {
      tool_call_id: `${runId}_call`,
      tool_name: "read_file",
      result: {
        ok: true,
        summary: `Read ${runId}.ts`,
        data: {
          path: `${runId}.ts`,
          content: "x".repeat(1000),
          output_resource_uri: resourceUri,
        },
      },
    },
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactionRequestContent(body: unknown): string {
  const messages = (body as { messages?: Array<{ content?: unknown }> } | undefined)?.messages ?? [];
  return String(messages.at(-1)?.content ?? "");
}

function compressionConfig(baseUrl: string): VllmAgentConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.model_setup.base_url = baseUrl;
  config.model_setup.model = "compression-test";
  config.model_setup.provider = "vllm";
  config.context.force_compression = true;
  return config;
}

function writeSse(res: { write: (chunk: string) => void }, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
