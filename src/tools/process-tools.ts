import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonObject, ToolResult } from "../types.js";
import { resolveInside } from "../util/fs.js";
import { fail, ok, truncateText } from "../util/limit.js";
import { randomId } from "../util/hash.js";
import type { ToolExecutionContext } from "./context.js";
import { runRtkAwareShellCommand } from "../rtk/command.js";
import { sandboxBlockedJson, spawnSandboxedShell } from "../sandbox/runner.js";
import { blockedSandboxInfoToJson, sandboxInfoToJson } from "../sandbox/types.js";

interface LiveProcess {
  child: ChildProcessWithoutNullStreams;
  session_id: string;
  process_id: string;
}

const liveProcesses = new Map<string, LiveProcess>();

function key(sessionId: string, processId: string): string {
  return `${sessionId}:${processId}`;
}

export async function runCommand(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const command = String(args.command);
  const cwd = resolveInside(context.workspace.root, String(args.cwd ?? "."));
  const env = {
    ...process.env,
    ...(typeof args.env === "object" && args.env ? stringEnv(args.env as Record<string, unknown>) : {}),
  };
  if (args.background) {
    const processId = randomId("p");
    const spawned = await spawnSandboxedShell({
      config: context.config,
      workspace: context.workspace,
      command,
      cwd,
      env,
      shell: true,
    });
    if (!spawned.child) {
      return fail("sandbox_blocked", spawned.error ?? "Sandbox blocked background command", {
        sandbox: sandboxBlockedJson(spawned.sandbox),
      });
    }
    const child = spawned.child;
    context.store.upsertProcess({
      session_id: context.session_id,
      process_id: processId,
      pid: child.pid,
      command,
      cwd,
      status: "running",
    });
    context.store.appendEvent({
      session_id: context.session_id,
      run_id: context.run_id,
      type: "process.started",
      data: { process_id: processId, pid: child.pid, command, cwd, sandbox: sandboxInfoToJson(spawned.sandbox) },
    });
    liveProcesses.set(key(context.session_id, processId), { child, session_id: context.session_id, process_id: processId });
    child.stdout.on("data", (chunk) => {
      safeStoreWrite(() => context.store.appendProcessOutput(context.session_id, processId, "stdout", String(chunk)));
    });
    child.stderr.on("data", (chunk) => {
      safeStoreWrite(() => context.store.appendProcessOutput(context.session_id, processId, "stderr", String(chunk)));
    });
    child.on("close", (code) => {
      safeStoreWrite(() => {
        context.store.upsertProcess({
          session_id: context.session_id,
          process_id: processId,
          pid: child.pid,
          command,
          cwd,
          status: "stopped",
          exit_code: code,
        });
        context.store.appendEvent({
          session_id: context.session_id,
          run_id: context.run_id,
          type: "process.stopped",
          data: { process_id: processId, code },
        });
      });
      liveProcesses.delete(key(context.session_id, processId));
    });
    return ok(`Started background process ${processId}`, { process_id: processId, pid: child.pid ?? null, command, cwd, sandbox: blockedSandboxInfoToJson(spawned.sandbox) });
  }

  const timeoutMs = typeof args.timeout_ms === "number" ? Math.max(100, Math.min(args.timeout_ms, 600_000)) : 120_000;
  const result = await runRtkAwareShellCommand({
    config: context.config,
    store: context.store,
    session_id: context.session_id,
    run_id: context.run_id,
    tool_call_id: context.tool_call_id,
    tool_name: context.tool_name ?? "run_command",
    command,
    cwd,
    workspace: context.workspace,
    env,
    timeout_ms: timeoutMs,
  });
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const truncated = truncateText(combined);
  const resource =
    truncated.truncated || combined.length > 24_000
      ? context.store.putResource(context.session_id, "command.output", combined, {
          command,
          cwd,
          code: result.code,
          timed_out: result.timed_out,
        }).uri
      : undefined;
  context.store.appendEvent({
    session_id: context.session_id,
    run_id: context.run_id,
    type: "tool.shell.completed",
    data: {
      command,
      rewritten_command: result.rewritten_command,
      cwd,
      code: result.code,
      timed_out: result.timed_out,
      sandbox: blockedSandboxInfoToJson(result.sandbox),
      resource_uri: resource,
    },
  });
  return {
    ok: result.code === 0 && !result.timed_out,
    summary: `Command exited ${result.code}${result.timed_out ? " after timeout" : ""}`,
    data: {
      command,
      cwd,
      code: result.code,
      timed_out: result.timed_out,
      output: truncated.text,
      sandbox: blockedSandboxInfoToJson(result.sandbox),
    },
    resource_uri: resource,
    error:
      result.code === 0 && !result.timed_out
        ? undefined
        : { code: result.timed_out ? "command_timeout" : result.sandbox?.blocked ? "sandbox_blocked" : "command_failed", message: result.stderr || result.stdout },
  };
}

export async function readProcess(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const processId = String(args.process_id);
  const sinceSeq = typeof args.since_seq === "number" ? args.since_seq : 0;
  const maxBytes = typeof args.max_bytes === "number" ? Math.max(1, Math.min(args.max_bytes, 100_000)) : 24_000;
  const output = context.store.readProcessOutput(context.session_id, processId, sinceSeq, maxBytes);
  return ok(`Read process ${processId} through seq ${output.seq}`, {
    process_id: processId,
    since_seq: sinceSeq,
    next_seq: output.seq,
    output: output.text,
    live: liveProcesses.has(key(context.session_id, processId)),
  });
}

export async function writeProcess(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const processId = String(args.process_id);
  const live = liveProcesses.get(key(context.session_id, processId));
  if (!live) {
    return fail("process_not_live", `Process is not live in this runtime: ${processId}`);
  }
  live.child.stdin.write(String(args.input));
  if (args.close_stdin) {
    live.child.stdin.end();
  }
  context.store.appendEvent({
    session_id: context.session_id,
    run_id: context.run_id,
    type: "process.stdin",
    data: { process_id: processId, bytes: Buffer.byteLength(String(args.input)), close_stdin: Boolean(args.close_stdin) },
  });
  return ok(`Wrote stdin to ${processId}`, { process_id: processId });
}

export async function stopProcess(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const processId = String(args.process_id);
  const live = liveProcesses.get(key(context.session_id, processId));
  if (!live) {
    return fail("process_not_live", `Process is not live in this runtime: ${processId}`);
  }
  const signal = String(args.signal ?? "SIGTERM") as NodeJS.Signals;
  killProcessTree(live.child, signal);
  context.store.appendEvent({
    session_id: context.session_id,
    run_id: context.run_id,
    type: "process.stop_requested",
    data: { process_id: processId, signal },
  });
  return ok(`Sent ${signal} to ${processId}`, { process_id: processId, signal });
}

function stringEnv(env: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([name, value]) => [name, String(value)]));
}

function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        child.kill(signal);
      }
      return;
    }
  }
  child.kill(signal);
}

function safeStoreWrite(write: () => void): void {
  try {
    write();
  } catch {
    // Process output can arrive after a test or session has closed its store.
  }
}
