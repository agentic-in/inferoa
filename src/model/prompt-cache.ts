import type { ModelRequest, ModelSetup, PromptCacheRetention } from "../types.js";
import { base32UrlSha256 } from "../util/hash.js";

export const DEFAULT_PROMPT_CACHE_RETENTION: PromptCacheRetention = "24h";

export function openAiResponsesPromptCacheControls(
  setup: ModelSetup,
  request: ModelRequest,
): { prompt_cache_key?: string; prompt_cache_retention?: PromptCacheRetention } {
  if (!supportsOpenAiPromptCacheControls(setup)) {
    return {};
  }
  const promptCacheKey = request.prompt_cache_key ?? buildPromptCacheKey(request);
  if (!promptCacheKey) {
    return {};
  }
  return {
    prompt_cache_key: promptCacheKey,
    ...(supportsOpenAiPromptCacheRetention(setup)
      ? { prompt_cache_retention: request.prompt_cache_retention ?? DEFAULT_PROMPT_CACHE_RETENTION }
      : {}),
  };
}

export function buildPromptCacheKey(request: Pick<ModelRequest, "provider_id" | "model" | "session_id" | "prompt_epoch_id">): string | undefined {
  const sessionId = request.session_id.trim();
  const promptEpochId = request.prompt_epoch_id?.trim();
  if (!sessionId || !promptEpochId) {
    return undefined;
  }
  const providerId = request.provider_id.trim() || "unknown-provider";
  const model = request.model.trim() || "unknown-model";
  return `inferoa:${base32UrlSha256([providerId, model, sessionId, promptEpochId].join("\0"), 40)}`;
}

function supportsOpenAiPromptCacheControls(setup: ModelSetup): boolean {
  return setup.provider === "external" && setup.provider_id === "openai";
}

function supportsOpenAiPromptCacheRetention(setup: ModelSetup): boolean {
  return setup.provider === "external" && setup.provider_id === "openai";
}
