import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { stripAnsi, visibleWidth } from "../src/tui/ansi.js";
import {
  commandDeckFrame,
  cacheEvidenceOverview,
  describeModelSetupForDisplay,
  endpointStatusLinesForDisplay,
  normalizeContextWindowInput,
  PREFIX_CACHE_REPORT_TITLE,
  setupReviewLinesForDisplay,
  TUI_OMNI_SETUP_CAPABILITIES,
  webSearchProviderSetupOptions,
} from "../src/tui/app.js";

test("TUI setup exposes every Omni capability, with final-acceptance requirements marked", () => {
  assert.deepEqual(
    TUI_OMNI_SETUP_CAPABILITIES.map((capability) => capability.name),
    [
      "vision",
      "image_generation",
      "image_edit",
      "video_understanding",
      "video_generation",
      "audio_understanding",
      "audio_generation",
      "speech",
    ],
  );
  assert.deepEqual(
    TUI_OMNI_SETUP_CAPABILITIES.filter((capability) => capability.requiredForAcceptance).map((capability) => capability.name),
    ["vision", "image_generation", "video_generation"],
  );
});

test("TUI setup supports explicit model context window configuration", () => {
  assert.equal(normalizeContextWindowInput("128k", 32_768), 128_000);
  assert.equal(normalizeContextWindowInput("131072", 32_768), 131_072);
  assert.equal(normalizeContextWindowInput("", 65_536), 65_536);
  assert.throws(() => normalizeContextWindowInput("512", 32_768), /at least 1024/);

  assert.match(
    describeModelSetupForDisplay({
      mode: "direct",
      provider: "vllm",
      model: "demo",
      base_url: "http://localhost:8000/v1",
      context_window: 128_000,
    }),
    /ctx 128000/,
  );
});

test("TUI setup web search provider list hides legacy fallback option", () => {
  const options = webSearchProviderSetupOptions();

  assert.deepEqual(
    options.map((option) => option.value),
    ["auto", "brave", "jina", "searxng", "custom"],
  );
  assert.doesNotMatch(options.map((option) => `${option.label} ${option.description}`).join("\n"), /Default fallback/i);
});

test("system status omits disconnected render availability", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const lines = stripAnsi(endpointStatusLinesForDisplay(
    {
      mode: "direct",
      provider_id: "vllm:openai_compatible:https://api.agrun.woa.com/v1",
      base_url: "https://api.agrun.woa.com/v1",
      model: "tke/deepseek-v4-pro-tokenhub",
      render_available: false,
    },
    config,
    "Auto chain · fallback ready",
  ).join("\n"));

  assert.match(lines, /Mode direct/);
  assert.match(lines, /Web Auto chain/);
  assert.doesNotMatch(lines, /\bRender\b/);
  assert.doesNotMatch(lines, /\bunavailable\b/);
});

test("system status renders Omni capability matrix details", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.omni.enabled = true;
  config.omni.endpoints.image_generation = {
    base_url: "http://omni.example/v1",
    model: "image-model",
  };
  const lines = stripAnsi(endpointStatusLinesForDisplay(
    {
      mode: "direct",
      provider_id: "vllm:openai_compatible:http://chat.example/v1",
      base_url: "http://chat.example/v1",
      model: "chat-model",
      omni_capabilities: [
        {
          name: "image_generation",
          label: "Image generation",
          endpoint_key: "image_generation",
          required_for_acceptance: true,
          route_path: "/v1/images/generations",
          configured: true,
          route_present: true,
          runtime_passed: undefined,
          base_url: "http://omni.example/v1",
          model: "image-model",
        },
      ],
    },
    config,
    "off",
  ).join("\n"));

  assert.match(lines, /Image generation: configured · route present · profile unverified · runtime unverified/);
  assert.match(lines, /http:\/\/omni\.example\/v1 · image-model/);
});

test("TUI setup review uses full-width rows and does not truncate final summary", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.model_setup.mode = "direct";
  config.model_setup.provider = "vllm";
  config.model_setup.model = `tke/deepseek-v4-pro-tokenhub-${"x".repeat(72)}-tail`;
  config.model_setup.base_url = `https://api.agrun.woa.com/v1/${"endpoint/".repeat(8)}tail`;
  config.model_setup.context_window = 1_024_000;
  config.context.context_window = 1_024_000;
  config.model_setup.api_key_ref = "secret-chat-direct-https-api-agrun-woa-com-v1-api-key";

  const frameWidth = 61;
  const lines = setupReviewLinesForDisplay(config, frameWidth - 3, {
    enabled: true,
    available: true,
    source: "managed",
    version: "0.42.3",
    delivery: "managed",
    auto_download: true,
    binary_path: "/Users/example/.inferoa/rtk/0.42.3/darwin-arm64/rtk",
  });
  const frame = commandDeckFrame("Review Setup", lines, frameWidth);
  const plain = stripAnsi(frame.join("\n"));
  const compactPlain = plain.replace(/[▌\s]/g, "");

  assert.ok(frame.every((line) => visibleWidth(line) === frameWidth));
  assert.doesNotMatch(plain, /…/);
  assert.match(plain, /setup 7\/7/);
  assert.match(plain, /context\s+1024000/);
  assert.match(plain, /rtk available .*managed v0\.42\.3/);
  assert.ok(compactPlain.includes(config.model_setup.model ?? ""));
  assert.ok(compactPlain.includes(config.model_setup.base_url ?? ""));
  assert.match(plain, /local vault/);
});

test("prefix cache report excludes the warmup turn from aggregate hit rate", () => {
  const lines = stripAnsi(cacheEvidenceOverview([
    { run_id: "run_1", usage: { prompt_tokens: 1000, cached_prompt_tokens: 58 } },
    { run_id: "run_2", usage: { prompt_tokens: 1000, cached_prompt_tokens: 971 } },
  ], [
    { session_id: "s", run_id: "run_1", type: "user.prompt", data: { prompt: "who are you" } },
    { session_id: "s", run_id: "run_2", type: "user.prompt", data: { prompt: "continue" } },
  ]).join("\n"));

  assert.equal(PREFIX_CACHE_REPORT_TITLE, "Prefix Cache Report");
  assert.match(lines, /turns 2/);
  assert.match(lines, /usage cache cached 971\/1000 · hit 97\.1% · 1\/1 turns exposed/);
  assert.doesNotMatch(lines, /1029\/2000/);
  assert.doesNotMatch(lines, /51\.5%/);
});
