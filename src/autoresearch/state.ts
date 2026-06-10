import type { JsonObject, SessionEvent } from "../types.js";
import { SessionStore } from "../session/store.js";
import { escapeXmlText } from "../goals/state.js";
import { truncateText } from "../util/limit.js";

const AUTORESEARCH_PROMPT_NOTES_LIMIT = 4_000;
const AUTORESEARCH_RESULT_DESCRIPTION_LIMIT = 500;

export type AutoresearchMode = "on" | "off" | "clear";
export type MetricDirection = "lower" | "higher";
export type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";

export interface AutoresearchRun {
  id: number;
  command: string;
  exit_code: number | null;
  duration_ms: number;
  output_resource_uri?: string;
  timed_out?: boolean;
  output_truncated?: boolean;
  parsed_metrics: Record<string, number>;
  parsed_primary: number | null;
  asi: JsonObject;
  sandbox?: JsonObject;
  completed_at: string;
}

export interface HarnessValidation {
  ok: boolean;
  command: string;
  exit_code: number | null;
  duration_ms: number;
  parsed_metrics: Record<string, number>;
  parsed_primary: number | null;
  output_resource_uri?: string;
  timed_out?: boolean;
  output_truncated?: boolean;
  sandbox?: JsonObject;
  message: string;
  validated_at: string;
}

export interface AutoresearchResult {
  run_id: number;
  status: ExperimentStatus;
  metric: number | null;
  metrics: Record<string, number>;
  description: string;
  asi: JsonObject;
  logged_at: string;
}

export interface AutoresearchExperiment {
  name: string;
  goal?: string;
  primary_metric: string;
  metric_unit: string;
  direction: MetricDirection;
  scope_paths: string[];
  off_limits: string[];
  constraints: string[];
  max_iterations?: number;
  current_segment: number;
  notes: string;
  harness_status?: HarnessValidation;
  next_run_id: number;
  best_metric: number | null;
  pending_run?: AutoresearchRun;
  results: AutoresearchResult[];
}

export interface AutoresearchState {
  enabled: boolean;
  goal?: string;
  experiment?: AutoresearchExperiment;
}

export interface AutoresearchProgress {
  logged_runs: number;
  total_runs: number;
  pending_runs: number;
  kept_runs: number;
  discarded_runs: number;
  crashed_runs: number;
  checks_failed_runs: number;
  keep_cap?: number;
  keep_remaining?: number;
}

export interface SetAutoresearchModeInput {
  mode: AutoresearchMode;
  goal?: string | null;
}

export function readAutoresearchState(store: SessionStore, sessionId: string): AutoresearchState {
  let state: AutoresearchState = { enabled: false };
  for (const event of store.listEvents(sessionId)) {
    if (event.type === "autoresearch.control") {
      state = applyControlEvent(state, event);
    } else if (event.type === "autoresearch.state") {
      state = parseAutoresearchState(event.data) ?? state;
    }
  }
  return state;
}

export function setAutoresearchMode(
  store: SessionStore,
  sessionId: string,
  input: SetAutoresearchModeInput,
  runId?: string,
): AutoresearchState {
  store.appendEvent({
    session_id: sessionId,
    run_id: runId,
    type: "autoresearch.control",
    data: {
      mode: input.mode,
      goal: input.goal ?? undefined,
    },
  });
  const previous = input.mode === "clear" ? { enabled: false } : readAutoresearchState(store, sessionId);
  const next: AutoresearchState =
    input.mode === "on"
      ? { ...previous, enabled: true, goal: input.goal?.trim() || previous.goal }
      : input.mode === "clear"
        ? { enabled: false }
        : { ...previous, enabled: false, goal: input.goal?.trim() || previous.goal };
  writeAutoresearchState(store, sessionId, next, runId);
  return next;
}

export function writeAutoresearchState(
  store: SessionStore,
  sessionId: string,
  state: AutoresearchState,
  runId?: string,
): AutoresearchState {
  const cloned = cloneAutoresearchState(state);
  store.appendEvent({
    session_id: sessionId,
    run_id: runId,
    type: "autoresearch.state",
    data: autoresearchStateToJson(cloned),
  });
  return cloned;
}

