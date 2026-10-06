import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/config.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

for (const format of ["json", "sse"] as const) {
  test(`Parallel loads opt-in YAML and executes through capability_call (${format})`, async () => {
    const originalFetch = globalThis.fetch;
    const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-parallel-"));
    const store = await SessionStore.open(path.join(dir, "state"));
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), "https://search.parallel.ai/mcp");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("user-agent"), "inferoa/0.14.19");
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.has("x-api-key"), false);
      if (init?.method === "GET") return new Response(null, { status: 405 });
      const message = JSON.parse(String(init?.body));
      requests.push(message);
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: unknown;
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: "web_search", inputSchema: { type: "object" } }] };
      } else if (message.method === "tools/call") {
        assert.equal(message.params.name, "web_search");
        const data = { results: [
          { title: "Inferoa", url: "https://github.com/agentic-in/inferoa", excerpts: ["A CLI agent harness.", "Requires Node 24."] },
          { url: "https://example.com/extra", excerpts: ["Second result."] },
        ] };
        result = format === "json"
          ? { content: [{ type: "text", text: JSON.stringify(data) }] }
          : { content: [{ type: "text", text: "Search completed" }], structuredContent: data };
      } else throw new Error(`Unexpected method ${message.method}`);
      const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      return new Response(format === "json" ? body : `event: message\ndata: ${body}\n\n`, {
        headers: { "content-type": format === "json" ? "application/json" : "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      await writeFile(path.join(dir, "config.yaml"), "web_search:\n  provider: parallel\n  api_key: ignored-key\n  base_url: https://example.com/ignored\n");
      const { config } = await loadConfig(dir, "config.yaml");
      assert.equal(config.web_search.provider, "parallel");
      assert.equal(DEFAULT_CONFIG.web_search.provider, "auto");
      const workspace = { id: "w_parallel", root: dir, alias: "parallel" };
      const session = store.createSession(workspace, "search");
      const registry = new ToolRegistry(config, workspace, store);
      const discovered = await registry.call({ id: "discover", name: "tool_search", arguments: { query: "web search" } }, { session_id: session.session_id });
      assert.match(JSON.stringify(discovered.data), /web_search/);
      const result = await registry.call({ id: "search", name: "capability_call", arguments: {
        name: "web_search", arguments: { query: "Inferoa Node requirements", limit: 1 },
      } }, { session_id: session.session_id });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.data?.provider, "parallel");
      assert.equal((result.data?.results as unknown[]).length, 1);
      assert.match(String(result.data?.results_text), /Requires Node 24/);
      const args = requests.find((r) => r.method === "tools/call")?.params?.arguments as Record<string, unknown>;
      assert.equal(args.session_id, session.session_id);
      assert.deepEqual(args.search_queries, ["Inferoa Node requirements"]);
      assert.equal(args.objective, "Inferoa Node requirements");
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const failure of ["missing_tool", "tool_error", "invalid_result", "http_error", "timeout"] as const) {
  test(`Parallel reports ${failure} without falling back`, async () => {
    const originalFetch = globalThis.fetch;
    const originalTimeout = AbortSignal.timeout;
    if (failure === "timeout") AbortSignal.timeout = () => originalTimeout(30);
    const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-parallel-error-"));
    const store = await SessionStore.open(path.join(dir, "state"));
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), "https://search.parallel.ai/mcp");
      if (failure === "timeout") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      if (failure === "http_error") return new Response("Too many requests", { status: 429 });
      if (init?.method === "GET") return new Response(null, { status: 405 });
      const message = JSON.parse(String(init?.body));
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : message.method === "tools/list"
          ? { tools: failure === "missing_tool" ? [] : [{ name: "web_search", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: failure === "tool_error" ? "Rate limit reached" : "{}" }], isError: failure === "tool_error" };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const config = structuredClone(DEFAULT_CONFIG);
      config.web_search.provider = "parallel";
      const workspace = { id: "w_parallel_error", root: dir, alias: "parallel" };
      const session = store.createSession(workspace, "search");
      const result = await new ToolRegistry(config, workspace, store).call({ id: "search", name: "capability_call", arguments: {
        name: "web_search", arguments: { query: "test" },
      } }, { session_id: session.session_id });
      assert.equal(result.ok, false);
      const codes = { missing_tool: "parallel_search_unavailable", tool_error: "parallel_search_failed", invalid_result: "parallel_search_invalid_response", http_error: "parallel_search_failed", timeout: "parallel_search_timeout" };
      assert.equal(result.error?.code, codes[failure]);
    } finally {
      globalThis.fetch = originalFetch;
      AbortSignal.timeout = originalTimeout;
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
