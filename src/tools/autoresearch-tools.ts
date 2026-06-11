import { spawn } from "node:child_process";
import path from "node:path";
import { access } from "node:fs/promises";
import type { JsonObject, ToolResult } from "../types.js";
import { fail, ok, truncateText } from "../util/limit.js";
import type { ToolExecutionContext } from "./context.js";
import {
  activeAutoresearchExperiment,
  createExperiment,
  type HarnessValidation,
  logPendingRun,
  parseAsiLines,
  parseMetricLines,
  pendingAutoresearchExperiment,
  readAutoresearchState,
  recordRun,
  type ResearchExperimentStatus,
  setAutoresearchMode,
  summarizeAutoresearchProgress,
  updateAutoresearchExperimentState,
  upsertAutoresearchExperiment,
  writeAutoresearchState,
  type AutoresearchState,
  type AutoresearchExperiment,
  type ExperimentStatus,
  type MetricDirection,
} from "../autoresearch/state.js";
import { readGoalState } from "../goals/state.js";
import { recordGoalVerification, researchVerificationVerdict } from "../loop/verification.js";

const HARNESS = "autoresearch.sh";
const HARNESS_COMMAND = `bash ${HARNESS}`;
const HARNESS_VALIDATION_TIMEOUT_MS = 60_000;
const HARNESS_TIMEOUT_GRACE_MS = 500;
const HARNESS_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

interface HarnessRunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  outputTruncated: boolean;
  parsedMetrics: Record<string, number>;
  asi: JsonObject;
}

export async function initExperiment(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  try {
    await access(path.join(context.workspace.root, HARNESS));
    const state = ensureResearchGoalEnabled(context);
    const primaryMetric = requiredString(args.primary_metric, "primary_metric");
    const shouldValidate = booleanArg(args.validate_harness) !== false;
    let harnessStatus: HarnessValidation | undefined;
    if (shouldValidate) {
      harnessStatus = await validateHarness(context, primaryMetric);
      if (!harnessStatus.ok) {
        return fail("harness_validation_failed", harnessStatus.message, autoresearchFailureData(state, {
          harness_status: harnessStatus as unknown as JsonObject,
        }));
      }
      if (harnessStatus.parsed_primary === null) {
        return fail("harness_metric_missing", `Harness did not print required METRIC ${primaryMetric}=value.`, autoresearchFailureData(state, {
          harness_status: harnessStatus as unknown as JsonObject,
        }));
      }
    }
    const experiment = createExperiment({
      name: requiredString(args.name, "name"),
      goal: stringArg(args.goal) ?? state.goal,
      primary_metric: primaryMetric,
      metric_unit: stringArg(args.metric_unit),
      direction: directionArg(args.direction),
      scope_paths: stringArrayArg(args.scope_paths),
      off_limits: stringArrayArg(args.off_limits),
      constraints: stringArrayArg(args.constraints),
      max_iterations: positiveIntArg(args.max_iterations),
      harness_status: harnessStatus,
    });
    const nextState = upsertAutoresearchExperiment(
      {
        ...state,
        enabled: true,
        goal: experiment.goal ?? state.goal,
      },
      experiment,
      { setActive: true },
    );
    const next = writeAutoresearchState(
      context.store,
      context.session_id,
      nextState,
      context.run_id,
    );
    return ok(`Research experiment initialized: ${experiment.name}\nMetric: ${experiment.primary_metric}\nBenchmark: ${HARNESS_COMMAND}`, {
      autoresearch: next as unknown as JsonObject,
      progress: summarizeAutoresearchProgress(experiment) as unknown as JsonObject,
      harness_status: harnessStatus as unknown as JsonObject | undefined,
    });
  } catch (error) {
    return fail("init_experiment_failed", error instanceof Error ? error.message : String(error));
  }
}

