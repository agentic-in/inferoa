import test from "node:test";
import assert from "node:assert/strict";
import {
  createComposerInputHistory,
  navigateComposerInputHistory,
  recordComposerInputHistoryEntry,
  type ComposerInputHistoryNavigation,
} from "../src/tui/input-history.js";

test("composer input history navigates sent prompts and restores the draft", () => {
  let history = createComposerInputHistory();
  history = recordComposerInputHistoryEntry(history, "first prompt");
  history = recordComposerInputHistoryEntry(history, "second prompt");

  let navigation: ComposerInputHistoryNavigation | undefined;
  let buffer = "draft";

  let next = navigateComposerInputHistory(history, navigation, "previous", buffer);
  assert.equal(next.buffer, "second prompt");
  assert.equal(next.cursor, "second prompt".length);
  assert.equal(next.navigation?.draft, "draft");
  navigation = next.navigation;
  buffer = next.buffer;

  next = navigateComposerInputHistory(history, navigation, "previous", buffer);
  assert.equal(next.buffer, "first prompt");
  assert.equal(next.cursor, "first prompt".length);
  navigation = next.navigation;
  buffer = next.buffer;

  next = navigateComposerInputHistory(history, navigation, "next", buffer);
  assert.equal(next.buffer, "second prompt");
  assert.equal(next.cursor, "second prompt".length);
  navigation = next.navigation;
  buffer = next.buffer;

  next = navigateComposerInputHistory(history, navigation, "next", buffer);
  assert.equal(next.buffer, "draft");
  assert.equal(next.cursor, "draft".length);
  assert.equal(next.navigation, undefined);
});

test("composer input history ignores empty and consecutive duplicate entries", () => {
  let history = createComposerInputHistory();
  history = recordComposerInputHistoryEntry(history, "   ");
  history = recordComposerInputHistoryEntry(history, "repeat");
  history = recordComposerInputHistoryEntry(history, "repeat");
  history = recordComposerInputHistoryEntry(history, "repeat later");

  assert.deepEqual(history.entries, ["repeat", "repeat later"]);
});

test("composer input history respects its configured limit", () => {
  let history = createComposerInputHistory(2);
  history = recordComposerInputHistoryEntry(history, "one");
  history = recordComposerInputHistoryEntry(history, "two");
  history = recordComposerInputHistoryEntry(history, "three");

  assert.deepEqual(history.entries, ["two", "three"]);
});

test("composer input history no-ops without entries or active next navigation", () => {
  const history = createComposerInputHistory();

  let next = navigateComposerInputHistory(history, undefined, "previous", "draft");
  assert.equal(next.buffer, "draft");
  assert.equal(next.changed, false);

  const populated = recordComposerInputHistoryEntry(history, "sent");
  next = navigateComposerInputHistory(populated, undefined, "next", "draft");
  assert.equal(next.buffer, "draft");
  assert.equal(next.changed, false);
});
