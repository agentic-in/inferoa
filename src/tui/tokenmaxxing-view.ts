import type { JsonObject, ModelUsage, RtkSavingsSummary, SessionEvent } from "../types.js";
import { bgLine, fg256, padRight, terminalHeight, terminalWidth, truncateToWidth, visibleWidth } from "./ansi.js";
import { formatDuration, type PrefixCacheTurnKind } from "./cache-footer.js";

export interface TokenmaxxingRenderOptions {
  detailLimit?: number;
  includeActivity?: boolean;
  activityOnly?: boolean;
}

export type TokenmaxxingRowKind = "summary" | "section" | "epoch" | "turn-header" | "turn" | "signal";

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
  isRunStart: boolean;
  actualTokens: number;
  withoutRtkTokens: number;
  toolCalls: number;
  rtk: RtkSavingsSummary;
  cache?: CacheObservation;
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
}

type TurnSummary = RunSummary | ModelCallSummary | CompactionCallSummary;

interface EpochSummary {
  promptEpochId: string;
  createdReason?: string;
  compactReason?: string;
  summaryStrategy?: string;
  archivedEvents?: number;
  protectedTailEvents?: number;
  promptTurns: number;
  promptTokens: number;
  cachedTokens: number;
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
  const runs = runSummaries(events, cacheEvidence.byRun);
  const modelCalls = modelCallSummaries(events, cacheEvidence.byCall);
  const compactionCalls = compactionCallSummaries(endpointEvidence, events, cacheEvidence.byCall);
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
    const epochs = epochSummaries(events, cacheEvidence.observations);
    rows.push(row(turnTableHeader(contentWidth), "turn-header"));
    let currentEpoch: string | undefined;
    for (const turn of recentTurns.slice().reverse()) {
      const epochId = turnEpochId(turn);
      if (epochId && epochId !== currentEpoch) {
        rows.push(row(epochLine(epochs.get(epochId) ?? emptyEpochSummary(epochId), contentWidth), "epoch"));
        currentEpoch = epochId;
      }
      rows.push(row(turnLine(turn, contentWidth), "turn"));
    }
  }

  const includeActivity = options.activityOnly || (options.includeActivity ?? false);
  const tokenmaxxingActivityEvents = includeActivity ? events.filter(isTokenmaxxingActivityEvent) : [];
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
  const title = `${fg256(87, "Tokenmaxxing")} ${fg256(244, "run cache · RTK · session savings")}`;
  const range = total ? `${firstVisible}-${lastVisible} / ${total}` : "0 / 0";
  const pageLabel = `page ${page + 1}/${pageCount}`;
  const headerRight = `${pageLabel} · ${range}`;
  const rows = [
    bgLine(234, fitLeftRight(`  ${title}`, fg256(244, headerRight), safeWidth), safeWidth),
    ...sticky.map((item) => bgLine(rowBackground(item), ` ${truncateToWidth(item.text, safeWidth - 2)}`, safeWidth)),
    ...visible.map((item) => bgLine(rowBackground(item), ` ${truncateToWidth(item.text, safeWidth - 2)}`, safeWidth)),
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

function row(text: string, kind: TokenmaxxingRowKind): TokenmaxxingScreenRow {
  return { text, kind };
}

function normalizeScreenRow(item: TokenmaxxingScreenInputRow): TokenmaxxingScreenRow {
  const normalized = typeof item === "string" ? row(item, "turn") : item;
  return { ...normalized, text: singleLine(normalized.text) };
}

function rowBackground(_row: TokenmaxxingScreenRow): number {
  return 234;
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
      };
    });
}

