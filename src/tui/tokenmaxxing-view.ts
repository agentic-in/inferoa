import type { JsonObject, ModelUsage, RtkSavingsSummary, SessionEvent } from "../types.js";
import { ansi, bgLine, center, fg256, padRight, terminalHeight, terminalWidth, truncateToWidth, visibleWidth } from "./ansi.js";
import { formatDuration, type PrefixCacheTurnKind } from "./cache-footer.js";

export interface TokenmaxxingRenderOptions {
  detailLimit?: number;
  includeActivity?: boolean;
  activityOnly?: boolean;
}

export interface TokenmaxxingScreenOptions {
  providerName?: string;
}

export type TokenmaxxingRowKind = "summary" | "section" | "epoch" | "turn-header" | "turn" | "compact" | "trend" | "signal";

export interface TokenmaxxingScreenRow {
  text: string;
  kind: TokenmaxxingRowKind;
}

type TokenmaxxingScreenInputRow = string | TokenmaxxingScreenRow;

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
  stepId?: string;
  stepIndex?: number;
  callKey: string;
  kind: PrefixCacheTurnKind;
  promptEpochId?: string;
  promptTokens: number;
  cachedTokens?: number;
  actualHit?: number;
  oracleHit?: number;
  cacheDiff?: number;
}

interface CacheSource {
  runId: string;
  stepId?: string;
  stepIndex?: number;
  promptEpochId?: string;
  promptTokens: number;
  cachedTokens?: number;
  order: number;
}

interface CacheEvidenceSummary {
  observations: CacheObservation[];
  byRun: Map<string, CacheObservation>;
  byCall: Map<string, CacheObservation>;
}

interface RunSummary {
  kind: "run";
  event: SessionEvent;
  order: number;
  index: number;
  actualTokens: number;
  withoutRtkTokens: number;
  toolCalls: number;
  rtk: RtkSavingsSummary;
  cache?: CacheObservation;
  prefixCacheStatus?: string;
  latency: TurnLatency;
}

interface ModelCallSummary {
  kind: "model_call";
  event: SessionEvent;
  order: number;
  index: number;
  runOrdinal: number;
  runId: string;
  stepId?: string;
  stepIndex?: number;
  promptEpochId?: string;
  model?: string;
  previousModel?: string;
  route?: JsonObject;
  isRunStart: boolean;
  requestClass?: string;
  requestOrigin?: string;
  actualTokens: number;
  withoutRtkTokens: number;
  toolCalls: number;
  rtk: RtkSavingsSummary;
  cache?: CacheObservation;
  prefixCacheStatus?: string;
  latency: TurnLatency;
}

interface CompactionCallSummary {
  kind: "compaction";
  order: number;
  index: number;
  runOrdinal: number;
  runId: string;
  promptEpochId?: string;
  actualTokens: number;
  withoutRtkTokens: number;
  toolCalls: number;
  rtk: RtkSavingsSummary;
  cache?: CacheObservation;
  prefixCacheStatus?: string;
  latency: TurnLatency;
}

type TurnSummary = RunSummary | ModelCallSummary | CompactionCallSummary;

interface TokenmaxxingSignalItem {
  event: SessionEvent;
  order: number;
}

interface TurnLatency {
  ttftMs?: number;
  tpotMs?: number;
  durationMs?: number;
}

interface EpochSummary {
  promptEpochId: string;
  createdReason?: string;
  compactReason?: string;
  summaryStrategy?: string;
  archivedEvents?: number;
  compactTokensBefore?: number;
  compactTokensAfter?: number;
  promptMessagesBefore?: number;
  promptMessagesAfter?: number;
  compressedMessages?: number;
  protectedTailEvents?: number;
  preservedTailEvents?: number;
  preservedRounds?: number;
  preservedRunAnchorCount?: number;
  promptTurns: number;
  promptTokens: number;
  cachedTokens: number;
}

interface TokenmaxxingTrendPoint {
  label: string;
  event: string;
  promptEpochId?: string;
  actualTokens: number;
  withoutRtkTokens: number;
  promptTokens?: number;
  cachedTokens?: number;
  actualHit?: number;
  oracleHit?: number;
  cacheDiff?: number;
  prefixStatus?: string;
  toolCalls: number;
  rtkSaved: number;
}

interface TokenmaxxingTrendModel {
  points: TokenmaxxingTrendPoint[];
  cache: CacheTotals;
  rtk: RtkTotals;
  compactEvents: EpochSummary[];
}

interface TrendChartSeries {
  label: string;
  values: Array<number | undefined>;
  color: number;
  formatValue: (value: number) => string;
  domain?: TrendValueDomain;
}

interface TrendValueDomain {
  min: number;
  max: number;
}

interface TrendChartDefinition {
  xLabels: string[];
  series: TrendChartSeries[];
  emptyMessage?: string;
}

interface TrendPanelDefinition {
  title: string;
  chart(model: TokenmaxxingTrendModel): TrendChartDefinition;
}

export function renderTokenmaxxingLines(
  events: SessionEvent[],
  endpointEvidence: JsonObject[] = [],
  width = terminalWidth(),
  options: TokenmaxxingRenderOptions = {},
): string[] {
  return renderTokenmaxxingRows(events, endpointEvidence, width, options).map((row) => row.text);
}

export function renderTokenmaxxingRows(
  events: SessionEvent[],
  endpointEvidence: JsonObject[] = [],
  width = terminalWidth(),
  options: TokenmaxxingRenderOptions = {},
): TokenmaxxingScreenRow[] {
  const contentWidth = Math.max(20, width - 2);
  const cacheEvidence = buildCacheEvidence(endpointEvidence, events);
  const latencyEvidence = buildLatencyEvidence(endpointEvidence, events);
  const runs = runSummaries(events, cacheEvidence.byRun);
  const modelCalls = modelCallSummaries(events, cacheEvidence.byCall, latencyEvidence);
  const compactionCalls = compactionCallSummaries(endpointEvidence, events, cacheEvidence.byCall, latencyEvidence);
  const modelDetailTurns = [...modelCalls, ...compactionCalls].sort((left, right) => left.order - right.order);
  const detailTurns: TurnSummary[] = modelDetailTurns.length ? modelDetailTurns : runs;
  const cache = cacheTotals(cacheEvidence.observations);
  const rtk = rtkTotals(events, runs);
  const actualTokens = detailTurns.length
    ? detailTurns.reduce((sum, turn) => sum + turn.actualTokens, 0)
    : runs.reduce((sum, run) => sum + run.actualTokens, 0);
  const estimatedWithout = actualTokens + cache.cachedTokens + rtk.savedTokens;
  const totalSaved = cache.cachedTokens + rtk.savedTokens;
  const rows: TokenmaxxingScreenRow[] = [];
  if (!options.activityOnly) {
    rows.push(...summaryRows(cache, rtk, totalSaved, actualTokens, estimatedWithout, contentWidth));
  }

  if (!options.activityOnly && detailTurns.length) {
    const limit = options.detailLimit ?? 6;
    const recentTurns = Number.isFinite(limit) ? detailTurns.slice(-Math.max(0, limit)) : detailTurns;
    const epochs = epochSummaries(events, cacheEvidence.observations, endpointEvidence);
    rows.push(row(turnTableHeader(contentWidth), "turn-header"));
    let currentEpoch: string | undefined;
    for (const turn of recentTurns.slice().reverse()) {
      const epochId = turnEpochId(turn);
      if (epochId && epochId !== currentEpoch) {
        rows.push(row(epochLine(epochs.get(epochId) ?? emptyEpochSummary(epochId), contentWidth), "epoch"));
        currentEpoch = epochId;
      }
      rows.push(row(turnLine(turn, contentWidth), turn.kind === "compaction" ? "compact" : "turn"));
    }
  }

  const includeActivity = options.activityOnly || (options.includeActivity ?? false);
  const tokenmaxxingActivityEvents = includeActivity ? tokenmaxxingActivityItems(events) : [];
  const activityEvents = options.activityOnly ? tokenmaxxingActivityEvents.slice(-80) : tokenmaxxingActivityEvents.slice(-4);
  if (activityEvents.length) {
    rows.push(...tokenmaxxingSignalRows(events, activityEvents, contentWidth));
  }

  if (options.activityOnly && !activityEvents.length) {
    rows.push(row(fg256(244, "No tokenmaxxing signals yet."), "signal"));
  }

  return rows.map((item) => ({ ...item, text: truncateToWidth(singleLine(item.text), contentWidth) }));
}

export function renderTokenmaxxingScreen(
  body: readonly TokenmaxxingScreenInputRow[],
  width = terminalWidth(),
  height = terminalHeight(),
  pageIndex = 0,
  options: TokenmaxxingScreenOptions = {},
): string[] {
  const safeWidth = Math.max(32, Math.floor(width));
  const safeHeight = Math.max(6, Math.floor(height));
  const bodyRows = body.map(normalizeScreenRow);
  const sticky = leadingSummaryRows(bodyRows);
  const pagedRows = bodyRows.slice(sticky.length);
  const contentHeight = Math.max(1, safeHeight - 2 - sticky.length);
  const total = pagedRows.length;
  const pageCount = tokenmaxxingScreenPageCount(bodyRows, safeHeight);
  const page = Math.max(0, Math.min(Math.floor(pageIndex), pageCount - 1));
  const top = page * contentHeight;
  const visible = pagedRows.slice(top, top + contentHeight);
  const firstVisible = total ? top + 1 : 0;
  const lastVisible = total ? Math.min(total, top + contentHeight) : 0;
  const providerName = singleLine(options.providerName ?? "vLLM").trim() || "vLLM";
  const title = `${fg256(39, "Tokenmaxxing")}${fg256(244, " · ")}${fg256(252, `${ansi.bold}${providerName}${ansi.reset}`)}`;
  const range = total ? `${firstVisible}-${lastVisible} / ${total}` : "0 / 0";
  const pageLabel = `page ${page + 1}/${pageCount}`;
  const headerRight = `${pageLabel} · ${range}`;
  const rows = [
    bgLine(234, fitLeftRight(`  ${title}`, fg256(244, headerRight), safeWidth), safeWidth),
    ...sticky.map((item) => renderScreenRow(item, safeWidth)),
    ...visible.map((item) => renderScreenRow(item, safeWidth)),
  ];
  while (rows.length < safeHeight - 1) {
    rows.push(bgLine(234, "", safeWidth));
  }
  const footerLeft = `${fg256(252, "esc")} exit   ${fg256(252, "ctrl+c")} exit   ${fg256(252, "←/→")} page`;
  const footerRight = pageLabel;
  rows.push(bgLine(234, fitLeftRight(` ${footerLeft}`, fg256(244, footerRight), safeWidth), safeWidth));
  return rows.slice(0, safeHeight);
}

export function tokenmaxxingScreenPageCount(
  body: readonly TokenmaxxingScreenInputRow[],
  height = terminalHeight(),
): number {
  const safeHeight = Math.max(6, Math.floor(height));
  const bodyRows = body.map(normalizeScreenRow);
  const sticky = leadingSummaryRows(bodyRows);
  const contentHeight = Math.max(1, safeHeight - 2 - sticky.length);
  const total = Math.max(0, bodyRows.length - sticky.length);
  return Math.max(1, Math.ceil(total / contentHeight));
}

