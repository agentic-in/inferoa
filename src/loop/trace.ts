import type { SessionStore } from "../session/store.js";
import type { JsonObject, SessionEvent, SessionRecord } from "../types.js";

export interface LoopTraceToolCall {
  tool_call_id: string;
  tool_name: string;
  step_id?: string;
  step_index?: number;
  ok?: boolean;
  error_code?: string;
  started_at?: string;
  completed_at?: string;
}

export interface LoopTraceStep {
  index: number;
  step_id?: string;
  model?: string;
  request_class?: string;
  visibility?: string;
  prompt_epoch_id?: string;
  estimated_tokens?: number;
  response_model?: string;
  tool_call_count: number;
  usage?: JsonObject;
  started_at?: string;
  completed_at?: string;
}

export interface LoopTraceGoalEvent {
  type: string;
  horizon_generation?: number;
  previous_horizon_generation?: number;
  decision?: string;
  verdict?: string;
  provider?: string;
  verifier_role?: string;
  created_at?: string;
}

export interface LoopTraceRun {
  run_id: string;
  status: "running" | "completed" | "stopped" | "failed" | "unknown";
  request_class?: string;
  visibility?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  tokens?: number;
  tool_rounds?: number;
  tool_calls?: number;
  steps: LoopTraceStep[];
  tools: LoopTraceToolCall[];
  goal_events: LoopTraceGoalEvent[];
  verification_count: number;
  skill_snapshot_count: number;
}

export interface LoopTraceSummary {
  runs: number;
  steps: number;
  tool_calls: number;
  verifications: number;
  completed: number;
  stopped: number;
  failed: number;
}

export interface LoopTrace {
  session: {
    session_id: string;
    title: string;
    status: string;
  };
  generated_at: string;
  summary: LoopTraceSummary;
  runs: LoopTraceRun[];
}

interface MutableTraceRun extends LoopTraceRun {
  toolMap: Map<string, LoopTraceToolCall>;
  stepMap: Map<string, LoopTraceStep>;
}

export function readLoopTrace(store: SessionStore, session: SessionRecord, options: { limit?: number } = {}): LoopTrace {
  const events = store.listEvents(session.session_id);
  const runs = new Map<string, MutableTraceRun>();
  for (const event of events) {
    const runId = event.run_id;
    if (!runId) {
      continue;
    }
    const run = getTraceRun(runs, runId);
    applyTraceEvent(run, event);
  }
  const allRuns = [...runs.values()]
    .map(finalizeRun)
    .sort((left, right) => (right.started_at ?? "").localeCompare(left.started_at ?? "") || right.run_id.localeCompare(left.run_id));
  const limitedRuns = allRuns.slice(0, Math.max(1, Math.trunc(options.limit ?? 20)));
  return {
    session: {
      session_id: session.session_id,
      title: session.title,
      status: session.status,
    },
    generated_at: new Date().toISOString(),
    summary: summarizeRuns(allRuns),
    runs: limitedRuns,
  };
}

function getTraceRun(runs: Map<string, MutableTraceRun>, runId: string): MutableTraceRun {
  const existing = runs.get(runId);
  if (existing) {
    return existing;
  }
  const run: MutableTraceRun = {
    run_id: runId,
    status: "unknown",
    steps: [],
    tools: [],
    toolMap: new Map(),
    stepMap: new Map(),
    goal_events: [],
    verification_count: 0,
    skill_snapshot_count: 0,
  };
  runs.set(runId, run);
  return run;
}

