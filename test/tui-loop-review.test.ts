import test from "node:test";
import assert from "node:assert/strict";
import { createGoalState } from "../src/goals/state.js";
import { applyLoopReviewInputToken, createLoopReviewInputState, renderLoopReviewPromptLines } from "../src/tui/loop-review.js";

test("loop review prompt supports dynamic choice and feedback", () => {
  let result = applyLoopReviewInputToken(createLoopReviewInputState(), "\u001b[B");
  assert.equal(result.state.selectedIndex, 1);
  assert.equal(result.response, undefined);

  result = applyLoopReviewInputToken(result.state, "\r");
  assert.equal(result.state.phase, "feedback");
  assert.equal(result.state.decision, "revise");

  for (const key of "Please add regression coverage.") {
    result = applyLoopReviewInputToken(result.state, key);
  }
  result = applyLoopReviewInputToken(result.state, "\r");

  assert.deepEqual(result.response, {
    decision: "revise",
    feedback: "Please add regression coverage.",
  });
});

test("loop review prompt renders actions without slash commands", () => {
  const goal = createGoalState({ objective: "Review staged loop decision" });
  goal.goal.pending_review_decision = {
    id: "review_1",
    action: "expand",
    summary: "Open a second horizon with tests.",
    source_run_id: "run_review",
    source_horizon_generation: 0,
    created_at: "2026-06-11T00:00:00.000Z",
    steps: [{ id: "tests", title: "Add regression tests", status: "pending" }],
  };

  const plain = renderLoopReviewPromptLines(goal.goal, createLoopReviewInputState(), 100)
    .join("\n")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

  assert.match(plain, /loop review needs your decision/);
  assert.match(plain, /Approve/);
  assert.match(plain, /Adjust/);
  assert.match(plain, /Continue/);
  assert.match(plain, /Block/);
  assert.doesNotMatch(plain, /Revise|Reject/);
  assert.match(plain, /Add regression tests/);
  assert.doesNotMatch(plain, /\/loop review/);
});

test("loop review prompt only colors blocking decisions red", () => {
  const goal = createGoalState({ objective: "Review decision colors" });
  goal.goal.pending_review_decision = {
    id: "review_color",
    action: "expand",
    summary: "Open another loop task.",
    source_run_id: "run_review",
    source_horizon_generation: 0,
    created_at: "2026-06-11T00:00:00.000Z",
  };

  const expand = renderLoopReviewPromptLines(goal.goal, createLoopReviewInputState(), 100).join("\n");
  assert.match(expand, /\x1b\[38;5;75mdecision/);
  assert.doesNotMatch(expand, /\x1b\[38;5;203mdecision/);

  goal.goal.pending_review_decision!.action = "blocked";
  const blocked = renderLoopReviewPromptLines(goal.goal, createLoopReviewInputState(), 100).join("\n");
  assert.match(blocked, /\x1b\[38;5;203mdecision/);
});