export async function runExperiment(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const state = readAutoresearchState(context.store, context.session_id);
  if (!state.enabled) {
    return fail("research_goal_required", "no active research goal; start with /loop mode research <objective>", autoresearchFailureData(state));
  }
  const pendingExperiment = pendingAutoresearchExperiment(state);
  if (pendingExperiment?.pending_run) {
    return fail(
      "autoresearch_pending_run",
      `experiment "${pendingExperiment.name}" run ${pendingExperiment.pending_run.id} is still pending; call log_experiment before starting another run`,
      autoresearchFailureData(state, { pending_run: pendingExperiment.pending_run as unknown as JsonObject, experiment_name: pendingExperiment.name }),
    );
  }
  const experiment = selectExperiment(state, args);
  if (!experiment) {
    return fail("autoresearch_not_initialized", "no active research experiment; call init_experiment first", autoresearchFailureData(state));
  }
  let timeoutMs: number;
  try {
    timeoutMs = timeoutArg(args);
  } catch (error) {
    return fail("autoresearch_timeout_invalid", error instanceof Error ? error.message : String(error), autoresearchFailureData(state));
  }
  const started = Date.now();
  const result = await runHarness(context.workspace.root, timeoutMs);
  const durationMs = Date.now() - started;
  const resource = context.store.putResource(context.session_id, "autoresearch.run.output", result.output, {
    command: HARNESS_COMMAND,
    exit_code: result.exitCode,
    duration_ms: durationMs,
    timed_out: result.timedOut,
    output_truncated: result.outputTruncated,
  });
  const parsedMetrics = result.parsedMetrics;
  const parsedPrimary = parsedMetrics[experiment.primary_metric] ?? null;
  const nextExperiment = recordRun(experiment, {
    command: HARNESS_COMMAND,
    exit_code: result.exitCode,
    duration_ms: durationMs,
    output_resource_uri: resource.uri,
    timed_out: result.timedOut,
    output_truncated: result.outputTruncated,
    parsed_metrics: parsedMetrics,
    parsed_primary: parsedPrimary,
    asi: result.asi,
    completed_at: new Date().toISOString(),
  });
  const next = writeAutoresearchState(
    context.store,
    context.session_id,
    upsertAutoresearchExperiment(state, nextExperiment, { setActive: true }),
    context.run_id,
  );
  const preview = truncateText(result.output, 4000).text;
  const status = result.timedOut ? `timed out exit=${result.exitCode}` : result.exitCode === 0 ? "passed" : `failed exit=${result.exitCode}`;
  return ok(`Run ${nextExperiment.pending_run?.id} ${status} in ${(durationMs / 1000).toFixed(1)}s`, {
    command: HARNESS_COMMAND,
    exit_code: result.exitCode,
    duration_ms: durationMs,
    timed_out: result.timedOut,
    output_truncated: result.outputTruncated,
    output_resource_uri: resource.uri,
    parsed_metrics: parsedMetrics,
    parsed_primary: parsedPrimary,
    output_preview: preview,
    autoresearch: next as unknown as JsonObject,
    progress: summarizeAutoresearchProgress(nextExperiment) as unknown as JsonObject,
  });
}

async function validateHarness(context: ToolExecutionContext, primaryMetric: string): Promise<HarnessValidation> {
  const started = Date.now();
  const result = await runHarness(context.workspace.root, HARNESS_VALIDATION_TIMEOUT_MS);
  const durationMs = Date.now() - started;
  const parsedMetrics = result.parsedMetrics;
  const parsedPrimary = parsedMetrics[primaryMetric] ?? null;
  const resource = context.store.putResource(context.session_id, "autoresearch.harness.validation", result.output, {
    command: HARNESS_COMMAND,
    exit_code: result.exitCode,
    duration_ms: durationMs,
    primary_metric: primaryMetric,
    timed_out: result.timedOut,
    output_truncated: result.outputTruncated,
  });
  const ok = result.exitCode === 0;
  const metricMessage = parsedPrimary === null ? `missing METRIC ${primaryMetric}=value` : `${primaryMetric}=${parsedPrimary}`;
  return {
    ok,
    command: HARNESS_COMMAND,
    exit_code: result.exitCode,
    duration_ms: durationMs,
    parsed_metrics: parsedMetrics,
    parsed_primary: parsedPrimary,
    output_resource_uri: resource.uri,
    timed_out: result.timedOut,
    output_truncated: result.outputTruncated,
    message: result.timedOut ? `harness timed out; ${metricMessage}` : ok ? `validated ${metricMessage}` : `harness exited ${result.exitCode}; ${metricMessage}`,
    validated_at: new Date().toISOString(),
  };
}

