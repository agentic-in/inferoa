export type JsonPrimitive = string | number | boolean | null | undefined;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type EndpointMode = "direct" | "auto";
export type ProviderKind = "vllm" | "external";
export type PermissionMode = "ask" | "auto_approve" | "full_access" | "custom";

export interface ModelSetup {
  mode: EndpointMode;
  provider?: ProviderKind;
  provider_id?: string;
  profile?: "openai" | "anthropic" | "gemini" | "deepseek" | "openai_compatible" | "openai_responses";
  router?: "vllm-sr";
  base_url?: string;
  model?: string;
  api_key_ref?: string;
  api_key?: string;
  headers?: Record<string, string>;
  context_window?: number;
  cache_salt?: string;
}

export type PromptCacheRetention = "in_memory" | "24h";

export interface OmniEndpointConfig {
  base_url?: string;
  model?: string;
  api_key_ref?: string;
  api_key?: string;
  headers?: Record<string, string>;
}

export type OmniEndpointName =
  | "vision"
  | "image_generation"
  | "image_edit"
  | "video_understanding"
  | "video_generation"
  | "audio_understanding"
  | "audio_generation"
  | "speech";

export type OmniCapabilityName =
  | "vision"
  | "image_generation"
  | "image_edit"
  | "video_understanding"
  | "video_generation"
  | "audio_understanding"
  | "audio_generation"
  | "speech_generation"
  | "speech_voices";

export interface OmniCapabilityStatus {
  name: OmniCapabilityName;
  label: string;
  endpoint_key: OmniEndpointName;
  required_for_acceptance: boolean;
  route_path: string;
  configured: boolean;
  route_present?: boolean;
  profile_compatible?: boolean;
  runtime_passed?: boolean;
  unavailable_reason?: string;
  base_url?: string;
  model?: string;
}

export interface OmniConfig {
  enabled: boolean;
  endpoints: Partial<Record<OmniEndpointName, OmniEndpointConfig>>;
}

export interface VllmAgentConfig {
  workspace?: {
    root?: string;
  };
  model_setup: ModelSetup;
  model_retry?: {
    max_attempts?: number;
    initial_delay_ms?: number;
    max_delay_ms?: number;
    backoff_factor?: number;
    jitter_ratio?: number;
    request_timeout_ms?: number;
  };
  omni: OmniConfig;
  permissions: {
    mode: PermissionMode;
    custom?: JsonObject;
    workspaces?: Record<string, { mode: PermissionMode; custom?: JsonObject }>;
  };
  context: {
    compression_threshold: number;
    context_window: number;
    protected_recent_loops?: number;
    force_compression?: boolean;
    engine?: {
      provider: "auto" | "codegraph" | "builtin" | "off";
      startup: "welcome" | "lazy" | "manual";
      require_ready_before_chat: boolean;
      watch: boolean;
    };
  };
  skills: {
    enabled: string[];
    managed_installs: "ask" | "allow" | "off";
  };
  web_search: {
    provider: "auto" | "brave" | "jina" | "exa" | "perplexity" | "kimi" | "openai" | "anthropic" | "gemini" | "searxng" | "custom" | "off";
    base_url?: string;
    api_key_ref?: string;
    api_key?: string;
  };
  rtk: RtkConfig;
  daemon: {
    poll_ms: number;
  };
}

export interface RtkConfig {
  enabled: boolean;
  delivery: "managed" | "path_only";
  version: string;
  binary_path?: string;
  auto_download: boolean;
}

export interface WorkspaceIdentity {
  root: string;
  id: string;
  alias: string;
  gitRoot?: string;
}

export interface SessionRecord {
  session_id: string;
  workspace_id: string;
  title: string;
  status: string;
  current_epoch_id?: string;
  created_at: string;
  updated_at: string;
}

export interface SessionEvent {
  id?: number;
  session_id: string;
  run_id?: string;
  type: string;
  data: JsonObject;
  created_at?: string;
}

export interface PromptEpochRecord {
  prompt_epoch_id: string;
  session_id: string;
  provider_id: string;
  model_id: string;
  cache_salt: string;
  prompt_layout_hash: string;
  tool_schema_hash: string;
  section_hashes: Record<string, string>;
  reason: string;
  created_at?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
  permission: "read" | "write" | "shell" | "network" | "external_path" | "destructive";
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: JsonObject;
  resource_uri?: string;
  next_page?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface ClarifyChoice {
  id: string;
  label: string;
  description?: string;
}

export interface ClarifyRequest {
  question: string;
  details?: string;
  choices: ClarifyChoice[];
  allow_freeform: boolean;
  placeholder?: string;
}

export interface ClarifyResponse {
  answer: string;
  choice_id?: string;
  choice_label?: string;
  freeform: boolean;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | JsonValue[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ModelRequest {
  session_id: string;
  run_id: string;
  mode: EndpointMode;
  provider_id: string;
  model: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
  request_class?: "interactive" | "tool" | "verification" | "compaction" | "background" | "reflection";
  prompt_hash?: string;
  tool_schema_hash?: string;
  prompt_epoch_id?: string;
  cache_salt?: string;
  prompt_cache_key?: string;
  prompt_cache_retention?: PromptCacheRetention;
}

export interface ModelUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_prompt_tokens?: number;
  raw?: JsonObject;
}

export interface RtkSavingsSummary {
  tool_calls: number;
  rtk_tool_calls: number;
  rtk_commands: number;
  input_tokens: number;
  output_tokens: number;
  saved_tokens: number;
  savings_pct: number;
  estimated_without_rtk_tokens: number;
  status: "ok" | "disabled" | "unavailable" | "partial";
}

export interface ModelResponse {
  content: string;
  tool_calls: ToolCall[];
  usage?: ModelUsage;
  http_status?: number;
  request_id?: string;
  response_id?: string;
  model?: string;
  route?: JsonObject;
  raw?: JsonObject;
  diagnostics?: JsonObject;
}

export interface EndpointSignalSnapshot {
  mode: EndpointMode;
  provider_id: string;
  base_url?: string;
  model?: string;
  models?: JsonObject[];
  render_available?: boolean;
  load?: JsonObject;
  request_id?: string;
  response_id?: string;
  http_status?: number;
  response_status?: string;
  request_class?: ModelRequest["request_class"];
  prompt_hash?: string;
  tool_schema_hash?: string;
  prompt_epoch_id?: string;
  prompt_cache_key?: string;
  prompt_cache_retention?: PromptCacheRetention;
  cache_hit_rate?: number;
  router?: JsonObject;
  usage?: ModelUsage;
  response_diagnostics?: JsonObject;
  cache_metrics?: JsonObject;
  omni_capabilities?: OmniCapabilityStatus[];
  headers?: Record<string, string>;
  errors?: string[];
}