export function tokenmaxxingTrendPageCount(): number {
  return TREND_PANELS.length;
}

export function renderTokenmaxxingTrendScreen(
  events: SessionEvent[],
  endpointEvidence: JsonObject[] = [],
  width = terminalWidth(),
  height = terminalHeight(),
  pageIndex = 0,
): string[] {
  const safeWidth = Math.max(32, Math.floor(width));
  const safeHeight = Math.max(6, Math.floor(height));
  const pageCount = tokenmaxxingTrendPageCount();
  const page = Math.max(0, Math.min(Math.floor(pageIndex), pageCount - 1));
  const panel = TREND_PANELS[page]!;
  const model = tokenmaxxingTrendModel(events, endpointEvidence);
  const contentHeight = Math.max(1, safeHeight - 2);
  const chart = panel.chart(model);
  const title = `${fg256(87, "Tokenmaxxing")} ${fg256(244, `trend · ${panel.title}`)}`;
  const headerRight = `metric ${page + 1}/${pageCount}`;
  const rows = [
    bgLine(234, fitLeftRight(`  ${title}`, fg256(244, headerRight), safeWidth), safeWidth),
    ...renderTrendCoordinateChart(chart, safeWidth, contentHeight).map((line) => bgLine(234, line, safeWidth)),
  ];
  while (rows.length < safeHeight - 1) {
    rows.push(bgLine(234, "", safeWidth));
  }
  const footerLeft = `${fg256(252, "esc")} exit   ${fg256(252, "ctrl+c")} exit   ${fg256(252, "←/→")} metric`;
  rows.push(bgLine(234, fitLeftRight(` ${footerLeft}`, fg256(244, headerRight), safeWidth), safeWidth));
  return rows.slice(0, safeHeight);
}

function row(text: string, kind: TokenmaxxingRowKind): TokenmaxxingScreenRow {
  return { text, kind };
}

function normalizeScreenRow(item: TokenmaxxingScreenInputRow): TokenmaxxingScreenRow {
  const normalized = typeof item === "string" ? row(item, "turn") : item;
  return { ...normalized, text: singleLine(normalized.text) };
}

function renderScreenRow(item: TokenmaxxingScreenRow, safeWidth: number): string {
  if (item.kind === "epoch") {
    return bgLine(rowBackground(item), center(item.text, safeWidth), safeWidth);
  }
  return bgLine(rowBackground(item), ` ${truncateToWidth(item.text, safeWidth - 2)}`, safeWidth);
}

function rowBackground(row: TokenmaxxingScreenRow): number {
  switch (row.kind) {
    case "epoch":
      return 24;
    case "compact":
      return 235;
    case "turn-header":
    case "section":
    case "trend":
      return 235;
    default:
      return 234;
  }
}

function leadingSummaryRows(rows: readonly TokenmaxxingScreenRow[]): TokenmaxxingScreenRow[] {
  const out: TokenmaxxingScreenRow[] = [];
  for (const item of rows) {
    if (item.kind !== "summary") {
      break;
    }
    out.push(item);
  }
  return out;
}

function singleLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").trimEnd();
}

function fitLeftRight(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap > 0) {
    return `${left}${" ".repeat(gap)}${right}`;
  }
  const leftWidth = Math.max(0, width - visibleWidth(right) - 1);
  return `${truncateToWidth(left, leftWidth)} ${right}`;
}

function runSummaries(events: SessionEvent[], cacheByRun: Map<string, CacheObservation>): RunSummary[] {
  return events
    .filter(isRunEvent)
    .map((event, index) => {
      const rtk = rtkSummary(event.data.rtk);
      const actualTokens = numberField(event.data.tokens);
      return {
        kind: "run",
        event,
        order: events.indexOf(event),
        index: index + 1,
        actualTokens,
        withoutRtkTokens: rtk.estimated_without_rtk_tokens || actualTokens,
        toolCalls: numberField(event.data.tool_calls) || rtk.tool_calls,
        rtk,
        cache: event.run_id ? cacheByRun.get(event.run_id) : undefined,
        latency: latencyFromData(event.data),
      };
    });
}

function modelCallSummaries(events: SessionEvent[], cacheByCall: Map<string, CacheObservation>, latencyByCall: Map<string, TurnLatency>): ModelCallSummary[] {
  const runOrdinals = runOrdinalMap(events);
  const requestByCall = modelRequestByCall(events);
  const loopOriginByRun = loopOriginByRunPrompt(events);
  const seenRuns = new Set<string>();
  const calls: ModelCallSummary[] = events
    .map((event, order) => ({ event, order }))
    .filter(({ event }) => event.type === "model.response.settled" && Boolean(event.run_id))
    .map(({ event, order }, index) => {
      const runId = event.run_id!;
      const stepId = stringField(event.data.step_id);
      const stepIndex = optionalNumberField(event.data.step_index);
      const actualTokens = modelUsageTokenCost(usageField(event.data.usage));
      const toolCalls = toolCallCount(event.data.tool_calls);
      const rtk = rtkSummaryForStep(events, runId, stepId, stepIndex, actualTokens, toolCalls);
      const callKey = cacheCallKey(runId, stepId, stepIndex);
      const request = requestByCall.get(callKey);
      const cache = cacheByCall.get(callKey);
      const latency = mergeLatency(latencyFromData(event.data, usageField(event.data.usage)), latencyByCall.get(callKey), usageField(event.data.usage));
      const isRunStart = !seenRuns.has(runId);
      const model = modelCallModel(event.data, request);
      const route = objectField(event.data.route);
      seenRuns.add(runId);
      return {
        kind: "model_call" as const,
        event,
        order,
        index: index + 1,
        runOrdinal: runOrdinals.get(runId) ?? index + 1,
        runId,
        stepId,
        stepIndex,
        promptEpochId: cache?.promptEpochId ?? stringField(event.data.prompt_epoch_id) ?? stringField(request?.prompt_epoch_id),
        model,
        route: Object.keys(route).length ? route : undefined,
        isRunStart,
        requestClass: stringField(event.data.request_class) ?? stringField(request?.request_class),
        requestOrigin: stringField(event.data.request_origin) ?? stringField(request?.request_origin) ?? loopOriginByRun.get(runId),
        actualTokens,
        withoutRtkTokens: actualTokens + rtk.saved_tokens,
        toolCalls,
        rtk,
        cache,
        prefixCacheStatus: stringField(request?.prefix_cache_status),
        latency,
      };
    });
  let previousModel: string | undefined;
  for (const call of calls) {
    if (call.model && previousModel && previousModel !== call.model) {
      call.previousModel = previousModel;
    }
    if (call.model) {
      previousModel = call.model;
    }
  }
  return calls;
}

function modelCallModel(data: JsonObject, request: JsonObject | undefined): string | undefined {
  return selectedModelFromRoute(objectField(data.route)) ?? stringField(data.model) ?? stringField(request?.model);
}

function selectedModelFromRoute(route: JsonObject): string | undefined {
  return (
    stringField(route["x-vsr-selected-model"]) ??
    stringField(route["x-selected-model"]) ??
    stringField(route["x-router-model"])
  );
}

function compactionCallSummaries(evidence: JsonObject[], events: SessionEvent[], cacheByCall: Map<string, CacheObservation>, latencyByCall: Map<string, TurnLatency>): CompactionCallSummary[] {
  const runOrdinals = runOrdinalMap(events);
  const eventOrder = endpointEvidenceEventOrder(events);
  return evidence
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => stringField(item.request_class) === "compaction" && Boolean(stringField(item.run_id)))
    .map(({ item, index }) => {
      const runId = String(item.run_id);
      const stepId = stringField(item.step_id);
      const stepIndex = optionalNumberField(item.step_index);
      const usage = usageField(item.usage);
      const actualTokens = modelUsageTokenCost(usage);
      const callKey = cacheCallKey(runId, stepId, stepIndex);
      const cache = cacheByCall.get(callKey);
      const latency = mergeLatency(latencyFromData(item, usage), latencyByCall.get(callKey), usage);
      return {
        kind: "compaction" as const,
        order: eventOrder.get(endpointEvidenceKey(item)) ?? 1_000_000 + index,
        index: index + 1,
        runOrdinal: runOrdinals.get(runId) ?? runOrdinals.size + index + 1,
        runId,
        promptEpochId: cache?.promptEpochId ?? stringField(item.prompt_epoch_id),
        actualTokens,
        withoutRtkTokens: actualTokens,
        toolCalls: 0,
        rtk: rtkSummary(undefined),
        cache,
        prefixCacheStatus: stringField(item.prefix_cache_status),
        latency,
      };
    });
}

function endpointEvidenceEventOrder(events: SessionEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  events.forEach((event, index) => {
    if (!event.run_id || event.type !== "endpoint.evidence.recorded") {
      return;
    }
    out.set(endpointEvidenceKey(event.data, event.run_id), index);
  });
  return out;
}

function endpointEvidenceKey(data: JsonObject, fallbackRunId?: string): string {
  return [stringField(data.run_id) ?? fallbackRunId ?? "", stringField(data.request_id) ?? "", stringField(data.prompt_hash) ?? ""].join(":");
}

function buildLatencyEvidence(evidence: JsonObject[], events: readonly SessionEvent[]): Map<string, TurnLatency> {
  const out = new Map<string, TurnLatency>();
  const put = (runId: string | undefined, data: JsonObject, usage?: ModelUsage) => {
    if (!runId) {
      return;
    }
    const latency = latencyFromData(data, usage);
    if (!hasLatency(latency)) {
      return;
    }
    out.set(cacheCallKey(runId, stringField(data.step_id), optionalNumberField(data.step_index)), latency);
  };
  for (const event of events) {
    if (event.type === "endpoint.evidence.recorded") {
      put(event.run_id ?? stringField(event.data.run_id), event.data, usageField(event.data.usage));
    }
  }
  for (const item of evidence) {
    put(stringField(item.run_id), item, usageField(item.usage));
  }
  return out;
}

function latencyFromData(data: JsonObject, usage?: ModelUsage): TurnLatency {
  const timings = objectField(data.timings);
  return deriveLatency({
    ttftMs: firstNumberField(data, timings, ["ttft_ms", "time_to_first_token_ms", "first_token_ms", "first_delta_ms"]),
    tpotMs: firstNumberField(data, timings, ["tpot_ms", "time_per_output_token_ms", "time_per_token_ms", "ms_per_output_token"]),
    durationMs: firstNumberField(data, timings, ["duration_ms", "latency_ms", "elapsed_ms", "total_ms"]),
  }, usage);
}

function mergeLatency(primary: TurnLatency, fallback: TurnLatency | undefined, usage?: ModelUsage): TurnLatency {
  return deriveLatency({
    ttftMs: primary.ttftMs ?? fallback?.ttftMs,
    tpotMs: primary.tpotMs ?? fallback?.tpotMs,
    durationMs: primary.durationMs ?? fallback?.durationMs,
  }, usage);
}

