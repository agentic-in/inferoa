import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { SessionStore } from "../src/session/store.js";
import { selfImproveLearnLines, TuiApp } from "../src/tui/app.js";
import { buildGoalWorkPrompt } from "../src/goals/supervisor-prompts.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { stripAnsi } from "../src/tui/ansi.js";
import { createExperiment, logPendingRun, recordRun, writeAutoresearchState } from "../src/autoresearch/state.js";
import {
  completeGoalAfterReflection,
  completeGoalReflection,
  createGoalState,
  readGoalState,
  replaceGoalPlanning,
  stageGoalReviewDecision,
  writeGoalState,
} from "../src/goals/state.js";
import { optLitePropose, type OptLiteLearnReport, type OptReplayStatus } from "../src/opt/opt-lite.js";

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

test("doctor tools queues an in-session built-in tool regression prompt", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-doctor-tools-"));
  const store = await SessionStore.open(stateDir);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    const workspace = { id: "w_doctor_tools", root: stateDir, alias: "doctor-tools" };
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
      renderLoopTranscriptPanel: (title: string, lines: string[]) => void;
      enqueuePrompt: (prompt: string, options?: { renderPrompt?: boolean }) => void;
    };
    const panels: Array<{ title: string; lines: string[] }> = [];
    const queued: Array<{ prompt: string; options?: { renderPrompt?: boolean } }> = [];
    view.renderLoopTranscriptPanel = (title, lines) => {
      panels.push({ title, lines });
    };
    view.enqueuePrompt = (prompt, options) => {
      queued.push({ prompt, options });
    };

    await view.renderDoctorView("tools");

    assert.equal(panels.at(-1)?.title, "Doctor Tools");
    assert.match(stripAnsi(panels.at(-1)?.lines.join("\n") ?? ""), /queued built-in tool regression/i);
    assert.equal(queued.length, 1);
    assert.match(queued[0]?.prompt ?? "", /Run a built-in tools regression/);
    assert.match(queued[0]?.prompt ?? "", /Required final report/);
    assert.equal(queued[0]?.options?.renderPrompt, false);
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

