import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ModelSetup } from "../types.js";

export type ExternalProviderAuthType = "api_key" | "oauth_external" | "none";
export type ExternalProviderProfile = NonNullable<ModelSetup["profile"]>;

export interface ExternalProviderDefinition {
  id: string;
  label: string;
  description: string;
  base_url?: string;
  default_model?: string;
  profile: ExternalProviderProfile;
  auth_type: ExternalProviderAuthType;
  provider_kind: string;
  model_hints: string[];
  env_var_names: string[];
  base_url_env_var?: string;
  supports_custom_base_url: boolean;
  listing_priority: number;
  model_catalog_path?: string;
  model_payload_list_keys?: string[];
  model_payload_id_keys?: string[];
  extra_headers?: Record<string, string>;
}

export interface ExternalProviderCredential {
  value: string;
  source: string;
}

export interface ExternalProviderState {
  provider: ExternalProviderDefinition;
  discovered: boolean;
  source?: string;
  credential?: ExternalProviderCredential;
  base_url?: string;
}

export interface ExternalProviderSetupOption {
  provider: ExternalProviderDefinition;
  discovered: boolean;
  description: string;
  state?: ExternalProviderState;
}

export interface ProviderDiscoveryOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  runCommand?: (command: string, args: string[], env: Record<string, string | undefined>) => Promise<string>;
}

export interface ProviderProbeResult {
  models: string[];
  errors: string[];
}

export interface ProviderModelProbeOptions {
  baseUrl?: string;
  apiKey?: string;
}

const COPILOT_HEADERS: Record<string, string> = {
  "Editor-Version": "vscode/1.99.3",
  "User-Agent": "Inferoa/0.1",
  "Openai-Intent": "conversation-edits",
  "x-initiator": "agent",
};

const QWEN_HEADERS: Record<string, string> = {
  "User-Agent": `QwenCode/0.14.1 (${os.platform()}; ${os.arch()})`,
  "X-DashScope-CacheControl": "enable",
  "X-DashScope-UserAgent": `QwenCode/0.14.1 (${os.platform()}; ${os.arch()})`,
  "X-DashScope-AuthType": "qwen-oauth",
};

