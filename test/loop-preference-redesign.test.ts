import test from "node:test";
import assert from "node:assert/strict";
import { createGoalState, renderGoalModeSection } from "../src/goals/state.js";
import * as promptBuilders from "../src/goals/supervisor-prompts.js";
import { slashSubcommands } from "../src/tui/slash.js";

function plain(value: string | undefined): string {
  return value ?? "";
}

test("loop state uses clean preference and runtime fields instead of public strategies", () => {
  const state = createGoalState({ objective: "Ship the redesign" } as never);
  const goal = state.goal as unknown as Record<string, unknown>;

  assert.equal(goal.preference, "deliver");
  assert.deepEqual(goal.runtime_policy, { mode: "auto" });
  assert.equal("strategy" in goal, false);
  assert.equal("kind" in goal, false);
  assert.equal(goal.planning && typeof goal.planning === "object", true);

  const planning = goal.planning as { summary?: string; active_step_id?: string; steps?: Array<{ id: string; title: string }> };
  assert.equal(planning.summary, "Loop task 0 · Deliver bootstrap");
  assert.equal(planning.active_step_id, "read_objective_and_constraints");
  assert.deepEqual(
    planning.steps?.map((step) => [step.id, step.title]),
    [
      ["read_objective_and_constraints", "Read objective and constraints"],
      ["map_work_surfaces", "Map work surfaces, risks, and unknowns"],
      ["seed_frontier_candidates", "Seed high-value frontier candidates"],
      ["choose_first_execution_slice", "Choose the first execution slice"],
    ],
  );
});

test("discover preference gets research bootstrap without forcing a script harness", () => {
  const state = createGoalState({ objective: "Find a better cache policy", preference: "discover" } as never);
  const goal = state.goal as unknown as Record<string, unknown>;
  const planning = goal.planning as { summary?: string; steps?: Array<{ id: string; title: string }> };

  assert.equal(goal.preference, "discover");
  assert.equal(planning.summary, "Loop task 0 · Discover bootstrap");
  assert.deepEqual(
    planning.steps?.map((step) => [step.id, step.title]),
    [
      ["read_research_objective", "Read research objective"],
      ["define_evidence_metrics_guardrails", "Define evidence, metrics, and guardrails"],
      ["design_experiment_protocol", "Design or locate the benchmark / experiment protocol"],
      ["seed_experiment_hypotheses", "Seed experiment hypotheses"],
    ],
  );

  const context = plain(renderGoalModeSection(state));
  assert.match(context, /preference: Discover/);
  assert.match(context, /benchmark \/ experiment protocol/i);
  assert.doesNotMatch(context, /autoresearch\.sh/i);
  assert.doesNotMatch(context, /strategy|approach|focus|explore|timebox/i);
});

test("at least runtime progress is visible only in loop context", () => {
  const state = createGoalState({
    objective: "Run for a meaningful minimum",
    runtime_policy: { mode: "at_least", min_duration_ms: 3_600_000 },
  } as never);
  state.goal.time_used_ms = 900_000;
  state.goal.time_used_seconds = 900;

  const context = plain(renderGoalModeSection(state));

  assert.match(context, /runtime: At least 1h/);
  assert.match(context, /runtime progress: elapsed 15m; minimum 1h; remaining 45m/);
});

test("replay preference has attempts but no bootstrap or hidden model context", () => {
  const state = createGoalState({
    objective: "say hi to me",
    preference: "replay",
    replay: { target_attempts: 100 },
  } as never);
  const goal = state.goal as unknown as Record<string, unknown>;

  assert.equal(goal.preference, "replay");
  assert.deepEqual(goal.replay, { target_attempts: 100, remaining_attempts: 100 });
  assert.equal(goal.planning, undefined);
  assert.equal(renderGoalModeSection(state), undefined);
});

test("loop prompt builders expose execution and decision contracts", () => {
  const module = promptBuilders as Record<string, unknown>;
  const buildExecution = module.buildLoopExecutionPrompt;
  const buildDecision = module.buildLoopDecisionPrompt;

  assert.equal(typeof buildExecution, "function");
  assert.equal(typeof buildDecision, "function");

  const deliverExecution = (buildExecution as (goal: unknown) => string)(
    createGoalState({ objective: "Ship a hard feature" } as never).goal,
  );
  assert.match(deliverExecution, /Execution turn/i);
  assert.match(deliverExecution, /highest-leverage next action/i);
  assert.match(deliverExecution, /top-level objective/i);
  assert.match(deliverExecution, /Verify/i);
  assert.match(deliverExecution, /loop step, ledger, or decomposition/i);
  assert.doesNotMatch(deliverExecution, /infer the loop approach|set_strategy|focus|timebox/i);

  const decision = (buildDecision as (goal: unknown) => string)(
    createGoalState({ objective: "Ship a hard feature", runtime_policy: { mode: "at_least", min_duration_ms: 86_400_000 } } as never).goal,
  );
  assert.match(decision, /Decision turn/i);
  assert.match(decision, /Independently judge/i);
  assert.match(decision, /At least runtime is pending/i);
  assert.match(decision, /decision=expand, done, or blocked/i);
  assert.match(decision, /never use bare expand/i);
  assert.doesNotMatch(decision, /Do not optimize endlessly/i);
});

test("loop slash subcommands expose run preferences and hide old modes", () => {
  const values = slashSubcommands("loop").map((item) => item.value);

  assert.deepEqual(values.slice(0, 6), [
    "/loop status",
    "/loop health",
    "/loop run",
    "/loop run deliver",
    "/loop run discover",
    "/loop run replay",
  ]);
  assert.equal(values.some((value) => value.includes("/loop mode")), false);
  assert.equal(values.some((value) => /focus|explore|timebox|auto/.test(value)), false);
});
