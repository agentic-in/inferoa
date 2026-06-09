import test from "node:test";
import assert from "node:assert/strict";
import { applyTextInputToken, createTextInputState, renderTextInputDisplay } from "../src/tui/text-input.js";

test("single-line setup input supports cursor movement and mid-string edits", () => {
  let state = createTextInputState("omni.internal:8091");

  state = applyTextInputToken(state, "\u001b[D");
  state = applyTextInputToken(state, "\u001b[D");
  state = applyTextInputToken(state, "x");

  assert.equal(state.value, "omni.internal:80x91");
  assert.equal(state.cursor, "omni.internal:80x".length);

  state = applyTextInputToken(state, "\u007f");
  assert.equal(state.value, "omni.internal:8091");
  assert.equal(state.cursor, "omni.internal:80".length);
});

test("single-line setup input does not insert escape sequences as text", () => {
  let state = createTextInputState("endpoint");
  state = applyTextInputToken(state, "\u001b[D");
  state = applyTextInputToken(state, "\u001b[D");

  assert.equal(state.value, "endpoint");
  assert.equal(state.cursor, "endpoi".length);
});

test("single-line setup input supports home and end keys", () => {
  let state = createTextInputState("example");
  state = applyTextInputToken(state, "\u001b[H");
  state = applyTextInputToken(state, "x");
  state = applyTextInputToken(state, "\u001b[F");
  state = applyTextInputToken(state, "y");

  assert.equal(state.value, "xexampley");
});

test("single-line setup input viewport keeps the cursor visible", () => {
  let state = createTextInputState("http://omni.internal:8091/v1");
  state = { ...state, cursor: "http://omni.inter".length };
  const display = renderTextInputDisplay(state, 12);

  assert.equal(display.beforeCursor, "/omni.inter");
  assert.equal(display.afterCursor, "n");
});
