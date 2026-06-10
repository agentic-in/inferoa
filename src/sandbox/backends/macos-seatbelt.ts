import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { SandboxAvailability, SandboxBackendAdapter, SandboxBuildRequest, SandboxInvocation, SandboxPolicy } from "../types.js";
import { sandboxInfo } from "../metadata.js";
import { macosSeatbeltPlatformBaseline } from "./macos-platform-baseline.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export class MacosSeatbeltBackend implements SandboxBackendAdapter {
  readonly id = "macos_seatbelt" as const;

  async available(): Promise<SandboxAvailability> {
    if (process.platform !== "darwin") {
      return { available: false, reason: "macOS Seatbelt sandbox is only available on macOS" };
    }
    try {
      await fs.access(SANDBOX_EXEC, constants.X_OK);
      return { available: true, executable: SANDBOX_EXEC };
    } catch {
      return { available: false, reason: `${SANDBOX_EXEC} is not executable on this system` };
    }
  }

  async build(policy: SandboxPolicy, request: SandboxBuildRequest): Promise<SandboxInvocation> {
    const command = request.shell ? ["/bin/sh", "-c", request.command] : [request.command, ...(request.args ?? [])];
    await ensureAgentWritableRoots(policy);
    const seatbeltPathsPolicy = {
      ...policy,
      writableRoots: await seatbeltPathVariantsFor(policy.writableRoots),
      readOnlyRoots: await seatbeltPathVariantsFor(policy.readOnlyRoots),
      protectedCreatePaths: await seatbeltPathVariantsFor(policy.protectedCreatePaths),
      protectedWritePaths: await seatbeltPathVariantsFor(policy.protectedWritePaths),
      agentWritableRoots: await seatbeltPathVariantsFor(policy.agentWritableRoots),
    };
    return {
      command: SANDBOX_EXEC,
      args: ["-p", seatbeltPolicy(seatbeltPathsPolicy), "--", ...command],
      shell: false,
      env: request.env,
      info: sandboxInfo(policy, request),
    };
  }

  explainFailure(reason: string): string {
    return `macOS sandbox unavailable: ${reason}`;
  }
}

async function seatbeltPathVariantsFor(paths: string[]): Promise<string[]> {
  const variants = await Promise.all(paths.map(seatbeltPathVariants));
  return [...new Set(variants.flat().map((item) => path.resolve(item)))];
}

async function seatbeltPathVariants(target: string): Promise<string[]> {
  const variants = [path.resolve(target)];
  try {
    variants.push(await fs.realpath(target));
    return variants;
  } catch {
    // Seatbelt evaluates canonical vnode paths. For paths that do not exist
    // yet, canonicalize the nearest existing parent and append the missing tail.
  }
  const missingParts: string[] = [];
  let cursor = path.resolve(target);
  while (cursor && cursor !== path.dirname(cursor)) {
    missingParts.unshift(path.basename(cursor));
    cursor = path.dirname(cursor);
    try {
      variants.push(path.join(await fs.realpath(cursor), ...missingParts));
      return variants;
    } catch {
      // Keep walking upward.
    }
  }
  return variants;
}

export function seatbeltPolicy(policy: SandboxPolicy): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    ...macosSeatbeltPlatformBaseline(),
  ];
  if (policy.writableRoots.length === 0) {
    lines.push("(deny file-write*)");
  } else {
    lines.push(
      "(deny file-write*",
      `  (require-all ${policy.writableRoots.map((root) => `(require-not (subpath ${seatbeltString(root)}))`).join(" ")})`,
      ")",
    );
  }
  for (const protectedPath of policy.protectedWritePaths) {
    lines.push(`(deny file-write* (literal ${seatbeltString(protectedPath)}))`);
    lines.push(`(deny file-write* (subpath ${seatbeltString(protectedPath)}))`);
  }
  for (const createPath of policy.protectedCreatePaths) {
    lines.push(`(deny file-write-create (literal ${seatbeltString(createPath)}))`);
  }
  for (const agentRoot of policy.agentWritableRoots) {
    lines.push(`(allow file-write* (literal ${seatbeltString(agentRoot)}))`);
    lines.push(`(allow file-write* (subpath ${seatbeltString(agentRoot)}))`);
  }
  if (policy.network === "restricted") {
    lines.push("(deny network*)");
  }
  return `${lines.join("\n")}\n`;
}

async function ensureAgentWritableRoots(policy: SandboxPolicy): Promise<void> {
  if (policy.mode !== "workspace_write") {
    return;
  }
  for (const root of policy.agentWritableRoots) {
    await fs.mkdir(root, { recursive: true });
  }
}

function seatbeltString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
