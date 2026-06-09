import test from "node:test";
import assert from "node:assert/strict";
import {
  adjustComposerCompactRanges,
  backspaceComposer,
  compactRangeBeforeCursor,
  composerPlainPasteFallback,
  isComposerPathPaste,
  insertComposerPaste,
  insertComposerNewline,
  insertComposerText,
  moveComposerCursorLeft,
  moveComposerCursorRight,
  renderComposerActivityLine,
  renderComposerSurface,
  renderWelcomeComposerSurface,
} from "../src/tui/composer.js";
import { stripAnsi } from "../src/tui/ansi.js";

test("composer edits at the real cursor instead of appending", () => {
  let state = insertComposerText("ab", 1, "你");
  assert.equal(state.buffer, "a你b");
  assert.equal(state.cursor, 2);

  state = insertComposerText(state.buffer, moveComposerCursorRight(state.buffer, state.cursor), "!");
  assert.equal(state.buffer, "a你b!");
  assert.equal(state.cursor, 4);

  state = backspaceComposer(state.buffer, moveComposerCursorLeft(state.buffer, state.cursor));
  assert.equal(state.buffer, "a你!");
  assert.equal(state.cursor, 2);
});

test("composer supports explicit multiline insertion", () => {
  let state = insertComposerText("", 0, "one");
  state = insertComposerNewline(state.buffer, state.cursor);
  state = insertComposerText(state.buffer, state.cursor, "two");

  assert.equal(state.buffer, "one\ntwo");
  const rendered = renderComposerSurface({
    buffer: state.buffer,
    cursor: state.cursor,
    items: [],
    selected: 0,
    width: 40,
  });
  assert.equal(rendered.cursorLine, 2);
  assert.equal(rendered.cursorColumn, 5);
  assert.equal(rendered.lines.filter((line) => stripAnsi(line).includes("two")).length, 1);
});

test("composer compacts pasted long text while preserving the raw buffer", () => {
  const pasted = `first line\n${"x".repeat(220)}\nlast line`;
  const state = insertComposerPaste("", 0, pasted);

  assert.equal(state.buffer, pasted);
  assert.equal(state.cursor, pasted.length);
  assert.equal(state.compactRange?.label, `[Pasted Content ${[...pasted].length} chars]`);

  const rendered = renderComposerSurface({
    buffer: state.buffer,
    cursor: state.cursor,
    compactRanges: state.compactRange ? [state.compactRange] : [],
    items: [],
    selected: 0,
    width: 80,
  });
  const plain = rendered.lines.map((line) => stripAnsi(line)).join("\n");

  assert.match(plain, /\[Pasted Content \d+ chars\]/);
  assert.doesNotMatch(plain, /first line/);
  assert.doesNotMatch(plain, /last line/);
  const inputLine = plain.split("\n").find((line) => line.includes("[Pasted Content")) ?? "";
  assert.ok(rendered.cursorColumn > inputLine.indexOf("[Pasted Content"));
});

test("composer compacts pasted file and image paths", () => {
  const image = insertComposerPaste("", 0, "/Users/demo/Desktop/screenshot.png");
  const files = insertComposerPaste("", 0, "/Users/demo/a.pdf\n/Users/demo/b.txt");

  assert.equal(image.compactRange?.label, "[Pasted Image path]");
  assert.equal(files.compactRange?.label, "[Pasted Files 2 paths]");

  const rendered = renderComposerSurface({
    buffer: files.buffer,
    cursor: files.cursor,
    compactRanges: files.compactRange ? [files.compactRange] : [],
    items: [],
    selected: 0,
    width: 72,
  });
  const plain = rendered.lines.map((line) => stripAnsi(line)).join("\n");
  assert.match(plain, /\[Pasted Files 2 paths\]/);
  assert.doesNotMatch(plain, /a\.pdf/);
});

