import { promises as fs } from "node:fs";
import path from "node:path";
import { loadApp, type AppOptions } from "../app.js";
import type { JsonObject, SessionEvent } from "../types.js";
import { randomId } from "../util/hash.js";

interface DebugRunSessionArgs {
  prompts: string[];
  promptFiles: string[];
  sessionPrefix?: string;
  title?: string;
  previewChars: number;
  includeContent: boolean;
  maxToolRounds?: number;
}

interface DebugModelTurn {
  step_id?: string;
  step_index?: number;
  request_class?: string;
  provider_id?: string;
  requested_model?: string;
  selected_model?: string;
  model?: string;
  decision?: string;
  category?: string;
  confidence?: string;
  phase?: string;
  learning?: string;
  replay_id?: string;
  route_cache_hit?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_prompt_tokens?: number;
  cache_hit_rate?: number;
  cache_gap_tokens?: number;
  cache_gap_rate?: number;
  request_id?: string;
  response_id?: string;
  route?: JsonObject;
}

export interface DebugRunSessionResult {
  report: JsonObject;
  failed: boolean;
}

export async function runDebugSession(options: AppOptions, rest: string[]): Promise<DebugRunSessionResult> {
  const parsed = parseDebugRunSessionArgs(rest);
  const prompts = [...parsed.prompts, ...(await readDebugPromptFiles(parsed.promptFiles))];
  if (prompts.length === 0) {
    prompts.push(...(await readDebugPromptsFromStdin()));
  }
  if (prompts.length === 0) {
    throw new Error("Usage: inferoa debug run-session --prompt <text> [--prompt <text>...] [--session <session-prefix>]");
  }

  const app = await loadApp(options);
  try {
    const existingSession = parsed.sessionPrefix ? app.store.findSessionByPrefix(app.workspace.id, parsed.sessionPrefix) : undefined;
    if (parsed.sessionPrefix && !existingSession) {
      throw new Error(`No session matches ${parsed.sessionPrefix}`);
    }
    const session = existingSession ?? (await app.runtime.createSession(parsed.title ?? "debug run-session"));
    const clientId = randomId("debug");
    const runs: JsonObject[] = [];
    let failed = false;

    for (let index = 0; index < prompts.length; index++) {
      const prompt = prompts[index]!;
      const runId = randomId("run");
      const startedAt = Date.now();
      try {
        const result = await app.runtime.run({
          prompt,
          session_id: session.session_id,
          run_id: runId,
          client_id: clientId,
          max_tool_rounds: parsed.maxToolRounds,
        });
        const events = app.store.listEvents(session.session_id).filter((event) => event.run_id === result.run_id);
        runs.push(debugRunSessionRunReport(index + 1, prompt, result.run_id, Date.now() - startedAt, events, parsed, {
          status: "completed",
          content: result.content,
          tool_rounds: result.tool_rounds,
          tool_calls: result.tool_calls,
          tokens_used: result.tokens_used,
          duration_ms: result.duration_ms,
        }));
      } catch (error) {
        failed = true;
        const events = app.store.listEvents(session.session_id).filter((event) => event.run_id === runId);
        runs.push(debugRunSessionRunReport(index + 1, prompt, runId, Date.now() - startedAt, events, parsed, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }));
        break;
      }
    }

    const latestSession = app.store.getSession(session.session_id) ?? session;
    return {
      failed,
      report: {
        session: publicSession(latestSession),
        continued_session: Boolean(existingSession),
        run_count: runs.length,
        runs,
        summary: debugRunSessionSummary(runs),
      },
    };
  } finally {
    app.runtime.dispose();
    app.store.close();
  }
}

