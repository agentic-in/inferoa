import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { SessionStore } from "../src/session/store.js";
import { TuiApp } from "../src/tui/app.js";
import { buildGoalWorkPrompt } from "../src/goals/supervisor-prompts.js";
import { stripAnsi } from "../src/tui/ansi.js";
import { completeGoalReflection, createGoalState, replaceGoalPlanning, writeGoalState } from "../src/goals/state.js";

test("clear starts a clean default session without prompting or rendering creation details", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-clear-session-"));
  const originalStdoutWrite = process.stdout.write;
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_clear_session", root: stateDir, alias: "clear-session" };
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const view = tui as unknown as {
      startFreshSessionFromClear: () => Promise<void>;
      ask: () => Promise<string>;
      renderPanel: (title: string, body: string[]) => void;
      writeHomeFrame: () => void;
      optionalSession: () => { session_id: string } | undefined;
    };
    let asked = false;
    const panels: string[] = [];
    let homeFrames = 0;

    view.ask = async () => {
      asked = true;
      return "custom title";
    };
    view.renderPanel = (title) => {
      panels.push(title);
    };
    view.writeHomeFrame = () => {
      homeFrames += 1;
    };

    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await view.startFreshSessionFromClear();
    } finally {
      process.stdout.write = originalStdoutWrite;
    }

    const sessions = store.listSessions(workspace.id, { includeArchived: true });
    assert.equal(asked, false);
    assert.deepEqual(panels, []);
    assert.equal(homeFrames, 1);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.title, "New session");
    assert.equal(view.optionalSession()?.session_id, sessions[0]?.session_id);
  } finally {
    process.stdout.write = originalStdoutWrite;
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("access command saves a workspace-specific permission override", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-access-session-"));
  const previousStateDir = process.env.INFEROA_STATE_DIR;
  const store = await SessionStore.open(path.join(stateDir, "store"));
  process.env.INFEROA_STATE_DIR = stateDir;
  try {
    const workspace = { id: "w_access_session", root: stateDir, alias: "access-session" };
    const config = structuredClone(DEFAULT_CONFIG);
    const tui = new TuiApp(
      {
        config,
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const view = tui as unknown as {
      renderAccessView: (args: string) => Promise<void>;
      renderPanel: (title: string, body: string[]) => void;
    };
    const panels: Array<{ title: string; body: string[] }> = [];
    view.renderPanel = (title, body) => {
      panels.push({ title, body });
    };

    await view.renderAccessView("ask");

    assert.equal(config.permissions.workspaces?.[workspace.id]?.mode, "ask");
    assert.equal(panels.at(-1)?.title, "Access");
    assert.ok(panels.at(-1)?.body.some((line) => line.includes("Request approval")));
    const text = await readFile(path.join(stateDir, "config.yaml"), "utf8");
    assert.match(text, /workspaces:/);
    assert.match(text, /w_access_session:/);
    assert.match(text, /mode: ask/);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.INFEROA_STATE_DIR;
    } else {
      process.env.INFEROA_STATE_DIR = previousStateDir;
    }
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("doctor view treats Omni as optional and omits release-only AMD checks", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-doctor-view-"));
  const store = await SessionStore.open(stateDir);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    const workspace = { id: "w_doctor_view", root: stateDir, alias: "doctor-view" };
    const tui = new TuiApp(
      {
        config,
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const view = tui as unknown as {
      renderDoctorView: (args: string) => Promise<void>;
      renderPanel: (title: string, body: string[]) => void;
    };
    const panels: Array<{ title: string; body: string[] }> = [];
    view.renderPanel = (title, body) => {
      panels.push({ title, body });
    };

    await view.renderDoctorView("status");

    const latest = panels.at(-1);
    assert.equal(latest?.title, "Doctor");
    const plain = stripAnsi(latest?.body.join("\n") ?? "");
    assert.match(plain, /coding endpoint/);
    assert.match(plain, /Omni Vision understanding .* optional/);
    assert.doesNotMatch(plain, /AMD direct vLLM deployment check/);
    assert.doesNotMatch(plain, /AMD vLLM-Omni deployment check/);
    assert.doesNotMatch(plain, /Final Acceptance/);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("goal continuation queues a hidden foreground prompt instead of a daemon job panel", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-foreground-"));
  const store = await SessionStore.open(stateDir);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.model_setup.base_url = "http://127.0.0.1:9999/v1";
    config.model_setup.model = "foreground-goal-test";
    const workspace = { id: "w_goal_foreground", root: stateDir, alias: "goal-foreground" };
    const tui = new TuiApp(
      {
        config,
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const view = tui as unknown as {
      enqueueGoalContinuation: (objective: string) => Promise<void>;
      optionalSession: () => { session_id: string } | undefined;
      enqueuePrompt: (prompt: string, options?: { renderPrompt?: boolean }) => void;
      renderPanel: (title: string, body: string[]) => void;
    };
    const session = store.createSession(workspace, "goal foreground");
    const queued: Array<{ prompt: string; renderPrompt?: boolean }> = [];
    const panels: string[] = [];

    view.optionalSession = () => session;
    view.enqueuePrompt = (prompt, options = {}) => {
      queued.push({ prompt, renderPrompt: options.renderPrompt });
    };
    view.renderPanel = (title) => {
      panels.push(title);
    };

    await view.enqueueGoalContinuation("deep research on this repo");

    assert.deepEqual(queued, [{ prompt: buildGoalWorkPrompt("deep research on this repo"), renderPrompt: false }]);
    assert.deepEqual(panels, []);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("goal show renders wrapped tree frontiers without repeated command hints", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-show-tree-"));
  const originalStdoutWrite = process.stdout.write;
  const originalColumns = process.stdout.columns;
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_goal_show_tree", root: stateDir, alias: "goal-show-tree" };
    const session = store.createSession(workspace, "goal show tree");
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const view = tui as unknown as {
      renderGoalPanel: (state: ReturnType<typeof createGoalState>) => void;
      renderInlinePanel: (title: string, body: string[]) => void;
      renderPanel: (title: string, body: string[]) => void;
      optionalSession: () => { session_id: string } | undefined;
    };
    const longSummary =
      "Successfully improved the vLLM Semantic Router codebase across all three sub-projects with Python CLI, Go core, and fleet simulator verification completed without truncation.";
    const longReflection =
      "Successfully improved the vLLM Semantic Router codebase across all three sub-projects after reflection, including Python tests passing and release notes prepared without hidden tail text.";
    let goal = replaceGoalPlanning(createGoalState({ objective: "improve codebase" }), {
      summary: "Initial audit and repair frontier",
      steps: [
        { id: "explore_and_audit", title: "Explore codebase and identify concrete improvement areas", status: "completed" },
        { id: "fix_python_issues", title: "Fix Python code quality issues in the vllm-sr CLI", status: "completed" },
      ],
    });
    goal.goal.summary = longSummary;
    writeGoalState(store, session.session_id, goal, "run_frontier_1");
    goal = completeGoalReflection(
      goal,
      {
        decision: "expand",
        summary: longReflection,
        steps: [
          {
            id: "verify_build_and_test_full_suite",
            title: "Verify build and test full suite across all three projects before calling the goal complete",
            status: "in_progress",
          },
        ],
        active_step_id: "verify_build_and_test_full_suite",
      },
      "run_reflection",
    );
    goal.goal.summary = longSummary;
    writeGoalState(store, session.session_id, goal, "run_frontier_2");

    const panels: Array<{ title: string; body: string[] }> = [];
    view.optionalSession = () => session;
    view.renderPanel = (title, body) => {
      panels.push({ title, body });
    };

    process.stdout.columns = 88;
    view.renderGoalPanel(goal);

    const latest = panels.at(-1);
    assert.equal(latest?.title, "Goal");
    const plain = stripAnsi(latest?.body.join("\n") ?? "");
    assert.match(plain, /◇ Frontier 1/);
    assert.match(plain, /◆ Frontier 2 current/);
    assert.match(plain, /├─ x explore_and_audit/);
    assert.match(plain, /└─ \* verify_build_and_test_full_suite/);
    assert.doesNotMatch(plain, /\/goal plan/);
    assert.doesNotMatch(plain, /\/goal complete/);
    assert.match(plain, /fleet simulator verification\s+completed without truncation/);
    assert.match(plain, /release notes\s+prepared without hidden tail text/);

    let inlineOutput = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      inlineOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    view.renderInlinePanel("Goal", latest?.body ?? []);

    const rendered = stripAnsi(inlineOutput);
    assert.doesNotMatch(rendered, /…/);
    assert.match(rendered, /fleet simulator verification\s+completed without truncation/);
    assert.match(rendered, /release notes\s+prepared without hidden tail text/);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stdout.columns = originalColumns;
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("decode activity stays active without per-chunk resume redraws", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-decode-activity-"));
  try {
    const session = {
      session_id: "s_decode_activity",
      workspace_id: "w_decode_activity",
      title: "decode activity",
      status: "idle",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    const activityCalls: string[] = [];
    const transcript: string[] = [];
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace: { id: "w_decode_activity", root: stateDir, alias: "decode-activity" },
        store: { listEvents: () => [] },
        runtime: {
          run: async (options: { onDelta?: (text: string) => void; onStatus?: (event: { type: "model_start"; model: string }) => void }) => {
            options.onStatus?.({ type: "model_start", model: "decode-activity-test" });
            options.onDelta?.("hello\n");
            options.onDelta?.("world\n");
            return {
              session,
              run_id: "run_decode_activity",
              content: "hello\nworld",
              tool_rounds: 0,
              tool_calls: 0,
              duration_ms: 1,
              tokens_used: 1,
              rtk: {
                tool_calls: 0,
                rtk_tool_calls: 0,
                rtk_commands: 0,
                input_tokens: 0,
                output_tokens: 0,
                saved_tokens: 0,
                savings_pct: 0,
                estimated_without_rtk_tokens: 1,
                status: "ok",
              },
            };
          },
        },
      } as never,
    );
    const view = tui as unknown as {
      submitPrompt: (prompt: string, options?: { renderPrompt?: boolean }) => Promise<unknown>;
      waitForCodeIntelligenceBeforeChat: () => Promise<boolean>;
      startActivityIndicator: (label: string) => {
        status: (label: string) => void;
        record: (line: string) => void;
        pauseForOutput: () => void;
        stop: () => void;
      };
      writeTranscript: (text: string) => void;
      latestTurnEvidence: () => Record<string, never>;
      toolSummaryBlock: () => string;
    };

    view.waitForCodeIntelligenceBeforeChat = async () => true;
    view.startActivityIndicator = (label) => {
      activityCalls.push(`start:${stripAnsi(label)}`);
      return {
        status: (next) => activityCalls.push(`status:${stripAnsi(next)}`),
        record: (line) => activityCalls.push(`record:${line}`),
        pauseForOutput: () => activityCalls.push("pause"),
        stop: () => activityCalls.push("stop"),
      };
    };
    view.writeTranscript = (text) => {
      transcript.push(text);
    };
    view.latestTurnEvidence = () => ({});
    view.toolSummaryBlock = () => "";

    await view.submitPrompt("hi", { renderPrompt: false });

    assert.ok(transcript.some((chunk) => chunk.includes("hello")));
    assert.ok(transcript.some((chunk) => chunk.includes("world")));
    assert.deepEqual(activityCalls, [
      "start:Prefill with >_ Inferoa",
      "status:Prefill with >_ Inferoa",
      "status:Decode with >_ Inferoa",
      "stop",
    ]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("suppressed internal reflection renders tool trace without assistant text", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-reflection-tool-trace-"));
  try {
    const session = {
      session_id: "s_reflection_trace",
      workspace_id: "w_reflection_trace",
      title: "reflection trace",
      status: "idle",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    const runId = "run_reflection_trace";
    const toolCallId = "call_reflection_done";
    const events = [
      {
        session_id: session.session_id,
        run_id: runId,
        type: "tool.call",
        created_at: new Date(0).toISOString(),
        data: {
          tool_call_id: toolCallId,
          tool_name: "goal",
          arguments: { op: "reflect", decision: "done" },
        },
      },
      {
        session_id: session.session_id,
        run_id: runId,
        type: "tool.result",
        created_at: new Date(0).toISOString(),
        data: {
          tool_call_id: toolCallId,
          tool_name: "goal",
          result: {
            ok: true,
            summary: "Goal reflection recorded: improve docs wording",
            data: {
              enabled: true,
              goal: {
                id: "goal_reflection_trace",
                objective: "improve docs wording",
                status: "active",
                frontier_generation: 1,
                reflection_status: "completed",
                last_reflection_decision: "done",
              },
            },
          },
        },
      },
    ];
    const transcript: string[] = [];
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace: { id: "w_reflection_trace", root: stateDir, alias: "reflection-trace" },
        store: { listEvents: () => events },
        runtime: {
          run: async (options: {
            onDelta?: (text: string) => void;
            onStatus?: (event: { type: string; [key: string]: unknown }) => void;
          }) => {
            options.onStatus?.({ type: "model_start", model: "reflection-trace-test" });
            options.onDelta?.("hidden reflection assistant text\n");
            options.onStatus?.({
              type: "tool_start",
              session_id: session.session_id,
              run_id: runId,
              tool_name: "goal",
              tool_call_id: toolCallId,
              summary: "Updated goal",
            });
            options.onStatus?.({
              type: "tool_end",
              session_id: session.session_id,
              run_id: runId,
              tool_name: "goal",
              tool_call_id: toolCallId,
              ok: true,
              summary: "Goal reflection recorded: improve docs wording",
              duration_ms: 12,
            });
            return {
              session,
              run_id: runId,
              content: "hidden reflection assistant text",
              tool_rounds: 1,
              tool_calls: 1,
              duration_ms: 1,
              tokens_used: 1,
              rtk: {
                tool_calls: 1,
                rtk_tool_calls: 0,
                rtk_commands: 0,
                input_tokens: 0,
                output_tokens: 0,
                saved_tokens: 0,
                savings_pct: 0,
                estimated_without_rtk_tokens: 1,
                status: "ok",
              },
            };
          },
        },
      } as never,
    );
    const view = tui as unknown as {
      submitPrompt: (
        prompt: string,
        options?: { renderPrompt?: boolean; suppressTranscript?: boolean; requestClass?: string; visibility?: "normal" | "internal" },
      ) => Promise<unknown>;
      waitForCodeIntelligenceBeforeChat: () => Promise<boolean>;
      startActivityIndicator: (label: string) => {
        status: () => void;
        record: () => void;
        pauseForOutput: () => void;
        stop: () => void;
      };
      writeTranscript: (text: string) => void;
    };

    view.waitForCodeIntelligenceBeforeChat = async () => true;
    view.startActivityIndicator = () => ({
      status: () => {},
      record: () => {},
      pauseForOutput: () => {},
      stop: () => {},
    });
    view.writeTranscript = (text) => {
      transcript.push(text);
    };

    await view.submitPrompt("reflection", { renderPrompt: false, suppressTranscript: true, requestClass: "reflection", visibility: "internal" });

    const plain = stripAnsi(transcript.join(""));
    assert.match(plain, /Updated goal/);
    assert.match(plain, /improve docs wording/);
    assert.doesNotMatch(plain, /hidden reflection assistant text/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("goal supervisor completion record wraps summary and includes stats", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-complete-record-"));
  try {
    const transcript: string[] = [];
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace: { id: "w_goal_complete_record", root: stateDir, alias: "goal-complete-record" },
        store: { listEvents: () => [] },
        runtime: {},
      } as never,
    );
    const view = tui as unknown as {
      renderGoalSupervisorRecord: (action: string, detail: Array<{ label: string; text: string; color?: number }>, color: number) => void;
      writeTranscript: (text: string) => void;
    };
    view.writeTranscript = (text) => {
      transcript.push(text);
    };

    view.renderGoalSupervisorRecord(
      "Goal complete",
      [
        {
          label: "summary",
          text: "Improved docs wording across the blog repository with a long completion summary that must wrap instead of disappearing at the terminal edge.",
        },
        {
          label: "stats",
          text: "Goal achieved. 46 loops · 128 tool calls · 8m 59s · 4767746 tokens used.",
        },
      ],
      48,
    );

    const plain = stripAnsi(transcript.join(""));
    assert.match(plain, /Goal complete/);
    assert.match(plain, /summary Improved docs wording/);
    assert.match(plain, /terminal edge/);
    assert.match(plain, /stats Goal achieved\. 46 loops .*128 tool calls .*8m 59s .*4767746 tokens used/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("inline panels sanitize embedded newlines before writing background rows", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-inline-panel-"));
  const originalStdoutWrite = process.stdout.write;
  try {
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace: { id: "w_inline_panel", root: stateDir, alias: "inline-panel" },
        store: { close() {} },
        runtime: {},
      } as never,
    );
    const view = tui as unknown as {
      renderInlinePanel: (title: string, body: string[]) => void;
    };
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;

    view.renderInlinePanel("Goal Supervisor", ["queued goal\nGoal objective: deep research"]);

    const plainLines = stripAnsi(output).split("\n");
    assert.equal(plainLines.length, 5);
    assert.match(plainLines[2] ?? "", /queued goal Goal objective: deep research/);
  } finally {
    process.stdout.write = originalStdoutWrite;
    await rm(stateDir, { recursive: true, force: true });
  }
});
