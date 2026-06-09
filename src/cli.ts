#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadApp, type AppOptions } from "./app.js";
import { userConfigPath } from "./config/config.js";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import { TuiApp } from "./tui/app.js";
import { EndpointSignals } from "./model/endpoint-signals.js";
import { SkillRegistry } from "./skills/registry.js";
import { ToolRegistry } from "./tools/registry.js";
import { randomId } from "./util/hash.js";
import { ensureDir } from "./util/fs.js";
import { fail } from "./util/limit.js";
import type { JsonObject, ToolCall } from "./types.js";
import {
  attachDaemonJob,
  cancelDaemonJob,
  daemonStatus,
  detachDaemonJob,
  queueDaemonGoal,
  queueDaemonRun,
  startDaemon,
} from "./daemon/supervisor.js";
import { runFinalAcceptance } from "./validation/acceptance.js";

interface ParsedCli extends AppOptions {
  json?: boolean;
  help?: boolean;
  print?: boolean;
  noAnimation?: boolean;
  initialView?: "setup";
  prompt?: string;
  debug?: string[];
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }
  if (parsed.debug) {
    await runDebug(parsed);
    return;
  }
  if (parsed.print) {
    await runPrint(parsed);
    return;
  }
  const app = await loadApp(parsed);
  try {
    await new TuiApp(app, {
      initialPrompt: parsed.prompt,
      initialView: parsed.initialView,
      stateDir: parsed.stateDir,
      noAnimation: parsed.noAnimation,
    }).run();
  } finally {
    closeApp(app);
  }
}

function closeApp(app: Awaited<ReturnType<typeof loadApp>>): void {
  app.runtime.dispose();
  app.store.close();
}

function parseArgs(argv: string[]): ParsedCli {
  const parsed: ParsedCli = {};
  const prompt: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--config") {
      parsed.config = requiredValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--workspace") {
      parsed.workspace = requiredValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--state-dir") {
      parsed.stateDir = requiredValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--print" || arg === "-p") {
      parsed.print = true;
      continue;
    }
    if (arg === "--no-animation") {
      parsed.noAnimation = true;
      continue;
    }
    if (arg === "debug") {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.debug = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "setup" && prompt.length === 0) {
      parsed.initialView = "setup";
      continue;
    }
    prompt.push(arg, ...argv.slice(i + 1));
    break;
  }
  parsed.prompt = prompt.join(" ").trim() || undefined;
  return parsed;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Inferoa

Usage:
  inferoa                         Launch the TUI
  inferoa "prompt"                Launch the TUI and submit an initial prompt
  inferoa setup                   Launch the TUI setup wizard
  inferoa --print "prompt"        Non-interactive print mode
  inferoa debug <command>         Machine/debug commands

Options:
  --config <path>                    Config YAML path
  --workspace <path>                 Workspace root
  --state-dir <path>                 State directory, defaults to ~/.inferoa
  --json                             JSON output for debug commands
  --no-animation                     Disable TUI intro animation

TUI commands:
  /setup /model /system /skills /tokenmaxxing /context /tools /sessions /jobs
  /todo /acceptance /help /clear /exit
  $                                  Open skill catalog

Debug commands:
  init [--force]                    Write ~/.inferoa/config.yaml
  setup
  status
  sessions
  tools list
  tools call <name> [json]
  events <session> [limit]
  archive <session>
  daemon start|status|jobs|run|goal|attach|detach|cancel ...
  acceptance [--daemon]
