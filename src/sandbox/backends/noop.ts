import type { SandboxAvailability, SandboxBackendAdapter, SandboxBuildRequest, SandboxInvocation, SandboxPolicy } from "../types.js";
import { sandboxInfo } from "../metadata.js";

export class NoopBackend implements SandboxBackendAdapter {
  readonly id = "none" as const;

  async available(): Promise<SandboxAvailability> {
    return { available: true };
  }

  async build(policy: SandboxPolicy, request: SandboxBuildRequest): Promise<SandboxInvocation> {
    return {
      command: request.command,
      args: request.args ?? [],
      shell: request.shell,
      env: request.env,
      info: sandboxInfo(policy, request),
    };
  }

  explainFailure(reason: string): string {
    return reason;
  }
}