const EXTERNAL_PROVIDERS: ExternalProviderDefinition[] = [
  provider("openai-compatible", "OpenAI-Compatible API", "Custom compatible endpoint", undefined, "model-id", "openai_compatible", "api_key", "custom", [], 10, {
    supportsCustomBaseUrl: true,
  }),
  provider("openai", "OpenAI", "First-party OpenAI API", "https://api.openai.com/v1", "gpt-4.1-mini", "openai_compatible", "api_key", "first_party", [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-4.1-mini",
    "o4-mini",
  ], 20, { env: ["OPENAI_API_KEY"] }),
  provider("openai-codex", "OpenAI Codex", "Local Codex OAuth session", "https://chatgpt.com/backend-api/codex", "gpt-5.4", "openai_responses", "oauth_external", "first_party", [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
  ], 22, {
    modelCatalogPath: "/models?client_version=1.0.0",
    modelPayloadListKeys: ["models"],
    modelPayloadIdKeys: ["slug", "id"],
  }),
  provider("openrouter", "OpenRouter", "Multi-provider model router", "https://openrouter.ai/api/v1", "openai/gpt-4o-mini", "openai_compatible", "api_key", "aggregator", [
    "openai/gpt-4o-mini",
    "anthropic/claude-3.7-sonnet",
    "google/gemini-2.5-pro",
  ], 25, { env: ["OPENROUTER_API_KEY"] }),
  provider("copilot", "GitHub Copilot", "GitHub Copilot model catalog", "https://api.githubcopilot.com", "gpt-5.4", "openai_compatible", "oauth_external", "oauth", [
    "claude-opus-4.6",
    "claude-sonnet-4.6",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.4-mini",
    "gpt-5.4",
    "grok-code-fast-1",
    "gpt-4.1",
  ], 28, {
    env: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    modelCatalogPath: "/models",
    modelPayloadListKeys: ["data", "models"],
    modelPayloadIdKeys: ["id", "slug"],
    extraHeaders: COPILOT_HEADERS,
  }),
  provider("anthropic", "Anthropic", "Claude API", "https://api.anthropic.com", "claude-sonnet-4-0", "anthropic", "api_key", "first_party", [
    "claude-sonnet-4-0",
    "claude-opus-4-0",
    "claude-haiku-4-0",
  ], 30, { env: ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"] }),
  provider("claude-code", "Claude Code", "Claude Code OAuth session", "https://api.anthropic.com", "claude-sonnet-4-0", "anthropic", "oauth_external", "oauth", [
    "claude-sonnet-4-0",
    "claude-opus-4-0",
    "claude-haiku-4-0",
  ], 31, { env: ["CLAUDE_CODE_OAUTH_TOKEN"] }),
  provider("google", "Google Gemini", "Gemini OpenAI-compatible endpoint", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash", "openai_compatible", "api_key", "first_party", [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
  ], 35, { env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] }),
  provider("groq", "Groq", "Fast compatible inference", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", "openai_compatible", "api_key", "first_party", [
    "llama-3.3-70b-versatile",
    "qwen-qwq-32b",
    "deepseek-r1-distill-llama-70b",
  ], 40, { env: ["GROQ_API_KEY"] }),
  provider("deepseek", "DeepSeek", "DeepSeek hosted models", "https://api.deepseek.com/v1", "deepseek-chat", "openai_compatible", "api_key", "first_party", [
    "deepseek-chat",
    "deepseek-reasoner",
  ], 45, { env: ["DEEPSEEK_API_KEY"] }),
  provider("xai", "xAI", "Grok compatible endpoint", "https://api.x.ai/v1", "grok-4-fast-reasoning", "openai_compatible", "api_key", "first_party", [
    "grok-4-fast-reasoning",
    "grok-3-mini",
    "grok-2-vision",
  ], 50, { env: ["XAI_API_KEY"] }),
  provider("mistral", "Mistral", "Mistral compatible endpoint", "https://api.mistral.ai/v1", "mistral-small-latest", "openai_compatible", "api_key", "first_party", [
    "mistral-small-latest",
    "mistral-medium-latest",
    "codestral-latest",
  ], 55, { env: ["MISTRAL_API_KEY"] }),
  provider("cohere", "Cohere", "Cohere compatibility API", "https://api.cohere.ai/compatibility/v1", "command-a-03-2025", "openai_compatible", "api_key", "first_party", [
    "command-a-03-2025",
    "command-a-plus-05-2026",
    "command-r-plus-08-2024",
  ], 56, { env: ["COHERE_API_KEY"], baseUrlEnv: "COHERE_BASE_URL" }),
  provider("perplexity", "Perplexity", "Perplexity Agent API", "https://api.perplexity.ai/v1", "openai/gpt-5-mini", "openai_responses", "api_key", "first_party", [
    "openai/gpt-5.5",
    "openai/gpt-5-mini",
    "anthropic/claude-sonnet-4.6",
  ], 57, { env: ["PERPLEXITY_API_KEY"], baseUrlEnv: "PERPLEXITY_BASE_URL" }),
  provider("cerebras", "Cerebras", "Cerebras compatible endpoint", "https://api.cerebras.ai/v1", "gpt-oss-120b", "openai_compatible", "api_key", "first_party", [
    "gpt-oss-120b",
    "zai-glm-4.7",
    "llama3.1-8b",
  ], 58, { env: ["CEREBRAS_API_KEY"], baseUrlEnv: "CEREBRAS_BASE_URL" }),
  provider("nvidia", "NVIDIA NIM", "NVIDIA hosted models", "https://integrate.api.nvidia.com/v1", "nvidia/llama-3.3-nemotron-super-49b-v1", "openai_compatible", "api_key", "first_party", [
    "nvidia/llama-3.3-nemotron-super-49b-v1",
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
  ], 59, { env: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"], baseUrlEnv: "NVIDIA_BASE_URL" }),
  provider("together", "Together AI", "Open model catalog", "https://api.together.ai/v1", "meta-llama/Llama-4-Scout-17B-16E-Instruct", "openai_compatible", "api_key", "aggregator", [
    "meta-llama/Llama-4-Scout-17B-16E-Instruct",
    "deepseek-ai/DeepSeek-V3.1",
    "Qwen/Qwen3-235B-A22B-Instruct-2507",
  ], 60, { env: ["TOGETHER_API_KEY"] }),
  provider("fireworks", "Fireworks AI", "Fireworks compatible endpoint", "https://api.fireworks.ai/inference/v1", "accounts/fireworks/models/deepseek-v3", "openai_compatible", "api_key", "aggregator", [
    "accounts/fireworks/models/deepseek-v3",
    "accounts/fireworks/models/llama-v3p1-70b-instruct",
  ], 62, { env: ["FIREWORKS_API_KEY"] }),
  provider("siliconflow", "SiliconFlow", "China-region model cloud", "https://api.siliconflow.cn/v1", "Qwen/Qwen3-32B", "openai_compatible", "api_key", "aggregator", [
    "Qwen/Qwen3-32B",
    "Qwen/Qwen3-235B-A22B",
    "deepseek-ai/DeepSeek-V3.2",
    "moonshotai/Kimi-K2-Instruct",
  ], 63, { env: ["SILICONFLOW_API_KEY"], baseUrlEnv: "SILICONFLOW_BASE_URL" }),
  provider("volcengine", "Volcengine Ark", "Doubao compatible endpoint", "https://ark.cn-beijing.volces.com/api/v3", "doubao-1-5-pro-32k-250115", "openai_compatible", "api_key", "first_party", [
    "doubao-1-5-pro-32k-250115",
    "doubao-1-5-pro-256k-250115",
    "doubao-seed-1-6-250615",
  ], 64, { env: ["ARK_API_KEY", "VOLCENGINE_API_KEY"], baseUrlEnv: "VOLCENGINE_BASE_URL" }),
  provider("moonshot-cn", "Moonshot Kimi China", "China-region Kimi endpoint", "https://api.moonshot.cn/v1", "kimi-k2-0905-preview", "openai_compatible", "api_key", "first_party", [
    "kimi-k2-0905-preview",
    "kimi-k2-instruct",
    "moonshot-v1-8k",
  ], 65, { env: ["KIMI_API_KEY", "MOONSHOT_API_KEY"], baseUrlEnv: "KIMI_BASE_URL" }),
  provider("moonshot", "Moonshot Kimi", "International Kimi endpoint", "https://api.moonshot.ai/v1", "kimi-k2-0905-preview", "openai_compatible", "api_key", "first_party", [
    "kimi-k2-0905-preview",
    "kimi-k2-instruct",
    "moonshot-v1-8k",
  ], 66, { env: ["MOONSHOT_API_KEY", "KIMI_API_KEY"], baseUrlEnv: "MOONSHOT_BASE_URL" }),
  provider("qwen-oauth", "Qwen OAuth", "Qwen CLI OAuth session", "https://portal.qwen.ai/v1", "qwen3-coder-plus", "openai_compatible", "oauth_external", "oauth", [
    "qwen3-coder-plus",
    "qwen3-235b-a22b",
    "qwen-max",
  ], 66, { baseUrlEnv: "ELEPHANT_QWEN_BASE_URL", extraHeaders: QWEN_HEADERS }),
  provider("baidu-qianfan", "Baidu Qianfan", "Wenxin compatible endpoint", "https://qianfan.baidubce.com/v2", "ernie-4.0-turbo-8k", "openai_compatible", "api_key", "first_party", [
    "ernie-4.0-turbo-8k",
    "ernie-3.5-8k",
    "deepseek-v3.2",
    "deepseek-r1",
  ], 67, { env: ["QIANFAN_API_KEY", "BAIDU_QIANFAN_API_KEY"], baseUrlEnv: "QIANFAN_BASE_URL" }),
  provider("tencent-hunyuan", "Tencent Hunyuan", "Tencent Cloud Hunyuan", "https://api.hunyuan.cloud.tencent.com/v1", "hunyuan-turbos-latest", "openai_compatible", "api_key", "first_party", [
    "hunyuan-turbos-latest",
    "hunyuan-t1-latest",
    "hunyuan-a13b-instruct",
  ], 68, { env: ["HUNYUAN_API_KEY", "TENCENT_HUNYUAN_API_KEY"], baseUrlEnv: "HUNYUAN_BASE_URL" }),
  provider("tencent-tokenhub", "Tencent TokenHub", "Tencent model gateway", "https://tokenhub.tencentmaas.com/v1", "hy3-preview", "openai_compatible", "api_key", "aggregator", [
    "hy3-preview",
    "deepseek-v3.2",
    "deepseek-r1",
    "glm-5",
    "kimi-k2.5",
    "minimax-m2.5",
  ], 68, { env: ["TOKENHUB_API_KEY", "TENCENT_TOKENHUB_API_KEY"], baseUrlEnv: "TOKENHUB_BASE_URL" }),
  provider("stepfun", "StepFun", "Step models endpoint", "https://api.stepfun.com/v1", "step-3.5-flash", "openai_compatible", "api_key", "first_party", [
    "step-3.5-flash",
    "step-3.5",
    "step-2-16k",
    "step-1v-8k",
  ], 69, { env: ["STEPFUN_API_KEY", "STEP_API_KEY"], baseUrlEnv: "STEPFUN_BASE_URL" }),
  provider("minimax", "MiniMax", "MiniMax compatible endpoint", "https://api.minimaxi.com/v1", "MiniMax-M2.7", "openai_compatible", "api_key", "first_party", [
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    "MiniMax-M2.5",
    "MiniMax-M2",
  ], 70, { env: ["MINIMAX_API_KEY"], baseUrlEnv: "MINIMAX_BASE_URL" }),
  provider("minimax-cn", "MiniMax China", "China-region MiniMax endpoint", "https://api.minimaxi.com/v1", "MiniMax-M2.7", "openai_compatible", "api_key", "first_party", [
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    "MiniMax-M2.5",
    "MiniMax-M2",
  ], 72, { env: ["MINIMAX_CN_API_KEY"], baseUrlEnv: "MINIMAX_CN_BASE_URL" }),
  provider("zhipu", "ZhipuAI", "GLM compatible endpoint", "https://open.bigmodel.cn/api/paas/v4", "glm-5.1", "openai_compatible", "api_key", "first_party", [
    "glm-5.1",
    "glm-5",
    "glm-5-turbo",
    "glm-4.7",
    "glm-4-long",
  ], 73, { env: ["ZHIPU_API_KEY"], baseUrlEnv: "ZHIPU_BASE_URL" }),
  provider("zai", "Z.AI / GLM", "Z.AI compatible endpoint", "https://api.z.ai/api/paas/v4", "glm-5", "openai_compatible", "api_key", "first_party", [
    "glm-5",
    "glm-5.1",
    "glm-4.7",
  ], 73, { env: ["GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"], baseUrlEnv: "GLM_BASE_URL" }),
  provider("alibaba", "Alibaba DashScope", "DashScope compatible endpoint", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen-max", "openai_compatible", "api_key", "first_party", [
    "qwen-max",
    "qwen-plus",
    "qwen3-coder-plus",
  ], 74, { env: ["DASHSCOPE_API_KEY"], baseUrlEnv: "DASHSCOPE_BASE_URL" }),
  provider("xiaomi", "Xiaomi MiMo", "MiMo compatible endpoint", "https://api.xiaomimimo.com/v1", "mimo-v2-pro", "openai_compatible", "api_key", "first_party", [
    "mimo-v2-pro",
    "mimo-v2-omni",
    "mimo-v2-flash",
  ], 75, { env: ["XIAOMI_API_KEY"], baseUrlEnv: "XIAOMI_BASE_URL" }),
  provider("huggingface", "Hugging Face", "Hugging Face router", "https://router.huggingface.co/v1", "openai/gpt-oss-120b", "openai_compatible", "api_key", "aggregator", [
    "openai/gpt-oss-120b",
    "meta-llama/Llama-3.3-70B-Instruct",
    "Qwen/Qwen3-235B-A22B-Instruct-2507",
  ], 76, { env: ["HF_TOKEN"], baseUrlEnv: "HF_BASE_URL" }),
  provider("modelscope", "ModelScope", "ModelScope inference API", "https://api-inference.modelscope.cn/v1", "Qwen/Qwen3-235B-A22B-Instruct-2507", "openai_compatible", "api_key", "aggregator", [
    "Qwen/Qwen3-235B-A22B-Instruct-2507",
    "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    "ZhipuAI/GLM-4.6",
  ], 77, { env: ["MODELSCOPE_API_KEY"], baseUrlEnv: "MODELSCOPE_BASE_URL" }),
  provider("opencode-zen", "OpenCode Zen", "OpenCode Zen gateway", "https://opencode.ai/zen/v1", "gpt-5.4", "openai_compatible", "api_key", "aggregator", [
    "gpt-5.4",
    "gpt-5.3-codex",
    "claude-sonnet-4-6",
    "gemini-3-flash",
  ], 78, { env: ["OPENCODE_ZEN_API_KEY"], baseUrlEnv: "OPENCODE_ZEN_BASE_URL" }),
  provider("opencode-go", "OpenCode Go", "OpenCode Go gateway", "https://opencode.ai/zen/go/v1", "glm-5", "openai_compatible", "api_key", "aggregator", [
    "glm-5",
    "kimi-k2.5",
    "minimax-m2.7",
  ], 79, { env: ["OPENCODE_GO_API_KEY"], baseUrlEnv: "OPENCODE_GO_BASE_URL" }),
  provider("kilocode", "Kilo Code", "Kilo Code gateway", "https://api.kilo.ai/api/gateway", "google/gemini-3-flash-preview", "openai_compatible", "api_key", "aggregator", [
    "google/gemini-3-flash-preview",
    "openai/gpt-5.4",
    "anthropic/claude-sonnet-4.6",
  ], 79, { env: ["KILOCODE_API_KEY"], baseUrlEnv: "KILOCODE_BASE_URL" }),
  provider("ollama", "Ollama", "Local Ollama runtime", "http://127.0.0.1:11434/v1", "llama3.2", "openai_compatible", "none", "local", [
    "llama3.2",
    "qwen2.5:7b",
    "gemma3:12b",
  ], 80),
];