export function createExperiment(input: {
  name: string;
  goal?: string;
  primary_metric: string;
  metric_unit?: string;
  direction?: MetricDirection;
  scope_paths?: string[];
  off_limits?: string[];
  constraints?: string[];
  max_iterations?: number;
  harness_status?: HarnessValidation;
}): AutoresearchExperiment {
  const name = input.name.trim();
  const primaryMetric = input.primary_metric.trim();
  if (!name) {
    throw new Error("experiment name is required");
  }
  if (!primaryMetric) {
    throw new Error("primary_metric is required");
  }
  const maxIterations = input.max_iterations;
  if (maxIterations !== undefined && (!Number.isInteger(maxIterations) || maxIterations <= 0)) {
    throw new Error("max_iterations must be a positive integer when provided");
  }
  return {
    name,
    goal: input.goal?.trim() || undefined,
    primary_metric: primaryMetric,
    metric_unit: input.metric_unit?.trim() ?? "",
    direction: input.direction ?? "lower",
    scope_paths: cleanStringList(input.scope_paths),
    off_limits: cleanStringList(input.off_limits),
    constraints: cleanStringList(input.constraints),
    max_iterations: maxIterations,
    current_segment: 0,
    notes: "",
    harness_status: input.harness_status ? cloneHarnessValidation(input.harness_status) : undefined,
    next_run_id: 1,
    best_metric: null,
    results: [],
  };
}

export function recordRun(experiment: AutoresearchExperiment, run: Omit<AutoresearchRun, "id">): AutoresearchExperiment {
  const next = cloneExperiment(experiment);
  next.pending_run = {
    id: next.next_run_id,
    ...run,
  };
  next.next_run_id += 1;
  return next;
}

export function logPendingRun(
  experiment: AutoresearchExperiment,
  input: {
    status: ExperimentStatus;
    metric: number | null;
    description: string;
    metrics?: Record<string, number>;
    asi?: JsonObject;
  },
): AutoresearchExperiment {
  if (!experiment.pending_run) {
    throw new Error("no pending autoresearch run; call run_experiment first");
  }
  if (input.metric !== null && !Number.isFinite(input.metric)) {
    throw new Error("metric must be finite");
  }
  if (input.status === "keep" && input.metric === null) {
    throw new Error("metric is required when keeping a run");
  }
  const description = input.description.trim();
  if (!description) {
    throw new Error("description is required");
  }
  const next = cloneExperiment(experiment);
  const pending = next.pending_run!;
  const metrics = {
    ...pending.parsed_metrics,
    ...numericRecord(input.metrics),
  };
  if (input.metric !== null) {
    metrics[experiment.primary_metric] = input.metric;
  }
  const result: AutoresearchResult = {
    run_id: pending.id,
    status: input.status,
    metric: input.metric,
    metrics,
    description,
    asi: { ...pending.asi, ...(input.asi ?? {}) },
    logged_at: new Date().toISOString(),
  };
  next.results.push(result);
  next.pending_run = undefined;
  next.best_metric = computeBestMetric(next.results, next.direction);
  return next;
}

