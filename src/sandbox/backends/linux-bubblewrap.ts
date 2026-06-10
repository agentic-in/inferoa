import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SandboxAvailability, SandboxBackendAdapter, SandboxBuildRequest, SandboxInvocation, SandboxPolicy } from "../types.js";
import { sandboxInfo } from "../metadata.js";
import { linuxBubblewrapPlatformBaselineArgs, type LinuxBubblewrapProcMode } from "./linux-platform-baseline.js";

export class LinuxBubblewrapBackend implements SandboxBackendAdapter {
  readonly id = "linux_bubblewrap" as const;

  async available(): Promise<SandboxAvailability> {
    if (process.platform !== "linux") {
      return { available: false, reason: "bubblewrap sandbox is only available on Linux" };
    }
    const executable = await findExecutable("bwrap");
    if (!executable) {
      return { available: false, reason: "bubblewrap (bwrap) was not found on PATH" };
    }
    const probe = await bubblewrapProcMode(executable);
    return probe.available ? { available: true, executable } : { available: false, reason: probe.reason };
  }

  async build(policy: SandboxPolicy, request: SandboxBuildRequest): Promise<SandboxInvocation> {
    const executable = (await findExecutable("bwrap")) ?? "bwrap";
    const command = request.shell ? ["/bin/sh", "-c", request.command] : [request.command, ...(request.args ?? [])];
    await ensureAgentWritableRoots(policy);
    const readOnlyMounts = await readOnlyMountsForPolicy(policy);
    const procMode = (await bubblewrapProcMode(executable)).mode ?? "procfs";
    const args = bubblewrapArgs(policy, command, readOnlyMounts, { procMode });
    return {
      command: executable,
      args,
      shell: false,
      env: request.env,
      info: sandboxInfo(policy, request),
    };
  }

  explainFailure(reason: string): string {
    return `Linux sandbox unavailable: ${reason}. Install bubblewrap or run /sandbox off to disable OS sandboxing.`;
  }
}

export interface BubblewrapReadOnlyMount {
  source: string;
  dest: string;
}

export interface BubblewrapArgsOptions {
  procMode?: LinuxBubblewrapProcMode;
}

export function bubblewrapArgs(policy: SandboxPolicy, command: string[], readOnlyMounts?: BubblewrapReadOnlyMount[], options: BubblewrapArgsOptions = {}): string[] {
  const args = linuxBubblewrapPlatformBaselineArgs(options.procMode);
  if (policy.network === "restricted") {
    args.push("--unshare-net");
  }
  for (const root of policy.writableRoots) {
    args.push("--bind", root, root);
  }
  for (const mount of readOnlyMounts ?? defaultReadOnlyMounts(policy)) {
    args.push("--ro-bind", mount.source, mount.dest);
  }
  for (const root of policy.agentWritableRoots) {
    args.push("--bind", root, root);
  }
  args.push("--chdir", policy.cwd, "--", ...command);
  return args;
}

export async function readOnlyMountsForPolicy(policy: SandboxPolicy): Promise<BubblewrapReadOnlyMount[]> {
  return readOnlyMountsFor([...policy.readOnlyRoots, ...policy.protectedWritePaths], policy.agentWritableRoots);
}

async function readOnlyMountsFor(paths: string[], agentWritableRoots: string[] = []): Promise<BubblewrapReadOnlyMount[]> {
  const syntheticDir = await syntheticEmptyDir();
  const out: BubblewrapReadOnlyMount[] = [];
  const writableCarveOuts = uniquePaths(agentWritableRoots);
  const mountedReadOnlyDests: string[] = [];
  for (const target of uniquePaths(paths).sort(comparePathDepth)) {
    try {
      await fs.access(target, constants.F_OK);
      out.push({ source: target, dest: target });
      mountedReadOnlyDests.push(target);
    } catch {
      if (hasReadOnlyAncestor(target, mountedReadOnlyDests, writableCarveOuts)) {
        continue;
      }
      out.push({ source: syntheticDir, dest: target });
      mountedReadOnlyDests.push(target);
    }
  }
  return out;
}

function hasReadOnlyAncestor(target: string, readOnlyDests: string[], writableCarveOuts: string[]): boolean {
  if (writableCarveOuts.some((root) => isStrictDescendant(target, root))) {
    return false;
  }
  return readOnlyDests.some((root) => isStrictDescendant(target, root));
}

function isStrictDescendant(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function comparePathDepth(left: string, right: string): number {
  return pathDepth(left) - pathDepth(right);
}

function pathDepth(value: string): number {
  return path.resolve(value).split(path.sep).filter(Boolean).length;
}

function defaultReadOnlyMounts(policy: SandboxPolicy): BubblewrapReadOnlyMount[] {
  return uniquePaths([...policy.readOnlyRoots, ...policy.protectedWritePaths]).map((target) => ({ source: target, dest: target }));
}

async function ensureAgentWritableRoots(policy: SandboxPolicy): Promise<void> {
  if (policy.mode !== "workspace_write") {
    return;
  }
  for (const root of policy.agentWritableRoots) {
    await fs.mkdir(root, { recursive: true });
  }
}

async function syntheticEmptyDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), "inferoa-bwrap-empty-dir");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function findExecutable(command: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, command);
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return undefined;
}

interface BubblewrapProcProbe {
  available: boolean;
  mode?: LinuxBubblewrapProcMode;
  reason?: string;
}

const procModeCache = new Map<string, Promise<BubblewrapProcProbe>>();

function bubblewrapProcMode(executable: string): Promise<BubblewrapProcProbe> {
  let cached = procModeCache.get(executable);
  if (!cached) {
    cached = detectBubblewrapProcMode(executable);
    procModeCache.set(executable, cached);
  }
  return cached;
}

async function detectBubblewrapProcMode(executable: string): Promise<BubblewrapProcProbe> {
  const procfs = await runBwrapProbe(executable, linuxBubblewrapPlatformBaselineArgs("procfs"));
  if (procfs.code === 0) {
    return { available: true, mode: "procfs" };
  }
  const readonlyBind = await runBwrapProbe(executable, linuxBubblewrapPlatformBaselineArgs("readonly_bind"));
  if (readonlyBind.code === 0) {
    return { available: true, mode: "readonly_bind" };
  }
  return { available: false, reason: readonlyBind.stderr || procfs.stderr || "bubblewrap baseline probe failed" };
}

function runBwrapProbe(executable: string, baselineArgs: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...baselineArgs, "--", "true"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: 124, stderr: "bubblewrap baseline probe timed out" });
    }, 3000);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr: stderr.trim() });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: 127, stderr: error.message });
    });
  });
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => path.resolve(item)))];
}
