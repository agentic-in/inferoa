import type { JsonObject, SandboxBackend, SandboxMode, SandboxNetworkMode } from "../types.js";

export type SandboxCapability = "git_metadata_write";
export type SandboxBackendId = Exclude<SandboxBackend, "auto">;
export type SandboxBlockStage = "preflight" | "backend_setup" | "runtime";

export interface SandboxExecutionInfo {
  backend: SandboxBackendId;
  mode: SandboxMode;
  network: SandboxNetworkMode;
  workspace_root: string;
  cwd: string;
  command: string;
  rewritten_command?: string;
  blocked: boolean;
  block_stage?: SandboxBlockStage;
  reason?: string;
  policy_rule?: string;
  suggested_action?: string;
  suspected_subcommand?: string;
  capabilities?: SandboxCapability[];
}

export interface SandboxPolicy {
  mode: SandboxMode;
  backend: SandboxBackendId;
  network: SandboxNetworkMode;
  workspaceRoot: string;
  cwd: string;
  writableRoots: string[];
  readOnlyRoots: string[];
  protectedCreatePaths: string[];
  protectedWritePaths: string[];
  agentWritableRoots: string[];
  envPassthrough: string[];
  failIfUnavailable: boolean;
  capabilities: SandboxCapability[];
}

export interface SandboxAvailability {
  available: boolean;
  reason?: string;
  executable?: string;
}

export interface SandboxInvocation {
  command: string;
  args: string[];
  shell: boolean;
  env: NodeJS.ProcessEnv;
  info: SandboxExecutionInfo;
}

export interface SandboxBackendAdapter {
  id: SandboxBackendId;
  available(): Promise<SandboxAvailability>;
  build(policy: SandboxPolicy, request: SandboxBuildRequest): Promise<SandboxInvocation>;
  explainFailure(reason: string): string;
}

export interface SandboxBuildRequest {
  command: string;
  args?: string[];
  shell: boolean;
  env: NodeJS.ProcessEnv;
  originalCommand?: string;
  rewrittenCommand?: string;
}

export function sandboxInfoToJson(info: SandboxExecutionInfo): JsonObject {
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)) as JsonObject;
}

export function blockedSandboxInfoToJson(info: SandboxExecutionInfo | undefined): JsonObject | undefined {
  return info?.blocked ? sandboxInfoToJson(info) : undefined;
}
