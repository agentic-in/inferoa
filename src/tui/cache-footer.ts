import type { JsonObject, ModelUsage, SessionEvent } from "../types.js";
import { ansi, fg256 } from "./ansi.js";

export type PrefixCacheTurnKind = "warmup" | "hit";

export interface CacheFooterInput {
  usage?: ModelUsage;
  requestId?: string;
  model?: string;
  mode?: string;
  latencyMs?: number;
  route?: JsonObject;
  showCacheHit?: boolean;
  cacheKind?: PrefixCacheTurnKind;
}

export function cacheHitRate(usage?: ModelUsage): number | undefined {
  const prompt = usage?.prompt_tokens;
  const cached = usage?.cached_prompt_tokens;
  if (prompt === undefined || cached === undefined || prompt <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(1, cached / prompt));
}

export function renderCacheFooter(input: CacheFooterInput): string {
  const usage = input.usage;
  const hit = cacheHitRate(usage);
  const parts: string[] = [];
  if (input.showCacheHit !== false && hit !== undefined && hit > 0) {
    parts.push(formatFooterHitRate(hit, input.cacheKind ?? "hit"));
  }
  if (input.latencyMs !== undefined) {
    parts.push(fg256(244, `worked for ${formatDuration(input.latencyMs)}`));
  }
  return parts.join(" · ");
}

export function renderCacheReportTurn(input: { usage?: ModelUsage; cacheKind?: PrefixCacheTurnKind }): string {
  const hit = cacheHitRate(input.usage);
  if (hit === undefined) {
    return fg256(244, "prefix cache unavailable");
  }
  const kind = input.cacheKind ?? "hit";
  const label = kind === "warmup" ? "warmup cache hit" : "prefix cache hit";
  return fg256(hitColor(hit, kind), `${ansi.bold}${label} ${(hit * 100).toFixed(1)}%${ansi.reset}`);
}

export function cacheTurnKind(events: readonly SessionEvent[], runId?: string): PrefixCacheTurnKind {
  if (!runId) {
    return "hit";
  }
  const priorPromptRunIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "user.prompt" || !event.run_id) {
      continue;
    }
    if (event.run_id === runId) {
      return priorPromptRunIds.size > 0 ? "hit" : "warmup";
    }
    priorPromptRunIds.add(event.run_id);
  }
  return "hit";
}

export function shouldShowChatCacheHit(events: readonly SessionEvent[], runId: string): boolean {
  return cacheTurnKind(events, runId) === "hit";
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0ms";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    const seconds = ms / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatFooterHitRate(hit: number, kind: PrefixCacheTurnKind): string {
  const label = kind === "warmup" ? "prefix cache warmup" : "prefix cache hit";
  if (kind === "warmup") {
    return fg256(48, `${ansi.bold}${label}${ansi.reset}`);
  }
  return `${fg256(hitColor(hit, kind), `${ansi.bold}${label} (${(hit * 100).toFixed(1)}%)${ansi.reset}`)}`;
}

function hitColor(hit: number, kind: PrefixCacheTurnKind): number {
  if (kind === "warmup") {
    return 220;
  }
  return hit >= 0.8 ? 48 : hit >= 0.5 ? 220 : 203;
}
