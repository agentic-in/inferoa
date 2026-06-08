import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "./defaults.js";
import type { VllmAgentConfig } from "../types.js";
import { ensureDir, homeStateDir, pathExists, realpathOrResolve } from "../util/fs.js";
import { readSecret } from "./secret-vault.js";
import { resolveExternalProviderCredentialSync } from "../model/providers.js";

function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) {
    return structuredClone(base);
  }
  if (Array.isArray(base) || Array.isArray(override) || typeof base !== "object" || typeof override !== "object") {
    return structuredClone(override as T);
  }
  const output: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    output[key] = deepMerge(output[key], value);
  }
  return output as T;
}

export async function configSearchPaths(cwd: string, explicit?: string): Promise<string[]> {
  if (explicit) {
    return [path.resolve(cwd, explicit)];
  }
  return [userConfigPath()];
}

export async function loadConfig(cwd: string, explicit?: string): Promise<{ config: VllmAgentConfig; files: string[] }> {
  let config = structuredClone(DEFAULT_CONFIG);
  const files: string[] = [];
  for (const candidate of await configSearchPaths(cwd, explicit)) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    const parsed = YAML.parse(await fs.readFile(candidate, "utf8")) as unknown;
    config = deepMerge(config, parsed);
    files.push(candidate);
  }
  const envBaseUrl = runtimeEnv("INFEROA_BASE_URL", "VLLM_BASE_URL");
  const envModel = runtimeEnv("INFEROA_MODEL", "VLLM_MODEL");
  if (envBaseUrl) {
    config.model_setup.base_url = envBaseUrl;
  }
  if (envModel) {
    config.model_setup.model = envModel;
  }
  if (process.env.INFEROA_MODE === "auto") {
    config.model_setup.mode = "auto";
    config.model_setup.router = "vllm-sr";
  }
  if (process.env.INFEROA_RTK) {
    config.rtk.enabled = !/^(0|false|off|disabled)$/i.test(process.env.INFEROA_RTK.trim());
  }
  if (process.env.INFEROA_RTK_PATH) {
    config.rtk.binary_path = process.env.INFEROA_RTK_PATH;
    config.rtk.delivery = "path_only";
  }
  if (process.env.INFEROA_RTK_AUTO_DOWNLOAD) {
    config.rtk.auto_download = !/^(0|false|off|disabled)$/i.test(process.env.INFEROA_RTK_AUTO_DOWNLOAD.trim());
  }
  if (process.env.INFEROA_OMNI_VISION_URL) {
    config.omni.enabled = true;
    config.omni.endpoints.vision = {
      ...(config.omni.endpoints.vision ?? {}),
      base_url: process.env.INFEROA_OMNI_VISION_URL,
      model: process.env.INFEROA_OMNI_VISION_MODEL ?? config.omni.endpoints.vision?.model,
    };
  }
  if (process.env.INFEROA_OMNI_IMAGE_URL) {
    config.omni.enabled = true;
    config.omni.endpoints.image_generation = {
      ...(config.omni.endpoints.image_generation ?? {}),
      base_url: process.env.INFEROA_OMNI_IMAGE_URL,
      model: process.env.INFEROA_OMNI_IMAGE_MODEL ?? config.omni.endpoints.image_generation?.model,
    };
  }
  if (process.env.INFEROA_OMNI_IMAGE_EDIT_URL) {
    config.omni.enabled = true;
    config.omni.endpoints.image_edit = {
      ...(config.omni.endpoints.image_edit ?? {}),
      base_url: process.env.INFEROA_OMNI_IMAGE_EDIT_URL,
      model: process.env.INFEROA_OMNI_IMAGE_EDIT_MODEL ?? config.omni.endpoints.image_edit?.model,
    };
  }
  if (process.env.INFEROA_OMNI_VIDEO_URL) {
    config.omni.enabled = true;
    config.omni.endpoints.video_generation = {
      ...(config.omni.endpoints.video_generation ?? {}),
      base_url: process.env.INFEROA_OMNI_VIDEO_URL,
      model: process.env.INFEROA_OMNI_VIDEO_MODEL ?? config.omni.endpoints.video_generation?.model,
    };
  }
  if (process.env.INFEROA_OMNI_SPEECH_URL) {
    config.omni.enabled = true;
    config.omni.endpoints.speech = {
      ...(config.omni.endpoints.speech ?? {}),
      base_url: process.env.INFEROA_OMNI_SPEECH_URL,
      model: process.env.INFEROA_OMNI_SPEECH_MODEL ?? config.omni.endpoints.speech?.model,
    };
  }
  if (!config.workspace) {
    config.workspace = {};
  }
  pruneConfig(config);
  delete config.model_setup.cache_salt;
  if (config.workspace.root) {
    config.workspace.root = await realpathOrResolve(config.workspace.root);
  }
  return { config, files };
}

export function userConfigPath(): string {
  return path.join(process.env.INFEROA_STATE_DIR || homeStateDir(), "config.yaml");
}

export async function saveUserConfig(config: VllmAgentConfig): Promise<string> {
  const target = userConfigPath();
  await ensureDir(path.dirname(target));
  const cleaned = sanitizeConfig(config, { includeWorkspace: false });
  await restoreRuntimeEnvOverrides(cleaned, target);
  await fs.writeFile(target, YAML.stringify(cleaned), "utf8");
  return target;
}

export function endpointApiKey(endpoint: { api_key?: string; api_key_ref?: string }): string | undefined {
  if (endpoint.api_key) {
    return endpoint.api_key;
  }
  const fromVault = readSecret(endpoint.api_key_ref);
  if (fromVault) {
    return fromVault;
  }
  const providerId = typeof (endpoint as { provider_id?: unknown }).provider_id === "string" ? (endpoint as { provider_id: string }).provider_id : undefined;
  if (providerId) {
    return resolveExternalProviderCredentialSync(providerId)?.value;
  }
  return undefined;
}

