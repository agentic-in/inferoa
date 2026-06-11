import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/config.js";
import { PromptBuilder } from "../src/context/prompt.js";
import { Runtime } from "../src/runtime.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { CORE_TOOL_DEFINITIONS } from "../src/tools/schemas.js";
import { resolveRtkStatus } from "../src/rtk/manager.js";
import { parseSlashCommand } from "../src/tui/slash.js";
import { renderSessionActivityLines } from "../src/tui/event-view.js";
import { renderRtkSessionLines } from "../src/tui/rtk-view.js";
import { stripAnsi } from "../src/tui/ansi.js";
import type { SessionEvent, VllmAgentConfig, WorkspaceIdentity } from "../src/types.js";

test("config enables managed RTK by default and honors env overrides", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "inferoa-rtk-config-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "inferoa-rtk-config-state-"));
  const previousState = process.env.INFEROA_STATE_DIR;
  const previousEnabled = process.env.INFEROA_RTK;
  const previousPath = process.env.INFEROA_RTK_PATH;
  const previousAutoDownload = process.env.INFEROA_RTK_AUTO_DOWNLOAD;
  process.env.INFEROA_STATE_DIR = stateDir;
  try {
    const defaults = await loadConfig(workspace);
    assert.equal(defaults.config.rtk.enabled, true);
    assert.equal(defaults.config.rtk.delivery, "managed");
    assert.equal(defaults.config.rtk.version, "0.42.3");
    assert.equal(defaults.config.rtk.auto_download, true);

    process.env.INFEROA_RTK = "off";
    process.env.INFEROA_RTK_PATH = "/tmp/fake-rtk";
    process.env.INFEROA_RTK_AUTO_DOWNLOAD = "0";
    const overridden = await loadConfig(workspace);
    assert.equal(overridden.config.rtk.enabled, false);
    assert.equal(overridden.config.rtk.binary_path, "/tmp/fake-rtk");
    assert.equal(overridden.config.rtk.delivery, "path_only");
    assert.equal(overridden.config.rtk.auto_download, false);
  } finally {
    restoreEnv("INFEROA_STATE_DIR", previousState);
    restoreEnv("INFEROA_RTK", previousEnabled);
    restoreEnv("INFEROA_RTK_PATH", previousPath);
    restoreEnv("INFEROA_RTK_AUTO_DOWNLOAD", previousAutoDownload);
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("slash parser and activity view expose RTK savings", () => {
  const rtk = parseSlashCommand("/rtk");
  assert.equal(rtk.command?.name, "tokenmaxxing");
  assert.equal(rtk.error, undefined);

  const activity = stripAnsi(
    renderSessionActivityLines(
      [
        event("run.completed", {
          tool_rounds: 1,
          tool_calls: 2,
          tokens: 50,
          duration_ms: 1000,
          rtk: {
            tool_calls: 2,
            rtk_tool_calls: 1,
            rtk_commands: 1,
            input_tokens: 120,
            output_tokens: 20,
            saved_tokens: 100,
            savings_pct: 83.333,
            estimated_without_rtk_tokens: 150,
            status: "ok",
          },
        }),
      ],
      140,
    ).join("\n"),
  );
  assert.match(activity, /run complete .*tools 2 .*tokens 50 .*rtk saved 100/);
});

test("RTK session view shows per-turn tool calls, saved tool tokens, and estimated total", () => {
  const lines = renderRtkSessionLines(
    [
      event("run.completed", {
        tool_calls: 3,
        tokens: 200,
        duration_ms: 1000,
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
      }),
    ],
    140,
  );
  const plain = stripAnsi(lines.join("\n"));
  assert.match(plain, /RTK tool savings/);
  assert.match(plain, /turns 1 .*tools 3 .*rtk commands 2 .*io 300->60 .*saved 240/);
  assert.match(plain, /tokens 200\/440/);
  assert.doesNotMatch(plain, /run run/);
  assert.match(plain, /turn 1 .*tools 3 .*rtk 2 .*io 300->60 .*saved 240 .*tokens 200\/440 .*tool 80\.0%/);
});

test("run_command foreground uses RTK rewrite and records tool savings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-rtk-run-command-"));
  const stateDir = path.join(dir, "state");
  const fakeRtk = await writeFakeRtk(dir);
  const store = await SessionStore.open(stateDir);
  try {
    const workspace: WorkspaceIdentity = { id: "w_rtk_run_command", root: dir, alias: "rtk-run-command" };
    const session = store.createSession(workspace, "rtk-run-command");
    const registry = new ToolRegistry(rtkConfig(fakeRtk), workspace, store);

    const result = await registry.call(
      { id: "rtk_call_1", name: "run_command", arguments: { command: "printf raw-output", timeout_ms: 5000 } },
      { session_id: session.session_id, run_id: "run_rtk", step_id: "step_rtk", step_index: 3 },
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(String(result.data?.output ?? ""), /compact printf raw-output/);
    const savings = store.listEvents(session.session_id).filter((item) => item.type === "rtk.tool_savings");
    assert.equal(savings.length, 1);
    assert.equal(savings[0]?.data.step_id, "step_rtk");
    assert.equal(savings[0]?.data.step_index, 3);
    assert.equal(savings[0]?.data.tool_call_id, "rtk_call_1");
    assert.equal(savings[0]?.data.original_command, "printf raw-output");
    assert.equal(savings[0]?.data.rewritten_command, "rtk printf raw-output");
    assert.equal(savings[0]?.data.saved_tokens, 100);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("RTK resolver reports configured binaries and raw command fallback stays usable when unavailable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-rtk-unavailable-"));
  const missingRtk = path.join(dir, "missing-rtk");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const cfg = rtkConfig(missingRtk);
    const status = await resolveRtkStatus(cfg, { allowDownload: false });
    assert.equal(status.enabled, true);
    assert.equal(status.available, false);
    assert.equal(status.source, "config");

    const workspace: WorkspaceIdentity = { id: "w_rtk_unavailable", root: dir, alias: "rtk-unavailable" };
    const session = store.createSession(workspace, "rtk-unavailable");
    const registry = new ToolRegistry(cfg, workspace, store);
    const result = await registry.call(
      { id: "raw_fallback", name: "run_command", arguments: { command: "printf raw-fallback", timeout_ms: 5000 } },
      { session_id: session.session_id, run_id: "run_unavailable" },
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(String(result.data?.output ?? ""), "raw-fallback");
    const event = store.listEvents(session.session_id).find((item) => item.type === "rtk.tool_savings");
    assert.equal(event?.data.status, "unavailable");
    assert.equal(event?.data.saved_tokens, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("RTK tool savings are not embedded in tool result prompt content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-rtk-prompt-content-"));
  const fakeRtk = await writeFakeRtk(dir);
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_rtk_prompt_content", root: dir, alias: "rtk-prompt-content" };
    const session = store.createSession(workspace, "rtk-prompt-content");
    store.appendEvent({ session_id: session.session_id, run_id: "run_rtk_prompt", type: "user.prompt", data: { prompt: "run a command" } });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_rtk_prompt",
      type: "model.response.settled",
      data: {
        content: "",
        tool_calls: [{ id: "rtk_call_prompt", name: "run_command", arguments: { command: "printf raw-output", timeout_ms: 5000 } }],
      },
    });
    const registry = new ToolRegistry(rtkConfig(fakeRtk), workspace, store);
    await registry.call(
      { id: "rtk_call_prompt", name: "run_command", arguments: { command: "printf raw-output", timeout_ms: 5000 } },
      { session_id: session.session_id, run_id: "run_rtk_prompt" },
    );

    const context = new PromptBuilder(rtkConfig(fakeRtk), store, workspace).build(session, "continue", CORE_TOOL_DEFINITIONS, [], "run_next");
    const serialized = JSON.stringify(context.messages);
    assert.doesNotMatch(serialized, /saved_tokens|rtk_commands|rewritten_command/);
    assert.match(serialized, /compact printf raw-output/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run_command background skips RTK rewrite", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-rtk-background-"));
  const fakeRtk = await writeFakeRtk(dir);
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_rtk_background", root: dir, alias: "rtk-background" };
    const session = store.createSession(workspace, "rtk-background");
    const registry = new ToolRegistry(rtkConfig(fakeRtk), workspace, store);
    const script = "setTimeout(()=>{}, 10000)";

    const started = await registry.call(
      { id: "bg", name: "run_command", arguments: { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, background: true } },
      { session_id: session.session_id, run_id: "run_bg" },
    );
    assert.equal(started.ok, true);
    const processId = String(started.data?.process_id);
    await registry.call({ id: "stop", name: "stop_process", arguments: { process_id: processId } }, { session_id: session.session_id, run_id: "run_bg" });

    assert.equal(store.listEvents(session.session_id).some((item) => item.type === "rtk.tool_savings"), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("git tools route through RTK while preserving result contract", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-rtk-git-"));
  const fakeRtk = await writeFakeRtk(dir);
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_rtk_git", root: dir, alias: "rtk-git" };
    const session = store.createSession(workspace, "rtk-git");
    const registry = new ToolRegistry(rtkConfig(fakeRtk), workspace, store);

    const status = await registry.call({ id: "gs", name: "git_status", arguments: {} }, { session_id: session.session_id, run_id: "run_git" });
    const diff = await registry.call({ id: "gd", name: "git_diff", arguments: { path: "." } }, { session_id: session.session_id, run_id: "run_git" });
    const diffEmptyPath = await registry.call({ id: "gd_empty", name: "git_diff", arguments: { path: "" } }, { session_id: session.session_id, run_id: "run_git" });
    const show = await registry.call({ id: "gsh", name: "git_show", arguments: { rev: "HEAD" } }, { session_id: session.session_id, run_id: "run_git" });
    const showEmptyPath = await registry.call({ id: "gsh_empty", name: "git_show", arguments: { rev: "HEAD", path: "" } }, { session_id: session.session_id, run_id: "run_git" });

    assert.equal(status.ok, true);
    assert.equal(diff.ok, true);
    assert.equal(diffEmptyPath.ok, true);
    assert.equal(show.ok, true);
    assert.equal(showEmptyPath.ok, true);
    assert.match(String(status.data?.output ?? ""), /compact git status --short --branch/);
    assert.match(String(diff.data?.output ?? ""), /compact git diff -- \./);
    assert.match(String(diffEmptyPath.data?.output ?? ""), /compact git diff -- \./);
    assert.match(String(show.data?.output ?? ""), /compact git show --stat --patch HEAD/);
    assert.match(String(showEmptyPath.data?.output ?? ""), /compact git show --stat --patch HEAD/);
    assert.doesNotMatch(String(showEmptyPath.data?.output ?? ""), /-- ''|-- ""/);
    assert.equal(store.listEvents(session.session_id).filter((item) => item.type === "rtk.tool_savings").length, 5);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime aggregates RTK savings into run result and keeps RTK telemetry out of prompt context", async () => {
  const modelServer = createServer((req, res) => {
    if (serveEndpointSignal(req.url, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      writeSse(res, { id: "resp_final", model: "rtk-runtime-test", choices: [{ delta: { content: "done" } }] });
      writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 10 } });
      res.end("data: [DONE]\n\n");
    });
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const address = modelServer.address() as AddressInfo;

  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-rtk-runtime-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_rtk_runtime", root: dir, alias: "rtk-runtime" };
    const session = store.createSession(workspace, "rtk-runtime");
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_previous",
      type: "rtk.tool_savings",
      data: {
        tool_call_id: "manual",
        tool_name: "run_command",
        original_command: "printf raw",
        rewritten_command: "rtk printf raw",
        rtk_commands: 1,
        input_tokens: 120,
        output_tokens: 20,
        saved_tokens: 100,
        savings_pct: 83.333,
      },
    });
    const runtime = new Runtime(config(`http://127.0.0.1:${address.port}/v1`), workspace, store);
    const result = await runtime.run({ session_id: session.session_id, prompt: "finish" });

    assert.equal(result.rtk.saved_tokens, 0);
    assert.equal(result.rtk.estimated_without_rtk_tokens, 50);

    const completed = store.listEvents(session.session_id).find((item) => item.run_id === result.run_id && item.type === "run.completed");
    const rtk = completed?.data.rtk as { status?: string; estimated_without_rtk_tokens?: number } | undefined;
    assert.equal(rtk?.status, "ok");
    assert.equal(rtk?.estimated_without_rtk_tokens, 50);

    const context = new PromptBuilder(config(`http://127.0.0.1:${address.port}/v1`), store, workspace).build(
      store.getSession(session.session_id)!,
      "next",
      CORE_TOOL_DEFINITIONS,
    );
    assert.doesNotMatch(JSON.stringify(context.messages), /rtk\.tool_savings|saved_tokens|printf raw/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});