export function externalProviderCatalog(): ExternalProviderDefinition[] {
  return [...EXTERNAL_PROVIDERS].sort((a, b) => a.listing_priority - b.listing_priority || a.id.localeCompare(b.id));
}

export function externalProviderById(id: string | undefined): ExternalProviderDefinition | undefined {
  if (!id) {
    return undefined;
  }
  const normalized = id.trim().toLowerCase();
  return EXTERNAL_PROVIDERS.find((provider) => provider.id === normalized);
}

export function externalProviderRequiresApiKey(provider: ExternalProviderDefinition | undefined): boolean {
  return Boolean(provider && provider.auth_type !== "none");
}

export async function discoverExternalProviderStates(options: ProviderDiscoveryOptions = {}): Promise<ExternalProviderState[]> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const runCommand = options.runCommand ?? defaultRunCommand;
  const states: ExternalProviderState[] = [];
  for (const provider of externalProviderCatalog()) {
    const credential = await discoverProviderCredential(provider, { env, homeDir, runCommand });
    const base_url = provider.base_url_env_var ? env[provider.base_url_env_var]?.trim() || provider.base_url : provider.base_url;
    states.push({
      provider,
      discovered: Boolean(credential),
      source: credential?.source,
      credential,
      base_url,
    });
  }
  return states;
}