function modelCallSummaries(events: SessionEvent[], cacheByCall: Map<string, CacheObservation>): ModelCallSummary[] {
  const runOrdinals = runOrdinalMap(events);
  const requestByCall = modelRequestByCall(events);
  const seenRuns = new Set<string>();
  return events
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
      const isRunStart = !seenRuns.has(runId);
      seenRuns.add(runId);
      return {
        kind: "model_call",
        event,
        order,
        index: index + 1,
        runOrdinal: runOrdinals.get(runId) ?? index + 1,
        runId,
        stepId,
        stepIndex,
        promptEpochId: cache?.promptEpochId ?? stringField(event.data.prompt_epoch_id) ?? stringField(request?.prompt_epoch_id),
        isRunStart,
        actualTokens,
        withoutRtkTokens: actualTokens + rtk.saved_tokens,
        toolCalls,
        rtk,
        cache,
      };
    });
}

function compactionCallSummaries(evidence: JsonObject[], events: SessionEvent[], cacheByCall: Map<string, CacheObservation>): CompactionCallSummary[] {
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

function epochSummaries(events: SessionEvent[], observations: CacheObservation[]): Map<string, EpochSummary> {
  const out = new Map<string, EpochSummary>();
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
      summary.protectedTailEvents = optionalNumberField(event.data.protected_tail_events);
    }
  }
  return out;
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

function tokenmaxxingSignalRows(allEvents: SessionEvent[], events: SessionEvent[], width: number): TokenmaxxingScreenRow[] {
  const runOrdinals = runOrdinalMap(allEvents);
  const rows: TokenmaxxingScreenRow[] = [
    row(fg256(39, "Recent signals"), "section"),
    row(formatSignalRow([fg256(244, "time"), fg256(244, "signal"), fg256(244, "turn"), fg256(244, "tokens"), fg256(244, "cache"), fg256(244, "status"), fg256(244, "detail")], width), "signal"),
  ];
  rows.push(...events.map((event) => row(formatSignalRow(signalCells(event, runOrdinals), width), "signal")));
  return rows;
}

function signalCells(event: SessionEvent, runOrdinals: Map<string, number>): string[] {
  const data = event.data;
  switch (event.type) {
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
  const fixed = [8, 16, 12, 22, 16, 10];
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
    fg256(244, "tokens"),
    fg256(244, "cache"),
    fg256(244, "gap"),
    fg256(244, "tools"),
    fg256(244, "rtk"),
  ], width);
}

function turnLine(turn: TurnSummary, width: number): string {
  const cache = turnCacheCells(turn.cache);
  return formatTurnTableRow([
    turnLabel(turn),
    `tokens ${turn.actualTokens}/${turn.withoutRtkTokens}`,
    cache.cache,
    cache.diff,
    `tools ${turn.toolCalls}`,
    turn.rtk.rtk_commands > 0 ? `rtk ${turn.rtk.saved_tokens}` : undefined,
  ], width);
}

function epochLine(epoch: EpochSummary, width: number): string {
  const reason = epoch.compactReason
    ? `compact ${epoch.compactReason}${epoch.summaryStrategy ? `/${epoch.summaryStrategy}` : ""}`
    : (epoch.createdReason ?? "session");
  const cache =
    epoch.promptTurns && epoch.promptTokens
      ? `prefix ${((epoch.cachedTokens / epoch.promptTokens) * 100).toFixed(1)}% ${epoch.cachedTokens}/${epoch.promptTokens}`
      : "prefix -";
  const retention = [
    epoch.archivedEvents === undefined ? undefined : `archived ${epoch.archivedEvents}`,
    epoch.protectedTailEvents === undefined ? undefined : `protected ${epoch.protectedTailEvents}`,
  ].filter((part): part is string => Boolean(part)).join(" · ");
  return centerLine(
    [
      `${fg256(39, "epoch")} ${fg256(244, shortEpochId(epoch.promptEpochId))}`,
      reason,
      cache,
      retention || undefined,
    ].filter((part): part is string => Boolean(part)).join(" · "),
    width,
  );
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
    .map((cellWidth, index) => centerCell(cells[index] ?? "", cellWidth))
    .join(separator)
    .trimEnd();
  return centerLine(rendered, width);
}

