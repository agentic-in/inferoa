import test from "node:test";
import assert from "node:assert/strict";
import { renderModeMetadataRight } from "../src/tui/mode-footer.js";
import { stripAnsi } from "../src/tui/ansi.js";
import type { AutoresearchState } from "../src/autoresearch/state.js";
import type { GoalState } from "../src/goals/state.js";
import type { PlanState } from "../src/plans/state.js";

test("mode footer surfaces plan readiness, research state, and goal progress", () => {
  const rendered = renderModeMetadataRight({
    plan: planState({ body: "1. inspect\n2. verify" }),
    autoresearch: autoresearchState({ pendingRunId: 3 }),
    goal: goalState({ objective: "improve codebase quality", timeUsedMs: 65_000 }),
  }, { nowMs: 10_000, activeRunStartedAtMs: 8_000 });

  const plain = stripAnsi(rendered ?? "");
  assert.match(plain, /Plan ready/);
  assert.match(plain, /Research pending 3/);
  assert.match(plain, /Loop .*improve codebase quality .*task 1 .*1\/3 .*1m 7s/);
});

test("mode footer keeps draft plan and blocked goal details compact", () => {
  const rendered = renderModeMetadataRight({
    plan: planState(),
    goal: goalState({ blocked: true }),
  });

  const plain = stripAnsi(rendered ?? "");
  assert.match(plain, /Plan drafting/);
  assert.match(plain, /Loop .*Improve long horizon flow .*task 1 .*1\/3 1 blocked/);
});

test("mode footer surfaces pending loop review decisions", () => {
  const rendered = renderModeMetadataRight({
    goal: goalState({ status: "paused", enabled: false, pendingReview: "expand" }),
  });

  const plain = stripAnsi(rendered ?? "");
  assert.match(plain, /Loop review expand/);
});

test("mode footer hides inactive or closed modes", () => {
  const rendered = renderModeMetadataRight({
    plan: planState({ status: "approved", enabled: false, body: "ready" }),
    autoresearch: { enabled: false, experiments: [] },
    goal: goalState({ status: "complete", enabled: false }),
  });

  assert.equal(rendered, undefined);
});

function planState(input: { status?: PlanState["plan"]["status"]; enabled?: boolean; body?: string } = {}): PlanState {
  return {
    enabled: input.enabled ?? true,
    plan: {
      id: "plan_1",
      objective: "Ship mode UX",
      status: input.status ?? "drafting",
      body: input.body,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

function goalState(input: { status?: GoalState["goal"]["status"]; enabled?: boolean; blocked?: boolean; objective?: string; timeUsedMs?: number; pendingReview?: "expand" | "done" | "blocked" } = {}): GoalState {
  return {
    enabled: input.enabled ?? true,
    goal: {
      id: "goal_1",
      objective: input.objective ?? "Improve long horizon flow",
      kind: "task",
      hil_policy: "auto",
      status: input.status ?? "active",
      tokens_used: 0,
      time_used_ms: input.timeUsedMs ?? 0,
      time_used_seconds: Math.floor((input.timeUsedMs ?? 0) / 1000),
      tool_rounds_used: 0,
      tool_calls_used: 0,
      horizon_generation: 1,
      pending_review_decision: input.pendingReview
        ? {
            id: "review_1",
            action: input.pendingReview,
            source_horizon_generation: 1,
            created_at: "2026-01-01T00:00:00.000Z",
          }
        : undefined,
      planning: {
        active_step_id: input.blocked ? "verify" : "edit",
        updated_at: "2026-01-01T00:00:00.000Z",
        steps: [
          { id: "inspect", title: "Inspect", status: "completed", updated_at: "2026-01-01T00:00:00.000Z" },
          { id: "edit", title: "Edit", status: input.blocked ? "blocked" : "in_progress", updated_at: "2026-01-01T00:00:00.000Z" },
          { id: "verify", title: "Verify", status: "pending", updated_at: "2026-01-01T00:00:00.000Z" },
        ],
      },
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

function autoresearchState(input: { pendingRunId?: number } = {}): AutoresearchState {
  return {
    enabled: true,
    goal: "reduce benchmark latency",
    active_experiment_name: "latency",
    experiments: [{
      name: "latency",
      status: "active",
      primary_metric: "latency_ms",
      metric_unit: "ms",
      direction: "lower",
      scope_paths: [],
      off_limits: [],
      constraints: [],
      current_segment: 0,
      notes: "",
      next_run_id: 4,
      best_metric: null,
      pending_run: input.pendingRunId
        ? {
            id: input.pendingRunId,
            command: "./autoresearch.sh",
            exit_code: 0,
            duration_ms: 12,
            parsed_metrics: {},
            parsed_primary: null,
            asi: {},
            completed_at: "2026-01-01T00:00:00.000Z",
          }
        : undefined,
      results: [],
    }],
  };
}
