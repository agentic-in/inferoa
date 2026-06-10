import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { SessionStore } from "../src/session/store.js";
import { configuredToolDefinitions } from "../src/tools/schemas.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { WorkspaceIdentity } from "../src/types.js";

test("configured tool list excludes unconfigured Omni capabilities from chat injection", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const names = configuredToolDefinitions(config).map((tool) => tool.name);

  assert.doesNotMatch(names.join("\n"), /vision_understanding|image_generation|image_edit|video_generation|audio_generation|speech_generation|speech_voices|audio_understanding|video_understanding/);
  assert.ok(names.includes("clarify"));
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("export_resource"));

  config.omni.enabled = true;
  config.omni.endpoints.vision = { base_url: "http://localhost:8000/v1", model: "vision-model" };
  const configuredNames = configuredToolDefinitions(config).map((tool) => tool.name);
  assert.ok(configuredNames.includes("vision_understanding"));
  assert.doesNotMatch(configuredNames.join("\n"), /image_generation|image_edit|video_generation|audio_generation|speech_generation|speech_voices|audio_understanding|video_understanding/);
});

test("ToolRegistry list follows configured tool availability", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-tool-filtering-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    const workspace: WorkspaceIdentity = { id: "w_tool_filtering", root: dir, alias: "tool-filtering" };
    const registry = new ToolRegistry(config, workspace, store);

    assert.equal(registry.list().some((tool) => tool.name === "image_generation"), false);

    config.omni.enabled = true;
    config.omni.endpoints.image_generation = { base_url: "http://localhost:8000/v1", model: "image-model" };
    assert.equal(new ToolRegistry(config, workspace, store).list().some((tool) => tool.name === "image_generation"), true);

    config.omni.endpoints.speech = { base_url: "http://localhost:8000/v1", model: "speech-model" };
    const speechTools = new ToolRegistry(config, workspace, store).list().map((tool) => tool.name);
    assert.equal(speechTools.includes("speech_generation"), true);
    assert.equal(speechTools.includes("speech_voices"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("configured Omni tool schemas do not expose model arguments", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.omni.enabled = true;
  config.omni.endpoints.vision = { base_url: "http://localhost:8000/v1", model: "vision-model" };
  config.omni.endpoints.image_generation = { base_url: "http://localhost:8001/v1", model: "image-model" };
  config.omni.endpoints.image_edit = { base_url: "http://localhost:8002/v1", model: "image-edit-model" };
  config.omni.endpoints.video_generation = { base_url: "http://localhost:8003/v1", model: "video-model" };
  config.omni.endpoints.video_understanding = { base_url: "http://localhost:8004/v1", model: "video-understanding-model" };
  config.omni.endpoints.audio_generation = { base_url: "http://localhost:8005/v1", model: "audio-model" };
  config.omni.endpoints.audio_understanding = { base_url: "http://localhost:8006/v1", model: "audio-understanding-model" };
  config.omni.endpoints.speech = { base_url: "http://localhost:8007/v1", model: "speech-model" };

  const omniToolNames = new Set([
    "audio_generation",
    "audio_understanding",
    "image_edit",
    "image_generation",
    "speech_generation",
    "speech_voices",
    "video_generation",
    "video_understanding",
    "vision_understanding",
  ]);
  const omniTools = configuredToolDefinitions(config).filter((tool) => omniToolNames.has(tool.name));

  assert.equal(omniTools.length, omniToolNames.size);
  for (const tool of omniTools) {
    assert.equal(((tool.parameters.properties as Record<string, unknown> | undefined) ?? {}).model, undefined, tool.name);
  }
});

test("model-facing tool schemas use enums and omit legacy aliases", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.omni.enabled = true;
  config.omni.endpoints.vision = { base_url: "http://localhost:8000/v1", model: "vision-model" };
  config.omni.endpoints.image_generation = { base_url: "http://localhost:8001/v1", model: "image-model" };
  config.omni.endpoints.image_edit = { base_url: "http://localhost:8002/v1", model: "image-edit-model" };
  config.omni.endpoints.video_generation = { base_url: "http://localhost:8003/v1", model: "video-model" };
  config.omni.endpoints.audio_generation = { base_url: "http://localhost:8005/v1", model: "audio-model" };
  config.omni.endpoints.speech = { base_url: "http://localhost:8007/v1", model: "speech-model" };

  const tools = configuredToolDefinitions(config);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const prop = (toolName: string, propName: string): Record<string, unknown> | undefined =>
    ((byName.get(toolName)?.parameters.properties as Record<string, Record<string, unknown>> | undefined) ?? {})[propName];

  assert.equal(byName.has("web_fetch"), false);
  assert.equal(byName.has("web_open"), true);
  assert.deepEqual(prop("web_open", "format")?.enum, ["text", "html"]);

  assert.deepEqual(prop("goal", "op")?.enum, ["create", "get", "decompose", "update_plan", "update_step", "set_strategy", "update_ledger", "reflect", "resume", "complete", "drop"]);
  assert.deepEqual(prop("goal", "status")?.enum, ["pending", "in_progress", "completed", "blocked", "skipped"]);
  assert.deepEqual(prop("goal", "decision")?.enum, ["expand", "done", "blocked"]);
  assert.equal(prop("goal", "open_candidates"), undefined);
  assert.equal(prop("goal", "done_candidates"), undefined);
  assert.equal(prop("goal", "rejected_candidates"), undefined);
  assert.equal(prop("goal", "force"), undefined);
  assert.ok((byName.get("goal")?.description.length ?? 999) < 240);

  assert.deepEqual(prop("plan", "op")?.enum, ["create", "get", "update", "approve", "pause", "resume", "drop"]);
  assert.deepEqual(prop("log_experiment", "status")?.enum, ["keep", "discard", "crash", "checks_failed"]);
  assert.deepEqual(prop("init_experiment", "direction")?.enum, ["lower", "higher"]);
  assert.deepEqual(prop("lsp", "action")?.enum, ["status", "diagnostics", "definition", "references", "hover", "symbols", "code_actions"]);
  assert.equal(prop("lsp", "apply"), undefined);
  assert.equal(byName.get("lsp_rename")?.permission, "write");

  assert.equal(prop("audio_generation", "prompt"), undefined);
  assert.equal(prop("audio_generation", "duration"), undefined);
  assert.equal(prop("audio_generation", "audio_length")?.type, "number");
  assert.equal(prop("video_generation", "sync"), undefined);
  assert.equal(prop("video_generation", "seconds"), undefined);
  assert.equal(prop("video_generation", "duration")?.type, "number");
  assert.deepEqual(prop("video_generation", "mode")?.enum, ["async", "sync"]);
  assert.equal(prop("run_experiment", "timeout_seconds"), undefined);
});
