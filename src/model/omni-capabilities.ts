import { endpointApiKey } from "../config/config.js";
import type {
  OmniCapabilityName,
  OmniCapabilityStatus,
  OmniEndpointConfig,
  OmniEndpointName,
  VllmAgentConfig,
} from "../types.js";

export interface OmniCapabilityDefinition {
  name: OmniCapabilityName;
  label: string;
  endpoint_key: OmniEndpointName;
  route_path: string;
  required_for_acceptance: boolean;
}

export const OMNI_CAPABILITY_DEFINITIONS: readonly OmniCapabilityDefinition[] = [
  {
    name: "vision",
    label: "Vision understanding",
    endpoint_key: "vision",
    route_path: "/v1/chat/completions",
    required_for_acceptance: true,
  },
  {
    name: "image_generation",
    label: "Image generation",
    endpoint_key: "image_generation",
    route_path: "/v1/images/generations",
    required_for_acceptance: true,
  },
  {
    name: "image_edit",
    label: "Image edit",
    endpoint_key: "image_edit",
    route_path: "/v1/images/edits",
    required_for_acceptance: false,
  },
  {
    name: "video_understanding",
    label: "Video understanding",
    endpoint_key: "video_understanding",
    route_path: "/v1/chat/completions",
    required_for_acceptance: false,
  },
  {
    name: "video_generation",
    label: "Video generation",
    endpoint_key: "video_generation",
    route_path: "/v1/videos",
    required_for_acceptance: true,
  },
  {
    name: "audio_understanding",
    label: "Audio understanding",
    endpoint_key: "audio_understanding",
    route_path: "/v1/chat/completions",
    required_for_acceptance: false,
  },
  {
    name: "audio_generation",
    label: "Audio generation",
    endpoint_key: "audio_generation",
    route_path: "/v1/audio/generate",
    required_for_acceptance: false,
  },
  {
    name: "speech_generation",
    label: "Speech generation",
    endpoint_key: "speech",
    route_path: "/v1/audio/speech",
    required_for_acceptance: false,
  },
  {
    name: "speech_voices",
    label: "Speech voices",
    endpoint_key: "speech",
    route_path: "/v1/audio/voices",
    required_for_acceptance: false,
  },
];

export function staticOmniCapabilityMatrix(config: VllmAgentConfig): OmniCapabilityStatus[] {
  return OMNI_CAPABILITY_DEFINITIONS.map((definition) => statusFromDefinition(config, definition));
}

export async function buildOmniCapabilityMatrix(config: VllmAgentConfig): Promise<OmniCapabilityStatus[]> {
  const baseStatuses = staticOmniCapabilityMatrix(config);
  const configuredByBase = configuredEndpointGroups(config);
  if (!configuredByBase.size) {
    return baseStatuses;
  }

  const routesByBase = new Map<string, Set<string>>();
  const errorsByBase = new Map<string, string>();
  await Promise.all(
    [...configuredByBase.entries()].map(async ([base, endpoint]) => {
      const result = await fetchOpenApiRoutes(endpoint);
      if (result.ok) {
        routesByBase.set(base, result.routes);
      } else {
        errorsByBase.set(base, result.error);
      }
    }),
  );

  return baseStatuses.map((status) => {
    if (!status.configured || !status.base_url) {
      return status;
    }
    const normalized = normalizedBaseUrl(status.base_url);
    const routeError = errorsByBase.get(normalized);
    if (routeError) {
      return {
        ...status,
        route_present: false,
        profile_compatible: false,
        unavailable_reason: routeError,
      };
    }
    const routes = routesByBase.get(normalized);
    if (!routes) {
      return status;
    }
    const routePresent = hasRoute(routes, status.route_path);
    return {
      ...status,
      route_present: routePresent,
      profile_compatible: routePresent ? undefined : false,
      unavailable_reason: routePresent ? undefined : `${status.route_path} missing from OpenAPI`,
    };
  });
}

function statusFromDefinition(config: VllmAgentConfig, definition: OmniCapabilityDefinition): OmniCapabilityStatus {
  const endpoint = config.omni.endpoints[definition.endpoint_key];
  const configured = Boolean(config.omni.enabled && endpoint?.base_url && endpoint.model);
  return {
    ...definition,
    configured,
    route_present: configured ? undefined : false,
    profile_compatible: configured ? undefined : false,
    runtime_passed: undefined,
    unavailable_reason: configured ? undefined : "not configured",
    base_url: endpoint?.base_url,
    model: endpoint?.model,
  };
}

function configuredEndpointGroups(config: VllmAgentConfig): Map<string, OmniEndpointConfig> {
  const endpoints = new Map<string, OmniEndpointConfig>();
  if (!config.omni.enabled) {
    return endpoints;
  }
  for (const endpoint of Object.values(config.omni.endpoints)) {
    if (!endpoint?.base_url || !endpoint.model) {
      continue;
    }
    endpoints.set(normalizedBaseUrl(endpoint.base_url), endpoint);
  }
  return endpoints;
}

async function fetchOpenApiRoutes(endpoint: OmniEndpointConfig): Promise<{ ok: true; routes: Set<string> } | { ok: false; error: string }> {
  const base = endpoint.base_url ? normalizedBaseUrl(endpoint.base_url) : "";
  const root = base.replace(/\/v1$/, "");
  const headers: Record<string, string> = { ...(endpoint.headers ?? {}) };
  const apiKey = endpointApiKey(endpoint);
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  try {
    const response = await fetch(`${root}/openapi.json`, {
      method: "GET",
      headers,
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, error: `/openapi.json returned ${response.status}: ${text.slice(0, 240)}` };
    }
    const json = text ? (JSON.parse(text) as { paths?: unknown }) : {};
    const paths = json.paths && typeof json.paths === "object" && !Array.isArray(json.paths) ? Object.keys(json.paths) : [];
    return { ok: true, routes: new Set(paths) };
  } catch (error) {
    return { ok: false, error: `/openapi.json unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function hasRoute(routes: Set<string>, routePath: string): boolean {
  if (routes.has(routePath)) {
    return true;
  }
  const withoutVersion = routePath.replace(/^\/v1/, "");
  return withoutVersion !== routePath && routes.has(withoutVersion);
}
