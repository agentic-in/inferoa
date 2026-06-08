import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  discoverExternalProviderStates,
  externalProviderById,
  externalProviderSetupOptions,
  probeExternalProviderModels,
} from "../src/model/providers.js";

test("external provider setup options put discovered providers first", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-provider-discovery-"));
  try {
    await mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".codex", "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: futureJwt(),
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    const states = await discoverExternalProviderStates({
      homeDir,
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      runCommand: async () => "",
    });
    const options = externalProviderSetupOptions(states);

    assert.equal(options[0]?.provider.id, "openai-codex");
    assert.equal(options[0]?.discovered, true);
    assert.match(options[0]?.description ?? "", /discovered/i);

    const openrouter = options.find((option) => option.provider.id === "openrouter");
    assert.equal(openrouter?.discovered, true);
    assert.match(openrouter?.description ?? "", /env:OPENROUTER_API_KEY/);

    const openaiCompatibleIndex = options.findIndex((option) => option.provider.id === "openai-compatible");
    assert.ok(openaiCompatibleIndex > 0);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("provider model probing honors provider-specific catalog payloads", async () => {
  const provider = externalProviderById("openai-codex");
  assert.ok(provider);

  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ models: [{ slug: "gpt-5.4", title: "GPT 5.4" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await probeExternalProviderModels(provider, { apiKey: "token" });
    assert.equal(result.models[0], "gpt-5.4");
    assert.ok(result.models.includes("gpt-5.4-mini"));
    assert.equal(result.errors.length, 0);
    assert.equal(urls[0], "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function futureJwt(): string {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `${header}.${payload}.signature`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
