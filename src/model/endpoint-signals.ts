import type { EndpointSignalSnapshot, JsonObject, ModelSetup, ModelUsage, VllmAgentConfig } from "../types.js";
import { endpointApiKey } from "../config/config.js";
import {
  externalProviderAuthHeaders,
  externalProviderById,
  externalProviderRequiresApiKey,
  probeExternalProviderModels,
} from "./providers.js";

export function providerId(config: VllmAgentConfig): string {
  const setup = config.model_setup;
  if (setup.mode === "auto") {
    return `auto:${setup.router ?? "vllm-sr"}:${setup.base_url ?? "unconfigured"}`;
  }
  const provider = setup.provider_id ?? setup.provider ?? "vllm";
  return `${provider}:${setup.profile ?? "openai_compatible"}:${setup.base_url ?? "unconfigured"}`;
}

export function modelBaseUrl(setup: ModelSetup): string {
  if (!setup.base_url) {
    throw new Error("model_setup.base_url is required");
  }
  return setup.base_url.replace(/\/$/, "");
}

export function authHeaders(endpoint: { api_key?: string; api_key_ref?: string; headers?: Record<string, string> }): HeadersInit {
  const provider = externalProviderById(typeof (endpoint as { provider_id?: unknown }).provider_id === "string" ? (endpoint as { provider_id: string }).provider_id : undefined);
  const apiKey = endpointApiKey(endpoint);
  return externalProviderAuthHeaders(provider, apiKey, endpoint.headers);
}

export function normalizeUsage(raw: unknown): ModelUsage | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const data = raw as Record<string, unknown>;
  const promptDetails = data.prompt_tokens_details as Record<string, unknown> | undefined;
  const inputDetails = data.input_tokens_details as Record<string, unknown> | undefined;
  const cached = firstNumber(
    promptDetails?.cached_tokens,
    promptDetails?.cached_prompt_tokens,
    inputDetails?.cached_tokens,
    inputDetails?.cached_prompt_tokens,
    data.cached_prompt_tokens,
    data.prompt_tokens_cached,
    data.prompt_cache_hit_tokens,
    data.cached_tokens,
  );
  return {
    prompt_tokens: numberOrUndefined(data.prompt_tokens ?? data.input_tokens),
    completion_tokens: numberOrUndefined(data.completion_tokens ?? data.output_tokens),
    total_tokens: numberOrUndefined(data.total_tokens),
    cached_prompt_tokens: cached,
    raw: data as JsonObject,
  };
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = numberOrUndefined(value);
    if (number !== undefined) {
      return number;
    }
  }
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

export function signalHeaders(headers: Headers): Record<string, string> {
  const interesting = [
    "x-request-id",
    "x-correlation-id",
    "x-vllm-request-id",
    "request-id",
    "openai-processing-ms",
    "endpoint-load-metrics",
    "x-router-model",
    "x-selected-model",
  ];
  const out: Record<string, string> = {};
  for (const key of interesting) {
    const value = headers.get(key);
    if (value) {
      out[key] = value;
    }
  }
  return out;
}

export class EndpointSignals {
  constructor(private readonly config: VllmAgentConfig) {}

  async snapshot(): Promise<EndpointSignalSnapshot> {
    const setup = this.config.model_setup;
    const snapshot: EndpointSignalSnapshot = {
      mode: setup.mode,
      provider_id: providerId(this.config),
      base_url: setup.base_url,
      model: setup.model,
      errors: [],
    };
    if (!setup.base_url) {
      snapshot.errors?.push("model_setup.base_url is not configured");
      return snapshot;
    }
    const externalProvider = setup.provider === "external" ? externalProviderById(setup.provider_id) : undefined;
    if (setup.provider === "external" && (!externalProvider || externalProviderRequiresApiKey(externalProvider)) && !endpointApiKey(setup)) {
      snapshot.errors?.push(`${externalProvider?.label ?? "external provider"} API key is missing from the local vault; run /setup and paste the key once`);
      return snapshot;
    }
    if (externalProvider) {
      const probe = await probeExternalProviderModels(externalProvider, {
        baseUrl: setup.base_url,
        apiKey: endpointApiKey(setup),
      });
      snapshot.models = probe.models.map((id) => ({ id }));
      snapshot.errors?.push(...probe.errors);
      return snapshot;
    }
    const base = modelBaseUrl(setup);
    try {
      const response = await fetch(`${base}/models`, {
        method: "GET",
        headers: authHeaders(setup),
      });
      snapshot.headers = signalHeaders(response.headers);
      if (response.ok) {
        const json = (await response.json()) as Record<string, unknown>;
        const data = Array.isArray(json.data) ? json.data : [];
        snapshot.models = data.filter((item): item is JsonObject => Boolean(item) && typeof item === "object") as JsonObject[];
      } else {
        snapshot.errors?.push(`/models returned ${response.status}`);
      }
    } catch (error) {
      snapshot.errors?.push(`/models unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const response = await fetch(`${base.replace(/\/v1$/, "")}/load`, {
        method: "GET",
        headers: authHeaders(setup),
      });
      if (response.ok) {
        snapshot.load = (await response.json()) as JsonObject;
      }
    } catch {
      // Optional signal.
    }
    if (setup.provider === "vllm") {
      try {
        const response = await fetch(`${base.replace(/\/v1$/, "")}/metrics`, {
          method: "GET",
          headers: authHeaders(setup),
        });
        if (response.ok) {
          const metrics = parseCacheMetrics(await response.text());
          if (Object.keys(metrics).length > 0) {
            snapshot.cache_metrics = metrics;
          }
        }
      } catch {
        // Optional signal.
      }
    }
    return snapshot;
  }

}

function parseCacheMetrics(text: string): JsonObject {
  const metrics: JsonObject = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const name = match[1] ?? "";
    const labels = match[2] ?? "";
    if (!isCacheMetric(name, labels)) {
      continue;
    }
    const value = Number(match[3]);
    if (!Number.isFinite(value)) {
      continue;
    }
    metrics[labels ? `${name}${labels}` : name] = value;
    if (Object.keys(metrics).length >= 80) {
      break;
    }
  }
  return metrics;
}

function isCacheMetric(name: string, labels: string): boolean {
  const haystack = `${name}${labels}`.toLowerCase();
  return (
    haystack.includes("prefix_cache") ||
    haystack.includes("prompt_tokens_cached") ||
    haystack.includes("cached_prompt") ||
    haystack.includes("cache_hit") ||
    haystack.includes("local_cache") ||
    (haystack.includes("prompt_tokens_by_source") && haystack.includes("cache"))
  );
}