test("composer recognizes dragged path lists with spaces, escaping, and file URLs", () => {
  const images = insertComposerPaste("", 0, "/Users/demo/a.png /Users/demo/b.jpg ");
  const escaped = insertComposerPaste("", 0, "/Users/demo/My\\ File.pdf");
  const urls = insertComposerPaste("", 0, "file:///Users/demo/a.pdf file:///Users/demo/b.txt");

  assert.equal(images.compactRange?.label, "[Pasted Images 2 paths]");
  assert.equal(escaped.compactRange?.label, "[Pasted File path]");
  assert.equal(urls.compactRange?.label, "[Pasted Files 2 paths]");
  assert.equal(isComposerPathPaste("/Users/demo/My\\ File.pdf"), true);
  assert.equal(isComposerPathPaste("/not-a-command"), false);
});

test("composer plain paste fallback does not treat Enter as pasted content", () => {
  assert.equal(composerPlainPasteFallback("\r"), undefined);
  assert.equal(composerPlainPasteFallback("\n"), undefined);
  assert.equal(composerPlainPasteFallback("short"), undefined);
  assert.equal(composerPlainPasteFallback("first\nsecond"), "first\nsecond");
  assert.equal(composerPlainPasteFallback("/Users/demo/a.png /Users/demo/b.jpg"), "/Users/demo/a.png /Users/demo/b.jpg");
});

test("composer compact paste ranges can be removed as a single unit", () => {
  const pasted = insertComposerPaste("", 0, "alpha\nbeta\ngamma");
  const range = pasted.compactRange;
  assert.ok(range);
  assert.deepEqual(compactRangeBeforeCursor([range], pasted.cursor), range);

  const nextBuffer = `${pasted.buffer.slice(0, range.start)}${pasted.buffer.slice(range.end)}`;
  const ranges = adjustComposerCompactRanges([range], range.start, range.end, 0);
  assert.equal(nextBuffer, "");
  assert.deepEqual(ranges, []);
});

test("empty composer anchors the terminal cursor before placeholder text", () => {
  const rendered = renderComposerSurface({
    buffer: "",
    cursor: 0,
    items: [],
    selected: 0,
    width: 80,
  });

  assert.equal(rendered.lines.length, 3);
  assert.equal(rendered.cursorLine, 1);
  assert.equal(rendered.cursorColumn, 2);
  assert.match(stripAnsi(rendered.lines[1] ?? ""), /^›  Ask Inferoa/);
});

test("composer renders metadata on the left and active mode on the right", () => {
  const rendered = renderComposerSurface({
    buffer: "",
    cursor: 0,
    items: [],
    selected: 0,
    width: 72,
    metadataLeft: "~/work/inferoa · deepseek-v4-pro-tokenhub · 1M",
    metadataRight: "Plan mode",
  });
  const plain = rendered.lines.map((line) => stripAnsi(line));
  const meta = plain.find((line) => line.includes("deepseek-v4-pro-tokenhub"));

  assert.ok(meta);
  assert.match(meta, /~\/work\/inferoa/);
  assert.match(meta, /Plan mode$/);
  assert.ok(visiblePlainWidth(meta) <= 72);
});