`);
}

async function runPrint(options: ParsedCli): Promise<void> {
  if (!options.prompt) {
    throw new Error("--print requires a prompt");
  }
  const app = await loadApp(options);
  try {
    const result = await app.runtime.run({
      prompt: options.prompt,
      client_id: randomId("print"),
      onDelta: options.json ? undefined : (text) => process.stdout.write(text),
    });
    if (!options.json) {
      process.stdout.write("\n");
    }
    print(
      {
        session: publicSession(result.session),
        content: result.content,
        tool_rounds: result.tool_rounds,
        tool_calls: result.tool_calls,
        duration_ms: result.duration_ms,
        tokens_used: result.tokens_used,
        rtk: result.rtk,
        goal_report: result.goal_report,
      },
      options.json,
    );
  } finally {
    closeApp(app);
  }
}

async function runDebug(options: ParsedCli): Promise<void> {
  const [command, ...rest] = options.debug ?? [];
  if (!command) {
    printHelp();
    return;
  }
  switch (command) {
    case "init":
      await debugInit(options, rest.includes("--force"));
      return;
    case "setup":
      await debugSetup(options);
      return;
    case "status":
      await debugStatus(options);
      return;
    case "sessions":
      await debugSessions(options);
      return;
    case "tools":
      await debugTools(options, rest);
      return;
    case "events":
      await debugEvents(options, rest);
      return;
    case "archive":
      await debugArchive(options, rest);
      return;
    case "daemon":
      await debugDaemon(options, rest);
      return;
    case "acceptance":
      await debugAcceptance(options, rest);
      return;
    default:
      throw new Error(`Unknown debug command: ${command}`);
  }
}

async function debugInit(options: ParsedCli, force: boolean): Promise<void> {
  if (options.stateDir) {
    process.env.INFEROA_STATE_DIR = options.stateDir;
  }
  const target = userConfigPath();
  await ensureDir(path.dirname(target));
  try {
    await fs.access(target);
    if (!force) {
      throw new Error(`Config already exists: ${target}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
      throw error;
    }
  }
  await fs.writeFile(target, YAML.stringify(DEFAULT_CONFIG), "utf8");
  console.log(`Wrote ${target}`);
}

async function debugSetup(options: ParsedCli): Promise<void> {
  const app = await loadApp(options);
  try {
    const signals = new EndpointSignals(app.config);
    const skills = new SkillRegistry(app.workspace, app.config);
    print(
      {
        workspace: { root: app.workspace.root, alias: app.workspace.alias },
        config_files: app.configFiles,
        model_setup: redactSecretFields(app.config.model_setup as unknown as JsonObject),
        endpoint_signals: await signals.snapshot(),
        skills: await skills.discover(),
      },
      options.json,
    );
  } finally {
    closeApp(app);
  }
}

async function debugStatus(options: ParsedCli): Promise<void> {
  const app = await loadApp(options);
  try {
    print({ ...(await app.runtime.status()), sessions: app.store.listSessions(app.workspace.id).map(publicSession) }, options.json);
  } finally {
    closeApp(app);
  }
}

async function debugSessions(options: ParsedCli): Promise<void> {
  const app = await loadApp(options);
  try {
    print(
      {
        workspace: { root: app.workspace.root, alias: app.workspace.alias },
        sessions: app.store.listSessions(app.workspace.id).map(publicSession),
      },
      options.json,
    );
  } finally {
    closeApp(app);
  }
}

async function debugTools(options: ParsedCli, rest: string[]): Promise<void> {
  const [subcommand, name, json] = rest;
  const app = await loadApp(options);
  try {
    const registry = new ToolRegistry(app.config, app.workspace, app.store);
    if (subcommand === "list" || !subcommand) {
      print({ tools: registry.list() }, options.json);
      return;
    }
    if (subcommand !== "call" || !name) {
      throw new Error("Usage: inferoa debug tools call <name> [json]");
    }
    const session = app.store.createSession(app.workspace, `tool:${name}`);
    const args = json ? (JSON.parse(json) as JsonObject) : {};
    const result = await registry.call({ id: randomId("tc"), name, arguments: args } satisfies ToolCall, {
      session_id: session.session_id,
      run_id: randomId("run"),
    });
    print({ session: publicSession(session), result }, options.json);
  } finally {
    closeApp(app);
  }
}