test("composer metadata reuses mode state while session events are unchanged", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-composer-metadata-cache-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_composer_metadata_cache", root: stateDir, alias: "composer-metadata-cache" };
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
      createModeSession: (title: string) => { session_id: string };
      composerMetadataRight: () => string | undefined;
    };
    const session = view.createModeSession("goal metadata cache");
    writeGoalState(store, session.session_id, createGoalState({ objective: "improve codebase quality" }), "run_goal");
    const originalListEvents = store.listEvents.bind(store);
    const originalLatestEventId = store.latestEventId.bind(store);
    let listEventsCalls = 0;
    let latestEventIdCalls = 0;
    (store as unknown as { listEvents: typeof store.listEvents }).listEvents = ((sessionId: string, limit?: number) => {
      listEventsCalls += 1;
      return originalListEvents(sessionId, limit);
    }) as typeof store.listEvents;
    (store as unknown as { latestEventId: typeof store.latestEventId }).latestEventId = ((sessionId: string) => {
      latestEventIdCalls += 1;
      return originalLatestEventId(sessionId);
    }) as typeof store.latestEventId;

    const first = view.composerMetadataRight();
    const callsAfterFirst = listEventsCalls;
    const latestCallsAfterFirst = latestEventIdCalls;
    const second = view.composerMetadataRight();
    store.appendEvent({ session_id: session.session_id, type: "session.note", data: { note: "changed" } });
    const third = view.composerMetadataRight();

    assert.ok(first);
    assert.equal(second, first);
    assert.equal(callsAfterFirst, 0);
    assert.equal(listEventsCalls, 0);
    assert.equal(latestCallsAfterFirst, 1);
    assert.equal(latestEventIdCalls, 1);
    assert.equal(third, first);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("composer metadata does not scan long session history while typing", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-composer-long-session-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_composer_long_session", root: stateDir, alias: "composer-long-session" };
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
      createModeSession: (title: string) => { session_id: string };
      composerMetadataRight: () => string | undefined;
    };
    const session = view.createModeSession("long session metadata");
    writeGoalState(store, session.session_id, createGoalState({ objective: "keep tui responsive for days" }), "run_goal");
    for (let index = 0; index < 1000; index += 1) {
      store.appendEvent({
        session_id: session.session_id,
        run_id: `run_${index}`,
        type: "model.response.settled",
        data: { usage: { total_tokens: index } },
      });
    }
    const originalListEvents = store.listEvents.bind(store);
    let listEventsCalls = 0;
    (store as unknown as { listEvents: typeof store.listEvents }).listEvents = ((sessionId: string, limit?: number) => {
      listEventsCalls += 1;
      return originalListEvents(sessionId, limit);
    }) as typeof store.listEvents;

    const rendered = view.composerMetadataRight();

    assert.ok(rendered);
    assert.equal(listEventsCalls, 0);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("bare loop command asks objective before goal type and approach setup", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-setup-order-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_goal_setup_order", root: stateDir, alias: "goal-setup-order" };
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const session = store.createSession(workspace, "goal setup order");
    const calls: string[] = [];
    const view = tui as unknown as {
      renderLoopControlView: (args: string) => Promise<void>;
      optionalSession: () => { session_id: string } | undefined;
      createModeSession: (title: string) => { session_id: string };
      chooseGoalSetup: () => Promise<object>;
      askModeObjective: (label: string) => Promise<string>;
      startGoal: (session: { session_id: string }, objective: string, options?: object) => Promise<void>;
    };
    view.optionalSession = () => undefined;
    view.createModeSession = () => session;
    view.chooseGoalSetup = async () => {
      calls.push("setup");
      return {};
    };
    view.askModeObjective = async () => {
      calls.push("objective");
      return "Improve codebase";
    };
    view.startGoal = async (_session, objective) => {
      calls.push(`start:${objective}`);
    };

    await view.renderLoopControlView("");

    assert.deepEqual(calls, ["objective", "setup", "start:Improve codebase"]);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("bare loop command with objective still walks goal setup steps", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-objective-setup-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_loop_objective_setup", root: stateDir, alias: "loop-objective-setup" };
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const session = store.createSession(workspace, "loop objective setup");
    const calls: Array<string | { objective: string; options?: { kind?: string; strategy?: { mode?: string }; hil_policy?: string } }> = [];
    const view = tui as unknown as {
      renderLoopControlView: (args: string) => Promise<void>;
      optionalSession: () => { session_id: string } | undefined;
      createModeSession: (title: string) => { session_id: string };
      chooseGoalSetup: () => Promise<{ kind?: string; strategy?: { mode?: string }; hil_policy?: string }>;
      askModeObjective: (label: string) => Promise<string>;
      startGoal: (session: { session_id: string }, objective: string, options?: { kind?: string; strategy?: { mode?: string }; hil_policy?: string }) => Promise<void>;
    };
    view.optionalSession = () => undefined;
    view.createModeSession = () => session;
    view.chooseGoalSetup = async () => {
      calls.push("setup");
      return { kind: "research", strategy: { mode: "focused" }, hil_policy: "review" };
    };
    view.askModeObjective = async () => {
      calls.push("objective");
      return "should not prompt";
    };
    view.startGoal = async (_session, objective, options) => {
      calls.push({ objective, options });
    };

    await view.renderLoopControlView("Improve codebase quality");

    assert.deepEqual(calls, [
      "setup",
      { objective: "Improve codebase quality", options: { kind: "research", strategy: { mode: "focused" }, hil_policy: "review" } },
    ]);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("goal setup labels human review as human in the loop", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-hil-title-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_goal_hil_title", root: stateDir, alias: "goal-hil-title" };
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const titles: string[] = [];
    const choices = ["task", "auto", "auto", "start"];
    const view = tui as unknown as {
      chooseGoalSetup: () => Promise<{ hil_policy?: string }>;
      chooseGoalSetupOption: <T extends string>(title: string) => Promise<T>;
    };
    view.chooseGoalSetupOption = async (title) => {
      titles.push(title);
      return choices.shift() as string as never;
    };

    const setup = await view.chooseGoalSetup();

    assert.deepEqual(titles, ["Loop Type", "Loop Approach", "Human in the Loop", "Start Loop"]);
    assert.equal(setup.hil_policy, "auto");
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("loop mode command starts a typed research approach with review policy", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-mode-command-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_goal_mode_command", root: stateDir, alias: "goal-mode-command" };
    const session = store.createSession(workspace, "loop mode command");
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const calls: Array<{ objective: string; options?: { kind?: string; strategy?: { mode?: string }; hil_policy?: string } }> = [];
    const view = tui as unknown as {
      renderLoopControlView: (args: string) => Promise<void>;
      optionalSession: () => { session_id: string } | undefined;
      createModeSession: (title: string) => { session_id: string };
      startGoal: (session: { session_id: string }, objective: string, options?: { kind?: string; strategy?: { mode?: string }; hil_policy?: string }) => Promise<void>;
    };
    view.optionalSession = () => undefined;
    view.createModeSession = () => session;
    view.startGoal = async (_session, objective, options) => {
      calls.push({ objective, options });
    };

    await view.renderLoopControlView("mode research --review explore Improve scheduler latency");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.objective, "Improve scheduler latency");
    assert.equal(calls[0]?.options?.kind, "research");
    assert.equal(calls[0]?.options?.strategy?.mode, "opportunistic");
    assert.equal(calls[0]?.options?.hil_policy, "review");
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("mode objective composer cancels on interrupt instead of submitting exit text", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-mode-objective-cancel-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_mode_objective_cancel", root: stateDir, alias: "mode-objective-cancel" };
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
      askModeObjective: (label: string) => Promise<string>;
      readComposer: (options: { suggestions?: boolean; cancelOnInterrupt?: boolean }) => Promise<string>;
    };
    let composerOptions: { suggestions?: boolean; cancelOnInterrupt?: boolean } | undefined;
    view.readComposer = async (options) => {
      composerOptions = options;
      throw new Error("Input cancelled");
    };

    await assert.rejects(() => view.askModeObjective("Loop objective"), /Input cancelled/);

    assert.equal(composerOptions?.suggestions, false);
    assert.equal(composerOptions?.cancelOnInterrupt, true);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("bare loop command flags do not bypass human-in-the-loop setup", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-review-flag-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_goal_review_flag", root: stateDir, alias: "goal-review-flag" };
    const session = store.createSession(workspace, "goal review flag");
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const calls: Array<{ objective: string; options?: { kind?: string; hil_policy?: string } }> = [];
    const view = tui as unknown as {
      renderLoopControlView: (args: string) => Promise<void>;
      optionalSession: () => { session_id: string } | undefined;
      createModeSession: (title: string) => { session_id: string };
      chooseGoalSetup: () => Promise<{ kind?: string; hil_policy?: string }>;
      startGoal: (session: { session_id: string }, objective: string, options?: { kind?: string; hil_policy?: string }) => Promise<void>;
    };
    view.optionalSession = () => undefined;
    view.createModeSession = () => session;
    view.chooseGoalSetup = async () => ({ kind: "research", hil_policy: "auto" });
    view.startGoal = async (_session, objective, options) => {
      calls.push({ objective, options });
    };

    await view.renderLoopControlView("--review Improve codebase quality");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.objective, "Improve codebase quality");
    assert.equal(calls[0]?.options?.kind, "research");
    assert.equal(calls[0]?.options?.hil_policy, "auto");
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("goal review command applies a pending staged decision", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-review-command-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_goal_review_command", root: stateDir, alias: "goal-review-command" };
    const session = store.createSession(workspace, "goal review command");
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    let goal = replaceGoalPlanning(createGoalState({ objective: "Review next horizon", hil_policy: "review" }), {
      active_step_id: "first",
      steps: [{ id: "first", title: "Complete first horizon", status: "completed" }],
    });
    goal = stageGoalReviewDecision(
      goal,
      {
        decision: "expand",
        summary: "Open the next horizon.",
        steps: [{ id: "second", title: "Run the reviewed second horizon", status: "pending" }],
        active_step_id: "second",
      },
      "run_review_reflection",
    );
    writeGoalState(store, session.session_id, goal, "run_review_reflection");

    const panels: Array<{ title: string; body: string[] }> = [];
    const view = tui as unknown as {
      renderLoopControlView: (args: string) => Promise<void>;
      optionalSession: () => { session_id: string } | undefined;
      renderLoopTranscriptPanel: (title: string, body: string[]) => void;
      enqueueGoalContinuation: () => Promise<void>;
    };
    view.optionalSession = () => session;
    view.renderLoopTranscriptPanel = (title, body) => {
      panels.push({ title, body });
    };
    view.enqueueGoalContinuation = async () => {};

    await view.renderLoopControlView("review approve");

    const saved = readGoalState(store, session.session_id);
    assert.equal(saved?.goal.status, "active");
    assert.equal(saved?.goal.horizon_generation, 1);
    assert.equal(saved?.goal.pending_review_decision, undefined);
    assert.equal(saved?.goal.planning?.active_step_id, "second");
    assert.equal(store.listEvents(session.session_id).some((event) => event.type === "goal.review.resolved"), true);
    const plain = stripAnsi(panels.at(-1)?.body.join("\n") ?? "");
    assert.match(plain, /review manual/);
    assert.match(plain, /Loop task 1 current/);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("foreground goal supervisor prompts pending HIL review between runs", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-review-autoprompt-"));
  const store = await SessionStore.open(stateDir);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.model_setup.base_url = "http://127.0.0.1:1/v1";
    config.model_setup.model = "test-model";
    const workspace = { id: "w_goal_review_autoprompt", root: stateDir, alias: "goal-review-autoprompt" };
    const session = store.createSession(workspace, "goal review autoprompt");
    const goal = replaceGoalPlanning(createGoalState({ objective: "Review between runs", hil_policy: "review" }), {
      active_step_id: "first",
      steps: [{ id: "first", title: "Complete first horizon", status: "completed" }],
    });
    writeGoalState(store, session.session_id, goal, "goal_init");
    const tui = new TuiApp(
      {
        config,
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const registry = new ToolRegistry(config, workspace, store);
    let prompted = 0;
    const view = tui as unknown as {
      drainForegroundGoalSupervisor: () => Promise<void>;
      optionalSession: () => { session_id: string } | undefined;
      submitPrompt: (prompt: string, options: { requestClass?: string; visibility?: string; runId?: string }) => Promise<{ run_id: string }>;
      promptPendingGoalReviewIfNeeded: (session: { session_id: string }) => Promise<void>;
      renderGoalSupervisorRecord: () => void;
    };
    view.optionalSession = () => session;
    view.renderGoalSupervisorRecord = () => {};
    view.submitPrompt = async (_prompt, options) => {
      if (options.requestClass === "reflection") {
        await registry.call(
          {
            id: "review_reflect",
            name: "goal",
            arguments: {
              op: "reflect",
              decision: "expand",
              summary: "Open the next reviewed horizon.",
              steps: [{ id: "second", title: "Second reviewed horizon", status: "pending" }],
              active_step_id: "second",
            },
          },
          { session_id: session.session_id, run_id: options.runId, request_class: "reflection", visibility: "internal" },
        );
      }
      return { run_id: options.runId ?? "run_work" };
    };
    view.promptPendingGoalReviewIfNeeded = async () => {
      prompted += 1;
    };

    await view.drainForegroundGoalSupervisor();

    assert.equal(prompted, 1);
    const saved = readGoalState(store, session.session_id);
    assert.equal(saved?.goal.status, "paused");
    assert.equal(saved?.goal.pending_review_decision?.action, "expand");
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("pending HIL review prompt shows details without auto-approving", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-review-inline-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_goal_review_inline", root: stateDir, alias: "goal-review-inline" };
    const session = store.createSession(workspace, "goal review inline");
    let goal = replaceGoalPlanning(createGoalState({ objective: "Review next horizon inline", hil_policy: "review" }), {
      active_step_id: "first",
      steps: [{ id: "first", title: "Complete first horizon", status: "completed" }],
    });
    goal = stageGoalReviewDecision(
      goal,
      {
        decision: "expand",
        summary: "Open the inline reviewed horizon.",
        verification_evidence: { verdict: "partial", reason: "current loop task exhausted" },
        steps: [{ id: "second", title: "Run the inline reviewed horizon", status: "pending" }],
        active_step_id: "second",
      },
      "run_review_reflection",
    );
    writeGoalState(store, session.session_id, goal, "run_review_reflection");
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const records: string[] = [];
    const transcripts: string[] = [];
    const view = tui as unknown as {
      promptPendingGoalReviewIfNeeded: (session: { session_id: string }) => Promise<void>;
      optionalSession: () => { session_id: string } | undefined;
      renderGoalSupervisorRecord: (title: string, detail: string) => void;
      writeTranscript: (text: string) => void;
    };
    view.optionalSession = () => session;
    view.renderGoalSupervisorRecord = (title, detail) => {
      records.push(`${title}: ${detail}`);
    };
    view.writeTranscript = (text) => {
      transcripts.push(text);
    };

    await view.promptPendingGoalReviewIfNeeded(session);

    const saved = readGoalState(store, session.session_id);
    assert.equal(saved?.goal.status, "paused");
    assert.equal(saved?.goal.horizon_generation, 0);
    assert.equal(saved?.goal.pending_review_decision?.action, "expand");
    assert.match(records.join("\n"), /Loop review: expand/);
    const plain = stripAnsi(transcripts.join("\n"));
    assert.match(plain, /Loop Review/);
    assert.match(plain, /objective Review next horizon inline/);
    assert.match(plain, /decision expand from loop task 0/);
    assert.match(plain, /summary Open the inline reviewed horizon/);
    assert.match(plain, /evidence .*verdict=partial/);
    assert.match(plain, /Proposed next steps/);
    assert.match(plain, /second .* Run the inline reviewed horizon/);
    assert.match(plain, /inline review prompt/);
    assert.doesNotMatch(plain, /\/loop review approve/);
    assert.doesNotMatch(plain, /\/loop review revise <feedback>/);
    assert.doesNotMatch(plain, /╭|╮|╰|╯/);
    assert.equal(store.listEvents(session.session_id).some((event) => event.type === "goal.review.resolved"), false);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("goal resume refuses pending review decisions", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-review-resume-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_goal_review_resume", root: stateDir, alias: "goal-review-resume" };
    const session = store.createSession(workspace, "goal review resume");
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const goal = stageGoalReviewDecision(
      createGoalState({ objective: "Review blocked resume", hil_policy: "review" }),
      {
        decision: "blocked",
        summary: "Needs a human decision.",
        blocker: "manual review required",
      },
      "run_review_reflection",
    );
    writeGoalState(store, session.session_id, goal, "run_review_reflection");

    const notices: string[] = [];
    const view = tui as unknown as {
      renderLoopControlView: (args: string) => Promise<void>;
      optionalSession: () => { session_id: string } | undefined;
      renderNotice: (message: string) => void;
      renderLoopTranscriptPanel: () => void;
    };
    view.optionalSession = () => session;
    view.renderNotice = (message) => {
      notices.push(message);
    };
    view.renderLoopTranscriptPanel = () => {};

    await view.renderLoopControlView("resume");

    const saved = readGoalState(store, session.session_id);
    assert.equal(saved?.goal.pending_review_decision?.action, "blocked");
    assert.equal(saved?.goal.status, "paused");
    assert.match(notices.join("\n"), /pending loop review/);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("inbox view renders in transcript flow without a framed panel", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-inbox-transcript-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_inbox_transcript", root: stateDir, alias: "inbox-transcript" };
    const session = store.createSession(workspace, "inbox transcript");
    const goal = stageGoalReviewDecision(
      createGoalState({ objective: "Review inbox rendering", hil_policy: "review" }),
      {
        decision: "expand",
        summary: "Needs inline inbox review.",
        steps: [{ id: "next", title: "Continue inbox review", status: "pending" }],
      },
      "run_review_reflection",
    );
    writeGoalState(store, session.session_id, goal, "run_review_reflection");
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const panels: Array<{ title: string; body: string[] }> = [];
    const transcripts: Array<{ title: string; body: string[] }> = [];
    const view = tui as unknown as {
      renderInboxView: (args?: string) => Promise<void>;
      renderPanel: (title: string, body: string[]) => void;
      renderLoopTranscriptPanel: (title: string, body: string[]) => void;
    };
    view.renderPanel = (title, body) => {
      panels.push({ title, body });
    };
    view.renderLoopTranscriptPanel = (title, body) => {
      transcripts.push({ title, body });
    };

    await view.renderInboxView("");

    assert.deepEqual(panels, []);
    const latest = transcripts.at(-1);
    assert.equal(latest?.title, "Loop Inbox");
    const plain = stripAnsi(latest?.body.join("\n") ?? "");
    assert.match(plain, /Open 1/);
    assert.match(plain, /Review loop decision: expand/);
    assert.match(plain, /Needs inline inbox review/);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("self-improve status renders a compact transcript without command checklist", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-self-improve-transcript-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_self_improve_transcript", root: stateDir, alias: "self-improve-transcript" };
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const panels: Array<{ title: string; body: string[] }> = [];
    const transcripts: Array<{ title: string; body: string[] }> = [];
    const view = tui as unknown as {
      renderSelfImproveView: (args?: string) => Promise<void>;
      shutdownBackgroundWork: (reason: string) => Promise<void>;
      renderPanel: (title: string, body: string[]) => void;
      renderLoopTranscriptPanel: (title: string, body: string[]) => void;
      composerSuggestions: (buffer: string, skills: []) => Array<{ value: string }>;
    };
    view.renderPanel = (title, body) => {
      panels.push({ title, body });
    };
    view.renderLoopTranscriptPanel = (title, body) => {
      transcripts.push({ title, body });
    };

    await view.renderSelfImproveView("");

    assert.deepEqual(panels, []);
    assert.match(stripAnsi(transcripts[0]?.body.join("\n") ?? ""), /loading self-improve status/i);
    for (let index = 0; index < 20 && transcripts.length < 2; index += 1) {
      await delay(10);
    }
    const latest = transcripts.at(-1);
    assert.equal(latest?.title, "Self-Improve");
    const plain = stripAnsi(latest?.body.join("\n") ?? "");
    assert.match(plain, /verified loop evidence/i);
    assert.doesNotMatch(plain, /\bCommands\b/);
    assert.doesNotMatch(plain, /\/self-improve propose/);
    assert.doesNotMatch(plain, /\/self-improve run --replay/);
    assert.doesNotMatch(plain, /\/self-improve report/);
    assert.deepEqual(
      view.composerSuggestions("/self-improve ", []).map((item) => item.value),
      ["/self-improve status", "/self-improve learn", "/self-improve adopt"],
    );
    await view.shutdownBackgroundWork("test done");
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("self-improve learn result explains rejected candidates without success wording", () => {
  const plain = stripAnsi(selfImproveLearnLines(fakeSelfImproveLearnReport("rejected")).join("\n"));

  assert.match(plain, /no skill change applied/);
  assert.match(plain, /Proposal self_improve_test · kept as a rejected candidate/);
  assert.match(plain, /candidate did not improve validation replay, so it was not offered for adoption/);
  assert.match(plain, /Score current 0\.00 · candidate 0\.00 · 0\.00 -> 0\.00/);
  assert.match(plain, /Checks heldout not regressed · hard failures 0 · edit syntax passed/);
  assert.match(plain, /Next keep working; run \/self-improve learn again after stronger verified evidence/);
  assert.doesNotMatch(plain, /\blearned\b/);
  assert.doesNotMatch(plain, /\bGate\b/);
});

test("self-improve learn result marks accepted candidates as reviewable skill changes", () => {
  const plain = stripAnsi(selfImproveLearnLines(fakeSelfImproveLearnReport("accepted")).join("\n"));

  assert.match(plain, /skill change ready for review/);
  assert.match(plain, /Proposal self_improve_test · accepted by replay/);
  assert.match(plain, /candidate improved validation replay and did not regress heldout samples/);
  assert.match(plain, /Score current 0\.30 · candidate 0\.70 · 0\.30 -> 0\.70/);
  assert.match(plain, /Next review staged skill changes below/);
});

test("self-improve from welcome keeps the chat banner before command output", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-self-improve-welcome-"));
  const originalStdoutWrite = process.stdout.write;
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_self_improve_welcome", root: stateDir, alias: "self-improve-welcome" };
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
      openView: (command: "self-improve", args: string) => Promise<void>;
      shouldRenderWelcomeComposer: () => boolean;
      shutdownBackgroundWork: (reason: string) => Promise<void>;
    };
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;

    await view.openView("self-improve", "");

    const plain = stripAnsi(output);
    const bannerIndex = plain.indexOf("Welcome back!");
    const panelIndex = plain.indexOf("Self-Improve");
    assert.ok(bannerIndex >= 0);
    assert.ok(panelIndex >= 0);
    assert.ok(bannerIndex < panelIndex);
    assert.equal(view.shouldRenderWelcomeComposer(), false);

    await view.shutdownBackgroundWork("test done");
  } finally {
    process.stdout.write = originalStdoutWrite;
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("self-improve learn from welcome renders pending status immediately", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-self-improve-welcome-learn-"));
  const originalStdoutWrite = process.stdout.write;
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_self_improve_welcome_learn", root: stateDir, alias: "self-improve-welcome-learn" };
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
      openView: (command: "self-improve", args: string) => Promise<void>;
      shutdownBackgroundWork: (reason: string) => Promise<void>;
    };
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;

    const result = await Promise.race([
      view.openView("self-improve", "learn").then(() => "returned"),
      delay(100).then(() => "blocked"),
    ]);

    assert.equal(result, "returned");
    const plain = stripAnsi(output);
    assert.ok(plain.indexOf("Welcome back!") >= 0);
    assert.ok(plain.indexOf("Self-Improve Learn") >= 0);
    assert.ok(plain.indexOf("learning from verified loop evidence") >= 0);
    assert.ok(plain.indexOf("Welcome back!") < plain.indexOf("Self-Improve Learn"));

    await view.shutdownBackgroundWork("test done");
  } finally {
    process.stdout.write = originalStdoutWrite;
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("self-improve learn returns composer control while optimizer is pending", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-self-improve-learn-bg-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_self_improve_learn_bg", root: stateDir, alias: "self-improve-learn-bg" };
    const session = store.createSession(workspace, "verified self improve source");
    let goal = createGoalState({ objective: "Keep slash commands responsive" });
    writeGoalState(store, session.session_id, goal, "run_goal");
    goal = completeGoalReflection(
      goal,
      {
        decision: "done",
        summary: "Verified with npm test.",
        verification_evidence: { command: "npm test", status: "pass" },
      },
      "run_reflect",
    );
    writeGoalState(store, session.session_id, goal, "run_reflect");
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_reflect",
      type: "goal.reflection.completed",
      data: {
        goal_id: goal.goal.id,
        source_horizon_generation: 0,
        horizon_generation: 0,
        decision: "done",
        summary: goal.goal.last_reflection_summary,
        verification_evidence: goal.goal.verification_evidence,
      },
    });

    const config = structuredClone(DEFAULT_CONFIG);
    config.model_setup.base_url = "http://127.0.0.1:65535/v1";
    config.model_setup.model = "optimizer-model";
    let runtimeOptions: { signal?: AbortSignal } | undefined;
    const tui = new TuiApp(
      {
        config,
        configFiles: [],
        workspace,
        store,
        runtime: {
          async run(options: { signal?: AbortSignal }) {
            runtimeOptions = options;
            await new Promise((_resolve, reject) => {
              options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
            throw new Error("unreachable");
          },
        },
      } as never,
    );
    const transcripts: Array<{ title: string; body: string[] }> = [];
    const activity: string[] = [];
    const view = tui as unknown as {
      renderSelfImproveView: (args?: string) => Promise<void>;
      renderLoopTranscriptPanel: (title: string, body: string[]) => void;
      startActivityIndicator: (label: string) => {
        status: (label: string) => void;
        record: (line: string) => void;
        pauseForOutput: () => void;
        stop: () => void;
      };
      shutdownBackgroundWork: (reason: string) => Promise<void>;
    };
    view.renderLoopTranscriptPanel = (title, body) => {
      transcripts.push({ title, body });
    };
    view.startActivityIndicator = (label) => {
      activity.push(`start:${stripAnsi(label)}`);
      return {
        status: (next) => activity.push(`status:${stripAnsi(next)}`),
        record: () => {},
        pauseForOutput: () => {},
        stop: () => activity.push("stop"),
      };
    };

    const result = await Promise.race([
      view.renderSelfImproveView("learn").then(() => "returned"),
      delay(100).then(() => "blocked"),
    ]);

    assert.equal(result, "returned");
    assert.equal(runtimeOptions, undefined);
    assert.equal(activity[0], "start:Learning from loop evidence");
    assert.equal(transcripts[0]?.title, "Self-Improve Learn");
    assert.match(stripAnsi(transcripts[0]?.body.join("\n") ?? ""), /learning from verified loop evidence/i);
    assert.match(stripAnsi(transcripts[0]?.body.join("\n") ?? ""), /optimizer and replay gate running/i);
    for (let index = 0; index < 20 && !runtimeOptions; index += 1) {
      await delay(10);
    }
    const startedRuntimeOptions = runtimeOptions as { signal?: AbortSignal } | undefined;
    assert.ok(startedRuntimeOptions);
    assert.ok(startedRuntimeOptions.signal);

    await view.shutdownBackgroundWork("test done");
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("self-improve learn opens inline adopt review after accepted replay", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-self-improve-learn-review-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_self_improve_learn_review", root: stateDir, alias: "self-improve-learn-review" };
    for (let index = 0; index < 4; index += 1) {
      const session = store.createSession(workspace, `verified self improve source ${index}`);
      let goal = createGoalState({ objective: `Ship verified docs workflow ${index}` });
      writeGoalState(store, session.session_id, goal, `run_goal_${index}`);
      goal = completeGoalReflection(
        goal,
        {
          decision: "done",
          summary: "Verified with npm test.",
          verification_evidence: { command: "npm test", status: "pass" },
        },
        `run_reflect_${index}`,
      );
      writeGoalState(store, session.session_id, goal, `run_reflect_${index}`);
      store.appendEvent({
        session_id: session.session_id,
        run_id: `run_reflect_${index}`,
        type: "goal.reflection.completed",
        data: {
          goal_id: goal.goal.id,
          source_horizon_generation: 0,
          horizon_generation: 0,
          decision: "done",
          summary: goal.goal.last_reflection_summary,
          verification_evidence: goal.goal.verification_evidence,
        },
      });
    }

    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const transcripts: Array<{ title: string; body: string[] }> = [];
    const view = tui as unknown as {
      renderSelfImproveView: (args?: string) => Promise<void>;
      renderLoopTranscriptPanel: (title: string, body: string[]) => void;
      startActivityIndicator: (label: string) => {
        status: () => void;
        record: () => void;
        pauseForOutput: () => void;
        stop: () => void;
      };
      askSelfImproveAdoptDecision: () => Promise<"approve" | "cancel">;
    };
    view.renderLoopTranscriptPanel = (title, body) => {
      transcripts.push({ title, body });
    };
    view.startActivityIndicator = () => ({
      status: () => {},
      record: () => {},
      pauseForOutput: () => {},
      stop: () => {},
    });
    view.askSelfImproveAdoptDecision = async () => "cancel";

    await view.renderSelfImproveView("learn");
    for (let index = 0; index < 50 && !transcripts.some((item) => item.title === "Self-Improve Adopt Review"); index += 1) {
      await delay(10);
    }

    const review = transcripts.find((item) => item.title === "Self-Improve Adopt Review");
    assert.ok(review);
    const plain = stripAnsi(review.body.join("\n"));
    assert.match(plain, /Inferoa Loop Skill/);
    assert.match(plain, /Inferoa Workspace Skill/);
    assert.equal(transcripts.at(-1)?.title, "Self-Improve Adopt Cancelled");
    await assert.rejects(
      () => readFile(path.join(stateDir, ".inferoa", "skills", "inferoa-loop-skill", "SKILL.md"), "utf8"),
      /ENOENT/,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("self-improve adopt previews staged skills and requires confirmation", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-self-improve-adopt-preview-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_self_improve_adopt_preview", root: stateDir, alias: "self-improve-adopt-preview" };
    const session = store.createSession(workspace, "verified self improve source");
    let goal = createGoalState({ objective: "Ship verified docs workflow" });
    writeGoalState(store, session.session_id, goal, "run_goal");
    goal = completeGoalReflection(
      goal,
      {
        decision: "done",
        summary: "Verified with npm test.",
        verification_evidence: { command: "npm test", status: "pass" },
      },
      "run_reflect",
    );
    writeGoalState(store, session.session_id, goal, "run_reflect");
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_reflect",
      type: "goal.reflection.completed",
      data: {
        goal_id: goal.goal.id,
        source_horizon_generation: 0,
        horizon_generation: 0,
        decision: "done",
        summary: goal.goal.last_reflection_summary,
        verification_evidence: goal.goal.verification_evidence,
      },
    });
    const proposal = await optLitePropose(store, workspace);
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const transcripts: Array<{ title: string; body: string[] }> = [];
    const view = tui as unknown as {
      renderSelfImproveView: (args?: string) => Promise<void>;
      renderLoopTranscriptPanel: (title: string, body: string[]) => void;
      confirm: (label: string, defaultValue: boolean) => Promise<boolean>;
    };
    view.renderLoopTranscriptPanel = (title, body) => {
      transcripts.push({ title, body });
    };
    view.confirm = async () => false;

    await view.renderSelfImproveView(`adopt ${proposal.id}`);

    const preview = transcripts.find((item) => item.title === "Self-Improve Adopt Preview");
    assert.ok(preview);
    const previewPlain = stripAnsi(preview.body.join("\n"));
    assert.match(previewPlain, /Inferoa Loop Skill/);
    assert.match(previewPlain, /Inferoa Workspace Skill/);
    assert.equal(transcripts.at(-1)?.title, "Self-Improve Adopt Cancelled");
    await assert.rejects(
      () => readFile(path.join(stateDir, ".inferoa", "skills", "inferoa-loop-skill", "SKILL.md"), "utf8"),
      /ENOENT/,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("goal panel surfaces research metrics as verification", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-goal-research-verification-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_goal_research_verification", root: stateDir, alias: "goal-research-verification" };
    const session = store.createSession(workspace, "goal research verification");
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
    );
    const goal = createGoalState({ objective: "Reduce latency", kind: "research" });
    writeGoalState(store, session.session_id, goal, "run_goal");
    let experiment = createExperiment({ name: "latency", goal: goal.goal.objective, primary_metric: "latency_ms", direction: "lower" });
    experiment = recordRun(experiment, {
      command: "npm test",
      exit_code: 0,
      duration_ms: 1200,
      parsed_metrics: { latency_ms: 12.5 },
      parsed_primary: 12.5,
      asi: {},
      completed_at: "2026-01-01T00:00:00.000Z",
    });
    experiment = logPendingRun(experiment, { status: "keep", metric: 12.5, description: "latency improved" });
    writeAutoresearchState(
      store,
      session.session_id,
      { enabled: true, goal: goal.goal.objective, active_experiment_name: "latency", experiments: [experiment] },
      "run_experiment",
    );

    const panels: Array<{ title: string; body: string[] }> = [];
    const view = tui as unknown as {
      renderGoalPanel: (state: ReturnType<typeof createGoalState>) => void;
      renderLoopTranscriptPanel: (title: string, body: string[]) => void;
      optionalSession: () => { session_id: string } | undefined;
    };
    view.optionalSession = () => session;
    view.renderLoopTranscriptPanel = (title, body) => {
      panels.push({ title, body });
    };

    view.renderGoalPanel(goal);

    const plain = stripAnsi(panels.at(-1)?.body.join("\n") ?? "");
    assert.match(plain, /verification research .*pass .*hard .*latency_ms 12\.5/);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("daemon status surfaces pending loop review pause reason", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-daemon-goal-review-status-"));
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = { id: "w_daemon_goal_review_status", root: stateDir, alias: "daemon-goal-review-status" };
    const session = store.createSession(workspace, "daemon goal review status");
    const job = store.createSupervisorJob(session.session_id, workspace.root, "Continue reviewed goal", { kind: "goal", metadata: {} });
    store.updateSupervisorJob(job.job_id, { status: "paused", metadata: { pause_reason: "goal_review_pending" } });
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace,
        store,
        runtime: {},
      } as never,
      { stateDir },
    );
    const panels: Array<{ title: string; body: string[] }> = [];
    const view = tui as unknown as {
      renderDaemonStatusPanel: () => Promise<void>;
      renderPanel: (title: string, body: string[]) => void;
    };
    view.renderPanel = (title, body) => {
      panels.push({ title, body });
    };

    await view.renderDaemonStatusPanel();

    const plain = stripAnsi(panels.at(-1)?.body.join("\n") ?? "");
    assert.match(plain, /paused\s+goal/);
    assert.match(plain, /goal_review_pending/);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("goal show renders wrapped tree horizons without repeated command hints", async () => {
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
      renderLoopTranscriptPanel: (title: string, body: string[]) => void;
      optionalSession: () => { session_id: string } | undefined;
    };
    const longSummary =
      "Successfully improved the vLLM Semantic Router codebase across all three sub-projects with Python CLI, Go core, and fleet simulator verification completed without truncation.";
    const expandReflection = "Found a second horizon after the first audit and verification pass.";
    const doneReflection =
      "Successfully improved the vLLM Semantic Router codebase across all three sub-projects after final reflection, including Python tests passing and release notes prepared without hidden tail text.";
    let goal = replaceGoalPlanning(createGoalState({ objective: "improve codebase" }), {
      summary: "Initial audit and repair horizon",
      steps: [
        { id: "explore_and_audit", title: "Explore codebase and identify concrete improvement areas", status: "completed" },
        { id: "fix_python_issues", title: "Fix Python code quality issues in the vllm-sr CLI", status: "completed" },
      ],
    });
    goal.goal.summary = longSummary;
    writeGoalState(store, session.session_id, goal, "run_horizon_0");
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_reflection_expand",
      type: "goal.reflection.started",
      data: { goal_id: goal.goal.id, horizon_generation: 0 },
    });
    goal = completeGoalReflection(
      goal,
      {
        decision: "expand",
        summary: expandReflection,
        steps: [
          {
            id: "verify_build_and_test_full_suite",
            title: "Verify build and test full suite across all three projects before completing the loop",
            status: "in_progress",
          },
        ],
        active_step_id: "verify_build_and_test_full_suite",
      },
      "run_reflection_expand",
    );
    goal.goal.summary = longSummary;
    writeGoalState(store, session.session_id, goal, "run_horizon_1");
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_reflection_expand",
      type: "goal.reflection.completed",
      data: {
        goal_id: goal.goal.id,
        source_horizon_generation: 0,
        horizon_generation: 1,
        decision: "expand",
        summary: expandReflection,
      },
    });
    goal.goal.planning!.steps[0]!.status = "completed";
    writeGoalState(store, session.session_id, goal, "run_horizon_1_done");
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_reflection_done",
      type: "goal.reflection.started",
      data: { goal_id: goal.goal.id, horizon_generation: 1 },
    });
    goal = completeGoalReflection(
      goal,
      {
        decision: "done",
        summary: doneReflection,
        verification_evidence: { test: "passed" },
      },
      "run_reflection_done",
    );
    writeGoalState(store, session.session_id, goal, "run_reflection_done");
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_reflection_done",
      type: "goal.reflection.completed",
      data: {
        goal_id: goal.goal.id,
        source_horizon_generation: 1,
        horizon_generation: 1,
        decision: "done",
        summary: doneReflection,
        verification_evidence: { test: "passed" },
      },
    });
    goal = completeGoalAfterReflection(goal, longSummary);
    writeGoalState(store, session.session_id, goal, "run_goal_complete");

    const panels: Array<{ title: string; body: string[] }> = [];
    view.optionalSession = () => session;
    view.renderLoopTranscriptPanel = (title, body) => {
      panels.push({ title, body });
    };

    process.stdout.columns = 88;
    view.renderGoalPanel(goal);

    const latest = panels.at(-1);
    assert.equal(latest?.title, "Loop");
    const plain = stripAnsi(latest?.body.join("\n") ?? "");
    assert.match(plain, /^complete improve codebase/m);
    assert.doesNotMatch(plain, /complete \(paused\)/);
    assert.match(plain, /decisions 2 recorded .*latest done/);
    assert.match(plain, /type task/);
    assert.match(plain, /approach auto/);
    assert.match(plain, /candidates 0 open .*0 done .*0 dismissed/);
    assert.match(plain, /◇ Loop task 0 .*Initial audit and repair horizon/);
    assert.match(plain, /◆ Loop task 1 current .*Found a second horizon/);
    assert.match(plain, /├─ x explore_and_audit/);
    assert.match(plain, /└─ x verify_build_and_test_full_suite/);
    assert.match(plain, /decision expand .*Found a second horizon/);
    assert.match(plain, /decision done/);
    assert.doesNotMatch(plain, /\/loop plan/);
    assert.doesNotMatch(plain, /\/loop complete/);
    assert.match(plain, /fleet simulator verification\s+completed without truncation/);
    assert.doesNotMatch(plain, /release notes[\s\S]*prepared without hidden[\s\S]*tail text/);

    let inlineOutput = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      inlineOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    view.renderInlinePanel("Loop", latest?.body ?? []);

    const rendered = stripAnsi(inlineOutput);
    assert.doesNotMatch(rendered, /…/);
    assert.match(rendered, /fleet simulator verification\s+completed without truncation/);
    assert.doesNotMatch(rendered, /release notes[\s\S]*prepared without hidden[\s\S]*tail text/);
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
            summary: "Loop decision recorded: improve docs wording",
            data: {
              enabled: true,
              goal: {
                id: "goal_reflection_trace",
                objective: "improve docs wording",
                status: "active",
                horizon_generation: 1,
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
              summary: "Loop decision recorded: improve docs wording",
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
    assert.match(plain, /Recorded loop decision/);
    assert.match(plain, /done · loop task 1/);
    assert.match(plain, /improve docs wording/);
    assert.doesNotMatch(plain, /hidden reflection assistant text/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("self-improve optimizer renders internal tool trace into chat transcript", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-self-improve-visible-trace-"));
  try {
    const session = {
      session_id: "s_self_improve_visible_trace",
      workspace_id: "w_self_improve_visible_trace",
      title: "self-improve optimizer",
      status: "idle",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    const runId = "run_self_improve_visible_trace";
    const toolCallId = "call_self_improve_read";
    const events = [
      {
        session_id: session.session_id,
        run_id: runId,
        type: "tool.call",
        created_at: new Date(0).toISOString(),
        data: {
          tool_call_id: toolCallId,
          tool_name: "read_file",
          arguments: { path: "src/opt/agentic-propose.ts" },
        },
      },
      {
        session_id: session.session_id,
        run_id: runId,
        type: "tool.result",
        created_at: new Date(0).toISOString(),
        data: {
          tool_call_id: toolCallId,
          tool_name: "read_file",
          result: {
            ok: true,
            summary: "Read 12 lines from src/opt/agentic-propose.ts",
            data: {
              path: "src/opt/agentic-propose.ts",
              start_line: 1,
              line_count: 12,
              content: "1: export function buildAgenticEvidencePacket() {}\n",
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
        workspace: { id: "w_self_improve_visible_trace", root: stateDir, alias: "self-improve-visible-trace" },
        store: { listEvents: () => events },
        runtime: {
          run: async (options: { onStatus?: (event: { type: string; [key: string]: unknown }) => void }) => {
            options.onStatus?.({ type: "model_start", model: "optimizer-trace-test" });
            options.onStatus?.({
              type: "tool_start",
              session_id: session.session_id,
              run_id: runId,
              tool_name: "read_file",
              tool_call_id: toolCallId,
              summary: "Reading optimizer source",
            });
            options.onStatus?.({
              type: "tool_end",
              session_id: session.session_id,
              run_id: runId,
              tool_name: "read_file",
              tool_call_id: toolCallId,
              ok: true,
              summary: "Read 12 lines from src/opt/agentic-propose.ts",
              duration_ms: 7,
            });
            return {
              session,
              run_id: runId,
              content: "{\"edits\":[]}",
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
      runVisibleSelfImproveOptimizer: (options: { prompt: string; title?: string; request_class?: "background"; visibility?: "internal" }) => Promise<unknown>;
      startActivityIndicator: (label: string) => {
        status: () => void;
        record: () => void;
        pauseForOutput: () => void;
        stop: () => void;
      };
      writeTranscript: (text: string) => void;
    };
    view.startActivityIndicator = () => ({
      status: () => {},
      record: () => {},
      pauseForOutput: () => {},
      stop: () => {},
    });
    view.writeTranscript = (text) => {
      transcript.push(text);
    };

    await view.runVisibleSelfImproveOptimizer({
      prompt: "Return JSON.",
      title: "self-improve optimizer",
      request_class: "background",
      visibility: "internal",
    });

    const plain = stripAnsi(transcript.join(""));
    assert.match(plain, /Read file/);
    assert.match(plain, /agentic-propose\.ts/);
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
      "Loop complete",
      [
        {
          label: "summary",
          text: "Improved docs wording across the blog repository with a long completion summary that must wrap instead of disappearing at the terminal edge.",
        },
        {
          label: "stats",
          text: "Loop achieved. 46 loops · 128 tool calls · 8m 59s · 4767746 tokens used.",
        },
      ],
      48,
    );

    const plain = stripAnsi(transcript.join(""));
    assert.match(plain, /Loop complete/);
    assert.match(plain, /summary Improved docs wording/);
    assert.match(plain, /terminal edge/);
    assert.match(plain, /stats Loop achieved\. 46 loops .*128 tool calls .*8m 59s .*4767746 tokens used/);
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

    view.renderInlinePanel("Loop Supervisor", ["queued goal\nLoop objective: deep research"]);

    const plainLines = stripAnsi(output).split("\n");
    assert.equal(plainLines.length, 5);
    assert.match(plainLines[2] ?? "", /queued goal Loop objective: deep research/);
  } finally {
    process.stdout.write = originalStdoutWrite;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("inline panels patch stable-height redraws without clearing the region", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-inline-panel-patch-"));
  const originalStdoutWrite = process.stdout.write;
  try {
    const tui = new TuiApp(
      {
        config: structuredClone(DEFAULT_CONFIG),
        configFiles: [],
        workspace: { id: "w_inline_panel_patch", root: stateDir, alias: "inline-panel-patch" },
        store: { close() {} },
        runtime: {},
      } as never,
    );
    const view = tui as unknown as {
      renderInlinePanel: (title: string, body: string[]) => void;
    };
    const writes: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    view.renderInlinePanel("Goal Setup", ["Progress · Type", "", "› Task", "  Research"]);
    writes.length = 0;
    view.renderInlinePanel("Goal Setup", ["Progress · Type", "", "  Task", "› Research"]);

    const output = writes.join("");
    assert.doesNotMatch(output, /\x1b\[J/);
    assert.match(output, /\x1b\[[0-9]+A/);
    assert.match(output, /\x1b\[2K/);
  } finally {
    process.stdout.write = originalStdoutWrite;
    await rm(stateDir, { recursive: true, force: true });
  }
});

function fakeSelfImproveLearnReport(status: OptReplayStatus): OptLiteLearnReport {
  const accepted = status === "accepted";
  return {
    kind: "learn",
    proposal: {
      id: "self_improve_test",
      status: "staged",
      created_at: "2026-06-12T00:00:00.000Z",
      skill_id: "inferoa-workspace-skill",
      skill_targets: [
        {
          target: "workspace_skill",
          skill_id: "inferoa-workspace-skill",
          skill_name: "Inferoa Workspace Skill",
          staged_skill_path: "/tmp/proposed.workspace.SKILL.md",
          edit_count: 1,
          body: "# Inferoa Workspace Skill\n",
          edits: [
            {
              target: "workspace_skill",
              op: "add",
              section: "Verification",
              content: "Run the repo test command before closing loop work.",
              rationale: "Verified loop evidence cited repo tests.",
              source_event_indexes: [0],
            },
          ],
        },
      ],
      proposal_source: "agentic",
      agentic_run: {
        session_id: "s_optimizer",
        run_id: "run_optimizer",
        request_class: "background",
      },
      normalization_warnings: ["normalized shorthand edit shape"],
      evidence: {
        goal_sessions: 5,
        verification_records: 5,
        human_feedback_records: 0,
        learning_signal_records: 5,
        skill_snapshots: 0,
      },
      source_sessions: [],
      source_events: [],
      skill_body: "# Inferoa Workspace Skill\n",
      staged_skill_path: "/tmp/proposed.workspace.SKILL.md",
    },
    replay: {
      id: "replay_test",
      proposal_id: "self_improve_test",
      status,
      created_at: "2026-06-12T00:00:00.000Z",
      sample_count: 5,
      baseline_score: accepted ? 0.3 : 0,
      candidate_score: accepted ? 0.7 : 0,
      report_path: "/tmp/replay_test.json",
      gate: {
        validation_improved: accepted,
        heldout_not_regressed: true,
        hard_failures: 0,
        edit_gate_passed: true,
      },
      splits: {
        train: [],
        validation: [],
        heldout: [],
      },
    },
  };
}