export function externalProviderSetupOptions(states: ExternalProviderState[]): ExternalProviderSetupOption[] {
  return states
    .map((state) => ({
      provider: state.provider,
      discovered: state.discovered,
      description: providerOptionDescription(state),
      state,
    }))
    .sort((a, b) => {
      if (a.discovered !== b.discovered) {
        return a.discovered ? -1 : 1;
      }
      return a.provider.listing_priority - b.provider.listing_priority || a.provider.label.localeCompare(b.provider.label);
    });
}

export async function probeExternalProviderModels(
  provider: ExternalProviderDefinition,
  options: ProviderModelProbeOptions = {},
): Promise<ProviderProbeResult> {
  const baseUrl = (options.baseUrl || provider.base_url || "").trim();
  const fallback = modelsFromHints(provider);
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    return { models: fallback, errors: baseUrl ? [`${provider.label} model discovery requires an HTTP endpoint.`] : [] };
  }
  const url = composeProviderUrl(baseUrl, provider.model_catalog_path ?? "/v1/models");
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: externalProviderAuthHeaders(provider, options.apiKey),
    });
    if (!response.ok) {
      return { models: fallback, errors: [`/models returned ${response.status}`] };
    }
    const json = (await response.json()) as Record<string, unknown>;
    const discovered = modelIdsFromPayload(provider, json);
    return { models: mergeModels(discovered, fallback), errors: [] };
  } catch (error) {
    return { models: fallback, errors: [`/models unavailable: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function externalProviderAuthHeaders(
  provider: ExternalProviderDefinition | undefined,
  apiKey?: string,
  headers: Record<string, string> = {},
): HeadersInit {
  const output: Record<string, string> = {
    "content-type": "application/json",
    ...(provider?.extra_headers ?? {}),
    ...headers,
  };
  const key = apiKey?.trim();
  if (!key) {
    return output;
  }
  const providerId = provider?.id;
  if (providerId === "anthropic") {
    output["x-api-key"] = key;
    output["anthropic-version"] = "2023-06-01";
    return output;
  }
  if (providerId === "claude-code") {
    output.authorization = `Bearer ${key}`;
    output["anthropic-beta"] = "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20";
    output["user-agent"] = "claude-cli/2.1.74 (external, cli)";
    output["x-app"] = "cli";
    return output;
  }
  output.authorization = `Bearer ${key}`;
  return output;
}

export function resolveExternalProviderCredentialSync(providerId: string, options: { homeDir?: string; env?: Record<string, string | undefined> } = {}): ExternalProviderCredential | undefined {
  const provider = externalProviderById(providerId);
  if (!provider) {
    return undefined;
  }
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const envCredential = credentialFromEnv(provider, env);
  if (envCredential) {
    return envCredential;
  }
  if (provider.id === "openai-codex") {
    return readCodexCredential(homeDir);
  }
  if (provider.id === "claude-code") {
    return readClaudeCodeCredential(homeDir, env);
  }
  if (provider.id === "qwen-oauth") {
    return readQwenCredential(homeDir);
  }
  return undefined;
}

function provider(
  id: string,
  label: string,
  description: string,
  baseUrl: string | undefined,
  defaultModel: string | undefined,
  profile: ExternalProviderProfile,
  authType: ExternalProviderAuthType,
  providerKind: string,
  modelHints: string[],
  listingPriority: number,
  options: {
    env?: string[];
    baseUrlEnv?: string;
    supportsCustomBaseUrl?: boolean;
    modelCatalogPath?: string;
    modelPayloadListKeys?: string[];
    modelPayloadIdKeys?: string[];
    extraHeaders?: Record<string, string>;
  } = {},
): ExternalProviderDefinition {
  return {
    id,
    label,
    description,
    base_url: baseUrl,
    default_model: defaultModel,
    profile,
    auth_type: authType,
    provider_kind: providerKind,
    model_hints: modelHints,
    env_var_names: options.env ?? [],
    base_url_env_var: options.baseUrlEnv,
    supports_custom_base_url: options.supportsCustomBaseUrl ?? false,
    listing_priority: listingPriority,
    model_catalog_path: options.modelCatalogPath,
    model_payload_list_keys: options.modelPayloadListKeys,
    model_payload_id_keys: options.modelPayloadIdKeys,
    extra_headers: options.extraHeaders,
  };
}

async function discoverProviderCredential(
  provider: ExternalProviderDefinition,
  options: Required<Pick<ProviderDiscoveryOptions, "homeDir" | "env" | "runCommand">>,
): Promise<ExternalProviderCredential | undefined> {
  const envCredential = credentialFromEnv(provider, options.env);
  if (envCredential) {
    return envCredential;
  }
  if (provider.id === "openai-codex") {
    return readCodexCredential(options.homeDir);
  }
  if (provider.id === "claude-code") {
    return readClaudeCodeCredential(options.homeDir, options.env);
  }
  if (provider.id === "qwen-oauth") {
    return readQwenCredential(options.homeDir);
  }
  if (provider.id === "copilot") {
    return await readCopilotCredential(options.runCommand, options.env);
  }
  return undefined;
}

function credentialFromEnv(provider: ExternalProviderDefinition, env: Record<string, string | undefined>): ExternalProviderCredential | undefined {
  for (const name of provider.env_var_names) {
    const value = env[name]?.trim();
    if (!value) {
      continue;
    }
    if (provider.id === "copilot" && value.startsWith("ghp_")) {
      continue;
    }
    return { value, source: `env:${name}` };
  }
  return undefined;
}

function readCodexCredential(homeDir: string): ExternalProviderCredential | undefined {
  const authPath = path.join(homeDir, ".codex", "auth.json");
  const payload = readJsonObject(authPath);
  const tokens = objectValue(payload?.tokens);
  const accessToken = stringValue(tokens?.access_token)?.trim();
  const refreshToken = stringValue(tokens?.refresh_token)?.trim();
  if (!accessToken || !refreshToken || jwtTokenIsExpiring(accessToken)) {
    return undefined;
  }
  return { value: accessToken, source: `codex-cli:${authPath}` };
}

function readClaudeCodeCredential(homeDir: string, env: Record<string, string | undefined>): ExternalProviderCredential | undefined {
  const fromEnv = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) {
    return { value: fromEnv, source: "env:CLAUDE_CODE_OAUTH_TOKEN" };
  }
  const credentialsPath = path.join(homeDir, ".claude", ".credentials.json");
  const payload = readJsonObject(credentialsPath);
  const nested = objectValue(payload?.claudeAiOauth) ?? payload;
  const token = stringValue(nested?.accessToken) ?? stringValue(nested?.access_token) ?? stringValue(nested?.token);
  if (!token?.trim()) {
    return undefined;
  }
  const expiresAt = stringValue(nested?.expiresAt) ?? stringValue(nested?.expires_at);
  if (timestampIsExpiring(expiresAt)) {
    return undefined;
  }
  return { value: token.trim(), source: `claude-code:${credentialsPath}` };
}

function readQwenCredential(homeDir: string): ExternalProviderCredential | undefined {
  const authPath = path.join(homeDir, ".qwen", "oauth_creds.json");
  const payload = readJsonObject(authPath);
  const token = stringValue(payload?.access_token)?.trim();
  if (!token) {
    return undefined;
  }
  const expiry = numberValue(payload?.expiry_date);
  if (expiry && expiry <= Date.now()) {
    return undefined;
  }
  return { value: token, source: `qwen-cli:${authPath}` };
}

async function readCopilotCredential(
  runCommand: (command: string, args: string[], env: Record<string, string | undefined>) => Promise<string>,
  env: Record<string, string | undefined>,
): Promise<ExternalProviderCredential | undefined> {
  const cleanEnv = { ...env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined };
  try {
    const token = (await runCommand("gh", ["auth", "token"], cleanEnv)).trim();
    if (!token || token.startsWith("ghp_")) {
      return undefined;
    }
    return { value: token, source: "gh auth token" };
  } catch {
    return undefined;
  }
}

async function defaultRunCommand(command: string, args: string[], env: Record<string, string | undefined>): Promise<string> {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 5000,
    env: scrubUndefinedEnv(env),
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function scrubUndefinedEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return objectValue(parsed);
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function jwtTokenIsExpiring(token: string, skewSeconds = 0): boolean {
  const [, payload] = token.split(".");
  if (!payload) {
    return false;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const exp = numberValue(decoded.exp);
    return Boolean(exp && exp <= Math.floor(Date.now() / 1000) + skewSeconds);
  } catch {
    return false;
  }
}

function timestampIsExpiring(value: string | undefined, skewMs = 0): boolean {
  if (!value) {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now() + skewMs;
}

function providerOptionDescription(state: ExternalProviderState): string {
  const prefix = state.discovered ? "discovered" : state.provider.auth_type === "none" ? "open" : "key";
  const source = state.source ? ` · ${compactSource(state.source)}` : "";
  return `${prefix}${source} · ${state.provider.description}`;
}

function compactSource(source: string): string {
  if (source.startsWith("env:")) {
    return source;
  }
  if (source === "gh auth token" || source === "no auth") {
    return source;
  }
  const [kind = source, rest = ""] = source.split(":", 2);
  return rest ? `${kind}:${path.basename(rest)}` : kind;
}

function composeProviderUrl(baseUrl: string, endpointPath: string): string {
  const base = baseUrl.trim().replace(/\/$/, "");
  let endpoint = endpointPath.trim() || "/v1/models";
  const queryIndex = endpoint.indexOf("?");
  const pathPart = queryIndex >= 0 ? endpoint.slice(0, queryIndex) : endpoint;
  const queryPart = queryIndex >= 0 ? endpoint.slice(queryIndex) : "";
  let trimmedPath = pathPart.replace(/^\/+/, "");
  if (base.endsWith("/v1") && trimmedPath.startsWith("v1/")) {
    trimmedPath = trimmedPath.slice(3);
  }
  return `${base}/${trimmedPath}${queryPart}`;
}

function modelIdsFromPayload(provider: ExternalProviderDefinition, payload: Record<string, unknown>): string[] {
  const listKeys = provider.model_payload_list_keys?.length ? provider.model_payload_list_keys : ["data", "models"];
  const idKeys = provider.model_payload_id_keys?.length ? provider.model_payload_id_keys : ["id", "slug", "name"];
  for (const listKey of listKeys) {
    const items = payload[listKey];
    if (!Array.isArray(items)) {
      continue;
    }
    return items
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const record = objectValue(item);
        if (!record) {
          return undefined;
        }
        for (const key of idKeys) {
          const value = stringValue(record[key])?.trim();
          if (value) {
            return value;
          }
        }
        return undefined;
      })
      .filter((model): model is string => Boolean(model));
  }
  return [];
}

function modelsFromHints(provider: ExternalProviderDefinition): string[] {
  return mergeModels(provider.model_hints, provider.default_model ? [provider.default_model] : []);
}

function mergeModels(primary: string[], fallback: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const model of [...primary, ...fallback]) {
    const normalized = model.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}