function deriveLatency(latency: TurnLatency, usage?: ModelUsage): TurnLatency {
  if (latency.tpotMs !== undefined || latency.durationMs === undefined) {
    return latency;
  }
  const completionTokens = optionalNumberField(usage?.completion_tokens);
  if (completionTokens === undefined || completionTokens <= 0) {
    return latency;
  }
  const generationMs = latency.ttftMs === undefined ? latency.durationMs : Math.max(0, latency.durationMs - latency.ttftMs);
  return {
    ...latency,
    tpotMs: generationMs / completionTokens,
  };
}

function hasLatency(latency: TurnLatency): boolean {
  return latency.ttftMs !== undefined || latency.tpotMs !== undefined || latency.durationMs !== undefined;
}

function firstNumberField(primary: JsonObject, secondary: JsonObject, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = optionalNumberField(primary[key]) ?? optionalNumberField(secondary[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function modelRequestByCall(events: SessionEvent[]): Map<string, JsonObject> {
  const out = new Map<string, JsonObject>();
  for (const event of events) {
    if (!event.run_id || event.type !== "model.request.started") {
      continue;
    }
    out.set(cacheCallKey(event.run_id, stringField(event.data.step_id), optionalNumberField(event.data.step_index)), event.data);
  }
  return out;
}

function buildCacheEvidence(evidence: JsonObject[], events: readonly SessionEvent[]): CacheEvidenceSummary {
  const observations: CacheObservation[] = [];
  const byRun = new Map<string, CacheObservation>();
  const byCall = new Map<string, CacheObservation>();
  const previousPromptByEpoch = new Map<string, number>();
  const sources = cacheSources(evidence, events);
  const warmupCallKeys = epochWarmupCallKeys(sources);
  const seen = new Set<string>();
  let previousPromptInSession: number | undefined;
  for (const source of sources) {
    const callKey = cacheCallKey(source.runId, source.stepId, source.stepIndex);
    if (seen.has(callKey)) {
      continue;
    }
    seen.add(callKey);
    const epochKey = source.promptEpochId ?? "__session__";
    const previousPrompt = previousPromptByEpoch.get(epochKey) ?? previousPromptInSession;
    const kind: PrefixCacheTurnKind = warmupCallKeys.has(callKey) ? "warmup" : "hit";
    const actualHit = source.cachedTokens === undefined ? undefined : ratio(source.cachedTokens, source.promptTokens);
    const oracleHit = previousPrompt !== undefined ? ratio(Math.min(previousPrompt, source.promptTokens), source.promptTokens) : undefined;
    const cacheDiff = actualHit === undefined || oracleHit === undefined ? undefined : Math.max(0, oracleHit - actualHit);
    const observation: CacheObservation = {
      runId: source.runId,
      stepId: source.stepId,
      stepIndex: source.stepIndex,
      callKey,
      kind,
      promptEpochId: source.promptEpochId,
      promptTokens: source.promptTokens,
      cachedTokens: source.cachedTokens,
      actualHit,
      oracleHit,
      cacheDiff,
    };
    observations.push(observation);
    byRun.set(source.runId, observation);
    byCall.set(callKey, observation);
    previousPromptByEpoch.set(epochKey, source.promptTokens);
    previousPromptInSession = source.promptTokens;
  }
  return { observations, byRun, byCall };
}

function cacheSources(evidence: JsonObject[], events: readonly SessionEvent[]): CacheSource[] {
  const sources: CacheSource[] = [];
  const requestByCall = new Map<string, JsonObject>();
  events.forEach((event, index) => {
    if (!event.run_id || event.type !== "model.request.started") {
      return;
    }
    requestByCall.set(cacheCallKey(event.run_id, stringField(event.data.step_id), optionalNumberField(event.data.step_index)), event.data);
  });
  events.forEach((event, index) => {
    if (!event.run_id || event.type !== "model.response.settled") {
      return;
    }
    const usage = usageField(event.data.usage);
    const prompt = optionalNumberField(usage?.prompt_tokens);
    if (prompt === undefined || prompt <= 0) {
      return;
    }
    const stepId = stringField(event.data.step_id);
    const stepIndex = optionalNumberField(event.data.step_index);
    const request = requestByCall.get(cacheCallKey(event.run_id, stepId, stepIndex)) ?? {};
    sources.push({
      runId: event.run_id,
      stepId,
      stepIndex,
      promptEpochId: stringField(event.data.prompt_epoch_id) ?? stringField(request.prompt_epoch_id),
      promptTokens: prompt,
      cachedTokens: optionalNumberField(usage?.cached_prompt_tokens),
      order: index,
    });
  });
  evidence.forEach((item, index) => {
    const runId = stringField(item.run_id);
    const usage = objectField(item.usage);
    const prompt = optionalNumberField(usage.prompt_tokens) ?? optionalNumberField(item.prompt_tokens);
    if (!runId || prompt === undefined || prompt <= 0) {
      return;
    }
    sources.push({
      runId,
      stepId: stringField(item.step_id),
      stepIndex: optionalNumberField(item.step_index),
      promptEpochId: stringField(item.prompt_epoch_id),
      promptTokens: prompt,
      cachedTokens: optionalNumberField(usage.cached_prompt_tokens) ?? optionalNumberField(item.cached_prompt_tokens),
      order: 1_000_000 + index,
    });
  });
  return sources.sort((left, right) => left.order - right.order);
}

function epochWarmupCallKeys(sources: CacheSource[]): Set<string> {
  const out = new Set<string>();
  const seenEpochs = new Set<string>();
  for (const source of sources) {
    const epochKey = source.promptEpochId ?? "__session__";
    if (seenEpochs.has(epochKey)) {
      continue;
    }
    seenEpochs.add(epochKey);
    out.add(cacheCallKey(source.runId, source.stepId, source.stepIndex));
  }
  return out;
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

function epochSummaries(events: SessionEvent[], observations: CacheObservation[], evidence: JsonObject[]): Map<string, EpochSummary> {
  const out = new Map<string, EpochSummary>();
  const compactTokenDeltas = compactTokenDeltasByEpoch(events, evidence, observations);
  for (const observation of observations) {
    if (!observation.promptEpochId) {
      continue;
    }
    const summary = ensureEpochSummary(out, observation.promptEpochId);
    if (observation.kind !== "warmup" && observation.cachedTokens !== undefined) {
      summary.promptTurns += 1;
      summary.promptTokens += observation.promptTokens;
      summary.cachedTokens += observation.cachedTokens;
    }
  }
  for (const event of events) {
    if (event.type === "prompt.epoch.created") {
      const epochId = stringField(event.data.prompt_epoch_id);
      if (!epochId) {
        continue;
      }
      const summary = ensureEpochSummary(out, epochId);
      summary.createdReason = stringField(event.data.reason);
    } else if (event.type === "evidence.context_compression") {
      const epochId = stringField(event.data.epoch_id) ?? stringField(event.data.prompt_epoch_id);
      if (!epochId) {
        continue;
      }
      const summary = ensureEpochSummary(out, epochId);
      summary.compactReason = stringField(event.data.reason);
      summary.summaryStrategy = stringField(event.data.summary_strategy);
      summary.archivedEvents = optionalNumberField(event.data.archived_events);
      const tokenDelta = compactTokenDeltas.get(epochId);
      summary.compactTokensBefore = tokenDelta?.before;
      summary.compactTokensAfter = tokenDelta?.after;
      summary.promptMessagesBefore = optionalNumberField(event.data.prompt_messages_before);
      summary.promptMessagesAfter = optionalNumberField(event.data.prompt_messages_after);
      summary.compressedMessages = optionalNumberField(event.data.compressed_messages);
      summary.protectedTailEvents = optionalNumberField(event.data.protected_tail_events);
      summary.preservedTailEvents = optionalNumberField(event.data.preserved_tail_events);
      summary.preservedRounds = optionalNumberField(event.data.preserved_rounds);
      summary.preservedRunAnchorCount = optionalNumberField(event.data.preserved_run_anchor_count);
    }
  }
  return out;
}

function compactTokenDeltasByEpoch(
  events: SessionEvent[],
  evidence: JsonObject[],
  observations: CacheObservation[],
): Map<string, { before?: number; after?: number }> {
  const firstPromptByEpoch = firstPromptTokensByEpoch(observations);
  const fallbackCompactionPrompts = compactionPromptTokensFromEvidence(evidence);
  const out = new Map<string, { before?: number; after?: number }>();
  let latestCompactionPrompt: number | undefined;
  let fallbackIndex = 0;
  for (const event of events) {
    if (event.type === "endpoint.evidence.recorded" && stringField(event.data.request_class) === "compaction") {
      latestCompactionPrompt = promptTokensFromEvidenceData(event.data);
      continue;
    }
    if (event.type !== "evidence.context_compression") {
      continue;
    }
    const epochId = stringField(event.data.epoch_id) ?? stringField(event.data.prompt_epoch_id);
    if (!epochId) {
      continue;
    }
    const before = latestCompactionPrompt ?? fallbackCompactionPrompts[fallbackIndex];
    if (latestCompactionPrompt === undefined && before !== undefined) {
      fallbackIndex += 1;
    }
    latestCompactionPrompt = undefined;
    out.set(epochId, {
      before,
      after: firstPromptByEpoch.get(epochId),
    });
  }
  return out;
}

function firstPromptTokensByEpoch(observations: CacheObservation[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const observation of observations) {
    if (!observation.promptEpochId || out.has(observation.promptEpochId)) {
      continue;
    }
    out.set(observation.promptEpochId, observation.promptTokens);
  }
  return out;
}

function compactionPromptTokensFromEvidence(evidence: JsonObject[]): number[] {
  const out: number[] = [];
  for (const item of evidence) {
    if (stringField(item.request_class) !== "compaction") {
      continue;
    }
    const prompt = promptTokensFromEvidenceData(item);
    if (prompt !== undefined) {
      out.push(prompt);
    }
  }
  return out;
}

function promptTokensFromEvidenceData(data: JsonObject): number | undefined {
  const usage = objectField(data.usage);
  return optionalNumberField(usage.prompt_tokens) ?? optionalNumberField(data.prompt_tokens);
}

function ensureEpochSummary(map: Map<string, EpochSummary>, epochId: string): EpochSummary {
  let summary = map.get(epochId);
  if (!summary) {
    summary = emptyEpochSummary(epochId);
    map.set(epochId, summary);
  }
  return summary;
}

function emptyEpochSummary(epochId: string): EpochSummary {
  return {
    promptEpochId: epochId,
    promptTurns: 0,
    promptTokens: 0,
    cachedTokens: 0,
  };
}

function rtkTotals(events: SessionEvent[], runs: RunSummary[]): RtkTotals {
  const rtkEvents = events.filter((event) => event.type === "rtk.tool_savings");
  if (rtkEvents.length) {
    return rtkTotalsFromSummaries(rtkEvents.map((event) => rtkSummary(event.data)));
  }
  return rtkTotalsFromSummaries(runs.map((run) => run.rtk));
}

function rtkTotalsFromSummaries(summaries: RtkSavingsSummary[]): RtkTotals {
  const totals: RtkTotals = { commands: 0, inputTokens: 0, outputTokens: 0, savedTokens: 0, toolSavingsPct: 0 };
  for (const rtk of summaries) {
    totals.commands += rtk.rtk_commands;
    totals.inputTokens += rtk.input_tokens;
    totals.outputTokens += rtk.output_tokens;
    totals.savedTokens += rtk.saved_tokens;
  }
  totals.toolSavingsPct = totals.inputTokens > 0 ? (totals.savedTokens / totals.inputTokens) * 100 : 0;
  return totals;
}

const TREND_PANELS: TrendPanelDefinition[] = [
  {
    title: "overview",
    chart: trendOverviewChart,
  },
  {
    title: "cache",
    chart: trendCacheChart,
  },
  {
    title: "prefix",
    chart: trendPrefixChart,
  },
  {
    title: "context",
    chart: trendContextChart,
  },
  {
    title: "rtk-tools",
    chart: trendRtkChart,
  },
  {
    title: "compact",
    chart: trendCompactChart,
  },
];

function tokenmaxxingTrendModel(events: SessionEvent[], endpointEvidence: JsonObject[]): TokenmaxxingTrendModel {
  const cacheEvidence = buildCacheEvidence(endpointEvidence, events);
  const latencyEvidence = buildLatencyEvidence(endpointEvidence, events);
  const modelCalls = modelCallSummaries(events, cacheEvidence.byCall, latencyEvidence);
  const compactionCalls = compactionCallSummaries(endpointEvidence, events, cacheEvidence.byCall, latencyEvidence);
  const turns = [...modelCalls, ...compactionCalls].sort((left, right) => left.order - right.order);
  const runFallback = runSummaries(events, cacheEvidence.byRun);
  const detailTurns: TurnSummary[] = turns.length ? turns : runFallback;
  const points = detailTurns.map((turn) => {
    const cache = turn.cache;
    return {
      label: trendTurnLabel(turn),
      event: turn.kind === "compaction" ? "compact" : turn.kind === "model_call" ? modelCallEventName(turn) : "run",
      promptEpochId: turnEpochId(turn),
      actualTokens: turn.actualTokens,
      withoutRtkTokens: turn.withoutRtkTokens,
      promptTokens: cache?.promptTokens,
      cachedTokens: cache?.cachedTokens,
      actualHit: cache?.actualHit,
      oracleHit: cache?.oracleHit,
      cacheDiff: cache?.cacheDiff,
      prefixStatus: turn.kind === "run" ? undefined : turn.prefixCacheStatus,
      toolCalls: turn.toolCalls,
      rtkSaved: turn.rtk.saved_tokens,
    };
  });
  const compactEvents = Array.from(epochSummaries(events, cacheEvidence.observations, endpointEvidence).values())
    .filter((epoch) => epoch.compactReason || epoch.compactTokensBefore !== undefined || epoch.promptMessagesBefore !== undefined)
    .sort((left, right) => compactEpochSortKey(left) - compactEpochSortKey(right));
  return {
    points,
    cache: cacheTotals(cacheEvidence.observations),
    rtk: rtkTotals(events, runFallback),
    compactEvents,
  };
}

function compactEpochSortKey(epoch: EpochSummary): number {
  return Number(epoch.promptEpochId.replace(/\D/g, "").slice(0, 8)) || 0;
}

const PERCENT_TREND_DOMAIN: TrendValueDomain = { min: 0, max: 1 };

function trendOverviewChart(model: TokenmaxxingTrendModel): TrendChartDefinition {
  const points = model.points;
  return {
    xLabels: points.map((point) => point.label),
    series: [
      trendSeries("prompt tokens", points.map((point) => point.promptTokens), 39, formatInteger),
      trendSeries("total tokens", points.map((point) => point.actualTokens), 75, formatInteger),
      trendSeries("cache hit", points.map((point) => point.actualHit), 48, formatPlainPct, PERCENT_TREND_DOMAIN),
    ],
    emptyMessage: "No model calls yet.",
  };
}

function trendCacheChart(model: TokenmaxxingTrendModel): TrendChartDefinition {
  const points = model.points;
  return {
    xLabels: points.map((point) => point.label),
    series: [
      trendSeries("actual hit", points.map((point) => point.actualHit), 48, formatPlainPct, PERCENT_TREND_DOMAIN),
      trendSeries("oracle hit", points.map((point) => point.oracleHit), 75, formatPlainPct, PERCENT_TREND_DOMAIN),
      trendSeries("cache gap", points.map((point) => point.cacheDiff), 203, formatPlainPct, PERCENT_TREND_DOMAIN),
      trendSeries("cached tokens", points.map((point) => point.cachedTokens), 39, formatInteger),
    ],
    emptyMessage: "No cache evidence yet.",
  };
}

function trendPrefixChart(model: TokenmaxxingTrendModel): TrendChartDefinition {
  const points = model.points;
  return {
    xLabels: points.map((point) => point.label),
    series: [
      trendSeries(
        "safe rate",
        rollingRate(points.map((point) => point.prefixStatus === "changed" ? 0 : 1), 8),
        48,
        formatPlainPct,
        PERCENT_TREND_DOMAIN,
      ),
      trendSeries("cache gap", points.map((point) => point.cacheDiff), 75, formatPlainPct, PERCENT_TREND_DOMAIN),
    ],
    emptyMessage: "No prefix-cache requests yet.",
  };
}

function trendContextChart(model: TokenmaxxingTrendModel): TrendChartDefinition {
  const points = model.points;
  return {
    xLabels: points.map((point) => point.label),
    series: [
      trendSeries("prompt tokens", points.map((point) => point.promptTokens), 39, formatInteger),
      trendSeries("total tokens", points.map((point) => point.actualTokens), 75, formatInteger),
      trendSeries("cache gap", points.map((point) => point.cacheDiff), 203, formatPlainPct, PERCENT_TREND_DOMAIN),
    ],
    emptyMessage: "No context pressure evidence yet.",
  };
}

function trendRtkChart(model: TokenmaxxingTrendModel): TrendChartDefinition {
  const points = model.points;
  return {
    xLabels: points.map((point) => point.label),
    series: [
      trendSeries("rtk saved", points.map((point) => point.rtkSaved), 48, formatInteger),
      trendSeries("tool calls", points.map((point) => point.toolCalls), 75, formatInteger),
      trendSeries("without rtk", points.map((point) => point.withoutRtkTokens), 39, formatInteger),
    ],
    emptyMessage: "No RTK or tool evidence yet.",
  };
}

function trendCompactChart(model: TokenmaxxingTrendModel): TrendChartDefinition {
  const compacts = model.compactEvents;
  return {
    xLabels: compacts.map((item) => shortEpochId(item.promptEpochId)),
    series: [
      trendSeries("tokens before", compacts.map((item) => item.compactTokensBefore), 203, formatInteger),
      trendSeries("tokens after", compacts.map((item) => item.compactTokensAfter), 48, formatInteger),
      trendSeries("messages saved", compacts.map((item) => item.compressedMessages), 75, formatInteger),
    ],
    emptyMessage: "No compact events yet.",
  };
}

function trendSeries(
  label: string,
  values: Array<number | undefined>,
  color: number,
  formatValue: (value: number) => string,
  domain?: TrendValueDomain,
): TrendChartSeries {
  return { label, values, color, formatValue, domain };
}

interface TrendScale {
  min: number;
  max: number;
  formatValue: (value: number) => string;
}

function renderTrendCoordinateChart(chart: TrendChartDefinition, width: number, height: number): string[] {
  const safeWidth = Math.max(32, Math.floor(width));
  const safeHeight = Math.max(4, Math.floor(height));
  const axisWidth = Math.min(11, Math.max(7, Math.floor(safeWidth * 0.1)));
  const plotWidth = Math.max(8, safeWidth - axisWidth - 3);
  const plotHeight = Math.max(2, safeHeight - 2);
  const grid = makeTrendGrid(plotWidth, plotHeight);
  const drawable = chart.series.filter((series) => trendFiniteValues(series.values).length > 0);
  const primary = drawable.at(0);
  const scale = primary ? trendSeriesScale(primary) : emptyTrendScale();
  const guideLabels = primary ? trendGuideLabels(primary, plotHeight, scale) : new Map<number, string>();
  if (primary) {
    drawTrendGuides(grid, primary, plotWidth, plotHeight, scale);
    plotTrendSeries(grid, primary, plotWidth, plotHeight, scale);
  }
  const summary = drawable.filter((series) => series !== primary);
  const rows = [
    trendLegendLine(primary, summary, chart.emptyMessage, safeWidth),
    ...renderTrendPlotRows(grid, axisWidth, plotWidth, plotHeight, scale, guideLabels),
    trendXAxisLine(chart.xLabels, axisWidth, plotWidth),
  ];
  if (!drawable.length && rows.length > 2) {
    const messageRow = Math.max(1, Math.floor(plotHeight / 2));
    rows[messageRow] = overlayTrendMessage(rows[messageRow] ?? "", chart.emptyMessage ?? "No data yet.", safeWidth);
  }
  while (rows.length < safeHeight) {
    rows.push("");
  }
  return rows.slice(0, safeHeight).map((line) => padRight(truncateToWidth(line, safeWidth), safeWidth));
}

interface TrendGridCell {
  char: string;
  color: number;
}

function makeTrendGrid(width: number, height: number): Array<Array<TrendGridCell | undefined>> {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => undefined));
}

function plotTrendSeries(
  grid: Array<Array<TrendGridCell | undefined>>,
  series: TrendChartSeries,
  width: number,
  height: number,
  scale: TrendScale,
): void {
  const coords = trendSeriesCoordinates(series.values, width, height, scale);
  for (const coord of coords) {
    if (!coord) {
      continue;
    }
    setTrendCell(grid, coord.x, coord.y, "●", series.color);
  }
}

function trendSeriesCoordinates(
  values: Array<number | undefined>,
  width: number,
  height: number,
  scale: TrendScale,
): Array<{ x: number; y: number } | undefined> {
  const finite = trendFiniteValues(values);
  if (!finite.length) {
    return [];
  }
  const span = trendScaleSpan(scale);
  const denominator = Math.max(1, values.length - 1);
  return values.map((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    const x = Math.max(0, Math.min(width - 1, Math.round((index / denominator) * (width - 1))));
    const ratio = Math.max(0, Math.min(1, (value - scale.min) / span));
    const y = Math.max(0, Math.min(height - 1, height - 1 - Math.round(ratio * (height - 1))));
    return { x, y };
  });
}

function trendSeriesScale(series: TrendChartSeries): TrendScale {
  const finite = trendFiniteValues(series.values);
  if (!finite.length) {
    return emptyTrendScale();
  }
  const dataMin = Math.min(...finite);
  const dataMax = Math.max(...finite);
  if (dataMax > dataMin) {
    return { min: dataMin, max: dataMax, formatValue: series.formatValue };
  }
  const defaultMin = series.domain?.min ?? Math.min(0, dataMin);
  const defaultMax = series.domain?.max ?? Math.max(dataMax, 1);
  const min = Number.isFinite(defaultMin) ? defaultMin : 0;
  let max = Number.isFinite(defaultMax) ? defaultMax : min + 1;
  if (max <= min) {
    max = min + 1;
  }
  return { min, max, formatValue: series.formatValue };
}

function emptyTrendScale(): TrendScale {
  return { min: 0, max: 1, formatValue: formatInteger };
}

function trendScaleSpan(scale: TrendScale): number {
  return Math.max(1e-9, scale.max - scale.min);
}

function drawTrendGuides(
  grid: Array<Array<TrendGridCell | undefined>>,
  series: TrendChartSeries,
  width: number,
  height: number,
  scale: TrendScale,
): void {
  const values = trendFiniteValues(series.values);
  if (!values.length) {
    return;
  }
  const rows = new Set([trendValueRow(Math.min(...values), height, scale), trendValueRow(Math.max(...values), height, scale)]);
  for (const y of rows) {
    for (let x = 0; x < width; x += 1) {
      setTrendCell(grid, x, y, "┄", 238);
    }
  }
}

function trendGuideLabels(series: TrendChartSeries, height: number, scale: TrendScale): Map<number, string> {
  const labels = new Map<number, string>();
  const values = trendFiniteValues(series.values);
  if (!values.length) {
    return labels;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  labels.set(trendValueRow(max, height, scale), series.formatValue(max));
  labels.set(trendValueRow(min, height, scale), series.formatValue(min));
  return labels;
}

function trendValueRow(value: number, height: number, scale: TrendScale): number {
  const ratio = Math.max(0, Math.min(1, (value - scale.min) / trendScaleSpan(scale)));
  return Math.max(0, Math.min(height - 1, height - 1 - Math.round(ratio * (height - 1))));
}

function setTrendCell(grid: Array<Array<TrendGridCell | undefined>>, x: number, y: number, char: string, color: number): void {
  const row = grid[y];
  if (!row || x < 0 || x >= row.length) {
    return;
  }
  const existing = row[x];
  if (existing?.char === "┄" && char !== "●") {
    return;
  }
  if (!existing || char === "●" || existing.char !== "●") {
    row[x] = { char, color };
  }
}

function renderTrendPlotRows(
  grid: Array<Array<TrendGridCell | undefined>>,
  axisWidth: number,
  plotWidth: number,
  plotHeight: number,
  scale: TrendScale,
  guideLabels: Map<number, string>,
): string[] {
  return grid.map((cells, index) => {
    const label = trendYAxisLabel(index, plotHeight, scale, guideLabels);
    const axis = index === 0 ? "┌" : index === plotHeight - 1 ? "└" : "│";
    const empty = index === 0 || index === plotHeight - 1 ? "─" : " ";
    const body = cells.map((cell) => cell ? fg256(cell.color, cell.char) : fg256(238, empty)).join("");
    return `${leftCell(label, axisWidth)} ${fg256(244, axis)}${body}${fg256(244, index === plotHeight - 1 ? "→" : " ")}`;
  });
}

function trendYAxisLabel(index: number, height: number, scale: TrendScale, guideLabels: Map<number, string>): string {
  const guideLabel = guideLabels.get(index);
  if (guideLabel) {
    return guideLabel;
  }
  if (index === 0) {
    return scale.formatValue(scale.max);
  }
  if (index === Math.floor((height - 1) / 2)) {
    return scale.formatValue((scale.min + scale.max) / 2);
  }
  if (index === height - 1) {
    return scale.formatValue(scale.min);
  }
  return "";
}

function trendXAxisLine(labels: string[], axisWidth: number, plotWidth: number): string {
  const cleanLabels = labels.filter(Boolean);
  const first = cleanLabels.at(0) ?? "start";
  const last = cleanLabels.at(-1) ?? "now";
  return `${" ".repeat(axisWidth + 2)}${fitLeftRight(fg256(244, first), fg256(244, last), plotWidth)}`;
}

function trendLegendLine(
  primary: TrendChartSeries | undefined,
  summary: TrendChartSeries[],
  emptyMessage: string | undefined,
  width: number,
): string {
  if (!primary) {
    return truncateToWidth(fg256(244, emptyMessage ?? "No data yet."), width);
  }
  const summaryText = summary.map((item) => trendSummaryItem(item)).filter(Boolean).join(fg256(244, " · "));
  const text = [
    `${fg256(244, "plot")} ${trendLegendItem(primary)}`,
    summaryText ? `${fg256(244, "summary")} ${summaryText}` : "",
  ].filter(Boolean).join("   ");
  return truncateToWidth(text, width);
}

function trendLegendItem(series: TrendChartSeries): string {
  const values = trendFiniteValues(series.values);
  if (!values.length) {
    return `${fg256(series.color, series.label)} ${fg256(244, "no data")}`;
  }
  const latest = values.at(-1) ?? 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return [
    fg256(series.color, series.label),
    `${fg256(244, "now")} ${series.formatValue(latest)}`,
    `${fg256(244, "min")} ${series.formatValue(min)}`,
    `${fg256(244, "max")} ${series.formatValue(max)}`,
  ].join(" ");
}

function trendSummaryItem(series: TrendChartSeries): string {
  const values = trendFiniteValues(series.values);
  const latest = values.at(-1);
  if (latest === undefined) {
    return "";
  }
  return `${fg256(series.color, series.label)} ${series.formatValue(latest)}`;
}

function trendFiniteValues(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function overlayTrendMessage(line: string, message: string, width: number): string {
  const clipped = truncateToWidth(fg256(244, message), Math.max(1, width - 4));
  const start = Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2));
  const plain = " ".repeat(start);
  return truncateToWidth(`${plain}${clipped}`, width);
}

function rollingRate(values: number[], window: number): number[] {
  return values.map((_, index) => {
    const start = Math.max(0, index - window + 1);
    const slice = values.slice(start, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length);
  });
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function trendTurnLabel(turn: TurnSummary): string {
  if (turn.kind === "compaction") {
    return "compact";
  }
  if (turn.kind === "model_call") {
    return `${turn.runOrdinal}.${turn.stepIndex ?? turn.index}`;
  }
  return String(turn.index);
}

function rtkSummaryForStep(
  events: SessionEvent[],
  runId: string,
  stepId: string | undefined,
  stepIndex: number | undefined,
  modelTokens: number,
  toolCalls: number,
): RtkSavingsSummary {
  const stepEvents = events.filter((event) => {
    if (event.type !== "rtk.tool_savings" || event.run_id !== runId) {
      return false;
    }
    if (stepId) {
      return stringField(event.data.step_id) === stepId;
    }
    if (stepIndex !== undefined) {
      return optionalNumberField(event.data.step_index) === stepIndex;
    }
    return false;
  });
  const summary = rtkSummaryFromEvents(stepEvents, modelTokens, toolCalls);
  return { ...summary, estimated_without_rtk_tokens: modelTokens + summary.saved_tokens };
}

function rtkSummaryFromEvents(events: SessionEvent[], modelTokens: number, toolCalls: number): RtkSavingsSummary {
  let rtkToolCalls = 0;
  let rtkCommands = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let savedTokens = 0;
  let okEvents = 0;
  let unavailableEvents = 0;
  let nonOkEvents = 0;
  for (const event of events) {
    const rtk = rtkSummary(event.data);
    rtkToolCalls += 1;
    rtkCommands += rtk.rtk_commands;
    inputTokens += rtk.input_tokens;
    outputTokens += rtk.output_tokens;
    savedTokens += rtk.saved_tokens;
    if (rtk.status === "ok") {
      okEvents += 1;
    } else if (rtk.status === "unavailable") {
      unavailableEvents += 1;
      nonOkEvents += 1;
    } else if (rtk.status !== "disabled") {
      nonOkEvents += 1;
    }
  }
  const status = nonOkEvents > 0 && okEvents === 0 && unavailableEvents > 0 ? "unavailable" : nonOkEvents > 0 ? "partial" : "ok";
  return {
    tool_calls: toolCalls,
    rtk_tool_calls: rtkToolCalls,
    rtk_commands: rtkCommands,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    saved_tokens: savedTokens,
    savings_pct: inputTokens > 0 ? (savedTokens / inputTokens) * 100 : 0,
    estimated_without_rtk_tokens: modelTokens + savedTokens,
    status,
  };
}

function cacheLine(cache: CacheTotals): string {
  if (!cache.promptTurns || !cache.promptTokens) {
    return fg256(244, cache.warmupTurns ? "prefix cache warming · no steady turns yet" : "prefix cache unavailable");
  }
  const hit = (cache.cachedTokens / cache.promptTokens) * 100;
  return [
    `${fg256(39, "prefix cache")} ${hit.toFixed(1)}%`,
    `${cache.cachedTokens}/${cache.promptTokens}`,
    `${cache.promptTurns}/${Math.max(cache.promptTurns, cache.turns - cache.warmupTurns)} turns`,
    cache.warmupTurns ? `warmup ${cache.warmupTurns}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function rtkLine(rtk: RtkTotals): string {
  return [
    `${fg256(39, "rtk")} ${rtk.commands} cmds`,
    `io ${rtk.inputTokens}->${rtk.outputTokens}`,
    `saved ${rtk.savedTokens}`,
    rtk.toolSavingsPct > 0 ? `tool ${rtk.toolSavingsPct.toFixed(1)}%` : undefined,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function modelChangeDetail(previousModel: string | undefined, model: string | undefined): string {
  return [
    previousModel ? fg256(244, compactModelName(previousModel)) : fg256(244, "?"),
    fg256(238, "->"),
    model ? fg256(75, compactModelName(model)) : fg256(244, "?"),
  ].join(" ");
}

function compactModelName(model: string): string {
  const parts = model.split("/");
  const display = (parts.at(-1) || model).replace(/-tokenhub$/, "");
  const maxWidth = 18;
  if (visibleWidth(display) <= maxWidth) {
    return display;
  }
  return `${[...display].slice(0, maxWidth - 1).join("")}…`;
}

function tokenmaxxingSignalRows(allEvents: SessionEvent[], items: TokenmaxxingSignalItem[], width: number): TokenmaxxingScreenRow[] {
  const runOrdinals = runOrdinalMap(allEvents);
  const rows: TokenmaxxingScreenRow[] = [
    row(fg256(39, "Recent signals"), "section"),
    row(formatSignalRow([fg256(244, "time"), fg256(244, "signal"), fg256(244, "turn"), fg256(244, "tokens"), fg256(244, "cache"), fg256(244, "status"), fg256(244, "detail")], width), "signal"),
  ];
  rows.push(...items.map((item) => row(formatSignalRow(signalCells(item.event, runOrdinals), width), "signal")));
  return rows;
}

function tokenmaxxingActivityItems(events: SessionEvent[]): TokenmaxxingSignalItem[] {
  const eventItems = events
    .map((event, order) => ({ event, order }))
    .filter((item) => isTokenmaxxingActivityEvent(item.event));
  return eventItems.sort((left, right) => left.order - right.order);
}

function signalCells(event: SessionEvent, runOrdinals: Map<string, number>): string[] {
  const data = event.data;
  switch (event.type) {
    case "model.route.selected": {
      const route = objectField(data.route);
      return [
        signalTime(event.created_at ?? ""),
        fg256(39, "route"),
        signalTurnLabel(event, runOrdinals),
        "",
        "",
        fg256(252, routeLearningShortLabel(route, { includeInitial: true })),
        routeLearningDetail(route),
      ];
    }
    case "model.response.settled": {
      const usage = usageField(data.usage);
      return [
        signalTime(event.created_at ?? ""),
        fg256(39, "model response"),
        signalTurnLabel(event, runOrdinals),
        usageTokensLabel(usage),
        usageCacheLabel(usage),
        httpStatusLabel(data.http_status),
        signalTextDetail(data),
      ];
    }
    case "endpoint.evidence.recorded":
      return [
        signalTime(event.created_at ?? ""),
        fg256(39, "cache evidence"),
        signalTurnLabel(event, runOrdinals),
        promptTokenSignalLabel(data.prompt_tokens),
        evidenceCacheLabel(data),
        compactInlineString(data.model ?? data.provider_id ?? data.request_class, 80),
        compactInlineString(data.prompt_hash ?? data.prompt_epoch_id, 120),
      ];
    case "prompt.epoch.created":
      return [
        signalTime(event.created_at ?? ""),
        fg256(39, "epoch"),
        "",
        "",
        stringField(data.prompt_epoch_id) ? `epoch ${shortEpochId(String(data.prompt_epoch_id))}` : "",
        compactInlineString(data.reason, 32),
        compactInlineString(data.tool_schema_hash ?? data.prompt_layout_hash, 140),
      ];
    case "context.compacted":
      return [
        signalTime(event.created_at ?? ""),
        fg256(39, "compact memory"),
        signalRunLabel(event, runOrdinals),
        optionalNumberField(data.archived_events) === undefined ? "" : `archived ${optionalNumberField(data.archived_events)}`,
        "",
        compactInlineString(data.reason, 32),
        compactSignalDetail(data),
      ];
    case "evidence.context_compression":
      return [
        signalTime(event.created_at ?? ""),
        fg256(39, "compact"),
        signalRunLabel(event, runOrdinals),
        compressionTokenLabel(data),
        stringField(data.epoch_id) ? `epoch ${shortEpochId(String(data.epoch_id))}` : "",
        compactInlineString(data.reason, 32),
        compactSignalDetail(data),
      ];
    case "context.compaction.failed":
      return [
        signalTime(event.created_at ?? ""),
        fg256(203, "compact fail"),
        signalRunLabel(event, runOrdinals),
        "",
        stringField(data.prompt_epoch_id) ? `epoch ${shortEpochId(String(data.prompt_epoch_id))}` : "",
        compactInlineString(data.reason, 32),
        compactInlineString(compactFailureDetail(data), 180),
      ];
    case "context.compaction.auto_paused":
      return [
        signalTime(event.created_at ?? ""),
        fg256(203, "compact paused"),
        signalRunLabel(event, runOrdinals),
        "",
        "",
        "breaker",
        compactInlineString(`failures ${data.consecutive_failures}/${data.failure_limit} · manual /compact allowed`, 180),
      ];
    case "context.compaction.skipped":
      return [
        signalTime(event.created_at ?? ""),
        fg256(214, "compact skipped"),
        signalRunLabel(event, runOrdinals),
        compressionTokenLabel(data),
        stringField(data.prompt_epoch_id) ? `epoch ${shortEpochId(String(data.prompt_epoch_id))}` : "",
        compactInlineString(data.skipped_reason, 40),
        compactInlineString(data.provider_error ?? data.reason, 180),
      ];
    case "rtk.tool_savings": {
      const rtk = rtkSummary(data);
      return [
        signalTime(event.created_at ?? ""),
        fg256(39, "rtk saving"),
        signalTurnLabel(event, runOrdinals),
        rtk.input_tokens || rtk.output_tokens ? `${rtk.input_tokens}->${rtk.output_tokens}` : "",
        rtk.saved_tokens ? `saved ${rtk.saved_tokens}` : "",
        rtk.status,
        compactInlineString(data.rewritten_command ?? data.original_command ?? data.tool_name ?? data.tool_call_id, 140),
      ];
    }
    case "run.completed":
    case "run.stopped":
    case "run.failed":
      return [
        signalTime(event.created_at ?? ""),
        fg256(39, runSignalName(event.type)),
        signalRunLabel(event, runOrdinals),
        numberField(data.tokens) ? `tokens ${numberField(data.tokens)}` : "",
        "",
        runStatusLabel(event.type, data),
        runDetailLabel(data),
      ];
    default:
      return [
        signalTime(event.created_at ?? ""),
        fg256(39, event.type),
        signalRunLabel(event, runOrdinals),
        "",
        "",
        "",
        compactInlineString(signalKeyValueSummary(data, 4), 180),
      ];
  }
}

function formatSignalRow(cells: string[], width: number): string {
  const widths = signalColumnWidths(width);
  const detailWidth = widths.at(-1) ?? 20;
  const rendered = [
    leftCell(cells[0] ?? "", widths[0] ?? 8),
    leftCell(cells[1] ?? "", widths[1] ?? 14),
    leftCell(cells[2] ?? "", widths[2] ?? 10),
    leftCell(cells[3] ?? "", widths[3] ?? 18),
    leftCell(cells[4] ?? "", widths[4] ?? 14),
    leftCell(cells[5] ?? "", widths[5] ?? 10),
    truncateToWidth(cells[6] ?? "", detailWidth),
  ].join("  ");
  return truncateToWidth(rendered, width);
}

function signalColumnWidths(width: number): number[] {
  const fixed = [8, 16, 12, 22, 16, 14];
  const separatorWidth = 2 * fixed.length;
  const detail = Math.max(20, width - fixed.reduce((sum, item) => sum + item, separatorWidth));
  return [...fixed, detail];
}

function leftCell(text: string, width: number): string {
  return padRight(truncateToWidth(text, width), width);
}

function summaryRows(cache: CacheTotals, rtk: RtkTotals, totalSaved: number, actualTokens: number, estimatedWithout: number, width: number): TokenmaxxingScreenRow[] {
  const left = [
    `${fg256(39, "saved")} ${totalSaved}`,
    `${fg256(39, "cache")} ${cache.cachedTokens}`,
    `${fg256(39, "rtk")} ${rtk.savedTokens}`,
    `${fg256(39, "tokens")} ${actualTokens}/${estimatedWithout}`,
  ].join(" · ");
  const cacheSummary = cacheLine(cache);
  const rtkSummary = rtk.commands > 0 ? rtkLine(rtk) : undefined;
  const right = rtkSummary ? `${cacheSummary} · ${rtkSummary}` : cacheSummary;
  const safeWidth = Math.max(20, width);

  if (visibleWidth(left) + visibleWidth(right) + 4 <= safeWidth) {
    return [row(fitLeftRight(left, right, safeWidth), "summary")];
  }
  if (!rtkSummary) {
    return [row(fitLeftRight(left, cacheSummary, safeWidth), "summary")];
  }
  return [
    row(fitLeftRight(left, cacheSummary, safeWidth), "summary"),
    row(fitLeftRight(rtkSummary, "", safeWidth), "summary"),
  ];
}

function turnTableHeader(width: number): string {
  return formatTurnTableRow([
    fg256(244, "turn"),
    fg256(244, "event"),
    fg256(244, "route"),
    fg256(244, "tokens"),
    fg256(244, "cache A/O"),
    fg256(244, "cache gap"),
    fg256(244, "prefix"),
    fg256(244, "tools"),
    fg256(244, "rtk"),
    fg256(244, "TTFT"),
    fg256(244, "TPOT"),
    fg256(244, "Duration"),
  ], width);
}

function turnLine(turn: TurnSummary, width: number): string {
  const cache = turnCacheCells(turn.cache);
  return formatTurnTableRow([
    turnLabel(turn),
    turnEventLabel(turn),
    turnRouteLabel(turn),
    `tokens ${turn.actualTokens}/${turn.withoutRtkTokens}`,
    cache.cache,
    cache.diff,
    prefixSafetyCell(turn),
    `tools ${turn.toolCalls}`,
    turn.rtk.rtk_commands > 0 ? `rtk ${turn.rtk.saved_tokens}` : fg256(244, "-"),
    formatLatencyCell(turn.latency.ttftMs),
    formatLatencyCell(turn.latency.tpotMs),
    formatLatencyCell(turn.latency.durationMs),
  ], width);
}

function epochLine(epoch: EpochSummary, width: number): string {
  const parts = epoch.compactReason
    ? [
        fg256(231, "compact"),
        fg256(159, compactReasonLabel(epoch.compactReason)),
        ...epochCompactTokenParts(epoch),
        epoch.archivedEvents === undefined ? undefined : fg256(195, `archived ${formatInteger(epoch.archivedEvents)}`),
      ]
    : [
        fg256(231, "new epoch"),
        fg256(159, createdEpochReasonLabel(epoch.createdReason)),
      ];
  return truncateToWidth(parts.filter((part): part is string => Boolean(part)).join(fg256(67, " · ")), width);
}

function epochCompactTokenParts(epoch: EpochSummary): string[] {
  if (epoch.compactTokensBefore === undefined) {
    return [];
  }
  if (epoch.compactTokensAfter === undefined) {
    return [fg256(195, `${formatInteger(epoch.compactTokensBefore)} -> pending`)];
  }
  const saved = Math.max(0, epoch.compactTokensBefore - epoch.compactTokensAfter);
  return [
    fg256(195, `${formatInteger(epoch.compactTokensBefore)} -> ${formatInteger(epoch.compactTokensAfter)}`),
    fg256(195, `saved ${formatInteger(saved)}`),
  ];
}

function compactReasonLabel(reason?: string): string {
  switch (reason) {
    case "provider-context-limit":
      return "context limit";
    case "threshold":
      return "threshold";
    case "manual":
      return "manual";
    default:
      return readableReason(reason ?? "compact");
  }
}

function createdEpochReasonLabel(reason?: string): string {
  switch (reason) {
    case "session-created":
      return "session start";
    case "session-or-layout":
      return "prompt layout changed";
    default:
      return readableReason(reason ?? "session");
  }
}

function readableReason(value: string): string {
  return value.replace(/[-_]+/g, " ");
}

function turnEpochId(turn: TurnSummary): string | undefined {
  if (turn.kind === "model_call") {
    return turn.promptEpochId ?? turn.cache?.promptEpochId;
  }
  return turn.cache?.promptEpochId;
}

function formatTurnTableRow(cells: Array<string | undefined>, width: number): string {
  const separator = "  ";
  const widths = turnTableWidths(width);
  const rendered = widths
    .map((cellWidth, index) => leftCell(cells[index] ?? "", cellWidth))
    .join(separator)
    .trimEnd();
  return truncateToWidth(rendered, width);
}

function turnTableWidths(width: number): number[] {
  const minimums = [9, 10, 10, 17, 11, 8, 6, 7, 7, 6, 6, 8];
  const maximums = [16, 13, 60, 30, 30, 20, 14, 14, 20, 9, 9, 11];
  const weights = [0.9, 0.9, 2.5, 1.45, 1.75, 1, 0.7, 0.7, 0.65, 0.55, 0.55, 0.8];
  const separatorWidth = 2 * (minimums.length - 1);
  const minimumSum = minimums.reduce((sum, value) => sum + value, 0);
  const maximumSum = maximums.reduce((sum, value) => sum + value, 0);
  const target = Math.max(minimumSum, Math.min(maximumSum, Math.max(1, width - separatorWidth)));
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  const widths = minimums.map((minimum, index) => {
    const proportional = Math.floor((target * (weights[index] ?? 1)) / weightSum);
    return Math.max(minimum, Math.min(maximums[index] ?? minimum, proportional));
  });
  rebalanceWidths(widths, minimums, maximums, target);
  return widths;
}

function rebalanceWidths(widths: number[], minimums: number[], maximums: number[], target: number): void {
  let current = widths.reduce((sum, value) => sum + value, 0);
  while (current < target) {
    const index = widestGrowthColumn(widths, maximums);
    if (index === -1) {
      break;
    }
    widths[index] = (widths[index] ?? 0) + 1;
    current += 1;
  }
  while (current > target) {
    const index = widestShrinkColumn(widths, minimums);
    if (index === -1) {
      break;
    }
    widths[index] = Math.max(0, (widths[index] ?? 0) - 1);
    current -= 1;
  }
}

function widestGrowthColumn(widths: number[], maximums: number[]): number {
  let candidate = -1;
  for (let index = 0; index < widths.length; index += 1) {
    if (widths[index]! >= maximums[index]!) {
      continue;
    }
    if (candidate === -1 || maximums[index]! - widths[index]! > maximums[candidate]! - widths[candidate]!) {
      candidate = index;
    }
  }
  return candidate;
}

function widestShrinkColumn(widths: number[], minimums: number[]): number {
  let candidate = -1;
  for (let index = 0; index < widths.length; index += 1) {
    if (widths[index]! <= minimums[index]!) {
      continue;
    }
    if (candidate === -1 || widths[index]! - minimums[index]! > widths[candidate]! - minimums[candidate]!) {
      candidate = index;
    }
  }
  return candidate;
}

function turnLabel(turn: TurnSummary): string {
  if (turn.kind === "compaction") {
    return fg256(87, "compact");
  }
  if (turn.kind === "model_call") {
    return `turn ${turn.runOrdinal}.${turn.stepIndex ?? turn.index}`;
  }
  return `turn ${turn.index}`;
}

function turnEventLabel(turn: TurnSummary): string {
  if (turn.kind === "compaction") {
    return fg256(87, "compact");
  }
  if (turn.kind === "model_call") {
    const name = modelCallEventName(turn);
    if (name === "user") {
      return fg256(87, name);
    }
    if (name === "execution") {
      return fg256(111, name);
    }
    if (name === "decision" || name === "verify") {
      return fg256(111, name);
    }
    return name;
  }
  return "run";
}

function turnRouteLabel(turn: TurnSummary): string {
  if (turn.kind === "compaction") {
    return fg256(87, "compact");
  }
  if (turn.kind !== "model_call") {
    return fg256(244, "-");
  }
  const model = turn.previousModel && turn.model
    ? modelChangeDetail(turn.previousModel, turn.model)
    : turn.model ? fg256(75, compactModelName(turn.model)) : fg256(244, "-");
  const learning = turn.route ? routeLearningShortLabel(turn.route) : undefined;
  return [model, learning ? fg256(252, learning) : undefined].filter((part): part is string => Boolean(part)).join(` ${fg256(67, "·")} `);
}

function modelCallEventName(turn: ModelCallSummary): string {
  if (!turn.isRunStart) {
    return "tool-loop";
  }
  switch (turn.requestClass) {
    case "reflection":
      return "decision";
    case "verification":
      return "verify";
    case "background":
      if (turn.requestOrigin === "loop") {
        return "execution";
      }
      return "bg";
    default:
      if (turn.requestOrigin === "loop") {
        return "execution";
      }
      return turn.isRunStart ? "user" : "tool-loop";
  }
}

function loopOriginByRunPrompt(events: readonly SessionEvent[]): Map<string, "loop"> {
  const out = new Map<string, "loop">();
  for (const event of events) {
    if (!event.run_id || event.type !== "user.prompt") {
      continue;
    }
    const prompt = stringField(event.data.prompt) ?? "";
    if (isLoopExecutionPrompt(prompt)) {
      out.set(event.run_id, "loop");
    }
  }
  return out;
}

function isLoopExecutionPrompt(prompt: string): boolean {
  return (
    /^Loop objective:/m.test(prompt) &&
    (/Execution turn for a (?:Deliver|Discover) loop\./.test(prompt) || /Continue the active loop task\./.test(prompt))
  );
}

function formatLatencyCell(value?: number): string {
  return value === undefined ? fg256(244, "-") : formatDuration(value);
}

function turnCacheCells(cache?: CacheObservation): { cache: string; diff: string } {
  if (!cache) {
    return { cache: fg256(244, "-"), diff: fg256(244, "-") };
  }
  if (cache.kind === "warmup") {
    if (cache.actualHit !== undefined && cache.oracleHit !== undefined) {
      const diff = cache.cacheDiff ?? 0;
      return {
        cache: `warm ${formatCacheHitForDiff(cache.actualHit, diff)}/${formatCacheHitForDiff(cache.oracleHit, diff)}`,
        diff: formatCacheDiff(diff),
      };
    }
    if (cache.actualHit !== undefined) {
      return { cache: fg256(244, `warm ${formatPlainPct(cache.actualHit)}`), diff: fg256(244, "-") };
    }
    return { cache: fg256(244, "warm -"), diff: fg256(244, "-") };
  }
  if (cache.actualHit !== undefined && cache.oracleHit !== undefined) {
    const diff = cache.cacheDiff ?? 0;
    return {
      cache: `${formatCacheHitForDiff(cache.actualHit, diff)}/${formatCacheHitForDiff(cache.oracleHit, diff)}`,
      diff: formatCacheDiff(diff),
    };
  }
  if (cache.actualHit !== undefined) {
    return { cache: formatCacheHit(cache.actualHit), diff: fg256(244, "-") };
  }
  if (cache.oracleHit !== undefined) {
    return { cache: `oracle ${formatCacheHit(cache.oracleHit)}`, diff: fg256(244, "-") };
  }
  return { cache: fg256(244, "-"), diff: fg256(244, "-") };
}

function prefixSafetyCell(turn: TurnSummary): string {
  if (turn.kind !== "run") {
    const status = prefixSafetyStatusLabel(turn.prefixCacheStatus);
    if (status) {
      return status;
    }
    return fg256(244, "legacy");
  }
  return fg256(244, "legacy");
}

function prefixSafetyStatusLabel(status?: string): string | undefined {
  switch (status) {
    case "new_epoch":
      return fg256(244, "new");
    case "safe":
      return fg256(48, "safe");
    case "changed":
      return fg256(203, "break");
    case "unknown":
      return fg256(244, "?");
    default:
      return undefined;
  }
}

function formatPlainPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function isRunEvent(event: SessionEvent): boolean {
  return event.type === "run.completed" || event.type === "run.stopped" || event.type === "run.failed";
}

function isTokenmaxxingActivityEvent(event: SessionEvent): boolean {
  return (
    event.type === "endpoint.evidence.recorded" ||
    event.type === "model.route.selected" ||
    event.type === "prompt.epoch.created" ||
    event.type === "context.compacted" ||
    event.type === "evidence.context_compression" ||
    event.type === "context.compaction.failed" ||
    event.type === "context.compaction.auto_paused" ||
    event.type === "context.compaction.skipped" ||
    event.type === "model.response.settled" ||
    event.type === "rtk.tool_savings" ||
    event.type === "run.completed" ||
    event.type === "run.stopped" ||
    event.type === "run.failed"
  );
}

interface LearningRouteFields {
  adaptation?: string;
  mode?: string;
  action?: string;
  scope?: string;
  reason?: string;
}

function routeLearningShortLabel(route: JsonObject, options: { includeInitial?: boolean } = {}): string {
  const fields = routeLearningFields(route);
  const { mode, action, scope, reason } = fields;
  if (!fields.adaptation && !action) {
    return options.includeInitial ? "selected" : "";
  }
  if (action === "select") {
    return options.includeInitial ? "new run" : "";
  }
  if (mode === "observe") {
    return observedRouteLearningShortLabel(action, scope, reason);
  }
  if (action === "hard_lock") {
    return learningRouteBadge(action, scope);
  }
  if (action === "stay") {
    return learningRouteBadge(action, scope);
  }
  if (action === "switch") {
    return learningRouteBadge(action, scope);
  }
  if (action === "bypass") {
    return learningRouteBadge(action, scope);
  }
  if (action === "noop") {
    return options.includeInitial ? noopRouteShortLabel(reason) : "";
  }
  return action ? learningRouteBadge(action, scope) : "selected";
}

function observedRouteLearningShortLabel(action: string | undefined, scope: string | undefined, reason: string | undefined): string {
  if (action === "hard_lock") {
    return scope ? `would hard lock/${learningDisplayScope(scope)}` : `would ${hardLockRouteShortLabel(reason)}`;
  }
  if (action === "stay") {
    return scope === "session" ? "would keep session" : "would keep run";
  }
  if (action === "switch") {
    return "would switch";
  }
  if (action === "bypass") {
    return "would bypass";
  }
  if (action === "noop") {
    return reason === "identity_missing" ? "would miss ids" : "observe only";
  }
  return action && scope ? `would ${learningRouteBadge(action, scope)}` : action ? `would ${readableReason(action)}` : "observe";
}

function learningRouteBadge(action: string, scope: string | undefined): string {
  return [
    readableLearningValue(action),
    scope ? learningDisplayScope(scope) : undefined,
  ].filter((part): part is string => Boolean(part)).join("/");
}

function noopRouteShortLabel(reason: string | undefined): string {
  return reason === "identity_missing" ? "missing ids" : "inactive";
}

function hardLockRouteShortLabel(reason: string | undefined): string {
  if (reason === "hard_lock=tool_loop") {
    return "pin tool";
  }
  if (reason?.startsWith("hard_lock=context_portability")) {
    return "pin context";
  }
  if (reason === "hard_lock=min_turns") {
    return "pin warmup";
  }
  return "pinned";
}

function routeLearningDetail(route: JsonObject): string {
  const fields = routeLearningFields(route);
  const model = selectedModelFromRoute(route);
  const decision = stringField(route["x-vsr-selected-decision"]);
  const action = fields.action;
  const scope = fields.scope;
  const reason = fields.reason;
  const showReason = reason && !(action === "select" && reason === "missing_previous_model");
  const showLearningFields = action && action !== "select";
  const parts = [
    routeLearningLongLabel(route),
    showLearningFields ? `action ${readableLearningValue(action)}` : undefined,
    showLearningFields && scope ? `scope ${learningDisplayScope(scope)}` : undefined,
    fields.mode && fields.mode !== "apply" ? `mode ${fields.mode}` : undefined,
    showReason ? `reason ${readableLearningReason(reason)}` : undefined,
    model ? `model ${model}` : undefined,
    decision ? `decision ${decision}` : undefined,
    showLearningFields && fields.adaptation ? `method ${fields.adaptation}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return compactInlineString(parts.join(" · "), 180);
}

function routeLearningLongLabel(route: JsonObject): string {
  const { mode, action, scope, reason } = routeLearningFields(route);
  if (action === "select") {
    return reason === "missing_previous_model" ? "first route for this run" : "route selected";
  }
  if (mode === "observe") {
    return observedRouteLearningLongLabel(action, scope, reason);
  }
  if (action === "hard_lock") {
    return hardLockRouteLongLabel(reason);
  }
  if (action === "stay") {
    return scope === "session" ? "kept session model" : "kept run model";
  }
  if (action === "switch") {
    return "model switched";
  }
  if (action === "bypass") {
    return "learning bypassed";
  }
  if (action === "noop") {
    return reason === "identity_missing" ? "learning identity missing" : "learning inactive";
  }
  return action ? readableReason(action) : "route selected";
}

function observedRouteLearningLongLabel(action: string | undefined, scope: string | undefined, reason: string | undefined): string {
  if (action === "hard_lock") {
    return `would pin ${hardLockRouteTarget(reason)}`;
  }
  if (action === "stay") {
    return scope === "session" ? "would keep session model" : "would keep run model";
  }
  if (action === "switch") {
    return "would switch model";
  }
  if (action === "bypass") {
    return "would bypass learning";
  }
  if (action === "noop") {
    return reason === "identity_missing" ? "would miss learning identity" : "learning observed only";
  }
  return action ? `would ${readableReason(action)}` : "learning observed";
}

function hardLockRouteLongLabel(reason: string | undefined): string {
  return `${hardLockRouteTarget(reason)} pinned`;
}

function hardLockRouteTarget(reason: string | undefined): string {
  if (reason === "hard_lock=tool_loop") {
    return "tool-loop";
  }
  if (reason?.startsWith("hard_lock=context_portability")) {
    return "context";
  }
  if (reason === "hard_lock=min_turns") {
    return "warmup";
  }
  return "model";
}

function routeLearningFields(route: JsonObject): LearningRouteFields {
  const adaptation = firstLearningMethod(stringField(route["x-vsr-learning-methods"]));
  return {
    adaptation,
    mode: methodHeaderValue(stringField(route["x-vsr-learning-modes"]), adaptation),
    action: methodHeaderValue(stringField(route["x-vsr-learning-actions"]), adaptation),
    scope: methodHeaderValue(stringField(route["x-vsr-learning-scopes"]), adaptation),
    reason: methodHeaderValue(stringField(route["x-vsr-learning-reasons"]), adaptation),
  };
}

function firstLearningMethod(header: string | undefined): string | undefined {
  return header?.split(",").map((part) => part.trim()).find(Boolean);
}

function methodHeaderValue(header: string | undefined, method: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(",").map((item) => item.trim()).filter(Boolean)) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (!method || key === method) {
      return value || undefined;
    }
  }
  return undefined;
}

function learningDisplayScope(scope: string): string {
  return scope === "conversation" ? "run" : scope;
}

function readableLearningValue(value: string): string {
  return value.replace(/[-_]+/g, " ");
}

function readableLearningReason(reason: string): string {
  if (reason.startsWith("hard_lock=")) {
    return readableLearningValue(reason.slice("hard_lock=".length));
  }
  return readableLearningValue(reason);
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

function runOrdinalMap(events: SessionEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const event of events) {
    if (!event.run_id || out.has(event.run_id)) {
      continue;
    }
    out.set(event.run_id, out.size + 1);
  }
  return out;
}

function signalTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return truncateToWidth(value, 8);
  }
  return date.toISOString().slice(11, 19);
}