export async function logExperiment(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  let state: AutoresearchState | undefined;
  try {
    state = readAutoresearchState(context.store, context.session_id);
    if (!state.enabled) {
      return fail("autoresearch_not_initialized", "no active autoresearch experiment; call init_experiment first", autoresearchFailureData(state));
    }
    const pendingExperiment = pendingAutoresearchExperiment(state);
    if (!pendingExperiment?.pending_run) {
      return fail("log_experiment_failed", "no pending autoresearch run; call run_experiment first", autoresearchFailureData(state));
    }
    const status = statusArg(args.status);
    let nextExperiment = logPendingRun(pendingExperiment, {
      status,
      metric: metricArg(args.metric, pendingExperiment.pending_run.parsed_primary, status),
      description: requiredString(args.description, "description"),
      metrics: numericRecordArg(args.metrics),
      asi: objectArg(args.asi),
    });
    const reachedLimit =
      nextExperiment.max_iterations !== undefined &&
      nextExperiment.results.filter((result) => result.status === "keep").length >= nextExperiment.max_iterations;
    const explicitExperimentStatus = experimentLifecycleStatusArg(args.experiment_status);
    if (explicitExperimentStatus) {
      nextExperiment = { ...nextExperiment, status: explicitExperimentStatus };
    } else if (reachedLimit) {
      nextExperiment = { ...nextExperiment, status: "completed" };
    }
    const next = writeAutoresearchState(
      context.store,
      context.session_id,
      upsertAutoresearchExperiment(state, nextExperiment, { setActive: true }),
      context.run_id,
    );
    const latest = nextExperiment.results.at(-1)!;
    const goal = readGoalState(context.store, context.session_id)?.goal;
    if (goal) {
      recordGoalVerification(context.store, context.session_id, {
        provider: "research",
        verdict: researchVerificationVerdict(latest.status),
        confidence: typeof latest.metric === "number" ? "hard" : "mixed",
        goal_id: goal.id,
        horizon_generation: goal.horizon_generation,
        run_id: String(latest.run_id),
        evidence: {
          experiment: nextExperiment.name,
          status: latest.status,
          description: latest.description,
          asi: latest.asi,
        },
        metrics: {
          primary_metric: nextExperiment.primary_metric,
          metric: latest.metric,
          ...latest.metrics,
        },
        summary: latest.description,
        failure_reason: latest.status === "keep" ? undefined : latest.description,
      }, context.run_id);
    }
    return ok(`Logged run ${latest.run_id}: ${latest.status} ${nextExperiment.primary_metric}=${latest.metric === null ? "missing" : latest.metric}`, {
      result: latest as unknown as JsonObject,
      autoresearch: next as unknown as JsonObject,
      progress: summarizeAutoresearchProgress(nextExperiment) as unknown as JsonObject,
    });
  } catch (error) {
    return fail("log_experiment_failed", error instanceof Error ? error.message : String(error), state ? autoresearchFailureData(state) : undefined);
  }
}

export async function updateNotes(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const state = readAutoresearchState(context.store, context.session_id);
  if (!state.enabled) {
    return fail("autoresearch_not_initialized", "no active autoresearch experiment; call init_experiment first", autoresearchFailureData(state));
  }
  const experiment = selectExperiment(state, args);
  if (!experiment) {
    return fail("autoresearch_not_initialized", "no active research experiment; call init_experiment first", autoresearchFailureData(state));
  }
  const body = stringArg(args.body) ?? experiment.notes;
  const appendIdea = stringArg(args.append_idea);
  const notes = appendIdea ? appendIdeaToNotes(body, appendIdea) : body;
  const nextExperiment = { ...experiment, notes };
  const next = writeAutoresearchState(context.store, context.session_id, upsertAutoresearchExperiment(state, nextExperiment, { setActive: true }), context.run_id);
  return ok(appendIdea ? "Research idea appended." : "Research notes updated.", {
    notes,
    autoresearch: next as unknown as JsonObject,
  });
}