function rtkConfig(binaryPath: string): VllmAgentConfig {
  const next = structuredClone(DEFAULT_CONFIG);
  next.rtk = {
    enabled: true,
    delivery: "path_only",
    version: "0.42.3",
    binary_path: binaryPath,
    auto_download: false,
  };
  next.permissions.mode = "full_access";
  next.model_setup.model = "rtk-test-model";
  return next;
}

function config(baseUrl: string): VllmAgentConfig {
  const next = structuredClone(DEFAULT_CONFIG);
  next.model_setup.base_url = baseUrl;
  next.model_setup.model = "rtk-runtime-test";
  next.permissions.mode = "full_access";
  return next;
}

async function writeFakeRtk(dir: string): Promise<string> {
  const bin = path.join(dir, "rtk");
  await writeFile(
    bin,
    [
      "#!/usr/bin/env node",
      "import { DatabaseSync } from 'node:sqlite';",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'rewrite') {",
      "  const command = args.slice(1).join(' ');",
      "  if (command.includes('no-rtk')) process.exit(1);",
      "  process.stdout.write(`rtk ${command}`);",
      "  process.exit(0);",
      "}",
      "const command = args.join(' ');",
      "if (process.env.RTK_DB_PATH) {",
      "  const db = new DatabaseSync(process.env.RTK_DB_PATH);",
      "  db.exec(`CREATE TABLE IF NOT EXISTS commands (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, original_cmd TEXT NOT NULL, rtk_cmd TEXT NOT NULL, project_path TEXT DEFAULT '', input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, saved_tokens INTEGER NOT NULL, savings_pct REAL NOT NULL, exec_time_ms INTEGER DEFAULT 0)`);",
      "  db.prepare(`INSERT INTO commands(timestamp, original_cmd, rtk_cmd, project_path, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(new Date().toISOString(), command, `rtk ${command}`, process.cwd(), 120, 20, 100, 83.333, 5);",
      "  db.close();",
      "}",
      "process.stdout.write(`compact ${command}\\n`);",
    ].join("\n"),
    "utf8",
  );
  await chmod(bin, 0o755);
  return bin;
}

function serveEndpointSignal(url: string | undefined, res: import("node:http").ServerResponse): boolean {
  if (!url?.endsWith("/models")) {
    return false;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "rtk-runtime-test" }] }));
  return true;
}

function writeSse(res: import("node:http").ServerResponse, value: unknown): void {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function event(type: string, data: SessionEvent["data"]): SessionEvent {
  return {
    session_id: "session",
    run_id: "run",
    type,
    data,
    created_at: "2026-06-06T08:09:10.000Z",
  };
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}