function signalTurnLabel(event: SessionEvent, runOrdinals: Map<string, number>): string {
  if (!event.run_id) {
    return "";
  }
  const run = runOrdinals.get(event.run_id) ?? 0;
  const step = optionalNumberField(event.data.step_index);
  return step === undefined ? `run ${run}` : `turn ${run}.${step}`;
}

function signalRunLabel(event: SessionEvent, runOrdinals: Map<string, number>): string {
  if (!event.run_id) {
    return "";
  }
  return `run ${runOrdinals.get(event.run_id) ?? 0}`;
}

function usageTokensLabel(usage?: ModelUsage): string {
  if (!usage) {
    return "";
  }
  const prompt = optionalNumberField(usage.prompt_tokens);
  const completion = optionalNumberField(usage.completion_tokens);
  const total = optionalNumberField(usage.total_tokens);
  const parts = [
    prompt === undefined ? undefined : `p ${prompt}`,
    completion === undefined ? undefined : `c ${completion}`,
    total === undefined ? undefined : `t ${total}`,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" ");
}

function usageCacheLabel(usage?: ModelUsage): string {
  const prompt = optionalNumberField(usage?.prompt_tokens);
  const cached = optionalNumberField(usage?.cached_prompt_tokens);
  if (prompt === undefined || cached === undefined || prompt <= 0) {
    return "";
  }
  return `cache ${formatCacheHit(ratio(cached, prompt))}`;
}

