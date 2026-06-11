import test from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, visibleWidth } from "../src/tui/ansi.js";
import { renderTokenmaxxingLines, renderTokenmaxxingRows, renderTokenmaxxingScreen } from "../src/tui/tokenmaxxing-view.js";
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

  assert.match(plain, /saved 1234 .*cache 994 .*rtk 240 .*tokens 300\/1534/);
  assert.doesNotMatch(plain, /model 0|model selection/);
  assert.match(plain, /prefix cache 94\.0% .*994\/1058 .*1\/1 turns/);
  assert.match(plain, /rtk 2 cmds .*io 300->60 .*saved 240 .*tool 80\.0%/);
  assert.match(plain, /turn 2 .*tokens 200\/440 .*actual\/oracle cache 94\.0%\/95\.2% .*cache gap 1\.2% .*tools 3 .*rtk 240/);
  assert.match(lines.join("\n"), /\x1b\[38;5;48m94\.0%\x1b\[0m\/\x1b\[38;5;48m95\.2%\x1b\[0m/);
  assert.match(lines.join("\n"), /\x1b\[38;5;48m1\.2%\x1b\[0m/);
  assert.match(plain, /turn 1 .*tokens 100\/100 .*warm cache 5\.8% .*tools 1/);
  assert.doesNotMatch(plain, /run_2|[{}"]/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 140));
});

test("tokenmaxxing fullscreen uses a quiet surface without zebra striping", () => {
  const events: SessionEvent[] = [
    event("user.prompt", { prompt: "long task" }, "run_1"),
    event("model.response.settled", {
      step_index: 1,
      usage: { prompt_tokens: 1000, cached_prompt_tokens: 0, completion_tokens: 100, total_tokens: 1100 },
      tool_calls: [],
    }, "run_1"),
    event("rtk.tool_savings", {
      step_index: 1,
      tool_call_id: "tool_1",
      rtk_commands: 1,
      input_tokens: 120,
      output_tokens: 20,
      saved_tokens: 100,
      savings_pct: 83.333,
      status: "ok",
    }, "run_1"),
    event("model.response.settled", {
      step_index: 2,
      output: "Changed files:\n- website/docs/workflows/loop-mode.md\n- src/loop/index.ts",
      usage: { prompt_tokens: 1100, cached_prompt_tokens: 900, completion_tokens: 20, total_tokens: 120 },
      tool_calls: [],
    }, "run_1"),
    event("run.completed", { tool_calls: 0, tokens: 1100 }, "run_1"),
  ];
  const rows = renderTokenmaxxingRows(events, [], 120, { detailLimit: Number.POSITIVE_INFINITY });
  const signalRows = renderTokenmaxxingRows(events, [], 220, { activityOnly: true });

  const screen = renderTokenmaxxingScreen(rows, 120, 14, 0);
  const plain = stripAnsi(screen.join("\n"));
  const signalPlain = stripAnsi(signalRows.map((row) => row.text).join("\n"));

  assert.doesNotMatch(screen.join("\n"), /\x1b\[48;5;23[56]m/);
  assert.doesNotMatch(plain, /Recent signals/);
  assert.doesNotMatch(plain, /model 0|model selection/);
  assert.match(signalPlain, /Recent signals/);
  assert.match(signalPlain, /time\s+signal\s+turn\s+tokens\s+cache\s+status\s+detail/);
  assert.match(signalPlain, /model response\s+turn 1\.2\s+p 1100 c 20 t 120\s+cache 81\.8%\s+ok/);
  assert.match(signalPlain, /Changed files:\s+-\s+website\/docs\/workflows\/loop-mode\.md\s+-\s+src\/loop\/index\.ts/);
  assert.doesNotMatch(signalPlain, /usage prompt_tokens|completion_tokens=/);
  assert.ok(signalRows.every((row) => !row.text.includes("\n")));
  assert.equal(renderTokenmaxxingScreen(signalRows, 80, 8, 0).length, 8);
});

test("tokenmaxxing wide summary uses left and right columns", () => {
  const events: SessionEvent[] = [
    event("user.prompt", { prompt: "warmup" }, "run_1"),
    event("run.completed", { tool_calls: 1, tokens: 100 }, "run_1"),
    event("user.prompt", { prompt: "hit" }, "run_2"),
    event("run.completed", { tool_calls: 1, tokens: 100 }, "run_2"),
  ];
  const evidence: JsonObject[] = [
    { run_id: "run_1", prompt_epoch_id: "pe_1", usage: { prompt_tokens: 1000, cached_prompt_tokens: 0 } },
    { run_id: "run_2", prompt_epoch_id: "pe_1", usage: { prompt_tokens: 1100, cached_prompt_tokens: 900 } },
  ];

  const rows = renderTokenmaxxingRows(events, evidence, 220, { detailLimit: Number.POSITIVE_INFINITY });
  const plainRows = rows.map((row) => stripAnsi(row.text));
  const firstSection = plainRows.findIndex((line) => /Recent turns|Run internal turns/.test(line));

  assert.equal(firstSection, -1);
  assert.match(plainRows[0] ?? "", /saved 900 .*tokens 200\/1100\s+prefix cache 81\.8% .*warmup 1/);
  assert.doesNotMatch(plainRows.join("\n"), /tool compress|no rewritten commands/);
});

test("tokenmaxxing screen keeps summary sticky while paging details", () => {
  const body = [
    { kind: "summary" as const, text: "saved 10 · cache 5 · rtk 1 · tokens 100/106" },
    { kind: "turn-header" as const, text: "turn tokens cache gap tools rtk" },
    ...Array.from({ length: 12 }, (_, index) => ({ kind: "turn" as const, text: `turn ${index + 1}` })),
  ];

  const secondPage = stripAnsi(renderTokenmaxxingScreen(body, 80, 8, 1).join("\n"));

  assert.match(secondPage, /saved 10 .*tokens 100\/106/);
  assert.match(secondPage, /turn 5/);
  assert.doesNotMatch(secondPage, /turn 1\n/);
  assert.match(secondPage, /page 2\/3/);
});

test("tokenmaxxing view exposes model-call cache and RTK inside a long run", () => {
  const events: SessionEvent[] = [
    event("user.prompt", { prompt: "long task" }, "run_long"),
    event("model.request.started", { step_id: "step_1", step_index: 1, prompt_epoch_id: "pe_long" }, "run_long"),
    event("model.response.settled", {
      step_id: "step_1",
      step_index: 1,
      prompt_epoch_id: "pe_long",
      usage: { prompt_tokens: 1000, cached_prompt_tokens: 0, completion_tokens: 100, total_tokens: 1100 },
      tool_calls: [{ id: "tool_1", name: "run_command", arguments: {} }],
    }, "run_long"),
    event("rtk.tool_savings", {
      step_id: "step_1",
      step_index: 1,
      tool_call_id: "tool_1",
      rtk_commands: 1,
      input_tokens: 120,
      output_tokens: 20,
      saved_tokens: 100,
      savings_pct: 83.333,
      status: "ok",
    }, "run_long"),
    event("model.request.started", { step_id: "step_2", step_index: 2, prompt_epoch_id: "pe_long" }, "run_long"),
    event("model.response.settled", {
      step_id: "step_2",
      step_index: 2,
      prompt_epoch_id: "pe_long",
      usage: { prompt_tokens: 1100, cached_prompt_tokens: 990, completion_tokens: 30, total_tokens: 130 },
      tool_calls: [],
    }, "run_long"),
    event("run.completed", {
      tool_calls: 1,
      tokens: 1230,
      rtk: {
        tool_calls: 1,
        rtk_tool_calls: 1,
        rtk_commands: 1,
        input_tokens: 120,
        output_tokens: 20,
        saved_tokens: 100,
        savings_pct: 83.333,
        estimated_without_rtk_tokens: 1330,
        status: "ok",
      },
    }, "run_long"),
  ];

  const lines = renderTokenmaxxingLines(events, [], 160, { detailLimit: Number.POSITIVE_INFINITY });
  const plain = stripAnsi(lines.join("\n"));

  assert.match(plain, /saved 1090 .*cache 990 .*rtk 100 .*tokens 1230\/2320/);
  assert.match(plain, /turn 1\.2 .*tokens 130\/130 .*actual\/oracle cache 90\.0%\/90\.9% .*cache gap 0\.9% .*tools 0/);
  assert.match(plain, /turn 1\.1 user .*tokens 1100\/1200 .*warm cache 0\.0% .*tools 1 .*rtk 100/);
  assert.doesNotMatch(plain, /turn 1 .*tokens 1230\/1330/);
  assert.ok(lines.slice(0, 6).every((line) => stripAnsi(line).trim().length > 0));

  const centeredTurn = renderTokenmaxxingRows(events, [], 160, { detailLimit: Number.POSITIVE_INFINITY })
    .map((row) => stripAnsi(row.text))
    .find((line) => line.includes("turn 1.2"));
  assert.match(centeredTurn ?? "", /^\s{2,}turn 1\.2\s{2,}tokens 130\/130/);
});

test("tokenmaxxing fullscreen renderer uses page-only horizontal navigation", () => {
  const body = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  const screen = renderTokenmaxxingScreen(body, 50, 8, 1);
  const plain = stripAnsi(screen.join("\n"));

  assert.equal(screen.length, 8);
  assert.ok(screen.every((line) => visibleWidth(line) <= 50));
  assert.match(plain, /line 7/);
  assert.doesNotMatch(plain, /line 1\n/);
  assert.match(plain, /7-12 \/ 20/);
  assert.match(plain, /page 2\/4/);
  assert.match(plain, /esc exit/);
  assert.match(plain, /←\/→ page/);
  assert.doesNotMatch(plain, /↑\/↓|scroll|g\/G|top\/bottom/);
});

test("tokenmaxxing oracle cache falls back to session previous prompt on a new epoch", () => {
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

  assert.match(plain, /turn 4 .*actual\/oracle cache 89\.2%\/92\.3% .*cache gap 3\.1% .*tools 0/);
  assert.match(plain, /turn 3 .*warm actual\/oracle cache 0\.0%\/100\.0% .*warm gap 100\.0% .*tools 0/);
  assert.doesNotMatch(plain, /turn 3 .*cache warmup/);
  assert.match(plain, /prefix cache 89\.7% .*1570\/1750 .*2\/2 turns .*warmup 2/);
  assert.doesNotMatch(plain, /tool compress .*no rewritten commands/);
});

test("tokenmaxxing shows compact boundaries as epoch rows and signals", () => {
  const events: SessionEvent[] = [
    event("prompt.epoch.created", { prompt_epoch_id: "pe_1", reason: "session-created", tool_schema_hash: "tools_1" }),
    event("user.prompt", { prompt: "first" }, "run_1"),
    event("model.request.started", { step_index: 1, prompt_epoch_id: "pe_1" }, "run_1"),
    event("model.response.settled", {
      step_index: 1,
      prompt_epoch_id: "pe_1",
      usage: { prompt_tokens: 1000, cached_prompt_tokens: 0, completion_tokens: 10, total_tokens: 1010 },
      tool_calls: [],
    }, "run_1"),
    event("endpoint.evidence.recorded", {
      request_class: "compaction",
      request_id: "req_compact",
      prompt_hash: "ph_compact",
      prompt_epoch_id: "pe_1",
      prompt_tokens: 1100,
      cached_prompt_tokens: 1000,
      cache_hit_rate: 0.909,
      model: "compression-test",
    }, "run_compact"),
    event("context.compacted", {
      reason: "threshold",
      summary_strategy: "prefix_query",
      archive_resource_uri: "resource://session/archive-1",
      archived_events: 12,
      protected_tail_events: 3,
    }),
    event("evidence.context_compression", {
      reason: "threshold",
      summary_strategy: "prefix_query",
      epoch_id: "pe_2",
      archive_resource_uri: "resource://session/archive-1",
      archived_events: 12,
      protected_tail_events: 3,
      estimated_tokens: 1200,
      threshold_tokens: 1000,
    }, "run_2"),
    event("prompt.epoch.created", { prompt_epoch_id: "pe_2", reason: "session-or-layout", tool_schema_hash: "tools_1" }),
    event("user.prompt", { prompt: "after compact" }, "run_2"),
    event("model.request.started", { step_index: 1, prompt_epoch_id: "pe_2" }, "run_2"),
    event("model.response.settled", {
      step_index: 1,
      prompt_epoch_id: "pe_2",
      usage: { prompt_tokens: 600, cached_prompt_tokens: 300, completion_tokens: 10, total_tokens: 610 },
      tool_calls: [],
    }, "run_2"),
  ];
  const evidence: JsonObject[] = [
    {
      run_id: "run_compact",
      request_class: "compaction",
      request_id: "req_compact",
      prompt_hash: "ph_compact",
      prompt_epoch_id: "pe_1",
      usage: { prompt_tokens: 1100, cached_prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1140 },
    },
  ];

  const plain = stripAnsi(renderTokenmaxxingLines(events, evidence, 170, { detailLimit: Number.POSITIVE_INFINITY }).join("\n"));
  const signalPlain = stripAnsi(renderTokenmaxxingRows(events, evidence, 190, { activityOnly: true }).map((row) => row.text).join("\n"));

  assert.match(plain, /epoch pe_2 .*compact threshold\/prefix_query .*prefix - .*archived 12 .*protected 3/);
  assert.match(plain, /turn 3\.1 user .*warm actual\/oracle cache 50\.0%\/100\.0% .*warm gap 50\.0%/);
  assert.match(plain, /epoch pe_1 .*session-created .*prefix 90\.9% 1000\/1100/);
  assert.match(plain, /compact .*tokens 1140\/1140 .*actual\/oracle cache 90\.9%\/90\.9% .*cache gap 0\.0% .*tools 0/);
  assert.match(signalPlain, /compact memory .*threshold .*strategy prefix_query .*archived 12 .*protected 3/);
  assert.match(signalPlain, /compact .*est 1200\/1000 .*epoch pe_2 .*threshold .*strategy prefix_query/);
});

test("tokenmaxxing cache gap marks large provider cache gaps in red", () => {
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

  assert.match(plain, /cache gap 45\.5%/);
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