function applyTraceEvent(run: MutableTraceRun, event: SessionEvent): void {
  if (!run.started_at || (event.created_at && event.created_at < run.started_at)) {
    run.started_at = event.created_at;
  }
  if (event.type === "user.prompt") {
    run.request_class = stringValue(event.data.request_class) ?? run.request_class;
    run.visibility = stringValue(event.data.visibility) ?? run.visibility;
    return;
  }
  if (event.type === "model.request.started") {
    run.request_class = stringValue(event.data.request_class) ?? run.request_class;
    run.visibility = stringValue(event.data.visibility) ?? run.visibility;
    const step = getOrCreateStep(run, event);
    step.model = stringValue(event.data.model);
    step.request_class = stringValue(event.data.request_class);
    step.visibility = stringValue(event.data.visibility);
    step.prompt_epoch_id = stringValue(event.data.prompt_epoch_id);
    step.estimated_tokens = numberValue(event.data.estimated_tokens);
    step.started_at = event.created_at;
    return;
  }
  if (event.type === "model.response.settled") {
    const step = getOrCreateStep(run, event);
    step.response_model = stringValue(event.data.model);
    step.usage = objectValue(event.data.usage);
    step.tool_call_count = Array.isArray(event.data.tool_calls) ? event.data.tool_calls.length : step.tool_call_count;
    step.completed_at = event.created_at;
    run.request_class = stringValue(event.data.request_class) ?? run.request_class;
    run.visibility = stringValue(event.data.visibility) ?? run.visibility;
    return;
  }
  if (event.type === "model.request.failed" || event.type === "model.request.retry") {
    const step = getOrCreateStep(run, event);
    step.completed_at = event.created_at;
    return;
  }
  if (event.type === "tool.call") {
    const id = stringValue(event.data.tool_call_id);
    const name = stringValue(event.data.tool_name);
    if (!id || !name) {
      return;
    }
    const tool = getTool(run, id, name);
    tool.step_id = stringValue(event.data.step_id) ?? tool.step_id;
    tool.step_index = numberValue(event.data.step_index) ?? tool.step_index;
    tool.started_at = event.created_at;
    return;
  }
  if (event.type === "tool.result") {
    const id = stringValue(event.data.tool_call_id);
    const name = stringValue(event.data.tool_name);
    if (!id || !name) {
      return;
    }
    const tool = getTool(run, id, name);
    tool.step_id = stringValue(event.data.step_id) ?? tool.step_id;
    tool.step_index = numberValue(event.data.step_index) ?? tool.step_index;
    const result = objectValue(event.data.result);
    tool.ok = typeof result?.ok === "boolean" ? result.ok : tool.ok;
    const error = objectValue(result?.error);
    tool.error_code = stringValue(error?.code) ?? tool.error_code;
    tool.completed_at = event.created_at;
    return;
  }
  if (event.type === "run.completed" || event.type === "run.stopped" || event.type === "run.failed") {
    run.status = event.type === "run.completed" ? "completed" : event.type === "run.stopped" ? "stopped" : "failed";
    run.completed_at = event.created_at;
    run.duration_ms = numberValue(event.data.duration_ms);
    run.tokens = numberValue(event.data.tokens);
    run.tool_rounds = numberValue(event.data.tool_rounds);
    run.tool_calls = numberValue(event.data.tool_calls);
    return;
  }
  if (event.type === "skill.snapshot.created") {
    run.skill_snapshot_count += 1;
    return;
  }
  if (event.type === "goal.verification.recorded") {
    run.verification_count += 1;
  }
  if (event.type.startsWith("goal.")) {
    run.goal_events.push({
      type: event.type,
      horizon_generation: numberValue(event.data.horizon_generation),
      previous_horizon_generation: numberValue(event.data.previous_horizon_generation),
      decision: stringValue(event.data.decision),
      verdict: stringValue(event.data.verdict),
      provider: stringValue(event.data.provider),
      verifier_role: stringValue(event.data.verifier_role) ?? stringValue(event.data.role),
      created_at: event.created_at,
    });
  }
}

function getTool(run: MutableTraceRun, id: string, name: string): LoopTraceToolCall {
  const existing = run.toolMap.get(id);
  if (existing) {
    return existing;
  }
  const tool: LoopTraceToolCall = { tool_call_id: id, tool_name: name };
  run.toolMap.set(id, tool);
  run.tools.push(tool);
  return tool;
}

function getOrCreateStep(run: MutableTraceRun, event: SessionEvent): LoopTraceStep {
  const explicitId = stringValue(event.data.step_id);
  if (explicitId) {
    const existing = run.stepMap.get(explicitId);
    if (existing) {
      return existing;
    }
    const step: LoopTraceStep = {
      index: numberValue(event.data.step_index) ?? run.steps.length + 1,
      step_id: explicitId,
      tool_call_count: 0,
    };
    run.stepMap.set(explicitId, step);
    run.steps.push(step);
    return step;
  }
  if (event.type === "model.response.settled" || event.type === "model.request.failed" || event.type === "model.request.retry") {
    const latest = run.steps.at(-1);
    if (latest) {
      return latest;
    }
  }
  const step: LoopTraceStep = {
    index: run.steps.length + 1,
    tool_call_count: 0,
  };
  run.steps.push(step);
  return step;
}

function finalizeRun(run: MutableTraceRun): LoopTraceRun {
  const { toolMap: _toolMap, stepMap: _stepMap, ...output } = run;
  return {
    ...output,
    steps: output.steps.slice().sort((left, right) => left.index - right.index || (left.started_at ?? "").localeCompare(right.started_at ?? "")),
    status: output.status === "unknown" && !output.completed_at ? "running" : output.status,
    tool_calls: output.tool_calls ?? output.tools.length,
  };
}

function summarizeRuns(runs: LoopTraceRun[]): LoopTraceSummary {
  return {
    runs: runs.length,
    steps: runs.reduce((sum, run) => sum + run.steps.length, 0),
    tool_calls: runs.reduce((sum, run) => sum + (run.tool_calls ?? run.tools.length), 0),
    verifications: runs.reduce((sum, run) => sum + run.verification_count, 0),
    completed: runs.filter((run) => run.status === "completed").length,
    stopped: runs.filter((run) => run.status === "stopped").length,
    failed: runs.filter((run) => run.status === "failed").length,
  };
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}