export function renderAutoresearchModeSection(state: AutoresearchState): string | undefined {
  if (!state.enabled) {
    return undefined;
  }
  const goal = state.goal ?? state.experiment?.goal ?? "";
  if (!state.experiment) {
    return [
      "Autoresearch mode is active for this session.",
      goal ? `Goal: ${escapeXmlText(goal)}` : "Goal: not specified yet",
      "Phase 1: build a benchmark harness at ./autoresearch.sh.",
      "The harness must exit 0 for a valid run and print lines like METRIC name=value.",
      "After validating the harness, call init_experiment with the primary metric, direction, scope paths, and constraints.",
    ].join("\n");
  }
  const experiment = state.experiment;
  const pending = experiment.pending_run;
  const progress = summarizeAutoresearchProgress(experiment);
  const recent = experiment.results.slice(-5).map((result) => {
    const metric = escapeXmlText(formatMetric(result.metric, experiment.metric_unit));
    const description = truncateInlinePromptText(result.description, AUTORESEARCH_RESULT_DESCRIPTION_LIMIT);
    return `- run ${result.run_id}: ${result.status} ${escapeXmlText(experiment.primary_metric)}=${metric} ${escapeXmlText(description)}`;
  });
  const notes = truncateText(experiment.notes.trim(), AUTORESEARCH_PROMPT_NOTES_LIMIT).text;
  return [
    "Autoresearch mode is active for this session.",
    goal ? `Goal: ${escapeXmlText(goal)}` : undefined,
    `Experiment: ${escapeXmlText(experiment.name)}`,
    `Primary metric: ${escapeXmlText(experiment.primary_metric)} (${escapeXmlText(experiment.metric_unit || "unitless")}; ${experiment.direction} is better)`,
    `Best kept metric: ${experiment.best_metric === null ? "none" : escapeXmlText(formatMetric(experiment.best_metric, experiment.metric_unit))}`,
    `Progress: ${formatProgress(progress)}`,
    progress.keep_cap === undefined
      ? undefined
      : `Keep-run cap: ${progress.kept_runs}/${progress.keep_cap}; ${progress.keep_remaining ?? 0} ${plural(progress.keep_remaining ?? 0, "keep run")} remaining before autoresearch disables itself.`,
    pending
      ? `Pending run: ${formatPendingRun(pending)}; parsed ${escapeXmlText(experiment.primary_metric)}=${pending.parsed_primary ?? "missing"}. Log it with log_experiment before starting another run; metric can be omitted when parsed.`
      : "No pending run. Continue with the next useful experiment or run the baseline if no results exist.",
    experiment.scope_paths.length ? `Scope paths: ${experiment.scope_paths.map(escapeXmlText).join(", ")}` : undefined,
    experiment.off_limits.length ? `Off limits: ${experiment.off_limits.map(escapeXmlText).join(", ")}` : undefined,
    experiment.constraints.length ? `Constraints: ${experiment.constraints.map(escapeXmlText).join("; ")}` : undefined,
    notes ? `Notes:\n${escapeXmlText(notes)}` : undefined,
    experiment.harness_status ? `Harness: ${escapeXmlText(experiment.harness_status.message)}` : undefined,
    recent.length ? `Recent results:\n${recent.join("\n")}` : "Recent results: none",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function truncateInlinePromptText(value: string, limit: number): string {
  return truncateText(value.replace(/\s+/g, " ").trim(), limit).text.replace(/\s+/g, " ").trim();
}

export function summarizeAutoresearchProgress(experiment: AutoresearchExperiment): AutoresearchProgress {
  let keptRuns = 0;
  let discardedRuns = 0;
  let crashedRuns = 0;
  let checksFailedRuns = 0;
  for (const result of experiment.results) {
    if (result.status === "keep") keptRuns += 1;
    if (result.status === "discard") discardedRuns += 1;
    if (result.status === "crash") crashedRuns += 1;
    if (result.status === "checks_failed") checksFailedRuns += 1;
  }
  const pendingRuns = experiment.pending_run ? 1 : 0;
  return {
    logged_runs: experiment.results.length,
    total_runs: experiment.results.length + pendingRuns,
    pending_runs: pendingRuns,
    kept_runs: keptRuns,
    discarded_runs: discardedRuns,
    crashed_runs: crashedRuns,
    checks_failed_runs: checksFailedRuns,
    keep_cap: experiment.max_iterations,
    keep_remaining: experiment.max_iterations === undefined ? undefined : Math.max(0, experiment.max_iterations - keptRuns),
  };
}

export function parseMetricLines(output: string): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*METRIC\s+([A-Za-z0-9_.:-]+)\s*=\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*$/i);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics[match[1]] = value;
    }
  }
  return metrics;
}

export function parseAsiLines(output: string): JsonObject {
  const asi: JsonObject = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*ASI\s+([A-Za-z0-9_.:-]+)\s*=\s*(.*?)\s*$/i);
    if (!match?.[1]) {
      continue;
    }
    asi[match[1]] = coerceAsiValue(match[2] ?? "");
  }
  return asi;
}