function promptTokenSignalLabel(value: unknown): string {
  const tokens = optionalNumberField(value);
  return tokens === undefined ? "" : `prompt ${tokens}`;
}

function evidenceCacheLabel(data: JsonObject): string {
  const hit = optionalNumberField(data.cache_hit_rate);
  if (hit !== undefined) {
    return `cache ${formatCacheHit(hit)}`;
  }
  const prompt = optionalNumberField(data.prompt_tokens);
  const cached = optionalNumberField(data.cached_prompt_tokens);
  if (prompt !== undefined && cached !== undefined && prompt > 0) {
    return `cache ${formatCacheHit(ratio(cached, prompt))}`;
  }
  return "";
}

function httpStatusLabel(value: unknown): string {
  const status = optionalNumberField(value);
  return status === undefined ? "ok" : `http ${status}`;
}

function signalTextDetail(data: JsonObject): string {
  return compactInlineString(
    data.output ?? data.text ?? data.message ?? data.response ?? data.model ?? data.request_id ?? data.provider_id,
    180,
  );
}

function runSignalName(type: string): string {
  switch (type) {
    case "run.completed":
      return "run complete";
    case "run.stopped":
      return "run stopped";
    case "run.failed":
      return "run failed";
    default:
      return type;
  }
}

function runStatusLabel(type: string, data: JsonObject): string {
  if (type === "run.failed") {
    return "failed";
  }
  if (type === "run.stopped") {
    return compactInlineString(data.reason, 32) || "stopped";
  }
  return "ok";
}