function parseDebugRunSessionArgs(rest: string[]): DebugRunSessionArgs {
  const parsed: DebugRunSessionArgs = {
    prompts: [],
    promptFiles: [],
    previewChars: 500,
    includeContent: false,
  };
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    switch (arg) {
      case "--prompt":
      case "-p":
        parsed.prompts.push(requiredValue(rest, ++index, arg));
        break;
      case "--prompt-file":
        parsed.promptFiles.push(requiredValue(rest, ++index, arg));
        break;
      case "--session":
      case "-s":
        parsed.sessionPrefix = requiredValue(rest, ++index, arg);
        break;
      case "--title":
        parsed.title = requiredValue(rest, ++index, arg);
        break;
      case "--preview-chars": {
        const value = Number(requiredValue(rest, ++index, arg));
        if (!Number.isInteger(value) || value < 0) {
          throw new Error("--preview-chars requires a non-negative integer");
        }
        parsed.previewChars = value;
        break;
      }
      case "--content":
        parsed.includeContent = true;
        break;
      case "--max-tool-rounds": {
        const value = Number(requiredValue(rest, ++index, arg));
        if (!Number.isInteger(value) || value < 0) {
          throw new Error("--max-tool-rounds requires a non-negative integer");
        }
        parsed.maxToolRounds = value;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown run-session option: ${arg}`);
        }
        positional.push(arg, ...rest.slice(index + 1));
        index = rest.length;
        break;
    }
  }
  if (positional.length > 0) {
    parsed.prompts.push(positional.join(" ").trim());
  }
  parsed.prompts = parsed.prompts.map((prompt) => prompt.trim()).filter(Boolean);
  return parsed;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function readDebugPromptFiles(files: string[]): Promise<string[]> {
  const prompts: string[] = [];
  for (const file of files) {
    const text = await fs.readFile(path.resolve(file), "utf8");
    prompts.push(...parseDebugPromptFile(text, file));
  }
  return prompts;
}

function parseDebugPromptFile(text: string, file: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error(`${file} must contain a JSON string array when it starts with '['`);
    }
    return parsed.map((item) => item.trim()).filter(Boolean);
  }
  const sections = trimmed.split(/\r?\n---+\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (sections.length > 1) {
    return sections;
  }
  return trimmed.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

async function readDebugPromptsFromStdin(): Promise<string[]> {
  if (process.stdin.isTTY !== false) {
    return [];
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return parseDebugPromptFile(Buffer.concat(chunks).toString("utf8"), "stdin");
}

function debugRunSessionRunReport(
  index: number,
  prompt: string,
  runId: string,
  fallbackDurationMs: number,
  events: SessionEvent[],
  options: DebugRunSessionArgs,
  result: {
    status: "completed" | "failed";
    content?: string;
    error?: string;
    tool_rounds?: number;
    tool_calls?: number;
    tokens_used?: number;
    duration_ms?: number;
  },
): JsonObject {
  const modelTurns = collectDebugModelTurns(events);
  const report: JsonObject = {
    index,
    run_id: runId,
    status: result.status,
    prompt,
    duration_ms: result.duration_ms ?? fallbackDurationMs,
    tool_rounds: result.tool_rounds,
    tool_calls: result.tool_calls,
    tokens_used: result.tokens_used,
    model_turns: modelTurns as unknown as JsonObject[],
    summary: debugModelTurnSummary(modelTurns),
  };
  if (result.content !== undefined) {
    report.content_preview = previewDebugText(result.content, options.previewChars);
    if (options.includeContent) {
      report.content = result.content;
    }
  }
  if (result.error) {
    report.error = result.error;
  }
  return report;
}

function collectDebugModelTurns(events: SessionEvent[]): DebugModelTurn[] {
  const turns = new Map<string, DebugModelTurn>();
  const order = new Map<string, number>();

  const ensureTurn = (data: JsonObject, event: SessionEvent): DebugModelTurn => {
    const key = debugModelTurnKey(data, event);
    let turn = turns.get(key);
    if (!turn) {
      turn = {};
      turns.set(key, turn);
      order.set(key, order.size);
    }
    assignDebugStepIdentity(turn, data);
    return turn;
  };

  for (const event of events) {
    const data = event.data;
    if (event.type === "model.route.selected") {
      const turn = ensureTurn(data, event);
      const route = objectField(data.route);
      turn.provider_id ??= stringField(data.provider_id);
      turn.request_class ??= stringField(data.request_class);
      turn.requested_model ??= stringField(data.model);
      if (route) {
        turn.route = route;
        turn.selected_model = selectedModelFromRoute(route) ?? turn.selected_model;
        turn.decision = stringField(route["x-vsr-selected-decision"]) ?? turn.decision;
        turn.category = stringField(route["x-vsr-selected-category"]) ?? turn.category;
        turn.confidence = stringField(route["x-vsr-selected-confidence"]) ?? turn.confidence;
        turn.phase = stringField(route["x-vsr-session-phase"]) ?? turn.phase;
        turn.learning = learningSummaryFromRoute(route) ?? turn.learning;
        turn.replay_id = stringField(route["x-vsr-replay-id"]) ?? turn.replay_id;
        turn.route_cache_hit = stringField(route["x-vsr-cache-hit"]) ?? turn.route_cache_hit;
      }
    } else if (event.type === "endpoint.evidence.recorded") {
      const turn = ensureTurn(data, event);
      turn.provider_id ??= stringField(data.provider_id);
      turn.request_class ??= stringField(data.request_class);
      turn.request_id = stringField(data.request_id) ?? turn.request_id;
      turn.response_id = stringField(data.response_id) ?? turn.response_id;
      turn.model = stringField(data.model) ?? turn.model;
      turn.prompt_tokens = numberField(data.prompt_tokens) ?? turn.prompt_tokens;
      turn.completion_tokens = numberField(data.completion_tokens) ?? turn.completion_tokens;
      turn.total_tokens = numberField(data.total_tokens) ?? turn.total_tokens;
      turn.cached_prompt_tokens = numberField(data.cached_prompt_tokens) ?? turn.cached_prompt_tokens;
      turn.cache_hit_rate = numberField(data.cache_hit_rate) ?? turn.cache_hit_rate;
    } else if (event.type === "model.response.settled") {
      const turn = ensureTurn(data, event);
      const usage = objectField(data.usage);
      turn.model = stringField(data.model) ?? turn.model;
      turn.prompt_tokens = numberField(usage?.prompt_tokens) ?? turn.prompt_tokens;
      turn.completion_tokens = numberField(usage?.completion_tokens) ?? turn.completion_tokens;
      turn.total_tokens = numberField(usage?.total_tokens) ?? turn.total_tokens;
      turn.cached_prompt_tokens = numberField(usage?.cached_prompt_tokens) ?? turn.cached_prompt_tokens;
    }
  }

  for (const turn of turns.values()) {
    finalizeDebugModelTurn(turn);
  }

  return [...turns.entries()]
    .sort(([left], [right]) => (order.get(left) ?? 0) - (order.get(right) ?? 0))
    .map(([, turn]) => turn);
}

function assignDebugStepIdentity(turn: DebugModelTurn, data: JsonObject): void {
  turn.step_id ??= stringField(data.step_id);
  turn.step_index ??= numberField(data.step_index);
}

function debugModelTurnKey(data: JsonObject, event: SessionEvent): string {
  const stepId = stringField(data.step_id);
  if (stepId) {
    return `step_id:${stepId}`;
  }
  const stepIndex = numberField(data.step_index);
  if (stepIndex !== undefined) {
    return `step_index:${stepIndex}`;
  }
  return `event:${event.id ?? "unknown"}`;
}

function selectedModelFromRoute(route: JsonObject): string | undefined {
  return stringField(route["x-vsr-selected-model"]) ?? stringField(route["x-selected-model"]) ?? stringField(route["x-router-model"]);
}

function finalizeDebugModelTurn(turn: DebugModelTurn): void {
  turn.selected_model ??= turn.model ?? turn.requested_model;
  if (turn.prompt_tokens !== undefined && turn.cached_prompt_tokens !== undefined) {
    turn.cache_gap_tokens = Math.max(0, turn.prompt_tokens - turn.cached_prompt_tokens);
    turn.cache_hit_rate ??= ratio(turn.cached_prompt_tokens, turn.prompt_tokens);
    turn.cache_gap_rate = ratio(turn.cache_gap_tokens, turn.prompt_tokens);
  } else if (turn.prompt_tokens !== undefined && turn.cache_hit_rate !== undefined) {
    turn.cache_gap_rate = roundRatio(Math.max(0, 1 - turn.cache_hit_rate));
  }
}

function debugRunSessionSummary(runs: JsonObject[]): JsonObject {
  const turns = runs.flatMap((run) => {
    const rawTurns = run.model_turns;
    return Array.isArray(rawTurns) ? (rawTurns as unknown as DebugModelTurn[]) : [];
  });
  return {
    run_count: runs.length,
    model_turn_count: turns.length,
    models: countDebugTurnsBy(turns, (turn) => turn.selected_model ?? turn.model),
    decisions: countDebugTurnsBy(turns, (turn) => turn.decision),
    phases: countDebugTurnsBy(turns, (turn) => turn.phase),
    learning: countDebugTurnsBy(turns, (turn) => learningActionFromHeader(turn.learning)),
    cache: debugCacheSummary(turns),
  };
}

function debugModelTurnSummary(turns: DebugModelTurn[]): JsonObject {
  return {
    model_turn_count: turns.length,
    models: countDebugTurnsBy(turns, (turn) => turn.selected_model ?? turn.model),
    decisions: countDebugTurnsBy(turns, (turn) => turn.decision),
    phases: countDebugTurnsBy(turns, (turn) => turn.phase),
    learning: countDebugTurnsBy(turns, (turn) => learningActionFromHeader(turn.learning)),
    cache: debugCacheSummary(turns),
  };
}

function debugCacheSummary(turns: DebugModelTurn[]): JsonObject {
  const observed = turns.filter((turn) => turn.prompt_tokens !== undefined && turn.cached_prompt_tokens !== undefined);
  const promptTokens = observed.reduce((sum, turn) => sum + (turn.prompt_tokens ?? 0), 0);
  const cachedPromptTokens = observed.reduce((sum, turn) => sum + (turn.cached_prompt_tokens ?? 0), 0);
  const cacheGapTokens = Math.max(0, promptTokens - cachedPromptTokens);
  return {
    observed_turns: observed.length,
    prompt_tokens: observed.length ? promptTokens : undefined,
    cached_prompt_tokens: observed.length ? cachedPromptTokens : undefined,
    cache_hit_rate: observed.length ? ratio(cachedPromptTokens, promptTokens) : undefined,
    cache_gap_tokens: observed.length ? cacheGapTokens : undefined,
    cache_gap_rate: observed.length ? ratio(cacheGapTokens, promptTokens) : undefined,
  };
}

function countDebugTurnsBy(turns: DebugModelTurn[], field: (turn: DebugModelTurn) => string | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const turn of turns) {
    const value = field(turn);
    if (!value) {
      continue;
    }
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function learningActionFromHeader(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const parts = header.split(/[;\s]+/).map((part) => part.trim()).filter(Boolean);
  const adaptation = parts[0];
  const action = parts.find((part) => part.startsWith("action="))?.slice("action=".length);
  if (!adaptation || !action) {
    return adaptation;
  }
  return `${adaptation}.${action}`;
}

function learningSummaryFromRoute(route: JsonObject): string | undefined {
  const adaptation = firstLearningMethod(stringField(route["x-vsr-learning-methods"]));
  const mode = methodHeaderValue(stringField(route["x-vsr-learning-modes"]), adaptation);
  const action = methodHeaderValue(stringField(route["x-vsr-learning-actions"]), adaptation);
  const scope = methodHeaderValue(stringField(route["x-vsr-learning-scopes"]), adaptation);
  const reason = methodHeaderValue(stringField(route["x-vsr-learning-reasons"]), adaptation);
  if (!adaptation) {
    return undefined;
  }
  return [
    adaptation,
    mode ? `mode=${mode}` : undefined,
    action ? `action=${action}` : undefined,
    reason ? `reason=${reason}` : undefined,
    scope ? `scope=${scope}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(" ");
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

function previewDebugText(text: string, maxChars: number): string {
  if (maxChars === 0 || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function ratio(numerator: number, denominator: number): number | undefined {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return undefined;
  }
  return roundRatio(numerator / denominator);
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function objectField(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function publicSession(session: { session_id: string; title: string; status: string; created_at: string; updated_at: string }): JsonObject {
  return {
    session_id: session.session_id,
    title: session.title,
    status: session.status,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}
