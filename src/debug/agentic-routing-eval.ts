import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { loadConfig, endpointApiKey } from "../config/config.js";
import type { AppOptions } from "../app.js";
import type { JsonObject, JsonValue, ModelSetup } from "../types.js";
import { runDebugSession } from "./run-session.js";

type AgenticRoutingEvalScenario = "all" | "matrix" | "session" | "tool-loop" | "scope";

interface AgenticRoutingEvalArgs {
  scenario: AgenticRoutingEvalScenario;
  replayBaseUrl?: string;
  previewChars: number;
  maxToolRounds: number;
  toolLoopMaxToolRounds: number;
  skipReplay: boolean;
  includeCost: boolean;
  baselineModels: string[];
  pricingFile?: string;
  pricingJson?: string;
}

interface EvalCase {
  label: string;
  prompt: string;
  expectation: EvalExpectation;
}

interface EvalExpectation {
  decisionGroups: DecisionGroup[];
  modelGroups: ModelGroup[];
}

type DecisionGroup = "simple" | "privacy" | "domain_code" | "domain_business" | "complex" | "agentic";
type ModelGroup = "local" | "domain_medium" | "domain_complex" | "frontier" | "high_care";

interface EvalCheck {
  name: string;
  passed: boolean;
  expected?: JsonValue;
  actual?: JsonValue;
  detail?: string;
}

interface ReplayFetchEnv {
  baseUrl?: string;
  headers: Record<string, string>;
  skipReplay: boolean;
}

interface CostEnv {
  includeCost: boolean;
  pricing: PricingTable;
  baselineModels: string[];
}

interface ModelPricing {
  currency: string;
  promptPer1M: number;
  cachedInputPer1M: number;
  completionPer1M: number;
}

interface PricingTable {
  source: string;
  models: Record<string, ModelPricing>;
}

const DECISIONS: Record<DecisionGroup, string[]> = {
  simple: ["simple_math_fast_path", "simple_general"],
  privacy: ["local_privacy_policy", "local_security_policy"],
  domain_code: ["domain_code", "domain_code_complex"],
  domain_business: ["domain_business"],
  complex: ["complex_general", "domain_code_complex", "domain_stem_research"],
  agentic: [],
};

const MODELS: Record<ModelGroup, string[]> = {
  local: ["qwen/qwen3.6-rocm", "qwen/qwen3.6-35b-a3b"],
  domain_medium: ["google/gemini-2.5-flash-lite"],
  domain_complex: ["google/gemini-3.1-pro"],
  frontier: ["openai/gpt5.4", "google/gemini-3.1-pro"],
  high_care: ["anthropic/claude-opus-4.6"],
};

const DEFAULT_BASELINE_MODELS = ["google/gemini-3.1-pro", "openai/gpt5.4"];

const DEFAULT_PRICING: PricingTable = {
  source: "agentic-routing-profile-default",
  models: {
    "qwen/qwen3.6-rocm": { currency: "USD", promptPer1M: 0, cachedInputPer1M: 0, completionPer1M: 0 },
    "qwen/qwen3.6-35b-a3b": { currency: "USD", promptPer1M: 0, cachedInputPer1M: 0, completionPer1M: 0 },
    "google/gemini-2.5-flash-lite": { currency: "USD", promptPer1M: 0.01, cachedInputPer1M: 0.002, completionPer1M: 0.04 },
    "google/gemini-3.1-pro": { currency: "USD", promptPer1M: 0.48, cachedInputPer1M: 0.12, completionPer1M: 1.92 },
    "openai/gpt5.4": { currency: "USD", promptPer1M: 1.2, cachedInputPer1M: 0.3, completionPer1M: 4.8 },
    "anthropic/claude-opus-4.6": { currency: "USD", promptPer1M: 1.8, cachedInputPer1M: 0.45, completionPer1M: 7.2 },
  },
};

const MATRIX_CASES: EvalCase[] = [
  {
    label: "fresh.simple_math",
    prompt: "Calculate 17 + 25. Answer with only the number.",
    expectation: { decisionGroups: ["simple"], modelGroups: ["local"] },
  },
  {
    label: "fresh.domain_code",
    prompt: "Implement a TypeScript debounce helper with leading and trailing options, and include two concise unit tests.",
    expectation: { decisionGroups: ["domain_code"], modelGroups: ["domain_medium", "domain_complex"] },
  },
  {
    label: "fresh.domain_business",
    prompt: "Compare seat-based pricing and usage-based pricing for a B2B SaaS product. Give concise recommendations.",
    expectation: { decisionGroups: ["domain_business"], modelGroups: ["domain_medium"] },
  },
  {
    label: "fresh.complex_general",
    prompt: "Design a multi-phase migration plan for a distributed service moving from synchronous RPC to event sourcing, including risks and rollback criteria.",
    expectation: { decisionGroups: ["complex", "agentic"], modelGroups: ["domain_complex", "frontier"] },
  },
  {
    label: "fresh.privacy_local",
    prompt: "Customer Jane Doe has SSN 123-45-6789 and email jane.doe@example.com in a CRM export. Summarize the privacy risk.",
    expectation: { decisionGroups: ["privacy"], modelGroups: ["local"] },
  },
];

const SESSION_CASES: EvalCase[] = [
  {
    label: "session.simple_start",
    prompt: "Calculate 8 * 7. Answer with only the number.",
    expectation: { decisionGroups: ["simple"], modelGroups: ["local"] },
  },
  {
    label: "session.agentic_plan",
    prompt: "Plan a repository refactor that will touch configuration, routing logic, tests, and docs. Treat this as an agentic workflow and explain the implementation order.",
    expectation: { decisionGroups: ["agentic", "complex"], modelGroups: ["domain_medium", "domain_complex", "frontier"] },
  },
  {
    label: "session.simple_after_agentic",
    prompt: "Now answer a simple follow-up: what is 21 + 21? Answer with only the number.",
    expectation: { decisionGroups: ["simple", "agentic"], modelGroups: ["local", "domain_medium", "domain_complex", "frontier"] },
  },
  {
    label: "session.privacy_turn",
    prompt: "Repository config snippet contains api_key=sk-test-private-000 and database password hunter2. Identify remediation steps.",
    expectation: { decisionGroups: ["privacy"], modelGroups: ["local"] },
  },
  {
    label: "session.privacy_followup",
    prompt: "What was the API key prefix in the secret I just gave you? Summarize why it should be rotated.",
    expectation: { decisionGroups: ["privacy"], modelGroups: ["local"] },
  },
];

