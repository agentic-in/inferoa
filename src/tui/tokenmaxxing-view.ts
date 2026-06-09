import type { JsonObject, RtkSavingsSummary, SessionEvent } from "../types.js";
import { fg256, terminalWidth, truncateToWidth } from "./ansi.js";
import { cacheTurnKind, type PrefixCacheTurnKind } from "./cache-footer.js";
import { renderSessionActivityLines } from "./event-view.js";

interface CacheTotals {
  promptTokens: number;
  cachedTokens: number;
  turns: number;
  promptTurns: number;
  warmupTurns: number;
}

interface RtkTotals {
  commands: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  toolSavingsPct: number;
}

interface CacheObservation {
  runId: string;
  kind: PrefixCacheTurnKind;
  promptEpochId?: string;
  promptTokens: number;
  cachedTokens?: number;
  actualHit?: number;
  oracleHit?: number;
  cacheDiff?: number;
}

interface CacheEvidenceSummary {
  observations: CacheObservation[];
  byRun: Map<string, CacheObservation>;
}

interface RunSummary {
  event: SessionEvent;
  index: number;
  actualTokens: number;
  withoutRtkTokens: number;
  toolCalls: number;
  rtk: RtkSavingsSummary;
  cache?: CacheObservation;
}

export function renderTokenmaxxingLines(events: SessionEvent[], endpointEvidence: JsonObject[] = [], width = terminalWidth()): string[] {
  const cacheEvidence = buildCacheEvidence(endpointEvidence, events);
  const runs = runSummaries(events, cacheEvidence.byRun);
  const cache = cacheTotals(cacheEvidence.observations);
  const rtk = rtkTotals(runs);
  const actualTokens = runs.reduce((sum, run) => sum + run.actualTokens, 0);
  const estimatedWithout = actualTokens + cache.cachedTokens + rtk.savedTokens;
  const totalSaved = cache.cachedTokens + rtk.savedTokens;
  const lines = [
    fg256(39, "Tokenmaxxing"),
    [
      `${fg256(39, "saved")} ${totalSaved}`,
      `${fg256(39, "cache")} ${cache.cachedTokens}`,
      `${fg256(39, "rtk")} ${rtk.savedTokens}`,
      `${fg256(39, "model")} 0`,
      `${fg256(39, "tokens")} ${actualTokens}/${estimatedWithout}`,
    ].join(" · "),
    "",
    cacheLine(cache),
    rtkLine(rtk),
    fg256(244, "model selection · cost compute rates pending"),
  ];

  if (runs.length) {
    lines.push("", fg256(39, "Recent turns"));
    for (const run of runs.slice(-6).reverse()) {
      lines.push(`  ${turnLine(run, width - 2)}`);
    }
  }

  const activityEvents = events.filter(isTokenmaxxingActivityEvent).slice(-4);
  if (activityEvents.length) {
    lines.push("", fg256(39, "Recent signals"), ...renderSessionActivityLines(activityEvents, width).slice(-4).map((line) => `  ${line}`));
  }

  return lines.map((line) => truncateToWidth(line, width));
}

function runSummaries(events: SessionEvent[], cacheByRun: Map<string, CacheObservation>): RunSummary[] {
  return events
    .filter(isRunEvent)
    .map((event, index) => {
      const rtk = rtkSummary(event.data.rtk);
      const actualTokens = numberField(event.data.tokens);
      return {
        event,
        index: index + 1,
        actualTokens,
        withoutRtkTokens: rtk.estimated_without_rtk_tokens || actualTokens,
        toolCalls: numberField(event.data.tool_calls) || rtk.tool_calls,
        rtk,
        cache: event.run_id ? cacheByRun.get(event.run_id) : undefined,
      };
    });
}

function buildCacheEvidence(evidence: JsonObject[], events: readonly SessionEvent[]): CacheEvidenceSummary {
  const observations: CacheObservation[] = [];
  const byRun = new Map<string, CacheObservation>();
  const previousPromptByEpoch = new Map<string, number>();
  for (const item of evidence) {
    const runId = stringField(item.run_id);
    const usage = objectField(item.usage);
    const prompt = optionalNumberField(usage.prompt_tokens) ?? optionalNumberField(item.prompt_tokens);
    if (!runId || prompt === undefined || prompt <= 0) {
      continue;
    }
    const cached = optionalNumberField(usage.cached_prompt_tokens) ?? optionalNumberField(item.cached_prompt_tokens);
    const promptEpochId = stringField(item.prompt_epoch_id);
    const epochKey = promptEpochId ?? "__session__";
    const previousPrompt = previousPromptByEpoch.get(epochKey);
    const kind = previousPrompt === undefined ? (promptEpochId ? "warmup" : cacheTurnKind(events, runId)) : "hit";
    const actualHit = cached === undefined ? undefined : ratio(cached, prompt);
    const oracleHit = kind === "hit" && previousPrompt !== undefined ? ratio(Math.min(previousPrompt, prompt), prompt) : undefined;
    const cacheDiff = actualHit === undefined || oracleHit === undefined ? undefined : Math.max(0, oracleHit - actualHit);
    const observation: CacheObservation = {
      runId,
      kind,
      promptEpochId,
      promptTokens: prompt,
      cachedTokens: cached,
      actualHit,
      oracleHit,
      cacheDiff,
    };
    observations.push(observation);
    byRun.set(runId, observation);
    previousPromptByEpoch.set(epochKey, prompt);
  }
  return { observations, byRun };
}

