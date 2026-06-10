import os from "node:os";
import path from "node:path";
import type { SandboxBackend, SandboxMode, SandboxNetworkMode, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import type { SandboxBackendId, SandboxCapability, SandboxPolicy } from "./types.js";

const PROTECTED_AGENT_METADATA_NAMES = [".claude", ".codex", ".agents"];
const INFEROA_AGENT_WRITABLE_NAMES = ["tmp", "exports", "artifacts", "evidence", "cache", "sandbox"];
const INFEROA_PROTECTED_NAMES = ["config", "secrets", "credentials", "plugins", "skills", "sessions", "state"];

export interface ResolveSandboxPolicyOptions {
  config: VllmAgentConfig;
  workspace: WorkspaceIdentity;
  cwd: string;
  capabilities?: SandboxCapability[];
  command?: string;
}

export function resolveSandboxPolicy(options: ResolveSandboxPolicyOptions): SandboxPolicy {
  const sandbox = normalizeSandboxConfig(options.config);
  const capabilities = new Set<SandboxCapability>(options.capabilities ?? []);
  for (const capability of inferCapabilities(options.command ?? "")) {
    capabilities.add(capability);
  }
  const workspaceRoot = path.resolve(options.workspace.root);
  const cwd = path.resolve(options.cwd);
  const writableRoots = sandbox.mode === "workspace_write" ? uniquePaths([workspaceRoot, os.tmpdir(), ...sandbox.extra_writable_roots]) : [];
  const metadataPolicy = sandbox.mode === "workspace_write"
    ? protectedMetadataPolicy(workspaceRoot, capabilities.has("git_metadata_write"))
    : { readOnlyRoots: [], protectedCreatePaths: [], protectedWritePaths: [], agentWritableRoots: [] };
  return {
    mode: sandbox.mode,
    backend: resolveBackend(sandbox.backend, sandbox.mode),
    network: sandbox.network,
    workspaceRoot,
    cwd,
    writableRoots,
    readOnlyRoots: uniquePaths(metadataPolicy.readOnlyRoots),
    protectedCreatePaths: uniquePaths(metadataPolicy.protectedCreatePaths),
    protectedWritePaths: uniquePaths(metadataPolicy.protectedWritePaths),
    agentWritableRoots: uniquePaths(metadataPolicy.agentWritableRoots),
    envPassthrough: sandbox.env_passthrough,
    failIfUnavailable: sandbox.fail_if_unavailable,
    capabilities: [...capabilities],
  };
}

export function normalizeSandboxConfig(config: VllmAgentConfig): {
  mode: SandboxMode;
  backend: SandboxBackend;
  network: SandboxNetworkMode;
  fail_if_unavailable: boolean;
  extra_writable_roots: string[];
  env_passthrough: string[];
} {
  const sandbox = config.sandbox ?? {};
  return {
    mode: sandbox.mode ?? "off",
    backend: sandbox.backend ?? "auto",
    network: sandbox.network ?? "restricted",
    fail_if_unavailable: sandbox.fail_if_unavailable ?? true,
    extra_writable_roots: Array.isArray(sandbox.extra_writable_roots) ? sandbox.extra_writable_roots.map((root) => path.resolve(String(root))) : [],
    env_passthrough: Array.isArray(sandbox.env_passthrough) ? sandbox.env_passthrough.map(String) : [],
  };
}

export function sandboxModeLabel(mode: SandboxMode): string {
  switch (mode) {
    case "off":
      return "Off";
    case "read_only":
      return "Read-only";
    case "workspace_write":
      return "Workspace write";
  }
}

export function inferCapabilities(command: string): SandboxCapability[] {
  const git = gitSubcommand(command);
  if (!git) {
    return [];
  }
  if (["add", "branch", "checkout", "commit", "merge", "mv", "rebase", "reset", "restore", "rm", "switch", "tag"].includes(git)) {
    if (isDangerousGitCommand(command)) {
      return [];
    }
    return ["git_metadata_write"];
  }
  return [];
}

export function gitSubcommand(command: string): string | undefined {
  const match = /(?:^|[;&|]\s*)(?:command\s+)?git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+([A-Za-z][A-Za-z0-9_-]*)/.exec(command);
  return match?.[1]?.toLowerCase();
}

export function isDangerousGitCommand(command: string): boolean {
  return /\bgit(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+reset\s+--hard\b/.test(command)
    || /\bgit(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+clean\s+-[^;\n]*[fd]/.test(command)
    || /\bgit(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+push\s+[^;\n]*--force/.test(command);
}

function resolveBackend(backend: SandboxBackend, mode: SandboxMode): SandboxBackendId {
  if (mode === "off" || backend === "none") {
    return "none";
  }
  if (backend === "macos_seatbelt" || backend === "linux_bubblewrap") {
    return backend;
  }
  if (process.platform === "darwin") {
    return "macos_seatbelt";
  }
  if (process.platform === "linux") {
    return "linux_bubblewrap";
  }
  return "none";
}

function protectedMetadataPolicy(workspaceRoot: string, allowGitMetadataWrite: boolean): {
  readOnlyRoots: string[];
  protectedCreatePaths: string[];
  protectedWritePaths: string[];
  agentWritableRoots: string[];
} {
  const inferoaRoot = path.join(workspaceRoot, ".inferoa");
  const agentWritableRoots = INFEROA_AGENT_WRITABLE_NAMES.map((name) => path.join(inferoaRoot, name));
  const protectedMetadataRoots = [
    ...PROTECTED_AGENT_METADATA_NAMES.map((name) => path.join(workspaceRoot, name)),
    inferoaRoot,
  ];
  if (!allowGitMetadataWrite) {
    protectedMetadataRoots.unshift(path.join(workspaceRoot, ".git"));
  }
  const inferoaControlPaths = INFEROA_PROTECTED_NAMES.map((name) => path.join(inferoaRoot, name));
  return {
    readOnlyRoots: protectedMetadataRoots,
    protectedCreatePaths: [...protectedMetadataRoots, ...inferoaControlPaths],
    protectedWritePaths: [...protectedMetadataRoots, ...inferoaControlPaths],
    agentWritableRoots,
  };
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => path.resolve(item)))];
}
