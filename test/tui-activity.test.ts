import test from "node:test";
import assert from "node:assert/strict";
import { inferoaActivityLabel, renderActivityLine, renderActivityRecordLine } from "../src/tui/activity.js";
import { stripAnsi, visibleWidth } from "../src/tui/ansi.js";

test("activity line uses only neutral white/gray text animation", () => {
  const first = renderActivityLine("Decode with Inferoa", 10_487, 0, 80);
  const later = renderActivityLine("Decode with Inferoa", 10_487, 4, 80);
  const neutralCodes = new Set(["244", "248", "250", "251", "252", "253", "254", "255"]);
  const colorCodes = [...`${first}${later}`.matchAll(/\x1b\[38;5;(\d+)m/g)].map((match) => match[1]!);

  assert.match(stripAnsi(first), /^[·•] Decode with Inferoa 10s$/);
  assert.doesNotMatch(stripAnsi(first), /deepseek|tokenhub|tke\//i);
  assert.notEqual(stripAnsi(first), stripAnsi(later));
  assert.notEqual(first, later);
  assert.ok(colorCodes.length > 0);
  assert.deepEqual(colorCodes.filter((code) => !neutralCodes.has(code)), []);
});

test("activity line uses distinct minimal motion for model, goal, tool, retry, and compression phases", () => {
  const thinking = stripAnsi(renderActivityLine("Decode with Inferoa", 1200, 1, 80));
  const goal = stripAnsi(renderActivityLine("Completing goal", 1200, 1, 80));
  const reflection = stripAnsi(renderActivityLine("Reflecting goal frontier", 1200, 1, 80));
  const tool = stripAnsi(renderActivityLine("Reading src/runtime.ts", 1200, 1, 80));
  const retry = stripAnsi(renderActivityLine("Retrying model in 1s", 1200, 1, 80));
  const compact = stripAnsi(renderActivityLine("Compressing context 200/100 tokens", 1200, 1, 80));
  const research = stripAnsi(renderActivityLine("Running autoresearch benchmark", 1200, 1, 80));

  assert.match(thinking, /^• Decode with Inferoa 1\.2s$/);
  assert.match(goal, /^· Completing goal 1\.2s$/);
  assert.match(reflection, /^◒ Reflecting goal frontier 1\.2s$/);
  assert.match(tool, /^· Reading src\/runtime\.ts 1\.2s$/);
  assert.match(retry, /^↺ Retrying model in 1s 1\.2s$/);
  assert.match(compact, /^▰ Compressing context 200\/100 tokens 1\.2s$/);
  assert.match(research, /^› Running autoresearch benchmark 1\.2s$/);
});

test("reflection activity uses a distinct focused accent", () => {
  const first = renderActivityLine("Reflecting goal frontier", 1200, 0, 80);
  const later = renderActivityLine("Reflecting goal frontier", 1200, 2, 80);

  assert.match(stripAnsi(first), /^◐ Reflecting goal frontier 1\.2s$/);
  assert.match(stripAnsi(later), /^◑ Reflecting goal frontier 1\.2s$/);
  assert.match(`${first}${later}`, /\x1b\[38;5;111m[^\x1b]+\x1b\[0m/);
});

test("Inferoa activity labels use the banner wordmark styling", () => {
  const line = renderActivityLine(inferoaActivityLabel("Decode"), 1200, 1, 80);

  assert.match(stripAnsi(line), /^• Decode with >_ Inferoa 1\.2s$/);
  assert.match(line, /\x1b\[38;5;244m>_\x1b\[0m/);
  assert.match(line, /\x1b\[38;5;252mInfer\x1b\[0m/);
  assert.match(line, /\x1b\[38;5;75moa\x1b\[0m/);
});

test("activity line stays within resized terminal width", () => {
  const narrow = renderActivityLine("Running autoresearch benchmark with a very long detail", 12_000, 2, 18);
  const tiny = renderActivityLine("Decode with a very long label", 12_000, 2, 6);

  assert.ok(visibleWidth(narrow) <= 18);
  assert.ok(visibleWidth(tiny) <= 6);
  assert.match(stripAnsi(narrow), /^› .*12s$/);
});

test("activity record line keeps completion details within resized width", () => {
  const wide = renderActivityRecordLine({
    marker: "•",
    markerColor: 48,
    action: "Ran experiment",
    actionColor: 75,
    detail: "Run 12 timed out after collecting a long benchmark trace with many metrics",
    suffix: "1.4s",
    width: 88,
  });
  const narrow = renderActivityRecordLine({
    marker: "×",
    markerColor: 203,
    action: "Ran experiment failed",
    actionColor: 203,
    detail: "Run 12 timed out after collecting a long benchmark trace with many metrics",
    suffix: "1.4s",
    width: 28,
  });
  const tiny = renderActivityRecordLine({
    marker: "•",
    markerColor: 75,
    action: "Compacted context",
    actionColor: 75,
    detail: "140 archived · 3 prompts kept · 120000/100000 tokens · 120%",
    width: 12,
  });

  assert.ok(visibleWidth(wide) <= 88);
  assert.ok(visibleWidth(narrow) <= 28);
  assert.ok(visibleWidth(tiny) <= 12);
  assert.match(stripAnsi(wide), /Ran experiment · Run 12 timed out/);
  assert.match(stripAnsi(narrow), /1\.4s$/);
});
