import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { VllmAgentConfig, WorkspaceIdentity } from "../src/types.js";

function config(): VllmAgentConfig {
  return structuredClone(DEFAULT_CONFIG);
}

test("web_open reads a direct URL and extracts readable HTML text", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/doc") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Docs &amp; Notes</title><style>.x{}</style><h1>Guide</h1><p>Hello <b>Inferoa</b>.</p>");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address!.port}/doc`;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-web-tools-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_web", root: dir, alias: "web" };
    const session = store.createSession(workspace, "web");
    const registry = new ToolRegistry(config(), workspace, store);
    const result = await registry.call({ id: "web1", name: "web_open", arguments: { url } }, { session_id: session.session_id, run_id: "run" });
    assert.equal(result.ok, true);
    assert.equal(result.data?.title, "Docs & Notes");
    assert.match(String(result.data?.text ?? ""), /Guide/);
    assert.match(String(result.data?.text ?? ""), /Hello Inferoa/);
  } finally {
    store.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("web_open works for direct URLs even when web search is disabled", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Direct URL</title><main>Direct fetch does not need search credentials.</main>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address!.port}/`;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-web-open-provider-off-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_web_open_off", root: dir, alias: "web-open-off" };
    const session = store.createSession(workspace, "web-open-off");
    const next = config();
    next.web_search.provider = "off";
    const registry = new ToolRegistry(next, workspace, store);
    const result = await registry.call({ id: "web3", name: "web_open", arguments: { url } }, { session_id: session.session_id, run_id: "run" });
    assert.equal(result.ok, true);
    assert.equal(result.data?.title, "Direct URL");
    assert.match(String(result.data?.text ?? ""), /does not need search credentials/);
  } finally {
    store.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("web_fetch is not exposed as a registry tool", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-web-fetch-removed-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_web_fetch_removed", root: dir, alias: "web-fetch-removed" };
    const session = store.createSession(workspace, "web-fetch-removed");
    const registry = new ToolRegistry(config(), workspace, store);
    assert.equal(registry.list().some((tool) => tool.name === "web_fetch"), false);
    const result = await registry.call(
      { id: "web_removed", name: "web_fetch", arguments: { url: "https://example.com" } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "unknown_tool");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("web_search delegates direct URLs to open when search provider is disabled", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>URL Through Search</title><main>Direct URL query was fetched.</main>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address!.port}/`;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-web-search-url-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_web_search_url", root: dir, alias: "web-search-url" };
    const session = store.createSession(workspace, "web-search-url");
    const next = config();
    next.web_search.provider = "off";
    const registry = new ToolRegistry(next, workspace, store);
    const result = await registry.call(
      { id: "web4", name: "web_search", arguments: { query: `please inspect ${url}，thanks` } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(result.ok, true);
    assert.equal(result.data?.title, "URL Through Search");
    assert.equal(result.data?.opened, true);
    assert.match(String(result.data?.text ?? ""), /Direct URL query was fetched/);
  } finally {
    store.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("web_search provider off uses the default HTTP fallback chain for keyword queries", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.startsWith("https://html.duckduckgo.com/html/")) {
      return new Response(
        [
          '<div class="result results_links">',
          '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fvllm">vLLM docs</a>',
          '<a class="result__snippet">A useful Inferoa result.</a>',
          "</div>",
        ].join(""),
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-web-search-fallback-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_web_search_fallback", root: dir, alias: "web-search-fallback" };
    const session = store.createSession(workspace, "web-search-fallback");
    const next = config();
    next.web_search.provider = "off";
    const registry = new ToolRegistry(next, workspace, store);
    const result = await registry.call(
      { id: "web5", name: "web_search", arguments: { query: "vllm agent search", limit: 3 } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(result.ok, true);
    assert.equal(result.data?.provider, "DuckDuckGo");
    assert.equal(Array.isArray(result.data?.results), true);
    assert.match(String(result.data?.results_text ?? ""), /vLLM docs/);
    assert.match(requested.join("\n"), /html\.duckduckgo\.com/);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("web_search uses the configured Brave provider when selected", async () => {
  const originalFetch = globalThis.fetch;
  const requested: Array<{ url: string; token?: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push({ url, token: new Headers(init?.headers).get("x-subscription-token") ?? undefined });
    if (url.startsWith("https://api.search.brave.com/res/v1/web/search")) {
      return Response.json({
        web: {
          results: [
            {
              title: "Brave vLLM result",
              url: "https://example.com/brave",
              description: "Configured provider result.",
            },
          ],
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-web-search-brave-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_web_search_brave", root: dir, alias: "web-search-brave" };
    const session = store.createSession(workspace, "web-search-brave");
    const next = config();
    next.web_search.provider = "brave";
    next.web_search.api_key = "brave-test-key";
    const registry = new ToolRegistry(next, workspace, store);
    const result = await registry.call(
      { id: "web6", name: "web_search", arguments: { query: "vllm agent brave", limit: 2 } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(result.ok, true);
    assert.equal(result.data?.provider, "brave");
    assert.equal(requested[0]?.token, "brave-test-key");
    assert.match(String(result.data?.results_text ?? ""), /Brave vLLM result/);
    assert.doesNotMatch(requested.map((item) => item.url).join("\n"), /duckduckgo|jina/i);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("web_open returns a lightweight preview for direct URLs", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Opened URL</title><main>Open returns readable preview text.</main>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address!.port}/`;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-web-open-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_web_open", root: dir, alias: "web-open" };
    const session = store.createSession(workspace, "web-open");
    const registry = new ToolRegistry(config(), workspace, store);
    const result = await registry.call(
      { id: "web2", name: "web_open", arguments: { url, note: "docs" } },
      { session_id: session.session_id, run_id: "run" },
    );
    assert.equal(result.ok, true);
    assert.equal(result.data?.url, url);
    assert.equal(result.data?.note, "docs");
    assert.equal(result.data?.opened, true);
    assert.equal(result.data?.title, "Opened URL");
    assert.match(String(result.data?.text ?? ""), /Open returns readable preview text/);
  } finally {
    store.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
