import { spawn } from "node:child_process";
import path from "node:path";
import { ensureDir } from "../util/fs.js";
import type { VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import type { SessionStore } from "../session/store.js";
import { resolveRtkStatus, rtkDbPath, rtkEnv, type RtkRuntime } from "./manager.js";
import { readRtkCommandStats, type RtkCommandStats } from "./stats.js";
import { runSandboxedProcess } from "../sandbox/runner.js";
import type { SandboxExecutionInfo } from "../sandbox/types.js";

export interface RtkShellCommandOptions {
  config: VllmAgentConfig;
  store: SessionStore;
  session_id: string;
  run_id?: string;
  tool_call_id?: string;
  tool_name: string;
  command: string;
  cwd: string;
  workspace: WorkspaceIdentity;
  env?: NodeJS.ProcessEnv;
  timeout_ms: number;
}

export interface RtkShellCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  command: string;
  rewritten_command?: string;
  rtk?: RtkCommandStats;
  sandbox?: SandboxExecutionInfo;
}

interface PreparedRtkCommand {
  command: string;
  original_command: string;
  rewritten_command?: string;
  db_path?: string;
  env: NodeJS.ProcessEnv;
  before_max_id: number;
}

export async function runRtkAwareShellCommand(options: RtkShellCommandOptions): Promise<RtkShellCommandResult> {
  const prepared = await prepareCommand(options);
  const result = await runShell(prepared.command, options.cwd, prepared.env, options.timeout_ms, options.config, options.workspace, prepared.original_command, prepared.rewritten_command);
  const rtk = await recordRtkSavings(options, prepared);
  return {
    ...result,
    command: prepared.original_command,
    rewritten_command: prepared.rewritten_command,
    rtk,
  };
}

async function prepareCommand(options: RtkShellCommandOptions): Promise<PreparedRtkCommand> {
  const env = options.env ?? process.env;
  const status = await resolveRtkStatus(options.config, { allowDownload: options.config.rtk.auto_download });
  if (!status.available || !status.binary_path || !options.run_id) {
    if (status.enabled && options.run_id) {
      recordRtkUnavailable(options, status.error);
    }
    return {
      command: options.command,
      original_command: options.command,
      env,
      before_max_id: 0,
    };
  }
  const runtime: RtkRuntime = {
    status: status as RtkRuntime["status"],
    bin_dir: path.dirname(status.binary_path),
  };
  const dbPath = rtkDbPath(options.session_id, options.run_id);
  await ensureDirForDb(dbPath);
  const rewritten = await rewriteCommand(runtime.status.binary_path, options.command, options.cwd, rtkEnv(runtime, dbPath, env));
  if (!rewritten || rewritten === options.command) {
    return {
      command: options.command,
      original_command: options.command,
      env,
      before_max_id: 0,
    };
  }
  const before = await readRtkCommandStats(dbPath);
  return {
    command: rewritten,
    original_command: options.command,
    rewritten_command: rewritten,
    db_path: dbPath,
    env: rtkEnv(runtime, dbPath, env),
    before_max_id: before.max_id,
  };
}

function recordRtkUnavailable(options: RtkShellCommandOptions, error?: string): void {
  options.store.appendEvent({
    session_id: options.session_id,
    run_id: options.run_id,
    type: "rtk.tool_savings",
    data: {
      tool_call_id: options.tool_call_id,
      tool_name: options.tool_name,
      original_command: options.command,
      rtk_commands: 0,
      input_tokens: 0,
      output_tokens: 0,
      saved_tokens: 0,
      savings_pct: 0,
      status: "unavailable",
      error,
    },
  });
}

async function rewriteCommand(binaryPath: string, command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const result = await runExecFile(binaryPath, ["rewrite", command], cwd, env, 5000);
  if ((result.code === 0 || result.code === 3) && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return undefined;
}

async function recordRtkSavings(options: RtkShellCommandOptions, prepared: PreparedRtkCommand): Promise<RtkCommandStats | undefined> {
  if (!prepared.db_path || !prepared.rewritten_command) {
    return undefined;
  }
  const stats = await readRtkCommandStats(prepared.db_path, prepared.before_max_id);
  if (stats.commands <= 0 && stats.saved_tokens <= 0) {
    return stats;
  }
  options.store.appendEvent({
    session_id: options.session_id,
    run_id: options.run_id,
    type: "rtk.tool_savings",
    data: {
      tool_call_id: options.tool_call_id,
      tool_name: options.tool_name,
      original_command: prepared.original_command,
      rewritten_command: prepared.rewritten_command,
      rtk_commands: stats.commands,
      input_tokens: stats.input_tokens,
      output_tokens: stats.output_tokens,
      saved_tokens: stats.saved_tokens,
      savings_pct: stats.savings_pct,
      status: "ok",
    },
  });
  return stats;
}

async function runShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  config: VllmAgentConfig,
  workspace: WorkspaceIdentity,
  originalCommand: string,
  rewrittenCommand?: string,
): Promise<Omit<RtkShellCommandResult, "command">> {
  return await runSandboxedProcess({
    config,
    workspace,
    command,
    shell: true,
    cwd,
    env,
    timeoutMs,
    originalCommand,
    rewrittenCommand,
  });
}

function runExecFile(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: 127, stdout, stderr: error.message });
    });
  });
}

async function ensureDirForDb(dbPath: string): Promise<void> {
  await ensureDir(path.dirname(dbPath));
}