export async function updateExperiment(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  let state: AutoresearchState | undefined;
  try {
    state = readAutoresearchState(context.store, context.session_id);
    if (!state.enabled) {
      return fail("autoresearch_not_initialized", "no active research goal; start with /loop mode research <objective>", autoresearchFailureData(state));
    }
    const experiment = selectExperiment(state, args);
    if (!experiment) {
      return fail("autoresearch_not_initialized", "no active research experiment; call init_experiment first", autoresearchFailureData(state));
    }
    const status = experimentLifecycleStatusArg(args.status);
    const nextState = updateAutoresearchExperimentState(state, experiment.name, {
      status,
      notes: stringArg(args.notes),
      appendIdea: stringArg(args.append_idea),
      setActive: booleanArg(args.set_active) || args.set_active === undefined,
    });
    const next = writeAutoresearchState(context.store, context.session_id, nextState, context.run_id);
    const active = next.experiment;
    return ok(`Research experiment updated: ${experiment.name}`, {
      experiment: active as unknown as JsonObject,
      autoresearch: next as unknown as JsonObject,
    });
  } catch (error) {
    return fail("update_experiment_failed", error instanceof Error ? error.message : String(error), state ? autoresearchFailureData(state) : undefined);
  }
}

function autoresearchFailureData(state: AutoresearchState, extra: JsonObject = {}): JsonObject {
  const experiment = activeAutoresearchExperiment(state);
  return {
    autoresearch: state as unknown as JsonObject,
    ...(experiment ? { progress: summarizeAutoresearchProgress(experiment) as unknown as JsonObject } : {}),
    ...extra,
  };
}

function ensureResearchGoalEnabled(context: ToolExecutionContext): AutoresearchState {
  const goal = readGoalState(context.store, context.session_id);
  if (!goal || goal.goal.kind !== "research" || goal.goal.status === "complete" || goal.goal.status === "dropped") {
    throw new Error("an active research goal is required; start with /loop mode research <objective>");
  }
  const state = readAutoresearchState(context.store, context.session_id);
  if (state.enabled) {
    return state;
  }
  return setAutoresearchMode(context.store, context.session_id, { mode: "on", goal: state.goal ?? goal.goal.objective }, context.run_id);
}

function selectExperiment(state: AutoresearchState, args: JsonObject): AutoresearchExperiment | undefined {
  const name = stringArg(args.experiment_name) ?? stringArg(args.name);
  if (name) {
    return state.experiments?.find((experiment) => experiment.name === name);
  }
  return activeAutoresearchExperiment(state);
}