function runDetailLabel(data: JsonObject): string {
  const parts = [
    optionalNumberField(data.tool_rounds) === undefined ? undefined : `loops ${optionalNumberField(data.tool_rounds)}`,
    optionalNumberField(data.tool_calls) === undefined ? undefined : `tools ${optionalNumberField(data.tool_calls)}`,
    optionalNumberField(data.duration_ms) === undefined ? undefined : `time ${formatDuration(optionalNumberField(data.duration_ms)!)}`,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

function compressionTokenLabel(data: JsonObject): string {
  const estimated = optionalNumberField(data.estimated_tokens);
  const threshold = optionalNumberField(data.threshold_tokens);
  if (estimated === undefined) {
    return "";
  }
  return threshold === undefined ? `est ${estimated}` : `est ${estimated}/${threshold}`;
}

function compactSignalDetail(data: JsonObject): string {
  const parts = [
    stringField(data.summary_strategy) ? `strategy ${stringField(data.summary_strategy)}` : undefined,
    Array.isArray(data.attempted_summary_strategies) ? `attempts ${data.attempted_summary_strategies.join("->")}` : undefined,
    data.model_summary_failed === true ? "fallback deterministic" : undefined,
    stringField(data.threshold_source) ? `trigger ${stringField(data.threshold_source)}` : undefined,
    compressionMessageDelta(
      optionalNumberField(data.prompt_messages_before),
      optionalNumberField(data.prompt_messages_after),
      optionalNumberField(data.compressed_messages),
    ),
    optionalNumberField(data.archived_events) === undefined ? undefined : `archived ${optionalNumberField(data.archived_events)}`,
    optionalNumberField(data.protected_tail_events) === undefined ? undefined : `protected ${optionalNumberField(data.protected_tail_events)}`,
    optionalNumberField(data.preserved_tail_events) === undefined ? undefined : `preserved ${optionalNumberField(data.preserved_tail_events)}`,
    optionalNumberField(data.preserved_rounds) === undefined ? undefined : `rounds ${optionalNumberField(data.preserved_rounds)}`,
    optionalNumberField(data.preserved_run_anchor_count) === undefined ? undefined : `anchors ${optionalNumberField(data.preserved_run_anchor_count)}`,
    stringField(data.archive_resource_uri),
  ].filter((part): part is string => Boolean(part));
  return compactInlineString(parts.join(" · "), 180);
}

function compactFailureDetail(data: JsonObject): string {
  const parts = [
    data.soft === true ? "model fallback" : "failed",
    optionalNumberField(data.consecutive_failures) === undefined || optionalNumberField(data.failure_limit) === undefined
      ? undefined
      : `${optionalNumberField(data.consecutive_failures)}/${optionalNumberField(data.failure_limit)}`,
    Array.isArray(data.failed_summary_strategies) ? `failed ${data.failed_summary_strategies.join("->")}` : undefined,
    stringField(data.error),
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

function compressionTokenDelta(before?: number, after?: number): string | undefined {
  if (before === undefined) {
    return undefined;
  }
  if (after === undefined) {
    return `observed tokens ${before}->pending`;
  }
  return `observed tokens ${before}->${after} saved ${Math.max(0, before - after)}`;
}

function compressionMessageDelta(before?: number, after?: number, saved?: number): string | undefined {
  if (before === undefined || after === undefined) {
    return undefined;
  }
  const compressed = saved ?? Math.max(0, before - after);
  return `messages ${before}->${after} saved ${compressed}`;
}

function shortEpochId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 5)}...${value.slice(-4)}` : value;
}

function signalKeyValueSummary(data: JsonObject, limit: number): string {
  return Object.entries(data)
    .slice(0, limit)
    .map(([key, value]) => {
      const rendered = compactInlineString(value, 80);
      return rendered ? `${key} ${rendered}` : "";
    })
    .filter(Boolean)
    .join(" · ");
}

function cacheCallKey(runId: string, stepId?: string, stepIndex?: number): string {
  if (stepId) {
    return `${runId}:step:${stepId}`;
  }
  if (stepIndex !== undefined) {
    return `${runId}:index:${stepIndex}`;
  }
  return `${runId}:run`;
}

function usageField(value: unknown): ModelUsage | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ModelUsage) : undefined;
}

function modelUsageTokenCost(usage?: ModelUsage): number {
  if (!usage) {
    return 0;
  }
  if (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)) {
    return usage.total_tokens;
  }
  return numberField(usage.prompt_tokens) + numberField(usage.completion_tokens);
}

function toolCallCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
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

function compactInlineString(value: unknown, maxWidth: number): string {
  if (value === null || value === undefined) {
    return "";
  }
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else if (Array.isArray(value)) {
    text = value.map((item) => compactInlineString(item, maxWidth)).filter(Boolean).slice(0, 6).join(", ");
  } else if (typeof value === "object") {
    text = Object.entries(value as Record<string, unknown>)
      .slice(0, 4)
      .map(([key, item]) => {
        const rendered = compactInlineString(item, maxWidth);
        return rendered ? `${key}=${rendered}` : "";
      })
      .filter(Boolean)
      .join(" · ");
  } else {
    text = String(value);
  }
  return truncateToWidth(singleLine(text).replace(/ {2,}/g, " ").trim(), maxWidth);
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

function formatCacheHitForDiff(value: number, diff: number): string {
  return fg256(cacheDiffColor(diff), formatPercent(value));
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
