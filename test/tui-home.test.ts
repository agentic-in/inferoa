import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { renderHomeFrame } from "../src/tui/home.js";
import { stripAnsi, visibleWidth } from "../src/tui/ansi.js";

const workspaceRoot = path.join(os.homedir(), "local-workbench/work/vllm/inferoa");

test("home banner omits border title without recent sessions or tagline", () => {
  const rendered = renderHomeFrame({
    workspaceRoot,
    mode: "direct",
    model: "tke/deepseek-v4-pro-tokenhub",
    width: 120,
  }).join("\n");
  const plain = stripAnsi(rendered);
  const firstLine = plain.split("\n")[0] ?? "";

  assert.match(firstLine, /^╭─+╮$/);
  assert.match(plain, />_ Inferoa/);
  assert.match(plain, /Welcome back!/);
  assert.match(plain, /Inference Optimized Agent Harness/);
  assert.match(plain, /Tips for getting started/);
  assert.match(plain, /vLLM native · tke\/deepseek-v4-pro-tokenhub/);
  assert.match(plain, /\/ commands/);
  assert.match(plain, /\$ skills/);
  assert.match(plain, /Esc interrupt the active loop/);
  assert.doesNotMatch(plain, /Agent inference-native coding/);
  assert.doesNotMatch(plain, /Recent/);
  assert.doesNotMatch(plain, /No recent sessions/);
  assert.doesNotMatch(plain, /\/setup/);
  assert.doesNotMatch(plain, /\/tools/);
  assert.doesNotMatch(plain, /Shortcuts/);
  assert.match(rendered, /\x1b\[38;5;244m~\/local-workbench\/work\/vllm\/inferoa/);
  assert.match(rendered, /\x1b\[38;5;39mtke\/deepseek-v4-pro-tokenhub/);
});

test("home banner contracts to narrow terminal widths", () => {
  const width = 58;
  const rendered = renderHomeFrame({
    workspaceRoot,
    mode: "direct",
    model: "tke/deepseek-v4-pro-tokenhub",
    width,
  });

  assert.ok(rendered.every((line) => visibleWidth(line) <= width));
  const plain = stripAnsi(rendered.join("\n"));
  assert.match(plain.split("\n")[0] ?? "", /^╭─+╮$/);
  assert.match(plain, />_ Inferoa/);
});

test("home banner expands to the resized terminal width", () => {
  const width = 168;
  const rendered = renderHomeFrame({
    workspaceRoot,
    mode: "direct",
    model: "tke/deepseek-v4-pro-tokenhub",
    width,
  });

  assert.ok(rendered.every((line) => visibleWidth(line) === width));
});