const TOOL_LOOP_CASES: EvalCase[] = [
  {
    label: "tool_loop.stability",
    prompt: "Use one safe local tool to inspect the current workspace, then answer with a brief summary. Keep the same model while the tool loop is active.",
    expectation: { decisionGroups: ["agentic", "domain_code", "complex"], modelGroups: ["domain_medium", "domain_complex", "frontier", "local"] },
  },
];

const SCOPE_CASES: EvalCase[] = [
  {
    label: "scope.agentic_start",
    prompt: "Plan a repository refactor that will touch configuration, routing logic, tests, and docs. Treat this as an agentic workflow and explain the implementation order.",
    expectation: { decisionGroups: ["agentic", "complex"], modelGroups: ["domain_medium", "domain_complex", "frontier"] },
  },
  {
    label: "scope.simple_new_conversation",
    prompt: "Calculate 21 + 21. Answer with only the number.",
    expectation: { decisionGroups: ["simple", "agentic", "complex"], modelGroups: ["local", "domain_medium", "domain_complex", "frontier"] },
  },
  {
    label: "scope.privacy_boundary",
    prompt: "Customer Jane Doe has SSN 123-45-6789 and api_key=sk-test-private-000 in a support export. Summarize the privacy risk.",
    expectation: { decisionGroups: ["privacy"], modelGroups: ["local"] },
  },
];

export interface AgenticRoutingEvalResult {
  report: JsonObject;
  failed: boolean;
}

export async function runAgenticRoutingEval(options: AppOptions, rest: string[]): Promise<AgenticRoutingEvalResult> {
  const parsed = parseAgenticRoutingEvalArgs(rest);
  if (options.stateDir) {
    process.env.INFEROA_STATE_DIR = options.stateDir;
  }
  const { config } = await loadConfig(process.cwd(), options.config);
  const costEnv: CostEnv = {
    includeCost: parsed.includeCost,
    pricing: await loadPricingTable(parsed),
    baselineModels: parsed.baselineModels,
  };
  const replayEnv: ReplayFetchEnv = {
    baseUrl: parsed.replayBaseUrl ?? config.model_setup.base_url,
    headers: replayHeaders(config.model_setup),
    skipReplay: parsed.skipReplay,
  };

  const scenarios: JsonObject[] = [];
  if (parsed.scenario === "all" || parsed.scenario === "matrix") {
    scenarios.push(await evaluateFreshMatrix(options, parsed, replayEnv, costEnv));
  }
  if (parsed.scenario === "all" || parsed.scenario === "session") {
    scenarios.push(await evaluateSingleSessionScenario(options, parsed, replayEnv, costEnv, "same_session_tradeoff", SESSION_CASES, parsed.maxToolRounds));
  }
  if (parsed.scenario === "all" || parsed.scenario === "tool-loop") {
    scenarios.push(await evaluateSingleSessionScenario(options, parsed, replayEnv, costEnv, "tool_loop_stability", TOOL_LOOP_CASES, parsed.toolLoopMaxToolRounds));
  }
  if (parsed.scenario === "all" || parsed.scenario === "scope") {
    scenarios.push(await evaluateSingleSessionScenario(options, parsed, replayEnv, costEnv, "scope_protection", SCOPE_CASES, parsed.maxToolRounds));
  }

  const summary = summarizeScenarios(scenarios);
  const routingQuality = routingQualitySummary(scenarios);
  const telemetry = telemetrySummary(scenarios);
  const cost = parsed.includeCost ? costSummary(scenarios, costEnv) : undefined;
  const failed = (numberField(summary.failed_checks) ?? 0) > 0 || scenarios.some((scenario) => Boolean(scenario.failed));
  return {
    failed,
    report: {
      suite: "agentic-routing",
      profile: "agentic-routing",
      endpoint: config.model_setup.base_url,
      replay_endpoint: replayEnv.baseUrl,
      scenario: parsed.scenario,
      passed: !failed,
      summary,
      routing_quality: routingQuality,
      telemetry,
      cost,
      scenarios,
    },
  };
}

function parseAgenticRoutingEvalArgs(rest: string[]): AgenticRoutingEvalArgs {
  const parsed: AgenticRoutingEvalArgs = {
    scenario: "all",
    previewChars: 0,
    maxToolRounds: 0,
    toolLoopMaxToolRounds: 1,
    skipReplay: false,
    includeCost: true,
    baselineModels: [...DEFAULT_BASELINE_MODELS],
  };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    const [flag, inlineValue] = splitInlineFlag(arg);
    switch (arg) {
      case "--scenario": {
        const value = requiredValue(rest, ++index, arg);
        if (!isAgenticRoutingEvalScenario(value)) {
          throw new Error("--scenario must be one of all, matrix, session, tool-loop, scope");
        }
        parsed.scenario = value;
        break;
      }
      case "--replay-base-url":
        parsed.replayBaseUrl = requiredValue(rest, ++index, arg);
        break;
      case "--pricing-file":
        parsed.pricingFile = requiredValue(rest, ++index, arg);
        break;
      case "--pricing-json":
        parsed.pricingJson = requiredValue(rest, ++index, arg);
        break;
      case "--baseline-model":
      case "--cost-baseline-model":
        parsed.baselineModels = parseModelList(requiredValue(rest, ++index, arg));
        break;
      case "--preview-chars":
        parsed.previewChars = nonNegativeInteger(requiredValue(rest, ++index, arg), arg);
        break;
      case "--max-tool-rounds":
        parsed.maxToolRounds = nonNegativeInteger(requiredValue(rest, ++index, arg), arg);
        break;
      case "--tool-loop-max-tool-rounds":
        parsed.toolLoopMaxToolRounds = nonNegativeInteger(requiredValue(rest, ++index, arg), arg);
        break;
      case "--skip-replay":
        parsed.skipReplay = true;
        break;
      case "--no-cost":
        parsed.includeCost = false;
        break;
      default:
        if (flag === "--scenario" && inlineValue !== undefined) {
          if (!isAgenticRoutingEvalScenario(inlineValue)) {
            throw new Error("--scenario must be one of all, matrix, session, tool-loop, scope");
          }
          parsed.scenario = inlineValue;
          break;
        }
        if (flag === "--replay-base-url" && inlineValue !== undefined) {
          parsed.replayBaseUrl = inlineValue;
          break;
        }
        if (flag === "--pricing-file" && inlineValue !== undefined) {
          parsed.pricingFile = inlineValue;
          break;
        }
        if (flag === "--pricing-json" && inlineValue !== undefined) {
          parsed.pricingJson = inlineValue;
          break;
        }
        if ((flag === "--baseline-model" || flag === "--cost-baseline-model") && inlineValue !== undefined) {
          parsed.baselineModels = parseModelList(inlineValue);
          break;
        }
        throw new Error(`Unknown agentic-routing eval option: ${arg}`);
    }
  }
  return parsed;
}

