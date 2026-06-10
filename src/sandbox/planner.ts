import type { VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { resolveSandboxPolicy } from "./policy.js";
import type { SandboxBackendAdapter, SandboxBuildRequest, SandboxCapability, SandboxInvocation } from "./types.js";
import { LinuxBubblewrapBackend } from "./backends/linux-bubblewrap.js";
import { MacosSeatbeltBackend } from "./backends/macos-seatbelt.js";
import { NoopBackend } from "./backends/noop.js";
import { sandboxInfoToJson, type SandboxExecutionInfo } from "./types.js";

export interface SandboxPlannerRequest extends SandboxBuildRequest {
  config: VllmAgentConfig;
  workspace: WorkspaceIdentity;
  cwd: string;
  capabilities?: SandboxCapability[];
}

export type SandboxPlannerResult =
  | { ok: true; invocation: SandboxInvocation }
  | { ok: false; info: SandboxExecutionInfo; stderr: string };

export async function planSandboxInvocation(request: SandboxPlannerRequest): Promise<SandboxPlannerResult> {
  const policy = resolveSandboxPolicy({
    config: request.config,
    workspace: request.workspace,
    cwd: request.cwd,
    capabilities: request.capabilities,
    command: request.originalCommand ?? request.command,
  });
  const backend = backendFor(policy.backend);
  const availability = await backend.available();
  if (!availability.available && policy.mode !== "off" && policy.failIfUnavailable) {
    const reason = backend.explainFailure(availability.reason ?? "backend is unavailable");
    return {
      ok: false,
      stderr: reason,
      info: {
        backend: policy.backend,
        mode: policy.mode,
        network: policy.network,
        workspace_root: policy.workspaceRoot,
        cwd: policy.cwd,
        command: request.originalCommand ?? request.command,
        rewritten_command: request.rewrittenCommand,
        blocked: true,
        block_stage: "backend_setup",
        reason,
        policy_rule: "sandbox_backend_unavailable",
        suggested_action: policy.backend === "linux_bubblewrap" ? "Install bubblewrap or run /sandbox off." : "Run /sandbox off or choose a supported platform.",
        capabilities: policy.capabilities.length ? policy.capabilities : undefined,
      },
    };
  }
  if (!availability.available) {
    const fallbackPolicy = { ...policy, backend: "none" as const, mode: "off" as const };
    return { ok: true, invocation: await new NoopBackend().build(fallbackPolicy, request) };
  }
  const env = policy.mode === "off" ? request.env : scrubSandboxEnv(request.env, request.config.sandbox?.env_passthrough ?? []);
  return { ok: true, invocation: await backend.build(policy, { ...request, env }) };
}

export function sandboxBlockedJson(info: SandboxExecutionInfo) {
  return sandboxInfoToJson(info);
}

function backendFor(id: "none" | "macos_seatbelt" | "linux_bubblewrap"): SandboxBackendAdapter {
  switch (id) {
    case "macos_seatbelt":
      return new MacosSeatbeltBackend();
    case "linux_bubblewrap":
      return new LinuxBubblewrapBackend();
    case "none":
      return new NoopBackend();
  }
}

function scrubSandboxEnv(env: NodeJS.ProcessEnv, passthrough: string[]): NodeJS.ProcessEnv {
  const pass = new Set(passthrough);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (pass.has(key) || !isSensitiveEnvKey(key)) {
      out[key] = value;
    }
  }
  return out;
}

function isSensitiveEnvKey(key: string): boolean {
  return /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|WEBHOOK|OPENAI|ANTHROPIC|GEMINI|GOOGLE|GITHUB|GH_TOKEN|VLLM|INFEROA_OMNI)/i.test(key);
}