export function cloneAutoresearchState(state: AutoresearchState): AutoresearchState {
  return {
    enabled: state.enabled,
    goal: state.goal,
    experiment: state.experiment ? cloneExperiment(state.experiment) : undefined,
  };
}

function cloneExperiment(experiment: AutoresearchExperiment): AutoresearchExperiment {
  return {
    ...experiment,
    scope_paths: [...experiment.scope_paths],
    off_limits: [...experiment.off_limits],
    constraints: [...experiment.constraints],
    harness_status: experiment.harness_status ? cloneHarnessValidation(experiment.harness_status) : undefined,
    pending_run: experiment.pending_run ? { ...experiment.pending_run, parsed_metrics: { ...experiment.pending_run.parsed_metrics }, asi: { ...experiment.pending_run.asi } } : undefined,
    results: experiment.results.map((result) => ({
      ...result,
      metrics: { ...result.metrics },
      asi: { ...result.asi },
    })),
  };
}

function autoresearchStateToJson(state: AutoresearchState): JsonObject {
  return {
    enabled: state.enabled,
    goal: state.goal,
    experiment: state.experiment as unknown as JsonObject,
  };
}

function applyControlEvent(state: AutoresearchState, event: SessionEvent): AutoresearchState {
  const mode = event.data.mode;
  const goal = typeof event.data.goal === "string" && event.data.goal.trim() ? event.data.goal.trim() : state.goal;
  if (mode === "clear") {
    return { enabled: false };
  }
  if (mode === "on") {
    return { ...state, enabled: true, goal };
  }
  if (mode === "off") {
    return { ...state, enabled: false, goal };
  }
  return state;
}

function parseAutoresearchState(data: JsonObject): AutoresearchState | undefined {
  const enabled = data.enabled === true;
  const goal = typeof data.goal === "string" ? data.goal : undefined;
  const experiment = parseExperiment(data.experiment);
  return { enabled, goal, experiment };
}

function parseExperiment(value: unknown): AutoresearchExperiment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const name = typeof data.name === "string" ? data.name : "";
  const primaryMetric = typeof data.primary_metric === "string" ? data.primary_metric : "";
  const direction = data.direction === "higher" ? "higher" : "lower";
  if (!name || !primaryMetric) {
    return undefined;
  }
  return {
    name,
    goal: typeof data.goal === "string" ? data.goal : undefined,
    primary_metric: primaryMetric,
    metric_unit: typeof data.metric_unit === "string" ? data.metric_unit : "",
    direction,
    scope_paths: stringArray(data.scope_paths),
    off_limits: stringArray(data.off_limits),
    constraints: stringArray(data.constraints),
    max_iterations: positiveIntOrUndefined(data.max_iterations),
    current_segment: nonNegativeInt(data.current_segment),
    notes: typeof data.notes === "string" ? data.notes : "",
    harness_status: parseHarnessValidation(data.harness_status),
    next_run_id: positiveIntOrUndefined(data.next_run_id) ?? 1,
    best_metric: typeof data.best_metric === "number" && Number.isFinite(data.best_metric) ? data.best_metric : null,
    pending_run: parseRun(data.pending_run),
    results: Array.isArray(data.results) ? data.results.map(parseResult).filter((item): item is AutoresearchResult => Boolean(item)) : [],
  };
}

function cloneHarnessValidation(status: HarnessValidation): HarnessValidation {
  return {
    ...status,
    parsed_metrics: { ...status.parsed_metrics },
    sandbox: status.sandbox ? { ...status.sandbox } : undefined,
  };
}

function parseRun(value: unknown): AutoresearchRun | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const id = positiveIntOrUndefined(data.id);
  const command = typeof data.command === "string" ? data.command : "";
  if (!id || !command) {
    return undefined;
  }
  return {
    id,
    command,
    exit_code: typeof data.exit_code === "number" ? Math.trunc(data.exit_code) : null,
    duration_ms: nonNegativeInt(data.duration_ms),
    output_resource_uri: typeof data.output_resource_uri === "string" ? data.output_resource_uri : undefined,
    timed_out: data.timed_out === true ? true : undefined,
    output_truncated: data.output_truncated === true ? true : undefined,
    parsed_metrics: numericRecord(data.parsed_metrics),
    parsed_primary: typeof data.parsed_primary === "number" && Number.isFinite(data.parsed_primary) ? data.parsed_primary : null,
    asi: objectRecord(data.asi),
    sandbox: objectRecordOrUndefined(data.sandbox),
    completed_at: typeof data.completed_at === "string" ? data.completed_at : "",
  };
}