function splitInlineFlag(arg: string): [string, string | undefined] {
  const index = arg.indexOf("=");
  return index > 0 ? [arg.slice(0, index), arg.slice(index + 1)] : [arg, undefined];
}

function parseModelList(value: string): string[] {
  const models = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (models.length === 0) {
    throw new Error("--baseline-model requires at least one model");
  }
  return models;
}

function isAgenticRoutingEvalScenario(value: string): value is AgenticRoutingEvalScenario {
  return value === "all" || value === "matrix" || value === "session" || value === "tool-loop" || value === "scope";
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function nonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  return parsed;
}

async function evaluateFreshMatrix(options: AppOptions, args: AgenticRoutingEvalArgs, replayEnv: ReplayFetchEnv, costEnv: CostEnv): Promise<JsonObject> {
  const runs: JsonObject[] = [];
  const checks: EvalCheck[] = [];
  for (const evalCase of MATRIX_CASES) {
    const scenario = await evaluateSingleSessionScenario(options, args, replayEnv, costEnv, evalCase.label, [evalCase], args.maxToolRounds);
    const run = objectArrayField(scenario.runs)[0];
    if (run) {
      runs.push(run);
    }
    checks.push(...checkArrayField(scenario.checks));
  }
  const failed = checks.some((check) => !check.passed);
  return {
    name: "fresh_decision_matrix",
    description: "Each prompt starts a fresh session to test decision reachability without session affinity.",
    failed,
    checks: checks as unknown as JsonObject[],
    runs,
    summary: summarizeChecks(checks),
  };
}

async function evaluateSingleSessionScenario(
  options: AppOptions,
  args: AgenticRoutingEvalArgs,
  replayEnv: ReplayFetchEnv,
  costEnv: CostEnv,
  name: string,
  cases: EvalCase[],
  maxToolRounds: number,
): Promise<JsonObject> {
  const runResult = await runDebugSession(options, runSessionArgs(name, cases, args.previewChars, maxToolRounds));
  const report = runResult.report;
  const runs = objectArrayField(report.runs);
  const scenarioRuns: JsonObject[] = [];
  const checks: EvalCheck[] = [];

  for (let index = 0; index < cases.length; index++) {
    const evalCase = cases[index]!;
    const run = runs[index];
    const enriched = run ? await enrichRunWithReplay(run, evalCase, replayEnv, costEnv) : missingRun(evalCase);
    scenarioRuns.push(enriched);
    checks.push(...caseChecks(evalCase, enriched));
  }

  checks.push(...scenarioChecks(name, cases, scenarioRuns));
  const failed = runResult.failed || checks.some((check) => !check.passed);
  return {
    name,
    session: objectField(report.session),
    failed,
    runner_failed: runResult.failed,
    checks: checks as unknown as JsonObject[],
    runs: scenarioRuns,
    summary: summarizeChecks(checks),
  };
}

function runSessionArgs(name: string, cases: EvalCase[], previewChars: number, maxToolRounds: number): string[] {
  const rest = ["--title", `agentic routing eval: ${name}`, "--preview-chars", String(previewChars), "--max-tool-rounds", String(maxToolRounds)];
  for (const evalCase of cases) {
    rest.push("--prompt", evalCase.prompt);
  }
  return rest;
}

async function enrichRunWithReplay(run: JsonObject, evalCase: EvalCase, replayEnv: ReplayFetchEnv, costEnv: CostEnv): Promise<JsonObject> {
  const turns = objectArrayField(run.model_turns);
  const enrichedTurns: JsonObject[] = [];
  for (const turn of turns) {
    enrichedTurns.push(annotateTurnCost(await enrichTurnWithReplay(turn, replayEnv), costEnv));
  }
  return {
    ...run,
    label: evalCase.label,
    expectation: publicExpectation(evalCase.expectation),
    routing_outcome: routingOutcome(evalCase, enrichedTurns),
    model_turns: enrichedTurns,
  };
}

function missingRun(evalCase: EvalCase): JsonObject {
  return {
    label: evalCase.label,
    status: "missing",
    expectation: publicExpectation(evalCase.expectation),
    routing_outcome: {
      acceptable: false,
      severity: "high",
      reason: "missing_run",
    },
    model_turns: [],
  };
}