async function debugEvents(options: ParsedCli, rest: string[]): Promise<void> {
  const [sessionPrefix, limit = "50"] = rest;
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa debug events <session> [limit]");
  }
  const app = await loadApp(options);
  try {
    const session = app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    print({ session: publicSession(session), events: app.store.listEvents(session.session_id, Number(limit)) }, options.json);
  } finally {
    closeApp(app);
  }
}

async function debugArchive(options: ParsedCli, rest: string[]): Promise<void> {
  const [sessionPrefix] = rest;
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa debug archive <session>");
  }
  const app = await loadApp(options);
  try {
    const session = app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    app.store.appendEvent({ session_id: session.session_id, type: "session.archived", data: { reason: "debug archive" } });
    app.store.updateSession(session.session_id, { status: "archived" });
    const archived = app.store.getSession(session.session_id);
    print({ session: archived ? publicSession(archived) : undefined }, options.json);
  } finally {
    closeApp(app);
  }
}

async function debugDaemon(options: ParsedCli, rest: string[]): Promise<void> {
  const [subcommand, ...args] = rest;
  switch (subcommand) {
    case "start":
      print(await startDaemon({ stateDir: options.stateDir, foreground: args.includes("--foreground") }), options.json);
      return;
    case "status":
      print(await daemonStatus(options.stateDir), options.json);
      return;
    case "jobs": {
      const status = await daemonStatus(options.stateDir);
      print({ jobs: status.jobs }, options.json);
      return;
    }
    case "run": {
      const prompt = args.join(" ");
      const app = await loadApp(options);
      try {
        const job = await queueDaemonRun({
          stateDir: options.stateDir,
          workspaceRoot: app.workspace.root,
          prompt,
          configPath: app.configFiles[0],
        });
        const status = await startDaemon({ stateDir: options.stateDir });
        print({ job, daemon: status }, options.json);
      } finally {
        closeApp(app);
      }
      return;
    }
    case "goal": {
      const sessionId = requiredArg(args, 0, "session");
      const maxIterations = optionalPositiveIntFlag(args, "--max-iterations");
      const app = await loadApp(options);
      try {
        const job = await queueDaemonGoal({
          stateDir: options.stateDir,
          workspaceRoot: app.workspace.root,
          sessionId,
          maxIterations,
          configPath: app.configFiles[0],
        });
        const status = await startDaemon({ stateDir: options.stateDir });
        print({ job, daemon: status }, options.json);
      } finally {
        closeApp(app);
      }
      return;
    }
    case "attach":
      print(await attachDaemonJob(options.stateDir, requiredArg(args, 0, "job"), { follow: args.includes("--follow") }), options.json);
      return;
    case "detach":
      print(await detachDaemonJob(options.stateDir, requiredArg(args, 0, "job")), options.json);
      return;
    case "cancel":
      print(await cancelDaemonJob(options.stateDir, requiredArg(args, 0, "job")), options.json);
      return;
    default:
      throw new Error("Usage: inferoa debug daemon start|status|jobs|run|goal|attach|detach|cancel ...");
  }
}

async function debugAcceptance(options: ParsedCli, rest: string[]): Promise<void> {
  const result = await runFinalAcceptance({
    workspaceRoot: path.resolve(options.workspace ?? process.cwd()),
    stateDir: options.stateDir,
    configPath: options.config,
    daemon: rest.includes("--daemon"),
  });
  print(result, options.json);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function requiredArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function optionalPositiveIntFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const raw = args[index + 1];
  const value = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return value;
}

function print(value: unknown, json = false): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(YAML.stringify(value));
}

function publicSession(session: { session_id: string; title: string; status: string; created_at: string; updated_at: string }): Record<string, unknown> {
  return {
    session_id: session.session_id,
    title: session.title,
    status: session.status,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

function redactSecretFields(value: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = key.includes("api_key") && typeof item === "string" ? "<redacted>" : item;
  }
  return output;
}

main().catch((error) => {
  const result = fail("cli_error", error instanceof Error ? error.message : String(error));
  console.error(result.summary);
  process.exitCode = 1;
});
