import test from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, visibleWidth } from "../src/tui/ansi.js";
import { renderTokenmaxxingLines } from "../src/tui/tokenmaxxing-view.js";
import type { JsonObject, SessionEvent } from "../src/types.js";

test("tokenmaxxing view combines prefix cache, RTK, and recent turn signal", () => {
  const events: SessionEvent[] = [
    event("user.prompt", { prompt: "warm up" }, "run_1"),
    event("run.completed", {
      tool_calls: 1,
      tokens: 100,
      rtk: {
        tool_calls: 1,
        rtk_tool_calls: 0,
        rtk_commands: 0,
        input_tokens: 0,
        output_tokens: 0,
        saved_tokens: 0,
        savings_pct: 0,
        estimated_without_rtk_tokens: 100,
        status: "ok",
      },
    }, "run_1"),
    event("user.prompt", { prompt: "real work" }, "run_2"),
    event("run.completed", {
      tool_calls: 3,
      tokens: 200,
      rtk: {
        tool_calls: 3,
        rtk_tool_calls: 2,
        rtk_commands: 2,
        input_tokens: 300,
        output_tokens: 60,
        saved_tokens: 240,
        savings_pct: 80,
        estimated_without_rtk_tokens: 440,
        status: "ok",
      },
    }, "run_2"),
    event("endpoint.evidence.recorded", {
      run_id: "run_2",
      prompt_tokens: 1000,
      cached_prompt_tokens: 971,
      cache_hit_rate: 0.971,
      model: "demo-model",
    }, "run_2"),
  ];
  const evidence: JsonObject[] = [
    { run_id: "run_1", prompt_epoch_id: "pe_1", usage: { prompt_tokens: 1007, cached_prompt_tokens: 58 } },
    { run_id: "run_2", prompt_epoch_id: "pe_1", usage: { prompt_tokens: 1058, cached_prompt_tokens: 994 } },
  ];

  const lines = renderTokenmaxxingLines(events, evidence, 140);
  const plain = stripAnsi(lines.join("\n"));

  assert.match(plain, /Tokenmaxxing/);
  assert.match(plain, /saved 1234 .*cache 994 .*rtk 240 .*model 0 .*tokens 300\/1534/);
  assert.match(plain, /prefix cache 94\.0% .*cached 994\/1058 .*1\/1 turns/);
  assert.match(plain, /rtk 2 cmds .*io 300->60 .*saved 240 .*tool 80\.0%/);
  assert.match(plain, /model selection .*cost compute rates pending/);
  assert.match(plain, /turn 2 .*tokens 200\/440 .*actual\/oracle cache 94\.0%\/95\.2% .*cache diff 1\.2% .*rtk 240 .*tools 3/);
  assert.match(lines.join("\n"), /\x1b\[38;5;48m94\.0%\x1b\[0m\/\x1b\[38;5;48m95\.2%\x1b\[0m/);
  assert.match(lines.join("\n"), /\x1b\[38;5;48m1\.2%\x1b\[0m/);
  assert.match(plain, /turn 1 .*tokens 100\/100 .*cache warmup .*tools 1/);
  assert.doesNotMatch(plain, /run_2|[{}"]/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 140));
});

test("tokenmaxxing oracle cache resets when a new prompt epoch starts", () => {
  const events: SessionEvent[] = [
    event("user.prompt", { prompt: "first epoch warmup" }, "run_1"),
    event("run.completed", { tool_calls: 0, tokens: 100 }, "run_1"),
    event("user.prompt", { prompt: "first epoch hit" }, "run_2"),
    event("run.completed", { tool_calls: 0, tokens: 100 }, "run_2"),
    event("evidence.context_compression", { epoch_id: "pe_2" }, "run_3"),
    event("user.prompt", { prompt: "compressed epoch warmup" }, "run_3"),
    event("run.completed", { tool_calls: 0, tokens: 100 }, "run_3"),
    event("user.prompt", { prompt: "compressed epoch hit" }, "run_4"),
    event("run.completed", { tool_calls: 0, tokens: 100 }, "run_4"),
  ];
  const evidence: JsonObject[] = [
    { run_id: "run_1", prompt_epoch_id: "pe_1", usage: { prompt_tokens: 1000, cached_prompt_tokens: 0 } },
    { run_id: "run_2", prompt_epoch_id: "pe_1", usage: { prompt_tokens: 1100, cached_prompt_tokens: 990 } },
    { run_id: "run_3", prompt_epoch_id: "pe_2", usage: { prompt_tokens: 600, cached_prompt_tokens: 0 } },
    { run_id: "run_4", prompt_epoch_id: "pe_2", usage: { prompt_tokens: 650, cached_prompt_tokens: 580 } },
  ];

  const plain = stripAnsi(renderTokenmaxxingLines(events, evidence, 160).join("\n"));

  assert.match(plain, /turn 4 .*actual\/oracle cache 89\.2%\/92\.3% .*cache diff 3\.1% .*tools 0/);
  assert.match(plain, /turn 3 .*cache warmup .*tools 0/);
  assert.match(plain, /prefix cache 89\.7% .*cached 1570\/1750 .*2\/2 turns .*warmup 2/);
  assert.match(plain, /tool compress .*no rewritten commands/);
});

test("tokenmaxxing cache diff marks large provider cache gaps in red", () => {
  const events: SessionEvent[] = [
    event("user.prompt", { prompt: "warmup" }, "run_1"),
    event("run.completed", { tool_calls: 0, tokens: 100 }, "run_1"),
    event("user.prompt", { prompt: "provider cache degraded" }, "run_2"),
    event("run.completed", { tool_calls: 0, tokens: 100 }, "run_2"),
  ];
  const evidence: JsonObject[] = [
    { run_id: "run_1", prompt_epoch_id: "pe_1", usage: { prompt_tokens: 1000, cached_prompt_tokens: 0 } },
    { run_id: "run_2", prompt_epoch_id: "pe_1", usage: { prompt_tokens: 1100, cached_prompt_tokens: 500 } },
  ];

  const lines = renderTokenmaxxingLines(events, evidence, 160);
  const plain = stripAnsi(lines.join("\n"));

  assert.match(plain, /cache diff 45\.5%/);
  assert.match(lines.join("\n"), /\x1b\[38;5;203m45\.5%\x1b\[0m\/\x1b\[38;5;48m90\.9%\x1b\[0m/);
  assert.match(lines.join("\n"), /\x1b\[38;5;203m45\.5%\x1b\[0m/);
});

function event(type: string, data: SessionEvent["data"], runId?: string): SessionEvent {
  return {
    session_id: "session",
    run_id: runId,
    type,
    data,
    created_at: "2026-06-09T08:09:10.000Z",
  };
}