function turnTableWidths(width: number): number[] {
  const widths = [18, 22, 46, 18, 10, 12];
  const minimums = [12, 16, 24, 12, 7, 8];
  const separatorWidth = 2 * (widths.length - 1);
  const target = Math.max(1, width);
  while (widths.reduce((sum, value) => sum + value, separatorWidth) > target) {
    let candidate = -1;
    for (let index = 0; index < widths.length; index += 1) {
      if (widths[index]! <= minimums[index]!) {
        continue;
      }
      if (candidate === -1 || widths[index]! - minimums[index]! > widths[candidate]! - minimums[candidate]!) {
        candidate = index;
      }
    }
    if (candidate === -1) {
      break;
    }
    widths[candidate] = widths[candidate]! - 1;
  }
  return widths;
}

function centerCell(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  const pad = Math.max(0, width - visibleWidth(clipped));
  const left = Math.floor(pad / 2);
  return `${" ".repeat(left)}${clipped}${" ".repeat(pad - left)}`;
}

function centerLine(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  const pad = Math.max(0, width - visibleWidth(clipped));
  return `${" ".repeat(Math.floor(pad / 2))}${clipped}`;
}

function turnLabel(turn: TurnSummary): string {
  if (turn.kind === "compaction") {
    return fg256(87, "compact");
  }
  if (turn.kind === "model_call") {
    const label = `turn ${turn.runOrdinal}.${turn.stepIndex ?? turn.index}`;
    return turn.isRunStart ? `${fg256(87, "›")} ${fg256(87, `${label} user`)}` : label;
  }
  return `turn ${turn.index}`;
}

function turnCacheCells(cache?: CacheObservation): { cache: string; diff: string } {
  if (!cache) {
    return { cache: fg256(244, "cache -"), diff: fg256(244, "cache gap -") };
  }
  if (cache.kind === "warmup") {
    if (cache.actualHit !== undefined && cache.oracleHit !== undefined) {
      return {
        cache: fg256(244, `warm actual/oracle cache ${formatPlainPct(cache.actualHit)}/${formatPlainPct(cache.oracleHit)}`),
        diff: fg256(244, `warm gap ${formatPlainPct(cache.cacheDiff ?? 0)}`),
      };
    }
    if (cache.actualHit !== undefined) {
      return { cache: fg256(244, `warm cache ${formatPlainPct(cache.actualHit)}`), diff: fg256(244, "warm gap -") };
    }
    return { cache: fg256(244, "warm cache -"), diff: fg256(244, "warm gap -") };
  }
  if (cache.actualHit !== undefined && cache.oracleHit !== undefined) {
    return {
      cache: `actual/oracle cache ${formatCacheHit(cache.actualHit)}/${formatCacheHit(cache.oracleHit)}`,
      diff: `cache gap ${formatCacheDiff(cache.cacheDiff ?? 0)}`,
    };
  }
  if (cache.actualHit !== undefined) {
    return { cache: `cache ${formatCacheHit(cache.actualHit)}`, diff: fg256(244, "cache gap -") };
  }
  if (cache.oracleHit !== undefined) {
    return { cache: `oracle cache ${formatCacheHit(cache.oracleHit)}`, diff: fg256(244, "cache gap -") };
  }
  return { cache: fg256(244, "cache -"), diff: fg256(244, "cache gap -") };
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
    event.type === "prompt.epoch.created" ||
    event.type === "context.compacted" ||
    event.type === "evidence.context_compression" ||
    event.type === "model.response.settled" ||
    event.type === "rtk.tool_savings" ||
    event.type === "run.completed" ||
    event.type === "run.stopped" ||
    event.type === "run.failed"
  );
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
    optionalNumberField(data.archived_events) === undefined ? undefined : `archived ${optionalNumberField(data.archived_events)}`,
    optionalNumberField(data.protected_tail_events) === undefined ? undefined : `protected ${optionalNumberField(data.protected_tail_events)}`,
    stringField(data.archive_resource_uri),
  ].filter((part): part is string => Boolean(part));
  return compactInlineString(parts.join(" · "), 180);
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