function parseHarnessValidation(value: unknown): HarnessValidation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const command = typeof data.command === "string" ? data.command : "";
  const message = typeof data.message === "string" ? data.message : "";
  if (!command || !message) {
    return undefined;
  }
  return {
    ok: data.ok === true,
    command,
    exit_code: typeof data.exit_code === "number" ? Math.trunc(data.exit_code) : null,
    duration_ms: nonNegativeInt(data.duration_ms),
    parsed_metrics: numericRecord(data.parsed_metrics),
    parsed_primary: typeof data.parsed_primary === "number" && Number.isFinite(data.parsed_primary) ? data.parsed_primary : null,
    output_resource_uri: typeof data.output_resource_uri === "string" ? data.output_resource_uri : undefined,
    timed_out: data.timed_out === true ? true : undefined,
    output_truncated: data.output_truncated === true ? true : undefined,
    sandbox: objectRecordOrUndefined(data.sandbox),
    message,
    validated_at: typeof data.validated_at === "string" ? data.validated_at : "",
  };
}

function parseResult(value: unknown): AutoresearchResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const runId = positiveIntOrUndefined(data.run_id);
  const status = parseStatus(data.status);
  const metric = typeof data.metric === "number" && Number.isFinite(data.metric) ? data.metric : data.metric === null ? null : undefined;
  const description = typeof data.description === "string" ? data.description : "";
  if (!runId || !status || metric === undefined || !description) {
    return undefined;
  }
  return {
    run_id: runId,
    status,
    metric,
    metrics: numericRecord(data.metrics),
    description,
    asi: objectRecord(data.asi),
    logged_at: typeof data.logged_at === "string" ? data.logged_at : "",
  };
}

function parseStatus(value: unknown): ExperimentStatus | undefined {
  return value === "keep" || value === "discard" || value === "crash" || value === "checks_failed" ? value : undefined;
}

function computeBestMetric(results: AutoresearchResult[], direction: MetricDirection): number | null {
  let best: number | null = null;
  for (const result of results) {
    if (result.status !== "keep") {
      continue;
    }
    if (typeof result.metric !== "number") {
      continue;
    }
    if (best === null || (direction === "lower" ? result.metric < best : result.metric > best)) {
      best = result.metric;
    }
  }
  return best;
}

function formatMetric(value: number | null, unit: string): string {
  if (value === null) {
    return "missing";
  }
  return `${value}${unit ? ` ${unit}` : ""}`;
}

function formatPendingRun(run: AutoresearchRun): string {
  const status = run.timed_out
    ? "timed out"
    : run.exit_code === null
      ? "exit unknown"
      : `exit ${run.exit_code}`;
  const parts = [
    status,
    run.output_truncated ? "output truncated" : undefined,
    run.output_resource_uri ? `output ${escapeXmlText(run.output_resource_uri)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return `${run.id} (${parts.join("; ")})`;
}

function formatProgress(progress: AutoresearchProgress): string {
  const pieces = [
    `${progress.logged_runs} ${plural(progress.logged_runs, "logged run")}`,
    `${progress.kept_runs} keep`,
    progress.discarded_runs ? `${progress.discarded_runs} discard` : undefined,
    progress.crashed_runs ? `${progress.crashed_runs} crash` : undefined,
    progress.checks_failed_runs ? `${progress.checks_failed_runs} checks_failed` : undefined,
    progress.pending_runs ? `${progress.pending_runs} pending` : "no pending run",
  ];
  return pieces.filter((piece): piece is string => Boolean(piece)).join("; ");
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function coerceAsiValue(value: string): string | number | boolean | null {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  const numeric = Number(trimmed);
  return trimmed && Number.isFinite(numeric) ? numeric : trimmed;
}

function cleanStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numericRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

function objectRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function objectRecordOrUndefined(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function positiveIntOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
