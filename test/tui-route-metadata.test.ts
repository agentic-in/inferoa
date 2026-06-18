import test from "node:test";
import assert from "node:assert/strict";
import { composerRouteSelectionFromRoute, renderComposerRouteSelection } from "../src/tui/app.js";
import { stripAnsi } from "../src/tui/ansi.js";

test("auto composer route metadata renders selected model, category, and decision as separate segments", () => {
  const selection = composerRouteSelectionFromRoute({
    "x-vsr-selected-model": "qwen/qwen3.6-rocm",
    "x-vsr-selected-category": "decision",
    "x-vsr-selected-decision": "agentic_session_route",
  });
  const rendered = renderComposerRouteSelection(selection).join(" ");
  const plain = stripAnsi(rendered);

  assert.equal(plain, "· qwen/qwen3.6-rocm · category: decision · decision: agentic_session_route");
  assert.doesNotMatch(plain, /selected:/);
  assert.doesNotMatch(plain, / \/ agentic_session_route/);
  assert.match(rendered, /\x1b\[38;5;75mqwen\/qwen3\.6-rocm\x1b\[0m/);
  assert.match(rendered, /\x1b\[38;5;252mcategory: decision\x1b\[0m/);
  assert.match(rendered, /\x1b\[38;5;75mdecision: agentic_session_route\x1b\[0m/);
});

test("composer route metadata falls back to request class labels when router category is absent", () => {
  const selection = composerRouteSelectionFromRoute(
    {
      "x-vsr-selected-model": "qwen/qwen3.6-rocm",
      "x-vsr-selected-decision": "agentic_session_route",
    },
    { requestClass: "reflection" },
  );
  const plain = stripAnsi(renderComposerRouteSelection(selection).join(" "));

  assert.equal(plain, "· qwen/qwen3.6-rocm · decision · decision: agentic_session_route");
});

test("composer route metadata renders vllm-sr learning action in auto mode", () => {
  const selection = composerRouteSelectionFromRoute({
    "x-vsr-selected-model": "google/gemini-3.1-pro",
    "x-vsr-selected-decision": "domain_code_complex",
    "x-vsr-learning-methods": "session_aware",
    "x-vsr-learning-actions": "session_aware=hard_lock",
    "x-vsr-learning-reasons": "session_aware=hard_lock=tool_loop",
    "x-vsr-learning-scopes": "session_aware=conversation",
    "x-vsr-learning-modes": "session_aware=apply",
  });
  const rendered = renderComposerRouteSelection(selection).join(" ");
  const plain = stripAnsi(rendered);

  assert.equal(plain, "· google/gemini-3.1-pro · decision: domain_code_complex · learning: hard lock · scope run · reason tool loop · tool-loop pinned");
  assert.match(rendered, /\x1b\[38;5;252mlearning: hard lock · scope run · reason tool loop · tool-loop pinned\x1b\[0m/);
});

test("composer route metadata renders applied model switches as learning state", () => {
  const selection = composerRouteSelectionFromRoute({
    "x-vsr-selected-model": "google/gemini-3.1-pro",
    "x-vsr-selected-decision": "domain_code_complex",
    "x-vsr-learning-methods": "session_aware",
    "x-vsr-learning-actions": "session_aware=switch",
    "x-vsr-learning-reasons": "session_aware=switch_allowed",
    "x-vsr-learning-scopes": "session_aware=conversation",
    "x-vsr-learning-modes": "session_aware=apply",
  });
  const rendered = renderComposerRouteSelection(selection).join(" ");
  const plain = stripAnsi(rendered);

  assert.equal(plain, "· google/gemini-3.1-pro · decision: domain_code_complex · learning: switch · scope run · reason switch allowed · model switched");
  assert.match(rendered, /\x1b\[38;5;252mlearning: switch · scope run · reason switch allowed · model switched\x1b\[0m/);
});

test("composer route metadata hides normal initial learning selections", () => {
  const selection = composerRouteSelectionFromRoute({
    "x-vsr-selected-model": "qwen/qwen3.6-rocm",
    "x-vsr-selected-decision": "simple_general",
    "x-vsr-learning-methods": "session_aware",
    "x-vsr-learning-actions": "session_aware=select",
    "x-vsr-learning-reasons": "session_aware=missing_previous_model",
    "x-vsr-learning-scopes": "session_aware=conversation",
    "x-vsr-learning-modes": "session_aware=apply",
  });
  const plain = stripAnsi(renderComposerRouteSelection(selection).join(" "));

  assert.equal(plain, "· qwen/qwen3.6-rocm · decision: simple_general");
  assert.doesNotMatch(plain, /initial|learning|select/);
});