function sanitizeConfig(config: VllmAgentConfig, options: { includeWorkspace?: boolean } = {}): VllmAgentConfig {
  const cleaned = JSON.parse(JSON.stringify(config)) as VllmAgentConfig;
  if (options.includeWorkspace === false) {
    delete cleaned.workspace;
  }
  pruneConfig(cleaned);
  delete cleaned.model_setup.api_key;
  delete (cleaned.model_setup as { api_key_env?: string }).api_key_env;
  delete cleaned.model_setup.cache_salt;
  cleaned.model_setup.api_key_ref = sanitizeSecretRef(cleaned.model_setup.api_key_ref);
  for (const endpoint of Object.values(cleaned.omni.endpoints)) {
    if (endpoint) {
      delete endpoint.api_key;
      delete (endpoint as { api_key_env?: string }).api_key_env;
      endpoint.api_key_ref = sanitizeSecretRef(endpoint.api_key_ref);
    }
  }
  if (cleaned.web_search) {
    delete cleaned.web_search.api_key;
    delete (cleaned.web_search as { api_key_env?: string }).api_key_env;
    cleaned.web_search.api_key_ref = sanitizeSecretRef(cleaned.web_search.api_key_ref);
  }
  return cleaned;
}

async function restoreRuntimeEnvOverrides(cleaned: VllmAgentConfig, target: string): Promise<void> {
  const existing = await readExistingConfig(target);
  const existingModelSetup = objectValue(existing, "model_setup");
  restoreEnvString(cleaned.model_setup, "base_url", runtimeEnv("INFEROA_BASE_URL", "VLLM_BASE_URL"), existingModelSetup);
  restoreEnvString(cleaned.model_setup, "model", runtimeEnv("INFEROA_MODEL", "VLLM_MODEL"), existingModelSetup);
  if (process.env.INFEROA_MODE === "auto" && cleaned.model_setup.mode === "auto" && cleaned.model_setup.router === "vllm-sr") {
    restoreExistingString(cleaned.model_setup, "mode", existingModelSetup, DEFAULT_CONFIG.model_setup.mode);
    restoreExistingString(cleaned.model_setup, "router", existingModelSetup);
  }
}

async function readExistingConfig(target: string): Promise<unknown> {
  if (!(await pathExists(target))) {
    return undefined;
  }
  try {
    return YAML.parse(await fs.readFile(target, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function restoreEnvString(target: object, key: string, envValue: string | undefined, existing: unknown): void {
  const record = target as Record<string, unknown>;
  if (!envValue || record[key] !== envValue) {
    return;
  }
  restoreExistingString(record, key, existing);
}

function restoreExistingString(target: object, key: string, existing: unknown, fallback?: string): void {
  const record = target as Record<string, unknown>;
  const existingValue = stringValue(objectValue(existing, key));
  if (existingValue !== undefined) {
    record[key] = existingValue;
    return;
  }
  if (fallback !== undefined) {
    record[key] = fallback;
    return;
  }
  delete record[key];
}

function runtimeEnv(primary: string, fallback: string): string | undefined {
  return process.env[primary] ?? process.env[fallback];
}

function objectValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pruneConfig(config: VllmAgentConfig): void {
  pruneKeys(config, ["workspace", "model_setup", "model_retry", "omni", "permissions", "context", "skills", "web_search", "rtk", "daemon"]);
  pruneKeys(config.workspace, ["root"]);
  pruneKeys(config.model_setup, ["mode", "provider", "provider_id", "profile", "router", "base_url", "model", "api_key_ref", "api_key", "headers", "context_window"]);
  pruneKeys(config.model_retry, [
    "max_attempts",
    "initial_delay_ms",
    "max_delay_ms",
    "backoff_factor",
    "jitter_ratio",
    "request_timeout_ms",
  ]);
  pruneKeys(config.omni, ["enabled", "endpoints"]);
  pruneKeys(config.omni?.endpoints, [
    "vision",
    "image_generation",
    "image_edit",
    "video_understanding",
    "video_generation",
    "audio_understanding",
    "audio_generation",
    "speech",
  ]);
  for (const endpoint of Object.values(config.omni?.endpoints ?? {})) {
    pruneKeys(endpoint, ["base_url", "model", "api_key_ref", "api_key", "headers"]);
  }
  pruneKeys(config.permissions, ["mode", "custom", "workspaces"]);
  for (const policy of Object.values(config.permissions?.workspaces ?? {})) {
    pruneKeys(policy, ["mode", "custom"]);
  }
  pruneKeys(config.context, ["compression_threshold", "context_window", "protected_recent_loops", "force_compression", "engine"]);
  pruneKeys(config.context?.engine, ["provider", "startup", "require_ready_before_chat", "watch"]);
  pruneKeys(config.skills, ["enabled", "managed_installs"]);
  pruneKeys(config.web_search, ["provider", "base_url", "api_key_ref", "api_key"]);
  pruneKeys(config.rtk, ["enabled", "delivery", "version", "binary_path", "auto_download"]);
  pruneKeys(config.daemon, ["poll_ms"]);
}

function pruneKeys(value: unknown, allowedKeys: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      delete (value as Record<string, unknown>)[key];
    }
  }
}

function looksLikeSecret(value: string): boolean {
  return /^(sk-|sk_|xai-|ak-|rk-|AIza|ya29\.|ghp_|github_pat_)/i.test(value) || /bearer\s+/i.test(value);
}

function sanitizeSecretRef(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return /^[A-Za-z0-9_.:-]+$/.test(value) && !looksLikeSecret(value) ? value : undefined;
}
