import test from "node:test";
import assert from "node:assert/strict";
import { cacheTurnKind, renderCacheFooter, renderCacheReportTurn } from "../src/tui/cache-footer.js";
import { stripAnsi } from "../src/tui/ansi.js";

test("cache footer hides unavailable cached-token fields", () => {
  const footer = stripAnsi(renderCacheFooter({
    mode: "direct",
    model: "model",
    usage: { prompt_tokens: 120, completion_tokens: 12 },
    latencyMs: 10_487,
  }));
  assert.doesNotMatch(footer, /prefill 120/);
  assert.doesNotMatch(footer, /decode 12/);
  assert.match(footer, /worked for 10s/);
  assert.doesNotMatch(footer, /mode direct/);
  assert.doesNotMatch(footer, /model model/);
  assert.doesNotMatch(footer, /cached unavailable/);
  assert.doesNotMatch(footer, /hit unavailable/);
  assert.doesNotMatch(footer, /prefill unavailable/);
  assert.doesNotMatch(footer, /decode unavailable/);
  assert.doesNotMatch(footer, /latency/);
});

test("cache footer shows cached-token hit rate when exposed", () => {
  const footer = stripAnsi(renderCacheFooter({
    mode: "direct",
    model: "model",
    usage: { prompt_tokens: 1000, cached_prompt_tokens: 750, completion_tokens: 20 },
  }));
  assert.doesNotMatch(footer, /prefix cache 750/);
  assert.match(footer, /prefix cache hit \(75\.0%\)/);
  assert.doesNotMatch(footer, /^cache hit/);
});

test("cache footer labels first chat turn as prefix cache warmup", () => {
  const rawFooter = renderCacheFooter({
    usage: { prompt_tokens: 1000, cached_prompt_tokens: 50, completion_tokens: 20 },
    latencyMs: 4_320,
    cacheKind: "warmup",
  });
  const footer = stripAnsi(rawFooter);

  assert.match(footer, /prefix cache warmup/);
  assert.doesNotMatch(footer, /prefix cache warmup \(/);
  assert.match(rawFooter, /\x1b\[38;5;48m/);
  assert.doesNotMatch(rawFooter, /\x1b\[38;5;220m/);
  assert.match(footer, /worked for 4\.3s/);
});

test("cache report turn labels warmup separately from steady-state hits", () => {
  assert.equal(stripAnsi(renderCacheReportTurn({
    usage: { prompt_tokens: 1000, cached_prompt_tokens: 50, completion_tokens: 20 },
    cacheKind: "warmup",
  })), "warmup cache hit 5.0%");
  assert.equal(stripAnsi(renderCacheReportTurn({
    usage: { prompt_tokens: 1000, cached_prompt_tokens: 971, completion_tokens: 20 },
    cacheKind: "hit",
  })), "prefix cache hit 97.1%");
});

test("chat cache turn kind treats only the first prompt run as warmup", () => {
  assert.equal(cacheTurnKind([
    { session_id: "s", type: "session.created", data: {} },
    { session_id: "s", run_id: "run_1", type: "user.prompt", data: { prompt: "who are you" } },
    { session_id: "s", run_id: "run_1", type: "model.response.settled", data: {} },
  ], "run_1"), "warmup");

  assert.equal(cacheTurnKind([
    { session_id: "s", run_id: "run_1", type: "user.prompt", data: { prompt: "who are you" } },
    { session_id: "s", run_id: "run_1", type: "model.response.settled", data: {} },
    { session_id: "s", run_id: "run_2", type: "user.prompt", data: { prompt: "continue" } },
  ], "run_2"), "hit");
});
