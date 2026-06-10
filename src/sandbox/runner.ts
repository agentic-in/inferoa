import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { planSandboxInvocation, sandboxBlockedJson } from "./planner.js";
import type { SandboxCapability, SandboxExecutionInfo } from "./types.js";

export interface SandboxRunOptions {
  config: VllmAgentConfig;
  workspace: WorkspaceIdentity;
  command: string;
  args?: string[];
  shell?: boolean;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdin?: string | Buffer;
  originalCommand?: string;
  rewrittenCommand?: string;
  capabilities?: SandboxCapability[];
}

export interface SandboxProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  sandbox: SandboxExecutionInfo;
}

export interface SandboxSpawnOptions extends Omit<SandboxRunOptions, "timeoutMs" | "stdin"> {}

export async function runSandboxedProcess(options: SandboxRunOptions): Promise<SandboxProcessResult> {
  const planned = await planSandboxInvocation({
    config: options.config,
    workspace: options.workspace,
    command: options.command,
    args: options.args,
    shell: options.shell ?? false,
    cwd: options.cwd,
    env: options.env ?? process.env,
    originalCommand: options.originalCommand,
    rewrittenCommand: options.rewrittenCommand,
    capabilities: options.capabilities,
  });
  if (!planned.ok) {
    return { code: 126, stdout: "", stderr: planned.stderr, timed_out: false, sandbox: planned.info };
  }
  return await new Promise((resolve) => {
    const child = spawn(planned.invocation.command, planned.invocation.args, {
      cwd: options.cwd,
      env: planned.invocation.env,
      shell: planned.invocation.shell,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      setTimeout(() => killProcessTree(child, "SIGKILL"), 2000).unref();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const sandbox = runtimeSandboxInfo(planned.invocation.info, code, stderr);
      resolve({ code, stdout, stderr, timed_out: timedOut, sandbox });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: 127, stdout, stderr: error.message, timed_out: timedOut, sandbox: planned.invocation.info });
    });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export async function spawnSandboxedShell(options: SandboxSpawnOptions): Promise<{ child?: ChildProcessWithoutNullStreams; sandbox: SandboxExecutionInfo; error?: string }> {
  const planned = await planSandboxInvocation({
    config: options.config,
    workspace: options.workspace,
    command: options.command,
    args: options.args,
    shell: options.shell ?? true,
    cwd: options.cwd,
    env: options.env ?? process.env,
    originalCommand: options.originalCommand,
    rewrittenCommand: options.rewrittenCommand,
    capabilities: options.capabilities,
  });
  if (!planned.ok) {
    return { sandbox: planned.info, error: planned.stderr };
  }
  const child = spawn(planned.invocation.command, planned.invocation.args, {
    cwd: options.cwd,
    env: planned.invocation.env,
    shell: planned.invocation.shell,
    detached: process.platform !== "win32",
  });
  return { child, sandbox: planned.invocation.info };
}

export { sandboxBlockedJson };

export function runtimeSandboxInfo(info: SandboxExecutionInfo, code: number | null, stderr: string): SandboxExecutionInfo {
  if (code === 0 || info.mode === "off" || info.blocked) {
    return info;
  }
  const policyRule = runtimeSandboxPolicyRule(info, stderr);
  if (policyRule) {
    return {
      ...info,
      blocked: true,
      block_stage: "runtime",
      reason: runtimeSandboxReason(policyRule, stderr),
      policy_rule: policyRule,
      suggested_action: suggestedActionForPolicyRule(policyRule),
    };
  }
  return info;
}

function runtimeSandboxPolicyRule(info: SandboxExecutionInfo, stderr: string): string | undefined {
  if (sandboxDenialSignal(stderr)) {
    return classifySandboxDenial(info, stderr);
  }
  if (!stderr.trim() && networkCommandLikelyDeniedByPolicy(info)) {
    return "network_restricted";
  }
  return undefined;
}

function runtimeSandboxReason(policyRule: string, stderr: string): string {
  const lastLine = stderr.trim().split(/\r?\n/).slice(-1)[0];
  if (lastLine) {
    return lastLine;
  }
  if (policyRule === "network_restricted") {
    return "Network is restricted inside the sandbox.";
  }
  return "Command was blocked by the OS sandbox.";
}

function sandboxDenialSignal(stderr: string): boolean {
  return /operation not permitted|permission denied|read-only file system|sandbox-exec|bwrap|bubblewrap|network is unreachable|could not resolve host|\bEPERM\b|\bEACCES\b|\bENETUNREACH\b|\bEHOSTUNREACH\b/i.test(
    stderr,
  );
}

function classifySandboxDenial(info: SandboxExecutionInfo, stderr: string): string {
  if (networkSandboxDenied(info, stderr)) {
    return "network_restricted";
  }
  const text = `${info.command}\n${info.rewritten_command ?? ""}\n${stderr}`;
  if (/\.git(?:\/|['"`:\s]|$)/.test(text) || (/\bgit\b/.test(text) && !info.capabilities?.includes("git_metadata_write"))) {
    return "git_metadata_requires_capability";
  }
  if (protectedAgentMetadataDenied(text)) {
    return "protected_metadata_write";
  }
  const blockedPath = firstAbsolutePath(stderr);
  if (blockedPath) {
    if (blockedPath.startsWith("/dev/")) {
      return "platform_baseline_denied";
    }
    if (!pathInside(blockedPath, info.workspace_root)) {
      return "outside_workspace_write";
    }
  }
  return "sandbox_runtime_denied";
}

function networkSandboxDenied(info: SandboxExecutionInfo, stderr: string): boolean {
  if (/network|resolve host|ENETUNREACH|EHOSTUNREACH|connect .*E(?:PERM|ACCES)|E(?:PERM|ACCES).*connect/i.test(stderr)) {
    return true;
  }
  if (info.network !== "restricted" || !/\bE(?:PERM|ACCES)\b/i.test(stderr)) {
    return false;
  }
  const command = `${info.rewritten_command ?? ""}\n${info.command}`.toLowerCase();
  return /\b(curl|wget|ssh|scp|rsync|nc|netcat|telnet|ping)\b|net\.connect|fetch\(|https?:\/\//.test(command);
}

function networkCommandLikelyDeniedByPolicy(info: SandboxExecutionInfo): boolean {
  return info.backend !== "none" && info.network === "restricted" && networkCommandIntent(info);
}

function networkCommandIntent(info: SandboxExecutionInfo): boolean {
  const command = `${info.rewritten_command ?? ""}\n${info.command}`.toLowerCase();
  return /\b(curl|wget)\b\s+\S+|\b(ssh|scp|rsync|nc|netcat|telnet|ping)\b\s+[A-Za-z0-9_.:-]+|net\.connect\s*\(|fetch\s*\(|https?:\/\//.test(command);
}

function protectedAgentMetadataDenied(text: string): boolean {
  if (/\.(?:codex|claude|agents)(?:\/|['"`:\s]|$)/.test(text)) {
    return true;
  }
  const matches = Array.from(text.matchAll(/(?:^|[\/\s'"`:])(\.inferoa(?:\/[^\s'"`:;]*)?)(?=$|[\s'"`:;])/g), (match) => match[1]).filter(
    (match): match is string => Boolean(match),
  );
  if (!matches) {
    return false;
  }
  return matches.some((match) => {
    const relative = match.replace(/^\.inferoa\/?/, "");
    if (!relative) {
      return true;
    }
    return !/^(?:tmp|exports|artifacts|evidence|cache|sandbox)(?:\/|$)/.test(relative);
  });
}

function suggestedActionForPolicyRule(policyRule: string): string {
  switch (policyRule) {
    case "outside_workspace_write":
      return "Write inside the workspace, use tmp, or add a trusted sandbox.extra_writable_roots entry.";
    case "protected_metadata_write":
      return "Use agent artifact paths such as .inferoa/exports or avoid modifying protected agent metadata.";
    case "git_metadata_requires_capability":
      return "Use a Git tool or a non-dangerous Git metadata command; destructive Git operations still require separate approval.";
    case "network_restricted":
      return "Run /sandbox network on only if this command should reach the network.";
    case "platform_baseline_denied":
      return "This looks like a missing platform baseline allowance; report the command and keep sandbox enabled.";
    default:
      return "Inspect /sandbox status, request a narrower capability, or run /sandbox off if you trust this command.";
  }
}

function firstAbsolutePath(text: string): string | undefined {
  const match = /(?:^|[\s'"`])((?:\/[A-Za-z0-9._@%+=:, -]+)+)/.exec(text);
  return match?.[1]?.trim();
}

function pathInside(candidate: string, root: string): boolean {
  const relative = candidate.startsWith("/") ? candidate : "";
  if (!relative) {
    return false;
  }
  const normalized = relative.replace(/\/+$/, "");
  const base = root.replace(/\/+$/, "");
  return normalized === base || normalized.startsWith(`${base}/`);
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
