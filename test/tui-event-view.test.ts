import test from "node:test";
import assert from "node:assert/strict";
import { renderCompactEventLine, renderSessionActivityLines, renderTodoEventLines } from "../src/tui/event-view.js";
import { stripAnsi, visibleWidth } from "../src/tui/ansi.js";
import type { SessionEvent } from "../src/types.js";

test("todo event view renders the latest todo snapshot without raw JSON", () => {
  const lines = renderTodoEventLines(
    [
      event("todo.updated", {
        items: [
          { id: "inspect", title: "Inspect flow", status: "completed" },
          { id: "verify", content: "Run verification", status: "in_progress" },
          { id: "commit", content: "Commit changes", status: "pending" },
        ],
      }),
    ],
    90,
  );
  const plain = stripAnsi(lines.join("\n"));

  assert.match(plain, /snapshot .*1 done .*1 active .*1 queued/);
  assert.match(plain, /done\s+Inspect flow/);
  assert.match(plain, /active\s+Run verification/);
  assert.match(plain, /queued\s+Commit changes/);
  assert.doesNotMatch(plain, /[{}"]/);
  assert.doesNotMatch(plain, /"items"|status/);
});

test("activity view renders session events without raw JSON or internal endpoint noise", () => {
  const lines = renderSessionActivityLines(
    [
      event("evidence.step.completed", {
        step_id: "verify",
        evidence: { test: "npm test", ok: true, duration_ms: 1200 },
      }),
      event("evidence.context_compression", {
        reason: "pre-run:token-pressure",
        estimated_tokens: 122000,
        threshold_tokens: 100000,
        epoch_id: "epoch_1",
        archive_resource_uri: "resource://session/archive",
        archived_events: 88,
        protected_tail_events: 9,
        protected_prompt_count: 2,
        protected_user_prompts: ["keep this private", "also private"],
      }),
      event("resource.created", {
        uri: "resource://session/r_1",
        kind: "prompt_epoch",
        bytes: 1536,
        metadata: { reason: "context" },
      }),
      event("endpoint.evidence.recorded", {
        provider_id: "direct",
        mode: "native",
        request_class: "interactive",
        model: "local-model",
        prompt_epoch_id: "pe_1",
        prompt_tokens: 900,
        cached_prompt_tokens: 450,
        cache_hit_rate: 0.5,
        request_id: "req_1",
      }),
    ],
    92,
  );
  const plain = stripAnsi(lines.join("\n"));

  assert.match(plain, /step verify .*test npm test .*ok true/);
  assert.match(plain, /context compacted .*reason pre-run:token-pressure/);
  assert.match(plain, /tokens 122000\/100000/);
  assert.match(plain, /archived 88 .*protected 9 tail \/ 2 prompts/);
  assert.match(plain, /saved prompt_epoch .*1\.5 KB/);
  assert.match(plain, /model turn .*native .*interactive .*local-model/);
  assert.match(plain, /tokens 900 prompt .*450 cached .*prefix cache 50\.0% .*epoch pe_1/);
  assert.doesNotMatch(plain, /vllm:openai|https?:\/\//);
  assert.doesNotMatch(plain, /request req_1|endpoint evidence/);
  assert.doesNotMatch(plain, /resource:\/\/session\/archive/);
  assert.doesNotMatch(plain, /[{}"]/);
  assert.doesNotMatch(plain, /"evidence"|"metadata"/);
  assert.doesNotMatch(plain, /keep this private|also private/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 92));
});

test("activity view renders goal completion reports as native metrics", () => {
  const lines = renderSessionActivityLines(
    [
      event("goal.completion_report", {
        goal_objective: "Ship the native long-horizon flow with stable cache-aware evidence cards",
        completion_summary: "Verified final state and committed changes.",
        report: "Goal achieved. 2 loops · 7 tool calls · 1m 08s · 340 tokens used.",
        tool_rounds: 2,
        tool_calls: 7,
        tokens: 340,
        duration_ms: 68_400,
      }),
    ],
    180,
  );
  const plain = stripAnsi(lines.join("\n"));

  assert.match(plain, /objective Ship the native long-horizon flow/);
  assert.match(plain, /goal complete .*loops 2 .*tools 7 .*time 1m 8s .*tokens 340/);
  assert.match(plain, /summary Verified final state and committed changes/);
  assert.match(plain, /Goal achieved/);
  assert.doesNotMatch(plain, /[{}"]/);
  assert.doesNotMatch(plain, /goal_objective|tool_rounds|tool_calls|duration_ms/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 180));
});

test("activity view renders horizon expansion as a native event", () => {
  const lines = renderSessionActivityLines(
    [
      event("goal.horizon.expanded", {
        goal_id: "goal_1",
        previous_horizon_generation: 1,
        horizon_generation: 2,
        step_count: 3,
        active_step_id: "verify",
      }),
    ],
    120,
  );
  const plain = stripAnsi(lines.join("\n"));

  assert.match(plain, /goal horizon started .*horizon 2 .*previous 1 .*steps 3 .*active verify/);
  assert.doesNotMatch(plain, /previous_horizon_generation|horizon_generation|step_count|active_step_id/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
});

test("activity view renders run lifecycle events as native metrics", () => {
  const lines = renderSessionActivityLines(
    [
      event("run.completed", {
        tool_rounds: 4,
        tool_calls: 11,
        tokens: 2048,
        duration_ms: 125_000,
      }),
      event("run.stopped", {
        reason: "max_tool_rounds",
        max_tool_rounds: 3,
        tool_rounds: 3,
        tool_calls: 9,
        tokens: 1440,
        duration_ms: 60_000,
      }),
      event("run.failed", {
        error: "provider timeout",
        tool_rounds: 1,
        tool_calls: 2,
        tokens: 320,
        duration_ms: 980,
      }),
    ],
    120,
  );
  const plain = stripAnsi(lines.join("\n"));

  assert.match(plain, /run complete .*loops 4 .*tools 11 .*time 2m 5s .*tokens 2048/);
  assert.match(plain, /run stopped .*reason tool-round limit .*loops 3 .*tools 9 .*time 1m .*tokens 1440/);
  assert.match(plain, /run failed .*error provider timeout .*loops 1 .*tools 2 .*time 980ms .*tokens 320/);
  assert.doesNotMatch(plain, /[{}"]/);
  assert.doesNotMatch(plain, /tool_rounds|tool_calls|max_tool_rounds|duration_ms/);
});

test("event view lines stay inside resized terminal width", () => {
  const width = 42;
  const lines = renderSessionActivityLines(
    [
      event("evidence.step.completed", {
        step_id: "verify-a-very-long-renderer-contract",
        evidence: { test: "npm test with a very long output summary", ok: true },
      }),
    ],
    width,
  );

  assert.ok(lines.every((line) => visibleWidth(line) <= width));
});

test("compact event line gives job attach panels a structured fallback", () => {
  const plain = stripAnsi(
    renderCompactEventLine(
      event("session.locked", {
        owner: "daemon",
        details: { pid: 1234, status: "running" },
      }),
      96,
    ),
  );

  assert.match(plain, /session\.locked .*owner daemon .*details pid=1234 .*status=running/);
  assert.doesNotMatch(plain, /[{}"]/);
});

function event(type: string, data: SessionEvent["data"]): SessionEvent {
  return {
    session_id: "session",
    run_id: "run",
    type,
    data,
    created_at: "2026-06-06T08:09:10.000Z",
  };
}