function cacheTotals(observations: CacheObservation[]): CacheTotals {
  const totals: CacheTotals = { promptTokens: 0, cachedTokens: 0, turns: 0, promptTurns: 0, warmupTurns: 0 };
  for (const item of observations) {
    totals.turns += 1;
    if (item.kind === "warmup") {
      totals.warmupTurns += 1;
      continue;
    }
    if (item.cachedTokens !== undefined) {
      totals.promptTurns += 1;
      totals.promptTokens += item.promptTokens;
      totals.cachedTokens += item.cachedTokens;
    }
  }
  return totals;
}

function rtkTotals(runs: RunSummary[]): RtkTotals {
  const totals: RtkTotals = { commands: 0, inputTokens: 0, outputTokens: 0, savedTokens: 0, toolSavingsPct: 0 };
  for (const run of runs) {
    totals.commands += run.rtk.rtk_commands;
    totals.inputTokens += run.rtk.input_tokens;
    totals.outputTokens += run.rtk.output_tokens;
    totals.savedTokens += run.rtk.saved_tokens;
  }
  totals.toolSavingsPct = totals.inputTokens > 0 ? (totals.savedTokens / totals.inputTokens) * 100 : 0;
  return totals;
}

function cacheLine(cache: CacheTotals): string {
  if (!cache.promptTurns || !cache.promptTokens) {
    return fg256(244, cache.warmupTurns ? "prefix cache warming · no steady turns yet" : "prefix cache unavailable");
  }
  const hit = (cache.cachedTokens / cache.promptTokens) * 100;
  return [
    `${fg256(39, "prefix cache")} ${hit.toFixed(1)}%`,
    `cached ${cache.cachedTokens}/${cache.promptTokens}`,
    `${cache.promptTurns}/${Math.max(cache.promptTurns, cache.turns - cache.warmupTurns)} turns`,
    cache.warmupTurns ? `warmup ${cache.warmupTurns}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function rtkLine(rtk: RtkTotals): string {
  if (!rtk.commands) {
    return fg256(244, "tool compress · no rewritten commands");
  }
  return [
    `${fg256(39, "rtk")} ${rtk.commands} cmds`,
    `io ${rtk.inputTokens}->${rtk.outputTokens}`,
    `saved ${rtk.savedTokens}`,
    rtk.toolSavingsPct > 0 ? `tool ${rtk.toolSavingsPct.toFixed(1)}%` : undefined,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function turnLine(run: RunSummary, width: number): string {
  const parts = [
    `turn ${run.index}`,
    `tokens ${run.actualTokens}/${run.withoutRtkTokens}`,
    turnCacheLabel(run.cache),
    run.rtk.rtk_commands > 0 ? `rtk ${run.rtk.saved_tokens}` : undefined,
    `tools ${run.toolCalls}`,
  ];
  return truncateToWidth(parts.filter((part): part is string => Boolean(part)).join(" · "), width);
}

function turnCacheLabel(cache?: CacheObservation): string | undefined {
  if (!cache) {
    return undefined;
  }
  if (cache.kind === "warmup") {
    return "cache warmup";
  }
  if (cache.actualHit !== undefined && cache.oracleHit !== undefined) {
    return `actual/oracle cache ${formatCacheHit(cache.actualHit)}/${formatCacheHit(cache.oracleHit)} · cache diff ${formatCacheDiff(cache.cacheDiff ?? 0)}`;
  }
  if (cache.actualHit !== undefined) {
    return `cache ${formatCacheHit(cache.actualHit)}`;
  }
  if (cache.oracleHit !== undefined) {
    return `oracle cache ${formatCacheHit(cache.oracleHit)}`;
  }
  return undefined;
}

function isRunEvent(event: SessionEvent): boolean {
  return event.type === "run.completed" || event.type === "run.stopped" || event.type === "run.failed";
}

function isTokenmaxxingActivityEvent(event: SessionEvent): boolean {
  return event.type === "endpoint.evidence.recorded" || event.type === "run.completed" || event.type === "run.stopped" || event.type === "run.failed";
}

function rtkSummary(value: unknown): RtkSavingsSummary {
  const data = objectField(value);
  const status = stringField(data.status);
  return {
    tool_calls: numberField(data.tool_calls),
    rtk_tool_calls: numberField(data.rtk_tool_calls),
    rtk_commands: numberField(data.rtk_commands),
    input_tokens: numberField(data.input_tokens),
    output_tokens: numberField(data.output_tokens),
    saved_tokens: numberField(data.saved_tokens),
    savings_pct: numberField(data.savings_pct),
    estimated_without_rtk_tokens: numberField(data.estimated_without_rtk_tokens),
    status: status === "disabled" || status === "unavailable" || status === "partial" ? status : "ok",
  };
}

function objectField(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, numerator / denominator));
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCacheHit(value: number): string {
  return fg256(cacheHitColor(value), formatPercent(value));
}

function formatCacheDiff(value: number): string {
  return fg256(cacheDiffColor(value), formatPercent(value));
}

function cacheHitColor(value: number): number {
  if (value >= 0.8) {
    return 48;
  }
  if (value >= 0.5) {
    return 220;
  }
  return 203;
}

function cacheDiffColor(value: number): number {
  if (value < 0.1) {
    return 48;
  }
  if (value < 0.25) {
    return 220;
  }
  return 203;
}
