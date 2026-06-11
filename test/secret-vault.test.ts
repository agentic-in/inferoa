import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { endpointApiKey, loadConfig, saveUserConfig } from "../src/config/config.js";
import { readSecret, secretRef, writeSecret } from "../src/config/secret-vault.js";

test("local secret vault stores API keys behind references", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-vault-"));
  const previous = process.env.INFEROA_STATE_DIR;
  process.env.INFEROA_STATE_DIR = dir;
  try {
    const ref = secretRef("external-provider", "api-key");
    await writeSecret(ref, "sk-test-value");
    assert.equal(readSecret(ref), "sk-test-value");
    assert.equal(endpointApiKey({ api_key_ref: ref }), "sk-test-value");
    process.env.INFEROA_TEST_API_KEY = "sk-env-value";
    assert.equal(endpointApiKey({ api_key_ref: ref }), "sk-test-value");
    assert.equal(endpointApiKey({ api_key_ref: "missing-ref" }), undefined);
  } finally {
    delete process.env.INFEROA_TEST_API_KEY;
    if (previous === undefined) {
      delete process.env.INFEROA_STATE_DIR;
    } else {
      process.env.INFEROA_STATE_DIR = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("user config never persists or exposes cache salt", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-config-"));
  const previousStateDir = process.env.INFEROA_STATE_DIR;
  process.env.INFEROA_STATE_DIR = dir;
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.model_setup.model = "demo-model";
    config.model_setup.cache_salt = "cs_visible";

    const saved = await saveUserConfig(config);
    const text = await readFile(saved, "utf8");
    assert.doesNotMatch(text, /cache_salt/);

    await writeFile(
      saved,
      [
        "model_setup:",
        "  mode: direct",
        "  provider: external",
        "  model: demo-model",
        "  cache_salt: cs_legacy",
        "omni:",
        "  enabled: false",
        "  endpoints: {}",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadConfig(dir);
    assert.equal(loaded.config.model_setup.cache_salt, undefined);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.INFEROA_STATE_DIR;
    } else {
      process.env.INFEROA_STATE_DIR = previousStateDir;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit config strips unknown fields on load and user config save", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-config-unknown-fields-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-config-unknown-fields-state-"));
  const previousStateDir = process.env.INFEROA_STATE_DIR;
  process.env.INFEROA_STATE_DIR = stateDir;
  try {
    await mkdir(dir, { recursive: true });
    const explicitConfig = path.join(dir, "explicit-config.yaml");
    await writeFile(
      explicitConfig,
      [
        "unknown_top_level: true",
        "model_setup:",
        "  mode: direct",
        "  provider: vllm",
        "  model: demo-model",
        "  unknown_model_setup: old",
        "context:",
        "  compression_threshold: 0.8",
        "  context_window: 32768",
        "  engine:",
        "    provider: codegraph",
        "    startup: welcome",
        "    require_ready_before_chat: true",
        "    watch: false",
        "    unknown_engine_key: old",
        "  unknown_context_key: 40",
        "omni:",
        "  enabled: false",
        "  endpoints: {}",
        "loop:",
        "  default_background_isolation: worktree",
        "  unknown_loop_key: old",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadConfig(dir, explicitConfig);
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.config, "unknown_top_level"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.config.model_setup, "unknown_model_setup"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.config.context, "unknown_context_key"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.config.context.engine, "unknown_engine_key"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.config.loop, "unknown_loop_key"), false);
    assert.equal(loaded.config.context.engine?.provider, "codegraph");
    assert.equal(loaded.config.context.engine?.watch, false);
    assert.equal(loaded.config.loop.default_background_isolation, "worktree");

    const saved = await saveUserConfig(loaded.config);
    const text = await readFile(saved, "utf8");
    assert.doesNotMatch(text, /unknown_/);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.INFEROA_STATE_DIR;
    } else {
      process.env.INFEROA_STATE_DIR = previousStateDir;
    }
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("user config provides model defaults across workspaces and repo-local config only loads when explicit", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-user-config-state-"));
  const firstWorkspace = await mkdtemp(path.join(os.tmpdir(), "inferoa-user-config-first-"));
  const secondWorkspace = await mkdtemp(path.join(os.tmpdir(), "inferoa-user-config-second-"));
  const previousStateDir = process.env.INFEROA_STATE_DIR;
  process.env.INFEROA_STATE_DIR = stateDir;
  try {
    const userConfig = structuredClone(DEFAULT_CONFIG);
    userConfig.workspace = { root: firstWorkspace };
    userConfig.model_setup.base_url = "http://global.example/v1";
    userConfig.model_setup.model = "global-model";

    const userConfigFile = await saveUserConfig(userConfig);
    const userConfigText = await readFile(userConfigFile, "utf8");
    assert.doesNotMatch(userConfigText, /workspace:/);

    const firstLoaded = await loadConfig(firstWorkspace);
    assert.equal(firstLoaded.config.model_setup.model, "global-model");
    assert.equal(firstLoaded.config.model_setup.base_url, "http://global.example/v1");

    await mkdir(path.join(secondWorkspace, ".inferoa"), { recursive: true });
    await writeFile(
      path.join(secondWorkspace, ".inferoa", "config.yaml"),
      [
        "model_setup:",
        "  model: workspace-model",
      ].join("\n"),
      "utf8",
    );

    const secondLoaded = await loadConfig(secondWorkspace);
    assert.equal(secondLoaded.config.model_setup.model, "global-model");
    assert.equal(secondLoaded.config.model_setup.base_url, "http://global.example/v1");
    assert.deepEqual(secondLoaded.files, [userConfigFile]);

    const workspaceConfigFile = path.join(secondWorkspace, ".inferoa", "config.yaml");
    const explicitLoaded = await loadConfig(secondWorkspace, workspaceConfigFile);
    assert.equal(explicitLoaded.config.model_setup.model, "workspace-model");
    assert.deepEqual(explicitLoaded.files, [workspaceConfigFile]);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.INFEROA_STATE_DIR;
    } else {
      process.env.INFEROA_STATE_DIR = previousStateDir;
    }
    await rm(stateDir, { recursive: true, force: true });
    await rm(firstWorkspace, { recursive: true, force: true });
    await rm(secondWorkspace, { recursive: true, force: true });
  }
});

test("runtime model env overrides do not persist back to user config", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-env-override-state-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "inferoa-env-override-workspace-"));
  const previousStateDir = process.env.INFEROA_STATE_DIR;
  const previousBaseUrl = process.env.INFEROA_BASE_URL;
  const previousModel = process.env.INFEROA_MODEL;
  process.env.INFEROA_STATE_DIR = stateDir;
  try {
    const userConfig = structuredClone(DEFAULT_CONFIG);
    userConfig.model_setup.base_url = "https://api.agrun.woa.com/v1";
    userConfig.model_setup.model = "tke/deepseek-v4-pro-tokenhub";

    const userConfigFile = await saveUserConfig(userConfig);

    process.env.INFEROA_BASE_URL = "http://127.0.0.1:61098/v1";
    process.env.INFEROA_MODEL = "long-horizon-test";

    const loaded = await loadConfig(workspace);
    assert.equal(loaded.config.model_setup.base_url, "http://127.0.0.1:61098/v1");
    assert.equal(loaded.config.model_setup.model, "long-horizon-test");

    await saveUserConfig(loaded.config);
    const savedText = await readFile(userConfigFile, "utf8");
    assert.match(savedText, /base_url: https:\/\/api\.agrun\.woa\.com\/v1/);
    assert.match(savedText, /model: tke\/deepseek-v4-pro-tokenhub/);
    assert.doesNotMatch(savedText, /127\.0\.0\.1:61098/);
    assert.doesNotMatch(savedText, /long-horizon-test/);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.INFEROA_STATE_DIR;
    } else {
      process.env.INFEROA_STATE_DIR = previousStateDir;
    }
    if (previousBaseUrl === undefined) {
      delete process.env.INFEROA_BASE_URL;
    } else {
      process.env.INFEROA_BASE_URL = previousBaseUrl;
    }
    if (previousModel === undefined) {
      delete process.env.INFEROA_MODEL;
    } else {
      process.env.INFEROA_MODEL = previousModel;
    }
    await rm(stateDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