function runHarness(cwd: string, timeoutMs: number): Promise<HarnessRunResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", [HARNESS], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let outputBytes = 0;
    let outputTruncated = false;
    let parseBuffer = "";
    const parsedMetrics: Record<string, number> = {};
    const asi: JsonObject = {};
    let timedOut = false;
    let settled = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;

    const appendNotice = (message: string) => {
      output += `${output.endsWith("\n") || output.length === 0 ? "" : "\n"}${message}\n`;
    };
    const markTruncated = () => {
      if (!outputTruncated) {
        outputTruncated = true;
        appendNotice(`[autoresearch output truncated at ${HARNESS_OUTPUT_LIMIT_BYTES} bytes]`);
      }
    };
    const appendOutput = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      parseHarnessChunk(buffer.toString("utf8"));
      if (outputBytes >= HARNESS_OUTPUT_LIMIT_BYTES) {
        markTruncated();
        return;
      }
      const remaining = HARNESS_OUTPUT_LIMIT_BYTES - outputBytes;
      if (buffer.length <= remaining) {
        output += buffer.toString("utf8");
        outputBytes += buffer.length;
        return;
      }
      output += buffer.subarray(0, remaining).toString("utf8");
      outputBytes = HARNESS_OUTPUT_LIMIT_BYTES;
      markTruncated();
    };
    const parseHarnessChunk = (text: string) => {
      parseBuffer += text;
      const lines = parseBuffer.split(/\r?\n/);
      parseBuffer = lines.pop() ?? "";
      for (const line of lines) {
        Object.assign(parsedMetrics, parseMetricLines(line));
        Object.assign(asi, parseAsiLines(line));
      }
    };
    const flushHarnessParser = () => {
      if (!parseBuffer.trim()) {
        return;
      }
      Object.assign(parsedMetrics, parseMetricLines(parseBuffer));
      Object.assign(asi, parseAsiLines(parseBuffer));
      parseBuffer = "";
    };
    const signalHarness = (signal: NodeJS.Signals) => {
      if (!child.pid) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The process may already have exited between timeout and cleanup.
        }
      }
    };
    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (hardKillTimer) {
        clearTimeout(hardKillTimer);
      }
      flushHarnessParser();
      resolve({ exitCode, output, timedOut, outputTruncated, parsedMetrics, asi });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      appendNotice(`[autoresearch timed out after ${timeoutMs}ms]`);
      signalHarness("SIGTERM");
      hardKillTimer = setTimeout(() => {
        appendNotice(`[autoresearch hard kill after ${timeoutMs + HARNESS_TIMEOUT_GRACE_MS}ms]`);
        signalHarness("SIGKILL");
      }, HARNESS_TIMEOUT_GRACE_MS);
      hardKillTimer.unref();
    }, timeoutMs);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      appendOutput(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      appendOutput(chunk);
    });
    child.on("error", (error) => {
      appendNotice(error.message);
      finish(127);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

function requiredString(value: unknown, name: string): string {
  const text = stringArg(value)?.trim();
  if (!text) {
    throw new Error(`${name} is required`);
  }
  return text;
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArrayArg(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function directionArg(value: unknown): MetricDirection | undefined {
  return value === "lower" || value === "higher" ? value : undefined;
}

function statusArg(value: unknown): ExperimentStatus {
  if (value === "keep" || value === "discard" || value === "crash" || value === "checks_failed") {
    return value;
  }
  throw new Error("status must be keep, discard, crash, or checks_failed");
}

function experimentLifecycleStatusArg(value: unknown): ResearchExperimentStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "active" || value === "completed" || value === "rejected") {
    return value;
  }
  throw new Error("experiment status must be active, completed, or rejected");
}

function positiveIntArg(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("max_iterations must be a positive integer when provided");
  }
  return value;
}

function finiteNumberArg(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function metricArg(value: unknown, fallback: number | null | undefined, status: ExperimentStatus): number | null {
  if (value !== undefined) {
    return finiteNumberArg(value, "metric");
  }
  if (typeof fallback === "number" && Number.isFinite(fallback)) {
    return fallback;
  }
  if (status !== "keep") {
    return null;
  }
  throw new Error("metric is required when the pending run did not parse the primary metric");
}

function timeoutArg(args: JsonObject): number {
  const timeoutMs = args.timeout_ms;
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      return Math.trunc(timeoutMs);
    }
    throw new Error("timeout_ms must be a positive finite number when provided");
  }
  const timeoutSeconds = args.timeout_seconds;
  if (timeoutSeconds !== undefined) {
    if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
      return Math.trunc(timeoutSeconds * 1000);
    }
    throw new Error("timeout_seconds must be a positive finite number when provided");
  }
  return 600_000;
}

function numericRecordArg(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

function objectArg(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function booleanArg(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function appendIdeaToNotes(notes: string, idea: string): string {
  const trimmed = notes.trimEnd();
  const bullet = `- ${idea.trim()}`;
  if (!trimmed) {
    return `## Ideas\n${bullet}\n`;
  }
  if (!trimmed.includes("## Ideas")) {
    return `${trimmed}\n\n## Ideas\n${bullet}\n`;
  }
  return `${trimmed}\n${bullet}\n`;
}