async function enrichTurnWithReplay(turn: JsonObject, replayEnv: ReplayFetchEnv): Promise<JsonObject> {
  const replayId = stringField(turn.replay_id);
  if (!replayId) {
    return { ...turn, replay_fetch: { status: "missing_replay_id" } };
  }
  if (replayEnv.skipReplay) {
    return { ...turn, replay_fetch: { status: "skipped" } };
  }
  if (!replayEnv.baseUrl) {
    return { ...turn, replay_fetch: { status: "missing_base_url" } };
  }
  try {
    const response = await fetch(replayUrl(replayEnv.baseUrl, replayId), { headers: replayEnv.headers });
    const text = await response.text();
    if (!response.ok) {
      return {
        ...turn,
        replay_fetch: { status: "http_error", code: response.status, body_preview: previewText(text, 400) },
      };
    }
    const replay = JSON.parse(text) as JsonObject;
    return {
      ...turn,
      replay_fetch: { status: "ok" },
      replay: compactReplay(replay),
      route_diagnostics: objectField(replay.route_diagnostics),
    };
  } catch (error) {
    return {
      ...turn,
      replay_fetch: { status: "error", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

function replayUrl(baseUrl: string, replayId: string): string {
  const url = new URL(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/v1")) {
    pathname = `${pathname}/v1`;
  }
  url.pathname = `${pathname}/router_replay/${encodeURIComponent(replayId)}`;
  url.search = "";
  return url.toString();
}

function replayHeaders(modelSetup: ModelSetup): Record<string, string> {
  const headers: Record<string, string> = { ...(modelSetup.headers ?? {}) };
  const apiKey = endpointApiKey(modelSetup);
  if (apiKey && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function compactReplay(replay: JsonObject): JsonObject {
  return {
    id: stringField(replay.id) ?? stringField(replay.record_id) ?? stringField(replay.replay_id),
    decision: stringField(replay.decision),
    decision_tier: numberField(replay.decision_tier),
    decision_priority: numberField(replay.decision_priority),
    selected_model: stringField(replay.selected_model),
    original_model: stringField(replay.original_model),
    route_diagnostics: objectField(replay.route_diagnostics),
    learning: compactLearning(objectField(replay.learning)),
    session_policy: compactSessionPolicy(objectField(replay.session_policy)),
  };
}

function compactLearning(learning: JsonObject | undefined): JsonObject | undefined {
  const adaptations = objectField(learning?.adaptations);
  const sessionAware = objectField(adaptations?.session_aware);
  if (!sessionAware) {
    return undefined;
  }
  return {
    adaptations: {
      session_aware: compactSessionAwareLearning(sessionAware),
    },
  };
}

function compactSessionAwareLearning(policy: JsonObject): JsonObject {
  return {
    mode: stringField(policy.mode),
    action: stringField(policy.action),
    reason: stringField(policy.reason),
    scope: stringField(policy.scope),
    current_model: stringField(policy.current_model),
    base_selected_model: stringField(policy.base_selected_model),
    selected_model: stringField(policy.selected_model),
    phase: stringField(policy.phase),
    hard_locked: boolField(policy.hard_locked),
    hard_lock_reason: stringField(policy.hard_lock_reason),
    memory_prompt_tokens: numberField(policy.memory_prompt_tokens),
    memory_cached_tokens: numberField(policy.memory_cached_tokens),
    memory_estimated_cached_tokens: numberField(policy.memory_estimated_cached_tokens),
    last_cache_accounting_source: stringField(policy.last_cache_accounting_source),
    cache_warmth: numberField(policy.cache_warmth),
    candidate_traces: selectedCandidateTraceSummary(policy),
  };
}

function compactSessionPolicy(policy: JsonObject | undefined): JsonObject | undefined {
  if (!policy) {
    return undefined;
  }
  return {
    current_model: stringField(policy.current_model),
    base_selected_model: stringField(policy.base_selected_model),
    selected_model: stringField(policy.selected_model),
    decision_reason: stringField(policy.decision_reason),
    hard_locked: boolField(policy.hard_locked),
    hard_lock_reason: stringField(policy.hard_lock_reason),
    phase: stringField(policy.phase),
    cache_warmth: numberField(policy.cache_warmth),
    continuation_mass: numberField(policy.continuation_mass),
    switch_margin: numberField(policy.switch_margin),
    stay_bias: numberField(policy.stay_bias),
    base_scores: objectField(policy.base_scores),
    final_scores: objectField(policy.final_scores),
    candidate_traces: selectedCandidateTraceSummary(policy),
  };
}

function selectedCandidateTraceSummary(policy: JsonObject): JsonObject | undefined {
  const traces = objectField(policy.candidate_traces);
  if (!traces) {
    return undefined;
  }
  const keep = new Set([
    stringField(policy.current_model),
    stringField(policy.base_selected_model),
    stringField(policy.selected_model),
  ].filter((item): item is string => Boolean(item)));
  const out: JsonObject = {};
  for (const model of keep) {
    const trace = objectField(traces[model]);
    if (trace) {
      out[model] = {
        current: boolField(trace.current),
        base_score: numberField(trace.base_score),
        final_score: numberField(trace.final_score),
        handoff_penalty: numberField(trace.handoff_penalty),
        prefix_cache_benefit: numberField(trace.prefix_cache_benefit),
        prefix_cache_penalty: numberField(trace.prefix_cache_penalty),
        net_switch_advantage: numberField(trace.net_switch_advantage),
      };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function loadPricingTable(args: AgenticRoutingEvalArgs): Promise<PricingTable> {
  if (args.pricingJson) {
    return parsePricingTable(JSON.parse(args.pricingJson) as unknown, "pricing-json");
  }
  if (args.pricingFile) {
    const filePath = path.resolve(args.pricingFile);
    const text = await readFile(filePath, "utf8");
    const parsed = filePath.endsWith(".json") ? JSON.parse(text) as unknown : YAML.parse(text) as unknown;
    return parsePricingTable(parsed, filePath);
  }
  return clonePricingTable(DEFAULT_PRICING);
}

function clonePricingTable(table: PricingTable): PricingTable {
  return {
    source: table.source,
    models: Object.fromEntries(Object.entries(table.models).map(([model, pricing]) => [model, { ...pricing }])),
  };
}

function parsePricingTable(value: unknown, source: string): PricingTable {
  const root = objectField(value);
  if (!root) {
    throw new Error("pricing data must be an object");
  }
  const models: Record<string, ModelPricing> = {};
  const providerModels = objectArrayField(objectField(root.providers)?.models);
  if (providerModels.length > 0) {
    for (const model of providerModels) {
      const name = stringField(model.name);
      const pricing = parseModelPricing(objectField(model.pricing));
      if (name && pricing) {
        models[name] = pricing;
      }
    }
  } else if (Array.isArray(root.models)) {
    for (const model of objectArrayField(root.models)) {
      const name = stringField(model.name) ?? stringField(model.model);
      const pricing = parseModelPricing(objectField(model.pricing) ?? model);
      if (name && pricing) {
        models[name] = pricing;
      }
    }
  } else {
    const modelMap = objectField(root.models) ?? root;
    for (const [name, rawPricing] of Object.entries(modelMap)) {
      const pricing = parseModelPricing(objectField(rawPricing));
      if (pricing) {
        models[name] = pricing;
      }
    }
  }
  if (Object.keys(models).length === 0) {
    throw new Error("pricing data did not contain any model prices");
  }
  return { source, models };
}

function parseModelPricing(value: JsonObject | undefined): ModelPricing | undefined {
  if (!value) {
    return undefined;
  }
  const prompt = numberField(value.prompt_per_1m) ?? numberField(value.promptPer1M);
  const cached = numberField(value.cached_input_per_1m)
    ?? numberField(value.cachedInputPer1M)
    ?? numberField(value.cached_prompt_per_1m)
    ?? numberField(value.cachedPromptPer1M)
    ?? prompt;
  const completion = numberField(value.completion_per_1m) ?? numberField(value.completionPer1M) ?? 0;
  if (prompt === undefined || cached === undefined) {
    return undefined;
  }
  return {
    currency: stringField(value.currency) ?? "USD",
    promptPer1M: prompt,
    cachedInputPer1M: cached,
    completionPer1M: completion,
  };
}

function annotateTurnCost(turn: JsonObject, costEnv: CostEnv): JsonObject {
  if (!costEnv.includeCost) {
    return turn;
  }
  const model = stringField(turn.selected_model) ?? stringField(turn.model);
  const actual = estimateTurnCost(turn, model, costEnv.pricing);
  const baselines: JsonObject = {};
  for (const baselineModel of costEnv.baselineModels) {
    const baseline = estimateTurnCost(turn, baselineModel, costEnv.pricing);
    baselines[baselineModel] = {
      ...baseline,
      savings_vs_actual: costDelta(baseline.total_cost, actual.total_cost),
      savings_pct_vs_actual: costSavingsPct(baseline.total_cost, actual.total_cost),
    };
  }
  return {
    ...turn,
    cost: {
      price_source: costEnv.pricing.source,
      actual,
      baselines,
    },
  };
}

function estimateTurnCost(turn: JsonObject, model: string | undefined, pricing: PricingTable): JsonObject {
  const promptTokens = numberField(turn.prompt_tokens);
  const cachedPromptTokens = clampTokenCount(numberField(turn.cached_prompt_tokens), promptTokens);
  const completionTokens = completionTokensForTurn(turn, promptTokens);
  const price = model ? modelPricing(pricing, model) : undefined;
  if (!model || !price || promptTokens === undefined) {
    return {
      model,
      estimated: false,
      reason: !model ? "missing_model" : !price ? "missing_pricing" : "missing_prompt_tokens",
    };
  }
  const cached = cachedPromptTokens ?? 0;
  const uncached = Math.max(0, promptTokens - cached);
  const completion = completionTokens ?? 0;
  const promptCost = (uncached * price.promptPer1M) / 1_000_000;
  const cachedCost = (cached * price.cachedInputPer1M) / 1_000_000;
  const completionCost = (completion * price.completionPer1M) / 1_000_000;
  const noCacheCost = (promptTokens * price.promptPer1M + completion * price.completionPer1M) / 1_000_000;
  const totalCost = promptCost + cachedCost + completionCost;
  return {
    model,
    estimated: true,
    currency: price.currency,
    prompt_tokens: promptTokens,
    cached_prompt_tokens: cached,
    uncached_prompt_tokens: uncached,
    completion_tokens: completionTokens,
    prompt_cost: roundCost(promptCost),
    cached_prompt_cost: roundCost(cachedCost),
    completion_cost: roundCost(completionCost),
    total_cost: roundCost(totalCost),
    no_cache_cost: roundCost(noCacheCost),
    prefix_cache_discount: roundCost(Math.max(0, noCacheCost - totalCost)),
  };
}

function modelPricing(pricing: PricingTable, model: string): ModelPricing | undefined {
  const normalized = normalizeModel(model);
  return Object.entries(pricing.models).find(([candidate]) => normalizeModel(candidate) === normalized)?.[1];
}

function completionTokensForTurn(turn: JsonObject, promptTokens: number | undefined): number | undefined {
  const completion = numberField(turn.completion_tokens);
  if (completion !== undefined) {
    return completion;
  }
  const total = numberField(turn.total_tokens);
  if (total !== undefined && promptTokens !== undefined) {
    return Math.max(0, total - promptTokens);
  }
  return undefined;
}

function clampTokenCount(value: number | undefined, max: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (max === undefined) {
    return Math.max(0, value);
  }
  return Math.max(0, Math.min(value, max));
}

function costSummary(scenarios: JsonObject[], costEnv: CostEnv): JsonObject {
  const turns = allTurns(scenarios);
  const actualTotals = sumActualCosts(turns);
  const baselines: JsonObject = {};
  for (const baselineModel of costEnv.baselineModels) {
    const baselineTotal = sumBaselineCosts(turns, baselineModel);
    baselines[baselineModel] = {
      model: baselineModel,
      total_cost: baselineTotal.total_cost,
      estimated_turns: baselineTotal.estimated_turns,
      missing_turns: baselineTotal.missing_turns,
      savings_vs_baseline: costDelta(baselineTotal.total_cost, actualTotals.total_cost),
      savings_pct_vs_baseline: costSavingsPct(baselineTotal.total_cost, actualTotals.total_cost),
    };
  }
  return {
    price_source: costEnv.pricing.source,
    currency: firstCurrency(turns) ?? "USD",
    actual: actualTotals,
    baselines,
    by_model: costByModel(turns),
    prefix_cache: prefixCacheCostSummary(turns),
  };
}

function telemetrySummary(scenarios: JsonObject[]): JsonObject {
  const turns = allTurns(scenarios);
  const promptTokens = sumTurnNumbers(turns, "prompt_tokens");
  const cachedPromptTokens = sumTurnNumbers(turns, "cached_prompt_tokens");
  return {
    model_turns: turns.length,
    decisions: countTurnsBy(turns, (turn) => stringField(turn.decision)),
    models: countTurnsBy(turns, (turn) => stringField(turn.selected_model) ?? stringField(turn.model)),
    saar_actions: countTurnsBy(turns, (turn) => sessionAwareAction(turn)),
    session_phases: countTurnsBy(turns, (turn) => stringField(turn.phase) ?? stringField(objectField(turn.route_diagnostics)?.session_phase)),
    cache: {
      observed_turns: turns.filter((turn) => numberField(turn.prompt_tokens) !== undefined && numberField(turn.cached_prompt_tokens) !== undefined).length,
      prompt_tokens: promptTokens,
      cached_prompt_tokens: cachedPromptTokens,
      cache_hit_rate: ratio(cachedPromptTokens, promptTokens),
      cache_gap_tokens: Math.max(0, promptTokens - cachedPromptTokens),
      completion_tokens: sumTurnNumbers(turns, "completion_tokens"),
    },
  };
}

function countTurnsBy(turns: JsonObject[], field: (turn: JsonObject) => string | undefined): Record<string, number> {
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

function sumTurnNumbers(turns: JsonObject[], field: string): number {
  return turns.reduce((sum, turn) => sum + (numberField(turn[field]) ?? 0), 0);
}

function sumActualCosts(turns: JsonObject[]): JsonObject {
  const costs = turns.map((turn) => objectField(objectField(turn.cost)?.actual)).filter((item): item is JsonObject => Boolean(item));
  return sumCostObjects(costs);
}

function sumBaselineCosts(turns: JsonObject[], baselineModel: string): JsonObject {
  const costs = turns
    .map((turn) => objectField(objectField(objectField(turn.cost)?.baselines)?.[baselineModel]))
    .filter((item): item is JsonObject => Boolean(item));
  return sumCostObjects(costs);
}

function sumCostObjects(costs: JsonObject[]): JsonObject {
  const estimated = costs.filter((cost) => boolField(cost.estimated));
  const promptTokens = sumNumbers(estimated, "prompt_tokens");
  const cachedPromptTokens = sumNumbers(estimated, "cached_prompt_tokens");
  const totalCost = sumNumbers(estimated, "total_cost");
  const noCacheCost = sumNumbers(estimated, "no_cache_cost");
  return {
    estimated_turns: estimated.length,
    missing_turns: costs.length - estimated.length,
    prompt_tokens: promptTokens,
    cached_prompt_tokens: cachedPromptTokens,
    uncached_prompt_tokens: Math.max(0, promptTokens - cachedPromptTokens),
    completion_tokens: sumNumbers(estimated, "completion_tokens"),
    total_cost: roundCost(totalCost),
    no_cache_cost: roundCost(noCacheCost),
    prefix_cache_discount: roundCost(Math.max(0, noCacheCost - totalCost)),
  };
}

function costByModel(turns: JsonObject[]): JsonObject {
  const out: Record<string, JsonObject[]> = {};
  for (const turn of turns) {
    const actual = objectField(objectField(turn.cost)?.actual);
    const model = stringField(actual?.model);
    if (!actual || !model) {
      continue;
    }
    out[model] ??= [];
    out[model]!.push(actual);
  }
  return Object.fromEntries(Object.entries(out).map(([model, costs]) => [model, sumCostObjects(costs)]));
}

function prefixCacheCostSummary(turns: JsonObject[]): JsonObject {
  const actual = sumActualCosts(turns);
  const promptTokens = numberField(actual.prompt_tokens) ?? 0;
  const cachedPromptTokens = numberField(actual.cached_prompt_tokens) ?? 0;
  return {
    observed_turns: numberField(actual.estimated_turns) ?? 0,
    prompt_tokens: promptTokens,
    cached_prompt_tokens: cachedPromptTokens,
    cache_hit_rate: ratio(cachedPromptTokens, promptTokens),
    cache_gap_tokens: Math.max(0, promptTokens - cachedPromptTokens),
    no_cache_cost: actual.no_cache_cost,
    observed_cache_discount: actual.prefix_cache_discount,
  };
}

function firstCurrency(turns: JsonObject[]): string | undefined {
  for (const turn of turns) {
    const currency = stringField(objectField(objectField(turn.cost)?.actual)?.currency);
    if (currency) {
      return currency;
    }
  }
  return undefined;
}

function costDelta(baseline: unknown, actual: unknown): number | undefined {
  const baselineCost = numberField(baseline);
  const actualCost = numberField(actual);
  return baselineCost === undefined || actualCost === undefined ? undefined : roundCost(baselineCost - actualCost);
}

function costSavingsPct(baseline: unknown, actual: unknown): number | undefined {
  const baselineCost = numberField(baseline);
  const actualCost = numberField(actual);
  if (baselineCost === undefined || actualCost === undefined || baselineCost <= 0) {
    return undefined;
  }
  return roundRatio((baselineCost - actualCost) / baselineCost);
}

function sumNumbers(items: JsonObject[], field: string): number {
  return items.reduce((sum, item) => sum + (numberField(item[field]) ?? 0), 0);
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function caseChecks(evalCase: EvalCase, run: JsonObject): EvalCheck[] {
  const turns = objectArrayField(run.model_turns);
  const primaryTurn = turns[turns.length - 1];
  const checks: EvalCheck[] = [
    {
      name: `${evalCase.label}.run_completed`,
      passed: stringField(run.status) === "completed",
      expected: "completed",
      actual: stringField(run.status),
    },
    {
      name: `${evalCase.label}.model_turn_present`,
      passed: turns.length > 0,
      expected: "at least one model turn",
      actual: turns.length,
    },
  ];
  if (!primaryTurn) {
    return checks;
  }

  const decision = stringField(primaryTurn.decision);
  const selectedModel = stringField(primaryTurn.selected_model) ?? stringField(primaryTurn.model);
  const diagnostics = objectField(primaryTurn.route_diagnostics);
  const learningPolicy = learningPolicyFromTurn(primaryTurn);
  const decisionOk = decisionMatches(decision, evalCase.expectation.decisionGroups);
  const saarProtectedToolLoop = isToolLoopCase(evalCase) && toolLoopTurnIsStable(primaryTurn);
  checks.push(
    {
      name: `${evalCase.label}.decision_matches_recipe_intent`,
      passed: decisionOk || saarProtectedToolLoop,
      expected: saarProtectedToolLoop
        ? { decisions: expectedDecisions(evalCase.expectation.decisionGroups), or: "SAAR-protected tool-loop stay/hard_lock" }
        : expectedDecisions(evalCase.expectation.decisionGroups),
      actual: decision,
    },
    {
      name: `${evalCase.label}.model_matches_recipe_intent`,
      passed: modelMatches(selectedModel, evalCase.expectation.modelGroups),
      expected: expectedModels(evalCase.expectation.modelGroups),
      actual: selectedModel,
    },
    {
      name: `${evalCase.label}.replay_id_present`,
      passed: Boolean(stringField(primaryTurn.replay_id)),
      expected: "x-vsr-replay-id",
      actual: stringField(primaryTurn.replay_id),
    },
    {
      name: `${evalCase.label}.replay_fetch_ok`,
      passed: replayStatus(primaryTurn) === "ok" || replayStatus(primaryTurn) === "skipped",
      expected: "ok",
      actual: replayStatus(primaryTurn),
    },
    {
      name: `${evalCase.label}.route_diagnostics_present`,
      passed: Boolean(diagnostics) || replayStatus(primaryTurn) === "skipped",
      expected: "replay.route_diagnostics",
      actual: Boolean(diagnostics),
    },
    {
      name: `${evalCase.label}.learning_header_present`,
      passed: Boolean(stringField(primaryTurn.learning)),
      expected: "x-vsr-learning-methods",
      actual: stringField(primaryTurn.learning),
    },
    {
      name: `${evalCase.label}.learning_replay_present`,
      passed: Boolean(learningPolicy) || replayStatus(primaryTurn) === "skipped",
      expected: "replay.learning.adaptations.session_aware",
      actual: Boolean(learningPolicy),
    },
  );
  if (diagnostics) {
    checks.push(
      {
        name: `${evalCase.label}.diagnostics_decision_matches_turn`,
        passed: stringField(diagnostics.decision) === decision,
        expected: decision,
        actual: stringField(diagnostics.decision),
      },
      {
        name: `${evalCase.label}.diagnostics_model_matches_turn`,
        passed: normalizeModel(stringField(diagnostics.selected_model)) === normalizeModel(selectedModel),
        expected: selectedModel,
        actual: stringField(diagnostics.selected_model),
      },
    );
  }
  return checks;
}

function scenarioChecks(name: string, cases: EvalCase[], runs: JsonObject[]): EvalCheck[] {
  if (name !== "same_session_tradeoff" && name !== "tool_loop_stability" && name !== "scope_protection") {
    return [];
  }
  const turns = runs.flatMap((run) => objectArrayField(run.model_turns));
  const checks: EvalCheck[] = [
    {
      name: `${name}.run_count`,
      passed: runs.length === cases.length,
      expected: cases.length,
      actual: runs.length,
    },
  ];
  if (name === "same_session_tradeoff") {
    checks.push(
      {
        name: `${name}.saar_policy_observed`,
        passed: turns.some((turn) => Boolean(learningPolicyFromTurn(turn)) || boolField(objectField(turn.route_diagnostics)?.session_policy_applied)),
        expected: "at least one turn with Router Learning session_aware policy",
        actual: turns.map((turn) => learningPolicyFromTurn(turn) ? "learning.session_aware" : objectField(turn.route_diagnostics)?.session_policy_applied).filter((item) => item !== undefined) as JsonValue,
      },
      {
        name: `${name}.saar_action_observed`,
        passed: turns.some((turn) => Boolean(activeSessionAwareAction(turn))),
        expected: ["select", "stay", "switch", "hard_lock"],
        actual: turns.map((turn) => sessionAwareAction(turn)).filter(Boolean) as JsonValue,
      },
    );
  }
  if (name === "tool_loop_stability") {
    const toolTurns = turns.filter(isToolLoopTurn);
    checks.push(
      {
        name: `${name}.tool_loop_turn_observed`,
        passed: toolTurns.length > 0,
        expected: "phase=tool_loop, learning.phase=tool_loop, or route_diagnostics.session_phase=tool_loop",
        actual: toolTurns.length,
      },
      {
        name: `${name}.tool_loop_stays_or_locks`,
        passed: toolTurns.length > 0 && toolTurns.every(toolLoopTurnIsStable),
        expected: "tool-loop turns use stay or hard_lock without switching models",
        actual: toolTurns.map((turn) => ({
          selected_model: stringField(turn.selected_model),
          action: sessionAwareAction(turn),
          previous_model: sessionAwareCurrentModel(turn) ?? stringField(objectField(turn.route_diagnostics)?.previous_model),
        })) as JsonValue,
      },
    );
  }
  if (name === "scope_protection") {
    checks.push(...scopeProtectionChecks(name, runs));
  }
  return checks;
}

function scopeProtectionChecks(name: string, runs: JsonObject[]): EvalCheck[] {
  const firstTurn = lastModelTurn(runs[0]);
  const simpleTurn = lastModelTurn(runs[1]);
  const privacyTurn = lastModelTurn(runs[2]);
  const observedScopes = [...new Set(runs.flatMap((run) => objectArrayField(run.model_turns).map(sessionAwareScope).filter(Boolean)))];
  const activeScope = observedScopes.includes("session") ? "session" : observedScopes.includes("conversation") ? "conversation" : undefined;
  const firstModel = normalizeModel(stringField(firstTurn?.selected_model) ?? stringField(firstTurn?.model));
  const simpleModel = normalizeModel(stringField(simpleTurn?.selected_model) ?? stringField(simpleTurn?.model));
  const simpleAction = simpleTurn ? sessionAwareAction(simpleTurn) : undefined;
  const simpleDecision = stringField(simpleTurn?.decision);
  const privacyModel = normalizeModel(stringField(privacyTurn?.selected_model) ?? stringField(privacyTurn?.model));
  const privacyAction = privacyTurn ? sessionAwareAction(privacyTurn) : undefined;

  const checks: EvalCheck[] = [
    {
      name: `${name}.scope_observed`,
      passed: activeScope === "conversation" || activeScope === "session",
      expected: ["conversation", "session"],
      actual: observedScopes as JsonValue,
    },
  ];

  if (activeScope === "session") {
    checks.push({
      name: `${name}.session_scope_protects_across_conversations`,
      passed: Boolean(firstModel) && firstModel === simpleModel && (simpleAction === "stay" || simpleAction === "hard_lock"),
      expected: { model: firstModel, action: ["stay", "hard_lock"] },
      actual: { model: simpleModel, action: simpleAction, decision: simpleDecision },
    });
  } else if (activeScope === "conversation") {
    checks.push({
      name: `${name}.conversation_scope_allows_new_conversation_reselect`,
      passed: modelMatches(simpleModel, ["local"]) && decisionMatches(simpleDecision, ["simple"]) && simpleAction === "select",
      expected: { model_group: "local", decision_group: "simple", action: "select" },
      actual: { model: simpleModel, action: simpleAction, decision: simpleDecision },
    });
  }

  checks.push({
    name: `${name}.privacy_bypass_stays_local`,
    passed: modelMatches(privacyModel, ["local"]) && privacyAction === "bypass",
    expected: { model_group: "local", action: "bypass" },
    actual: { model: privacyModel, action: privacyAction, decision: stringField(privacyTurn?.decision) },
  });

  return checks;
}

function lastModelTurn(run: JsonObject | undefined): JsonObject | undefined {
  const turns = objectArrayField(run?.model_turns);
  return turns[turns.length - 1];
}

function routingOutcome(evalCase: EvalCase, turns: JsonObject[]): JsonObject {
  const primaryTurn = turns[turns.length - 1];
  const decision = stringField(primaryTurn?.decision);
  const selectedModel = stringField(primaryTurn?.selected_model) ?? stringField(primaryTurn?.model);
  const decisionOk = decisionMatches(decision, evalCase.expectation.decisionGroups);
  const modelOk = modelMatches(selectedModel, evalCase.expectation.modelGroups);
  const saarProtectedToolLoop = primaryTurn ? isToolLoopCase(evalCase) && toolLoopTurnIsStable(primaryTurn) : false;
  const acceptable = Boolean(primaryTurn) && modelOk && (decisionOk || saarProtectedToolLoop);
  return {
    acceptable,
    severity: acceptable ? "ok" : routingMismatchSeverity(evalCase.label),
    label: evalCase.label,
    actual_decision: decision,
    actual_model: selectedModel,
    expected_decisions: expectedDecisions(evalCase.expectation.decisionGroups),
    expected_models: expectedModels(evalCase.expectation.modelGroups),
    reason: acceptable
      ? decisionOk
        ? "matches_profile_expectation"
        : "protected_by_saar_despite_decision_drift"
      : routingMismatchReason(decisionOk, modelOk),
  };
}

function routingQualitySummary(scenarios: JsonObject[]): JsonObject {
  const runs = allRuns(scenarios);
  const outcomes = runs.map((run) => objectField(run.routing_outcome)).filter((item): item is JsonObject => Boolean(item));
  const failedChecks = scenarios.flatMap((scenario) => checkArrayField(scenario.checks).filter((check) => !check.passed));
  const findings = [
    ...outcomes.filter((outcome) => !boolField(outcome.acceptable)).map(routingFindingFromOutcome),
    ...failedChecks.filter((check) => !check.name.endsWith(".decision_matches_recipe_intent") && !check.name.endsWith(".model_matches_recipe_intent")).map(routingFindingFromCheck),
  ];
  return {
    evaluated_runs: outcomes.length,
    acceptable_runs: outcomes.filter((outcome) => boolField(outcome.acceptable)).length,
    questionable_runs: outcomes.filter((outcome) => stringField(outcome.severity) === "medium").length,
    unreasonable_runs: outcomes.filter((outcome) => stringField(outcome.severity) === "high").length,
    findings,
  };
}

function routingFindingFromOutcome(outcome: JsonObject): JsonObject {
  return {
    severity: stringField(outcome.severity) ?? "medium",
    label: stringField(outcome.label),
    reason: stringField(outcome.reason),
    expected_decisions: outcome.expected_decisions,
    actual_decision: outcome.actual_decision,
    expected_models: outcome.expected_models,
    actual_model: outcome.actual_model,
  };
}

function routingFindingFromCheck(check: EvalCheck): JsonObject {
  return {
    severity: check.name.includes("tool_loop") ? "high" : "medium",
    check: check.name,
    reason: "profile_check_failed",
    expected: check.expected,
    actual: check.actual,
  };
}

function routingMismatchSeverity(label: string): "medium" | "high" {
  if (label.includes("privacy") || label.includes("tool_loop")) {
    return "high";
  }
  return "medium";
}

function routingMismatchReason(decisionOk: boolean, modelOk: boolean): string {
  if (!decisionOk && !modelOk) {
    return "decision_and_model_mismatch";
  }
  if (!decisionOk) {
    return "decision_mismatch";
  }
  return "model_mismatch";
}

function isToolLoopCase(evalCase: EvalCase): boolean {
  return evalCase.label.includes("tool_loop");
}

function isToolLoopTurn(turn: JsonObject): boolean {
  const diagnostics = objectField(turn.route_diagnostics);
  const learning = learningPolicyFromTurn(turn);
  return stringField(turn.phase) === "tool_loop" || stringField(learning?.phase) === "tool_loop" || stringField(diagnostics?.session_phase) === "tool_loop";
}

function toolLoopTurnIsStable(turn: JsonObject): boolean {
  const diagnostics = objectField(turn.route_diagnostics);
  const action = sessionAwareAction(turn);
  if (action !== "stay" && action !== "hard_lock") {
    return false;
  }
  const previous = normalizeModel(sessionAwareCurrentModel(turn) ?? stringField(diagnostics?.previous_model));
  const selected = normalizeModel(sessionAwareSelectedModel(turn) ?? stringField(diagnostics?.selected_model) ?? stringField(turn.selected_model));
  return !previous || previous === selected;
}

function decisionMatches(decision: string | undefined, groups: DecisionGroup[]): boolean {
  if (!decision) {
    return false;
  }
  const normalized = decision.toLowerCase();
  return groups.some((group) => DECISIONS[group].some((candidate) => candidate.toLowerCase() === normalized));
}

function modelMatches(model: string | undefined, groups: ModelGroup[]): boolean {
  if (!model) {
    return false;
  }
  const normalized = normalizeModel(model);
  return groups.some((group) => MODELS[group].some((candidate) => normalizeModel(candidate) === normalized));
}

function expectedDecisions(groups: DecisionGroup[]): string[] {
  return [...new Set(groups.flatMap((group) => DECISIONS[group]))];
}

function expectedModels(groups: ModelGroup[]): string[] {
  return [...new Set(groups.flatMap((group) => MODELS[group]))];
}

function publicExpectation(expectation: EvalExpectation): JsonObject {
  return {
    decisions: expectedDecisions(expectation.decisionGroups),
    models: expectedModels(expectation.modelGroups),
  };
}

function replayStatus(turn: JsonObject): string | undefined {
  return stringField(objectField(turn.replay_fetch)?.status);
}

function learningPolicyFromTurn(turn: JsonObject): JsonObject | undefined {
  const replayLearning = objectField(objectField(turn.replay)?.learning);
  const adaptations = objectField(replayLearning?.adaptations);
  return objectField(adaptations?.session_aware);
}

function sessionAwareAction(turn: JsonObject): string | undefined {
  return stringField(learningPolicyFromTurn(turn)?.action) ?? stringField(objectField(turn.route_diagnostics)?.session_action);
}

function sessionAwareScope(turn: JsonObject): string | undefined {
  return stringField(learningPolicyFromTurn(turn)?.scope) ?? learningSummaryField(stringField(turn.learning), "scope");
}

function activeSessionAwareAction(turn: JsonObject): string | undefined {
  const action = sessionAwareAction(turn);
  if (action === "select" || action === "stay" || action === "switch" || action === "hard_lock") {
    return action;
  }
  return undefined;
}

function sessionAwareCurrentModel(turn: JsonObject): string | undefined {
  return stringField(learningPolicyFromTurn(turn)?.current_model);
}

function sessionAwareSelectedModel(turn: JsonObject): string | undefined {
  return stringField(learningPolicyFromTurn(turn)?.selected_model);
}

function learningSummaryField(summary: string | undefined, key: string): string | undefined {
  if (!summary) {
    return undefined;
  }
  const prefix = `${key}=`;
  for (const part of summary.split(/[;\s]+/)) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return undefined;
}

function summarizeScenarios(scenarios: JsonObject[]): JsonObject {
  const checks = scenarios.flatMap((scenario) => checkArrayField(scenario.checks));
  return {
    scenario_count: scenarios.length,
    check_count: checks.length,
    passed_checks: checks.filter((check) => check.passed).length,
    failed_checks: checks.filter((check) => !check.passed).length,
    failed_check_names: checks.filter((check) => !check.passed).map((check) => check.name),
  };
}

function allRuns(scenarios: JsonObject[]): JsonObject[] {
  return scenarios.flatMap((scenario) => objectArrayField(scenario.runs));
}

function allTurns(scenarios: JsonObject[]): JsonObject[] {
  return allRuns(scenarios).flatMap((run) => objectArrayField(run.model_turns));
}

function summarizeChecks(checks: EvalCheck[]): JsonObject {
  return {
    check_count: checks.length,
    passed_checks: checks.filter((check) => check.passed).length,
    failed_checks: checks.filter((check) => !check.passed).length,
    failed_check_names: checks.filter((check) => !check.passed).map((check) => check.name),
  };
}

function objectArrayField(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => objectField(item)).filter((item): item is JsonObject => Boolean(item));
}

function checkArrayField(value: unknown): EvalCheck[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => objectField(item)).filter((item): item is JsonObject => Boolean(item)).map((item) => ({
    name: stringField(item.name) ?? "unknown",
    passed: boolField(item.passed) ?? false,
    expected: item.expected,
    actual: item.actual,
    detail: stringField(item.detail),
  }));
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

function boolField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeModel(model: string | undefined): string | undefined {
  return model?.trim().toLowerCase();
}

function previewText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
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
