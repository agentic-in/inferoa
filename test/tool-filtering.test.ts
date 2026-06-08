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