test("composer folds cache footer, path, model, and mode into one metadata line", () => {
  const rendered = renderComposerSurface({
    buffer: "",
    cursor: 0,
    items: [],
    selected: 0,
    width: 132,
    metadataLeft: "\x1b[38;5;75m~/local-workbench/work/vllm/inferoa\x1b[0m \x1b[38;5;238m·\x1b[0m \x1b[38;5;252mdeepseek-v4-pro-tokenhub\x1b[0m",
    metadataRight: "Plan ready",
    footer: "\x1b[38;5;203mprefix cache hit (5.0%)\x1b[0m \x1b[38;5;238m·\x1b[0m \x1b[38;5;244mworked for 5.3s\x1b[0m",
  });
  const plain = rendered.lines.map((line) => stripAnsi(line));
  const metaLines = plain.filter((line) => line.includes("deepseek-v4-pro-tokenhub") || line.includes("prefix cache hit"));
  const rawLine = rendered.lines.find((line) => stripAnsi(line).includes("prefix cache hit (5.0%)")) ?? "";

  assert.equal(metaLines.length, 1);
  assert.match(metaLines[0] ?? "", /prefix cache hit \(5\.0%\) · ~\/local-workbench\/work\/vllm\/inferoa · deepseek-v4-pro-tokenhub · worked for 5\.3s/);
  assert.match(metaLines[0] ?? "", /Plan ready$/);
  assert.match(rawLine, /\x1b\[38;5;75m~\/local-workbench\/work\/vllm\/inferoa/);
  assert.match(rawLine, /\x1b\[38;5;252mdeepseek-v4-pro-tokenhub/);
  assert.match(rawLine, /\x1b\[38;5;244mworked for 5\.3s/);
});

test("composer gives activity and queued prompts balanced space above input", () => {
  const rendered = renderComposerSurface({
    buffer: "",
    cursor: 0,
    items: [],
    selected: 0,
    width: 80,
    activity: "● Working 1m 08s",
    queue: ["queued one", "queued two"],
  });
  const plain = rendered.lines.map((line) => stripAnsi(line));
  const activityIndex = plain.findIndex((line) => line.includes("Working 1m 08s"));
  const queueIndex = plain.findIndex((line) => line.includes("Messages queued after current loop"));
  const inputIndex = plain.findIndex((line) => line.startsWith("›  Ask Inferoa"));

  assert.equal(plain[activityIndex - 1]?.trim(), "");
  assert.equal(plain[activityIndex + 1]?.trim(), "");
  assert.equal(rendered.activityLine, activityIndex);
  assert.equal(stripAnsi(renderComposerActivityLine("● Working 1m 09s", 80)), plain[activityIndex]?.replace("08s", "09s"));
  assert.ok(queueIndex > activityIndex);
  assert.equal(plain[inputIndex - 1]?.trim(), "");
  assert.match(plain.join("\n"), /queued one/);
  assert.match(plain.join("\n"), /queued two/);
});

function visiblePlainWidth(text: string): number {
  return [...text].reduce((width, char) => width + (char.codePointAt(0)! > 0xff ? 2 : 1), 0);
}

test("welcome composer centers Inferoa wordmark and keeps slash and skill affordances", () => {
  const rendered = renderWelcomeComposerSurface({
    buffer: "",
    cursor: 0,
    items: [],
    selected: 0,
    width: 120,
    height: 40,
    workspaceRoot: "/Users/bitliu/local-workbench/work/vllm/inferoa",
    mode: "direct",
    model: "tke/deepseek-v4-pro-tokenhub",
    contextWindow: 1_000_000,
  });
  const plain = rendered.lines.map((line) => stripAnsi(line)).join("\n");

  assert.match(plain, /██████╗  ██████╗  █████╗/);
  assert.match(plain, /Inference-native Tokenmaxxing Agent Harness/);
  assert.doesNotMatch(plain, /vLLM agent/);
  assert.doesNotMatch(plain, /▟▙/);
  assert.match(plain, /Ask Inferoa/);
  assert.match(plain, /\/ commands/);
  assert.match(plain, /\$ skills/);
  assert.match(plain, /deepseek-v4-pro-tokenhub · 1M/);
  assert.doesNotMatch(plain, /\/Users|~\/|\.\.\.\/vllm|inferoa/);
  assert.doesNotMatch(plain, /DS v4/);
  assert.doesNotMatch(rendered.lines.join("\n"), /\x1b\[38;5;214m/);
  assert.match(rendered.lines.join("\n"), /\x1b\[38;5;31m/);
  assert.match(rendered.lines.join("\n"), /\x1b\[38;5;24m/);
  assert.match(rendered.lines.join("\n"), /\x1b\[38;5;252mdeepseek-v4-pro-tokenhub/);
  const metaIndex = rendered.lines.map((line) => stripAnsi(line)).findIndex((line) => line.includes("deepseek-v4-pro-tokenhub"));
  assert.ok(metaIndex > 0);
  assert.equal(stripAnsi(rendered.lines[metaIndex + 1] ?? "").replace("▌", "").trim(), "");
  assert.equal(rendered.cursorLine > 2, true);
  assert.equal(rendered.cursorColumn > 0, true);

  const withSuggestions = renderWelcomeComposerSurface({
    buffer: "/",
    cursor: 1,
    items: [
      { label: "/goal", description: "Start goal mode", kind: "command" },
      { label: "frontend-design", description: "enabled · UI skill", kind: "skill" },
    ],
    selected: 0,
    width: 120,
    height: 40,
    workspaceRoot: "/Users/bitliu/local-workbench/work/vllm/inferoa",
    mode: "direct",
    model: "qwen3-coder",
    contextWindow: 128_000,
  });
  assert.match(withSuggestions.lines.map((line) => stripAnsi(line)).join("\n"), /\/goal/);
});

test("welcome composer can surface compact context engine status", () => {
  const rendered = renderWelcomeComposerSurface({
    buffer: "",
    cursor: 0,
    items: [],
    selected: 0,
    width: 120,
    height: 36,
    workspaceRoot: "/tmp/workspace",
    mode: "direct",
    model: "demo-model",
    contextWindow: 128_000,
    codeIntelligence: "index parsing 4/12",
  });
  const lines = rendered.lines.map((line) => stripAnsi(line));
  const plain = lines.join("\n");
  const inputLine = lines.find((line) => line.includes("Ask Inferoa"));
  const statusLine = lines.find((line) => line.includes("/ commands") && line.includes("index parsing"));
  assert.ok(inputLine);
  assert.ok(statusLine);
  const inputRight = inputLine.length;
  const commandStart = statusLine.indexOf("/ commands");
  const statusStart = statusLine.indexOf("index parsing");

  assert.ok(lines.some((line) => /demo-model · 128k/.test(line) && !/index parsing/.test(line)));
  assert.ok(lines.some((line) => /\/ commands\s+\$ skills\s+index parsing 4\/12/.test(line)));
  assert.ok(commandStart >= 0 && commandStart < statusStart);
  assert.ok(statusStart + "index parsing 4/12".length <= inputRight);
  assert.match(plain, /index parsing 4\/12/);
});

test("welcome composer keeps code intelligence status inside input box edge", () => {
  const rendered = renderWelcomeComposerSurface({
    buffer: "",
    cursor: 0,
    items: [],
    selected: 0,
    width: 120,
    height: 36,
    workspaceRoot: "/tmp/workspace",
    mode: "direct",
    model: "deepseek-v4-pro-tokenhub",
    contextWindow: 1_000_000,
    codeIntelligence: "index parsing 531/4942 with very long status text",
  });
  const lines = rendered.lines.map((line) => stripAnsi(line));
  const inputLine = lines.find((line) => line.includes("Ask Inferoa"));
  const statusLine = lines.find((line) => line.includes("/ commands"));
  assert.ok(inputLine);
  assert.ok(statusLine);

  const inputRight = inputLine.length;
  const commandStart = statusLine.indexOf("/ commands");
  const statusStart = statusLine.indexOf("index parsing");
  assert.ok(commandStart >= 0);
  assert.ok(statusStart > commandStart);
  assert.ok(statusLine.length <= inputRight);
});

test("welcome composer keeps multiline cursor math stable for resize redraws", () => {
  const narrow = renderWelcomeComposerSurface({
    buffer: "first line\nsecond line",
    cursor: "first line\nsecond".length,
    items: [],
    selected: 0,
    width: 72,
    height: 30,
    workspaceRoot: "/tmp/workspace",
    mode: "direct",
    model: "demo",
    contextWindow: 128_000,
  });
  const wide = renderWelcomeComposerSurface({
    buffer: "first line\nsecond line",
    cursor: "first line\nsecond".length,
    items: [],
    selected: 0,
    width: 132,
    height: 30,
    workspaceRoot: "/tmp/workspace",
    mode: "direct",
    model: "demo",
    contextWindow: 128_000,
  });

  assert.ok(narrow.cursorLine > 4);
  assert.ok(wide.cursorLine > 4);
  assert.ok(narrow.cursorColumn > 0);
  assert.ok(wide.cursorColumn > narrow.cursorColumn);
  assert.match(stripAnsi(narrow.lines.join("\n")), /second line/);
  assert.match(stripAnsi(wide.lines.join("\n")), /second line/);
});
