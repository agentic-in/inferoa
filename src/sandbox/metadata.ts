import type { SandboxBuildRequest, SandboxExecutionInfo, SandboxPolicy } from "./types.js";
import { gitSubcommand } from "./policy.js";

export function sandboxInfo(policy: SandboxPolicy, request: SandboxBuildRequest): SandboxExecutionInfo {
  const command = request.originalCommand ?? displayCommand(request);
  return {
    backend: policy.backend,
    mode: policy.mode,
    network: policy.network,
    workspace_root: policy.workspaceRoot,
    cwd: policy.cwd,
    command,
    rewritten_command: request.rewrittenCommand,
    blocked: false,
    suspected_subcommand: gitSubcommand(command),
    capabilities: policy.capabilities.length ? policy.capabilities : undefined,
  };
}

function displayCommand(request: SandboxBuildRequest): string {
  if (request.shell || !request.args?.length) {
    return request.command;
  }
  return [request.command, ...request.args.map(shellQuoteForDisplay)].join(" ");
}

function shellQuoteForDisplay(value: string): string {
  return /^[A-Za-z0-9_/:=.,@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
