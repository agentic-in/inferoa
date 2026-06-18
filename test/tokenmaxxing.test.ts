import test from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, visibleWidth } from "../src/tui/ansi.js";
import {
  renderTokenmaxxingLines,
  renderTokenmaxxingRows,
  renderTokenmaxxingScreen,
  renderTokenmaxxingTrendScreen,
  tokenmaxxingTrendPageCount,
} from "../src/tui/tokenmaxxing-view.js";
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
  assert.match(plain, /turn 2 .*tokens 200\/440 .*94\.0%\/95\.2% .*1\.2% .*legacy .*tools 3 .*rtk 240/);
  assert.match(lines.join("\n"), /\x1b\[38;5;48m94\.0%\x1b\[0m\/\x1b\[38;5;48m95\.2%\x1b\[0m/);
  assert.match(lines.join("\n"), /\x1b\[38;5;48m1\.2%\x1b\[0m/);
  assert.match(plain, /turn 1 .*tokens 100\/100 .*warm 5\.8% .*legacy .*tools 1/);
  assert.doesNotMatch(plain, /run_2|[{}"]/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 140));
});

test("tokenmaxxing fullscreen highlights headers and boundaries without zebra striping turns", () => {
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

  assert.match(screen.join("\n"), /\x1b\[48;5;235m/);
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

test("tokenmaxxing signals expose vllm-sr learning route decisions", () => {
  const events: SessionEvent[] = [
    event("model.route.selected", {
      step_index: 2,
      route: {
        "x-vsr-selected-model": "google/gemini-3.1-pro",
        "x-vsr-selected-decision": "domain_code_complex",
        "x-vsr-learning-methods": "session_aware",
        "x-vsr-learning-actions": "session_aware=hard_lock",
        "x-vsr-learning-reasons": "session_aware=hard_lock=tool_loop",
        "x-vsr-learning-scopes": "session_aware=conversation",
        "x-vsr-learning-modes": "session_aware=apply",
      },
    }, "run_1"),
  ];

  const rows = renderTokenmaxxingRows(events, [], 260, { activityOnly: true });
  const plain = stripAnsi(rows.map((row) => row.text).join("\n"));

  assert.match(plain, /route\s+turn 1\.2\s+hard lock\/run\s+tool-loop pinned/);
  assert.match(plain, /action hard lock .*scope run .*reason tool loop .*model google\/gemini-3\.1-pro .*decision domain_code_complex/);
});

test("tokenmaxxing keeps initial learning routes out of the overview", () => {
  const events: SessionEvent[] = [
    event("user.prompt", { prompt: "hi" }, "run_initial"),
    event("model.request.started", { step_id: "step_1", step_index: 1, prompt_epoch_id: "pe_initial", model: "auto" }, "run_initial"),
    event("model.route.selected", {
      step_id: "step_1",
      step_index: 1,
      route: {
        "x-vsr-selected-model": "qwen/qwen3.6-rocm",
        "x-vsr-selected-decision": "simple_general",
        "x-vsr-learning-methods": "session_aware",
        "x-vsr-learning-actions": "session_aware=select",
        "x-vsr-learning-reasons": "session_aware=missing_previous_model",
        "x-vsr-learning-scopes": "session_aware=conversation",
        "x-vsr-learning-modes": "session_aware=apply",
      },
    }, "run_initial"),
    event("model.response.settled", {
      step_id: "step_1",
      step_index: 1,
      prompt_epoch_id: "pe_initial",
      model: "auto",
      route: {
        "x-vsr-selected-model": "qwen/qwen3.6-rocm",
        "x-vsr-selected-decision": "simple_general",
        "x-vsr-learning-methods": "session_aware",
        "x-vsr-learning-actions": "session_aware=select",
        "x-vsr-learning-reasons": "session_aware=missing_previous_model",
        "x-vsr-learning-scopes": "session_aware=conversation",
        "x-vsr-learning-modes": "session_aware=apply",
      },
      usage: { prompt_tokens: 900, cached_prompt_tokens: 0, completion_tokens: 20, total_tokens: 920 },
      tool_calls: [],
    }, "run_initial"),
  ];

  const overview = stripAnsi(renderTokenmaxxingLines(events, [], 180, { detailLimit: Number.POSITIVE_INFINITY }).join("\n"));
  const signals = stripAnsi(renderTokenmaxxingLines(events, [], 220, { activityOnly: true }).join("\n"));

  assert.match(overview, /turn 1\.1\s+user\s+qwen3\.6-rocm\s+tokens 920\/920/);
  assert.doesNotMatch(overview, /initial route|new run\s+tokens/);
  assert.match(signals, /route\s+turn 1\.1\s+new run\s+first route for this run/);
  assert.doesNotMatch(signals, /reason missing previous model/);
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
    { kind: "turn-header" as const, text: "turn event tokens cache gap tools rtk" },
    ...Array.from({ length: 12 }, (_, index) => ({ kind: "turn" as const, text: `turn ${index + 1}` })),
  ];

  const secondPage = stripAnsi(renderTokenmaxxingScreen(body, 80, 8, 1).join("\n"));

  assert.match(secondPage, /saved 10 .*tokens 100\/106/);
  assert.match(secondPage, /turn 5/);
  assert.doesNotMatch(secondPage, /turn 1\n/);
  assert.match(secondPage, /page 2\/3/);
});

test("tokenmaxxing fullscreen title uses theme blue with a bold white provider name", () => {
  const body = [
    { kind: "summary" as const, text: "saved 10 · cache 5 · rtk 1 · tokens 100/106" },
    { kind: "turn" as const, text: "turn 1" },
  ];

  const screen = renderTokenmaxxingScreen(body, 100, 8, 0, { providerName: "OpenAI Codex" });
  const ansi = screen.join("\n");
  const plain = stripAnsi(ansi);

  assert.match(plain, /Tokenmaxxing · OpenAI Codex/);
  assert.doesNotMatch(plain, /run cache/);
  assert.match(ansi, /\x1b\[38;5;39mTokenmaxxing\x1b\[0m/);
  assert.match(ansi, /\x1b\[38;5;252m\x1b\[1mOpenAI Codex\x1b\[0m/);
  assert.doesNotMatch(ansi, /\x1b\[38;5;87m(?:Tokenmaxxing|OpenAI Codex)/);
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
  assert.match(plain, /turn 1\.2 .*tool-loop .*tokens 130\/130 .*90\.0%\/90\.9% .*0\.9% .*legacy .*tools 0/);
  assert.match(plain, /turn 1\.1 .*user .*tokens 1100\/1200 .*warm 0\.0% .*legacy .*tools 1 .*rtk 100/);
  assert.doesNotMatch(plain, /turn 1 .*tokens 1230\/1330/);
  assert.ok(lines.slice(0, 6).every((line) => stripAnsi(line).trim().length > 0));

  const leftAlignedTurn = renderTokenmaxxingRows(events, [], 160, { detailLimit: Number.POSITIVE_INFINITY })
    .map((row) => stripAnsi(row.text))
    .find((line) => line.includes("turn 1.2"));
  assert.match(leftAlignedTurn ?? "", /^turn 1\.2\s+tool-loop\s+-\s+tokens 130\/130/);
});

test("tokenmaxxing marks loop-origin execution prompts and shows model latency columns", () => {
  const events: SessionEvent[] = [
    event("user.prompt", { prompt: "repeat this", request_class: "interactive", visibility: "normal", origin: "loop" }, "run_loop"),
    event("model.request.started", { step_id: "step_1", step_index: 1, prompt_epoch_id: "pe_loop", request_origin: "loop" }, "run_loop"),
    event("model.response.settled", {
      step_id: "step_1",
      step_index: 1,
      prompt_epoch_id: "pe_loop",
      request_origin: "loop",
      duration_ms: 1200,
      ttft_ms: 300,
      usage: { prompt_tokens: 900, cached_prompt_tokens: 810, completion_tokens: 30, total_tokens: 930 },
      tool_calls: [{ id: "tool_1", name: "goal", arguments: {} }],
    }, "run_loop"),
    event("model.request.started", { step_id: "step_2", step_index: 2, prompt_epoch_id: "pe_loop", request_origin: "loop" }, "run_loop"),
    event("model.response.settled", {
      step_id: "step_2",
      step_index: 2,
      prompt_epoch_id: "pe_loop",
      request_origin: "loop",
      usage: { prompt_tokens: 940, cached_prompt_tokens: 880, completion_tokens: 10, total_tokens: 950 },
      tool_calls: [],
    }, "run_loop"),
  ];

  const plain = stripAnsi(renderTokenmaxxingLines(events, [], 220, { detailLimit: Number.POSITIVE_INFINITY }).join("\n"));

  assert.match(plain, /TTFT\s+TPOT\s+Duration/);
  assert.match(plain, /turn 1\.1\s+execution\s+-\s+tokens 930\/930/);
  assert.match(plain, /turn 1\.2\s+tool-loop\s+-\s+tokens 950\/950/);
  assert.match(plain, /300ms\s+30ms\s+1\.2s/);
  assert.doesNotMatch(plain, /turn 1\.1\s+user/);
});

test("tokenmaxxing surfaces model changes in turns and signals", () => {
  const events: SessionEvent[] = [
    event("user.prompt", { prompt: "route with auto model" }, "run_route"),
    event("model.request.started", { step_id: "step_1", step_index: 1, prompt_epoch_id: "pe_route", model: "auto" }, "run_route"),
    event("model.route.selected", {
      step_id: "step_1",
      step_index: 1,
      route: { "x-vsr-selected-model": "qwen/qwen3.6-rocm" },
    }, "run_route"),
    event("model.response.settled", {
      step_id: "step_1",
      step_index: 1,
      prompt_epoch_id: "pe_route",
      model: "auto",
      route: { "x-vsr-selected-model": "qwen/qwen3.6-rocm" },
      usage: { prompt_tokens: 900, cached_prompt_tokens: 0, completion_tokens: 20, total_tokens: 920 },
      tool_calls: [],
    }, "run_route"),
    event("model.request.started", { step_id: "step_2", step_index: 2, prompt_epoch_id: "pe_route", model: "auto" }, "run_route"),
    event("model.route.selected", {
      step_id: "step_2",
      step_index: 2,
      route: {
        "x-vsr-selected-model": "deepseek-v4-pro-tokenhub",
        "x-vsr-learning-methods": "session_aware",
        "x-vsr-learning-actions": "session_aware=switch",
        "x-vsr-learning-reasons": "session_aware=switch_allowed",
        "x-vsr-learning-scopes": "session_aware=conversation",
        "x-vsr-learning-modes": "session_aware=apply",
      },
    }, "run_route"),
    event("model.response.settled", {
      step_id: "step_2",
      step_index: 2,
      prompt_epoch_id: "pe_route",
      model: "auto",
      route: {
        "x-vsr-selected-model": "deepseek-v4-pro-tokenhub",
        "x-vsr-learning-methods": "session_aware",
        "x-vsr-learning-actions": "session_aware=switch",
        "x-vsr-learning-reasons": "session_aware=switch_allowed",
        "x-vsr-learning-scopes": "session_aware=conversation",
        "x-vsr-learning-modes": "session_aware=apply",
      },
      usage: { prompt_tokens: 950, cached_prompt_tokens: 900, completion_tokens: 20, total_tokens: 970 },
      tool_calls: [],
    }, "run_route"),
  ];

  const overview = stripAnsi(renderTokenmaxxingLines(events, [], 220, { detailLimit: Number.POSITIVE_INFINITY }).join("\n"));
  const signals = stripAnsi(renderTokenmaxxingLines(events, [], 220, { activityOnly: true }).join("\n"));

  assert.doesNotMatch(overview, /Model changes/);
  assert.match(overview, /turn 1\.2\s+tool-loop\s+qwen3\.6-rocm -> deepseek-v4-pro .*switch\/run/);
  assert.match(signals, /route\s+turn 1\.2\s+switch\/run\s+model switched .*action switch .*scope run .*reason switch allowed .*model deepseek-v4-pro-tokenhub/);
});

test("tokenmaxxing infers hidden loop execution prompts without origin metadata", () => {
  const events: SessionEvent[] = [
    event(
      "user.prompt",
      {
        prompt: "Loop objective: ship the task\n\nExecution turn for a Deliver loop.\nKeep making concrete progress.",
        request_class: "interactive",
        visibility: "internal",
      },
      "run_loop_hidden",
    ),
    event("model.request.started", { step_id: "step_1", step_index: 1, prompt_epoch_id: "pe_loop" }, "run_loop_hidden"),
    event("model.response.settled", {
      step_id: "step_1",
      step_index: 1,
      prompt_epoch_id: "pe_loop",
      usage: { prompt_tokens: 900, cached_prompt_tokens: 800, completion_tokens: 20, total_tokens: 920 },
      tool_calls: [{ id: "tool_1", name: "read_file", arguments: {} }],
    }, "run_loop_hidden"),
    event("model.request.started", { step_id: "step_2", step_index: 2, prompt_epoch_id: "pe_loop" }, "run_loop_hidden"),
    event("model.response.settled", {
      step_id: "step_2",
      step_index: 2,
      prompt_epoch_id: "pe_loop",
      usage: { prompt_tokens: 940, cached_prompt_tokens: 860, completion_tokens: 20, total_tokens: 960 },
      tool_calls: [],
    }, "run_loop_hidden"),
  ];

  const plain = stripAnsi(renderTokenmaxxingLines(events, [], 220, { detailLimit: Number.POSITIVE_INFINITY }).join("\n"));

  assert.match(plain, /turn 1\.1\s+execution\s+-\s+tokens 920\/920/);
  assert.match(plain, /turn 1\.2\s+tool-loop\s+-\s+tokens 960\/960/);
  assert.doesNotMatch(plain, /turn 1\.1\s+user/);
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

  assert.match(plain, /turn 4 .*89\.2%\/92\.3% .*3\.1% .*legacy .*tools 0/);
  assert.match(plain, /turn 3 .*warm 0\.0%\/100\.0% .*100\.0% .*legacy .*tools 0/);
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
      usage: { prompt_tokens: 1000, cached_prompt_tokens: 600, completion_tokens: 10, total_tokens: 1010 },
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
      estimated_tokens_before: 10000,
      estimated_tokens_after: 1800,
      compressed_tokens: 8200,
      prompt_messages_before: 87,
      prompt_messages_after: 4,
      compressed_messages: 83,
      protected_tail_events: 3,
      preserved_tail_events: 7,
      preserved_rounds: 2,
      preserved_run_anchor_count: 3,
    }),
    event("evidence.context_compression", {
      reason: "threshold",
      summary_strategy: "prefix_query",
      epoch_id: "pe_2",
      archive_resource_uri: "resource://session/archive-1",
      archived_events: 12,
      protected_tail_events: 3,
      preserved_tail_events: 7,
      preserved_rounds: 2,
      preserved_run_anchor_count: 3,
      estimated_tokens: 1200,
      threshold_tokens: 1000,
      estimated_tokens_before: 10000,
      estimated_tokens_after: 1800,
      compressed_tokens: 8200,
      prompt_messages_before: 87,
      prompt_messages_after: 4,
      compressed_messages: 83,
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

  const plain = stripAnsi(renderTokenmaxxingLines(events, evidence, 260, { detailLimit: Number.POSITIVE_INFINITY }).join("\n"));
  const screen = renderTokenmaxxingScreen(renderTokenmaxxingRows(events, evidence, 180, { detailLimit: Number.POSITIVE_INFINITY }), 180, 12, 0);
  const screenPlain = stripAnsi(screen.join("\n"));
  const signalPlain = stripAnsi(renderTokenmaxxingRows(events, evidence, 280, { activityOnly: true }).map((row) => row.text).join("\n"));

  assert.match(plain, /compact .*threshold .*1,100 -> 600 .*saved 500 .*archived 12/);
  assert.doesNotMatch(plain, /epoch pe_2|prefix -|protected 3|preserved 7|rounds 2|anchors 3/);
  assert.match(screen.join("\n"), /\x1b\[48;5;24m/);
  assert.match(screenPlain, /^\s+compact .*threshold .*1,100 -> 600 .*archived 12\s*$/m);
  assert.match(plain, /turn 3\.1 .*user .*warm 50\.0%\/100\.0% .*50\.0%/);
  assert.match(plain, /new epoch .*session start/);
  assert.match(plain, /compact .*compact .*tokens 1140\/1140 .*90\.9%\/90\.9% .*0\.0% .*legacy .*tools 0/);
  assert.match(signalPlain, /compact memory .*threshold .*strategy prefix_query .*messages 87->4 saved 83 .*archived 12 .*protected 3 .*preserved 7 .*rounds 2 .*anchors 3/);
  assert.match(signalPlain, /compact .*est 1200\/1000 .*epoch pe_2 .*threshold .*strategy prefix_query .*messages 87->4 saved 83 .*preserved 7 .*rounds 2 .*anchors 3/);
});

test("tokenmaxxing marks each turn with prefix safety", () => {
  const events: SessionEvent[] = [
    event("user.prompt", { prompt: "warmup" }, "run_1"),
    event("model.request.started", { step_id: "step_1", step_index: 1, prompt_epoch_id: "pe_1", prefix_cache_status: "new_epoch" }, "run_1"),
    event("model.response.settled", {
      step_id: "step_1",
      step_index: 1,
      prompt_epoch_id: "pe_1",
      usage: { prompt_tokens: 1000, cached_prompt_tokens: 0, completion_tokens: 10, total_tokens: 1010 },
      tool_calls: [],
    }, "run_1"),
    event("user.prompt", { prompt: "stable prefix" }, "run_2"),
    event("model.request.started", { step_id: "step_1", step_index: 1, prompt_epoch_id: "pe_1", prefix_cache_status: "safe" }, "run_2"),
    event("model.response.settled", {
      step_id: "step_1",
      step_index: 1,
      prompt_epoch_id: "pe_1",
      usage: { prompt_tokens: 1100, cached_prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1110 },
      tool_calls: [],
    }, "run_2"),
    event("user.prompt", { prompt: "provider cache gap" }, "run_3"),
    event("model.request.started", { step_id: "step_1", step_index: 1, prompt_epoch_id: "pe_1", prefix_cache_status: "changed" }, "run_3"),
    event("model.response.settled", {
      step_id: "step_1",
      step_index: 1,
      prompt_epoch_id: "pe_1",
      usage: { prompt_tokens: 1200, cached_prompt_tokens: 400, completion_tokens: 10, total_tokens: 1210 },
      tool_calls: [],
    }, "run_3"),
  ];

  const plain = stripAnsi(renderTokenmaxxingLines(events, [], 190, { detailLimit: Number.POSITIVE_INFINITY }).join("\n"));

  assert.match(plain, /turn 1\.1 .*user .*new/);
  assert.match(plain, /turn 2\.1 .*user .*0\.0% .*safe/);
  assert.match(plain, /turn 3\.1 .*user .*58\.3% .*break/);
});

test("tokenmaxxing labels hidden reflection starts as decision and tool continuations as tool-loop", () => {
  const events: SessionEvent[] = [
    event("user.prompt", { prompt: "reflect", request_class: "reflection", visibility: "internal" }, "run_reflect"),
    event("model.request.started", {
      step_id: "step_reflect",
      step_index: 1,
      request_class: "reflection",
      visibility: "internal",
      prompt_epoch_id: "pe_1",
      prefix_cache_status: "safe",
    }, "run_reflect"),
    event("model.response.settled", {
      step_id: "step_reflect",
      step_index: 1,
      request_class: "reflection",
      visibility: "internal",
      prompt_epoch_id: "pe_1",
      usage: { prompt_tokens: 1000, cached_prompt_tokens: 900, completion_tokens: 10, total_tokens: 1010 },
      tool_calls: [{ id: "goal_reflect", name: "goal", arguments: { op: "reflect" } }],
    }, "run_reflect"),
    event("model.request.started", {
      step_id: "step_reflect_2",
      step_index: 2,
      request_class: "reflection",
      visibility: "internal",
      prompt_epoch_id: "pe_1",
      prefix_cache_status: "safe",
    }, "run_reflect"),
    event("model.response.settled", {
      step_id: "step_reflect_2",
      step_index: 2,
      request_class: "reflection",
      visibility: "internal",
      prompt_epoch_id: "pe_1",
      usage: { prompt_tokens: 1010, cached_prompt_tokens: 920, completion_tokens: 10, total_tokens: 1020 },
      tool_calls: [],
    }, "run_reflect"),
  ];

  const plain = stripAnsi(renderTokenmaxxingLines(events, [], 160, { detailLimit: Number.POSITIVE_INFINITY }).join("\n"));

  assert.match(plain, /turn 1\.1 .*decision .*safe/);
  assert.match(plain, /turn 1\.2 .*tool-loop .*safe/);
  assert.doesNotMatch(plain, /turn 1\.1 .*user/);
  assert.doesNotMatch(plain, /decision-loop/);
});

test("tokenmaxxing shows compact failure and breaker lifecycle signals", () => {
  const events: SessionEvent[] = [
    event("context.compaction.failed", {
      trigger: "auto",
      reason: "threshold",
      prompt_epoch_id: "pe_1",
      soft: true,
      consecutive_failures: 1,
      failure_limit: 2,
      attempted_summary_strategies: ["prefix_query", "standalone_payload", "trimmed_standalone"],
      failed_summary_strategies: ["prefix_query", "standalone_payload", "trimmed_standalone"],
      model_summary_failed: true,
    }, "run_1"),
    event("context.compaction.auto_paused", {
      reason: "auto-failure-circuit-breaker",
      consecutive_failures: 2,
      failure_limit: 2,
      manual_compact_allowed: true,
    }, "run_2"),
    event("context.compaction.skipped", {
      skipped_reason: "auto-failure-circuit-breaker",
      reason: "threshold",
      prompt_epoch_id: "pe_2",
      estimated_tokens: 99_000,
      threshold_tokens: 80_000,
    }, "run_3"),
  ];

  const plain = stripAnsi(renderTokenmaxxingRows(events, [], 220, { activityOnly: true }).map((row) => row.text).join("\n"));

  assert.match(plain, /compact fail .*epoch pe_1 .*threshold .*model fallback .*1\/2 .*failed prefix_query->standalone_payload->trimmed_standalone/);
  assert.match(plain, /compact paused .*breaker .*failures 2\/2 .*manual \/compact allowed/);
  assert.match(plain, /compact skipped .*est 99000\/80000 .*epoch pe_2 .*auto-fail.*threshold/);
});

test("tokenmaxxing trend renders fullscreen coordinate charts without tables", () => {
  const events: SessionEvent[] = [
    event("prompt.epoch.created", { prompt_epoch_id: "pe_1", reason: "session-created" }),
    event("user.prompt", { prompt: "warmup" }, "run_1"),
    event("model.request.started", { step_id: "step_1", step_index: 1, prompt_epoch_id: "pe_1", prefix_cache_status: "new_epoch" }, "run_1"),
    event("model.response.settled", {
      step_id: "step_1",
      step_index: 1,
      prompt_epoch_id: "pe_1",
      usage: { prompt_tokens: 1000, cached_prompt_tokens: 0, completion_tokens: 10, total_tokens: 1010 },
      tool_calls: [{ id: "tool_1", name: "run_command", arguments: {} }],
    }, "run_1"),
    event("rtk.tool_savings", {
      step_id: "step_1",
      step_index: 1,
      rtk_commands: 1,
      input_tokens: 200,
      output_tokens: 50,
      saved_tokens: 150,
      status: "ok",
    }, "run_1"),
    event("model.request.started", { step_id: "step_2", step_index: 2, prompt_epoch_id: "pe_1", prefix_cache_status: "safe" }, "run_1"),
    event("model.response.settled", {
      step_id: "step_2",
      step_index: 2,
      prompt_epoch_id: "pe_1",
      usage: { prompt_tokens: 1200, cached_prompt_tokens: 900, completion_tokens: 20, total_tokens: 1220 },
      tool_calls: [],
    }, "run_1"),
    event("context.compacted", { reason: "manual", summary_strategy: "prefix_query" }),
    event("evidence.context_compression", {
      reason: "manual",
      epoch_id: "pe_2",
      summary_strategy: "prefix_query",
      archived_events: 10,
      prompt_messages_before: 12,
      prompt_messages_after: 4,
      compressed_messages: 8,
    }, "run_2"),
    event("prompt.epoch.created", { prompt_epoch_id: "pe_2", reason: "session-or-layout" }),
    event("model.request.started", { step_id: "step_1", step_index: 1, prompt_epoch_id: "pe_2", prefix_cache_status: "new_epoch" }, "run_2"),
    event("model.response.settled", {
      step_id: "step_1",
      step_index: 1,
      prompt_epoch_id: "pe_2",
      usage: { prompt_tokens: 700, cached_prompt_tokens: 500, completion_tokens: 10, total_tokens: 710 },
      tool_calls: [],
    }, "run_2"),
  ];
  const evidence: JsonObject[] = [
    {
      run_id: "run_compact",
      request_class: "compaction",
      prompt_epoch_id: "pe_1",
      usage: { prompt_tokens: 1500, cached_prompt_tokens: 1000, total_tokens: 1510 },
    },
  ];

  assert.equal(tokenmaxxingTrendPageCount(), 6);
  const overview = stripAnsi(renderTokenmaxxingTrendScreen(events, evidence, 140, 16, 0).join("\n"));
  const cache = stripAnsi(renderTokenmaxxingTrendScreen(events, evidence, 140, 16, 1).join("\n"));
  const prefix = stripAnsi(renderTokenmaxxingTrendScreen(events, evidence, 140, 16, 2).join("\n"));
  const rtkTools = stripAnsi(renderTokenmaxxingTrendScreen(events, evidence, 140, 16, 4).join("\n"));
  const compact = stripAnsi(renderTokenmaxxingTrendScreen(events, evidence, 140, 16, 5).join("\n"));

  assert.match(overview, /Tokenmaxxing trend .*overview/);
  assert.match(overview, /┌[─┄]+/);
  assert.match(overview, /│/);
  assert.match(overview, /└/);
  assert.match(overview, /plot prompt tokens/);
  assert.match(overview, /summary .*total tokens.*cache hit/);
  assert.doesNotMatch(overview, /relative trend/);
  assert.doesNotMatch(overview, /◆/);
  assert.doesNotMatch(overview, /turn\s+event\s+cache\s+gap\s+prefix\s+tokens/);
  assert.match(cache, /Tokenmaxxing trend .*cache/);
  assert.match(cache, /plot actual hit/);
  assert.match(cache, /summary .*oracle hit.*cache gap/);
  assert.match(cache, /^75\.0%\s+[┌│]/m);
  assert.doesNotMatch(cache, /^100\.0%\s+[┌│]/m);
  assert.match(cache, /┄/);
  assert.doesNotMatch(cache, /◆/);
  assert.doesNotMatch(cache, /[╱╲]/);
  assert.doesNotMatch(cache, /╌/);
  assert.match(prefix, /Tokenmaxxing trend .*prefix/);
  assert.match(prefix, /plot safe rate/);
  assert.match(prefix, /summary .*cache gap/);
  assert.match(prefix, /^100\.0%\s+[┌│]/m);
  assert.match(prefix, /┄/);
  assert.doesNotMatch(prefix, /◆/);
  assert.doesNotMatch(prefix, /break rate/);
  assert.doesNotMatch(prefix, /[╱╲]/);
  assert.doesNotMatch(prefix, /╌/);
  assert.doesNotMatch(prefix, /sequence/);
  assert.match(rtkTools, /Tokenmaxxing trend .*rtk-tools/);
  assert.match(rtkTools, /plot rtk saved/);
  assert.match(rtkTools, /summary .*tool calls.*without rtk/);
  assert.doesNotMatch(rtkTools, /[╱╲]/);
  assert.doesNotMatch(rtkTools, /╌/);
  assert.match(compact, /Tokenmaxxing trend .*compact/);
  assert.match(compact, /plot tokens before/);
  assert.match(compact, /summary .*tokens after.*messages saved/);
  assert.doesNotMatch(compact, /◆/);
  assert.doesNotMatch(compact, /epoch\s+reason\s+tokens\s+messages\s+archive/);
  assert.equal(overview.split("\n").length, 16);
  assert.equal(prefix.split("\n").length, 16);
  assert.equal(compact.split("\n").length, 16);
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

  assert.match(plain, /45\.5%/);
  assert.match(lines.join("\n"), /\x1b\[38;5;203m45\.5%\x1b\[0m\/\x1b\[38;5;203m90\.9%\x1b\[0m/);
  assert.match(lines.join("\n"), /\x1b\[38;5;203m45\.5%\x1b\[0m/);
});

test("tokenmaxxing cache A/O color follows the provider cache gap instead of absolute hit rate", () => {
  const events: SessionEvent[] = [
    event("user.prompt", { prompt: "warmup" }, "run_1"),
    event("run.completed", { tool_calls: 0, tokens: 100 }, "run_1"),
    event("user.prompt", { prompt: "provider cache capped" }, "run_2"),
    event("run.completed", { tool_calls: 0, tokens: 100 }, "run_2"),
  ];
  const evidence: JsonObject[] = [
    { run_id: "run_1", prompt_epoch_id: "pe_1", usage: { prompt_tokens: 500, cached_prompt_tokens: 0 } },
    { run_id: "run_2", prompt_epoch_id: "pe_1", usage: { prompt_tokens: 1000, cached_prompt_tokens: 500 } },
  ];

  const lines = renderTokenmaxxingLines(events, evidence, 160);
  const ansi = lines.join("\n");
  const plain = stripAnsi(ansi);

  assert.match(plain, /50\.0%\/50\.0% .*0\.0%/);
  assert.match(ansi, /\x1b\[38;5;48m50\.0%\x1b\[0m\/\x1b\[38;5;48m50\.0%\x1b\[0m/);
  assert.match(ansi, /\x1b\[38;5;48m0\.0%\x1b\[0m/);
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
