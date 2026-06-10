import { constants, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { singlePathInput } from "./path-input.js";
import { runSandboxedProcess } from "../sandbox/runner.js";
import type { SandboxCapability, SandboxExecutionInfo } from "../sandbox/types.js";
import type { VllmAgentConfig, WorkspaceIdentity } from "../types.js";

export function homeStateDir(): string {
  return path.join(os.homedir(), ".inferoa");
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isExecutable(command: string): Promise<boolean> {
  const result = await runSmallCommand("command", ["-v", command], process.cwd(), 2000);
  return result.code === 0;
}

export async function realpathOrResolve(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

export async function findGitRoot(cwd: string): Promise<string | undefined> {
  const result = await runSmallCommand("git", ["rev-parse", "--show-toplevel"], cwd, 2000);
  if (result.code === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return undefined;
}

export async function runSmallCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: RunSmallCommandOptions = {},
): Promise<{ code: number | null; stdout: string; stderr: string; sandbox?: SandboxExecutionInfo }> {
  if (options.config && options.workspace) {
    const useShell = command === "command";
    const result = await runSandboxedProcess({
      config: options.config,
      workspace: options.workspace,
      command: useShell ? [command, ...args.map(shellQuote)].join(" ") : command,
      args: useShell ? undefined : args,
      shell: useShell,
      cwd,
      env: options.env ?? process.env,
      timeoutMs,
      capabilities: options.capabilities,
    });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr, sandbox: result.sandbox };
  }
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: command === "command" });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: 127, stdout, stderr: String(error) });
    });
  });
}

export interface RunSmallCommandOptions {
  config?: VllmAgentConfig;
  workspace?: WorkspaceIdentity;
  env?: NodeJS.ProcessEnv;
  capabilities?: SandboxCapability[];
}

export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function resolveInside(base: string, requested: string): string {
  const normalizedRequest = requested.trim() === "/" ? "." : requested;
  const resolved = path.resolve(base, normalizedRequest);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${requested}`);
  }
  return resolved;
}

export function resolveReadablePath(base: string, requested: string): { file: string; displayPath: string; external: boolean } {
  if (requested.trim() === "/") {
    return { file: base, displayPath: ".", external: false };
  }
  const input = normalizeLocalPathInput(requested);
  if (path.isAbsolute(input)) {
    return { file: input, displayPath: input, external: true };
  }
  const file = resolveInside(base, input);
  return { file, displayPath: input, external: false };
}

export function resolveWritablePath(base: string, requested: string, allowExternal: boolean): { file: string; displayPath: string; external: boolean } {
  const resolved = resolveReadablePath(base, requested);
  if (resolved.external && !allowExternal) {
    throw new Error(`Path escapes workspace: ${requested}`);
  }
  return resolved;
}

export function isExternalLocalPath(base: string, requested: unknown): boolean {
  if (typeof requested !== "string") {
    return false;
  }
  const input = normalizeLocalPathInput(requested);
  const resolved = path.isAbsolute(input) ? input : path.resolve(base, input);
  const relative = path.relative(base, resolved);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

export function normalizeLocalPathInput(requested: string): string {
  const trimmed = requested.trim();
  const input = singlePathInput(trimmed) ?? trimmed;
  if (input.startsWith("file://")) {
    return fileURLToPath(input);
  }
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
