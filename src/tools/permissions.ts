import type { JsonObject, PermissionMode, ToolDefinition, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { isExternalLocalPath } from "../util/fs.js";
import { classifyExternalMutationToolCall, decideExternalMutationPolicy } from "./external-mutation-policy.js";

export interface PermissionDecision {
  status: "allow" | "ask" | "deny";
  reason: string;
  policy_kind?: "destructive_shell" | "external_mutation";
  external_system?: string;
  external_surface?: string;
  external_action?: string;
  external_area?: string;
  external_operation?: string;
}

export interface PermissionContext {
  request_class?: string;
  permission_mode?: PermissionMode;
}

const destructivePatterns = [
  /\brm\s+-rf\s+(\/|\*|~)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+--\s+/,
  /\bgit\s+clean\s+-[^\s]*f/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
];

export class PermissionPolicy {
  constructor(
    private readonly config: VllmAgentConfig,
    private readonly workspace: WorkspaceIdentity,
  ) {}

  decide(tool: ToolDefinition, args: Record<string, unknown>, context: PermissionContext = {}): PermissionDecision {
    const policy = effectiveWorkspacePermission(this.config, this.workspace);
    const mode = context.permission_mode ?? policy.mode;
    if (tool.name === "run_command" && typeof args.command === "string" && isDestructiveCommand(args.command) && isUnattendedRequest(context.request_class)) {
      return {
        status: "deny",
        reason: "unattended destructive shell command requires explicit interactive approval",
        policy_kind: "destructive_shell",
      };
    }
    const externalMutation = classifyExternalMutationToolCall(tool.name, args);
    if (externalMutation) {
      const externalDecision = decideExternalMutationPolicy(externalMutation, requestClassForExternalMutationPolicy(context.request_class));
      if (externalDecision.status !== "allow") {
        return {
          status: "deny",
          reason: externalDecision.reason,
          policy_kind: externalDecision.policy_kind,
          external_system: externalDecision.action.system,
          external_surface: externalDecision.action.surface,
          external_action: externalDecision.action.kind,
          external_area: externalDecision.action.area,
          external_operation: externalDecision.action.operation,
        };
      }
    }
    if (mode === "full_access") {
      return { status: "allow", reason: "full_access" };
    }
    if (tool.name === "run_command" && typeof args.command === "string" && isDestructiveCommand(args.command)) {
      return {
        status: mode === "auto_approve" ? "ask" : "deny",
        reason: "destructive shell command requires explicit approval",
      };
    }
    if (usesExternalLocalPath(args, this.workspace.root)) {
      return {
        status: mode === "auto_approve" || mode === "ask" || mode === "custom" ? "ask" : "deny",
        reason: "path is outside workspace",
      };
    }
    switch (mode) {
      case "auto_approve":
        if (tool.permission === "destructive" || tool.permission === "external_path") {
          return { status: "ask", reason: "auto_approve requires approval for risky operations" };
        }
        return { status: "allow", reason: "auto_approve" };
      case "ask":
        if (tool.permission === "read") {
          return { status: "allow", reason: "read allowed" };
        }
        return { status: "ask", reason: "ask mode" };
      case "custom":
        return customDecision(policy.custom, tool);
      default:
        return { status: "deny", reason: "unknown permission mode" };
    }
  }
}

export function effectiveWorkspacePermission(
  config: VllmAgentConfig,
  workspace: WorkspaceIdentity,
): { mode: PermissionMode; custom?: JsonObject; source: "workspace" | "default" } {
  const workspacePolicy = config.permissions.workspaces?.[workspace.id];
  if (workspacePolicy && isPermissionMode(workspacePolicy.mode)) {
    return { mode: workspacePolicy.mode, custom: workspacePolicy.custom, source: "workspace" };
  }
  return { mode: "full_access", source: "default" };
}

export function setWorkspacePermissionMode(config: VllmAgentConfig, workspace: WorkspaceIdentity, mode: PermissionMode): void {
  config.permissions.workspaces ??= {};
  const existing = config.permissions.workspaces[workspace.id];
  config.permissions.workspaces[workspace.id] = {
    mode,
    ...(mode === "custom" && (existing?.custom ?? config.permissions.custom) ? { custom: (existing?.custom ?? config.permissions.custom)! } : {}),
  };
}

export function workspaceExternalPathsAllowed(config: VllmAgentConfig, workspace: WorkspaceIdentity): boolean {
  return effectiveWorkspacePermission(config, workspace).mode === "full_access";
}

function customDecision(custom: unknown, tool: ToolDefinition): PermissionDecision {
  if (!custom || typeof custom !== "object") {
    return { status: "ask", reason: "custom policy missing rules" };
  }
  const record = custom as Record<string, unknown>;
  const tools = record.tools as Record<string, unknown> | undefined;
  const value = tools?.[tool.name] ?? tools?.[tool.permission];
  if (value === "allow" || value === "ask" || value === "deny") {
    return { status: value, reason: "custom policy" };
  }
  return { status: "ask", reason: "custom policy default" };
}

function isDestructiveCommand(command: string): boolean {
  return destructivePatterns.some((pattern) => pattern.test(command));
}

function isUnattendedRequest(requestClass: string | undefined): boolean {
  return requestClass === "background" || requestClass === "verification";
}

function requestClassForExternalMutationPolicy(requestClass: string | undefined): "interactive" | "tool" | "verification" | "compaction" | "background" | "reflection" {
  if (
    requestClass === "interactive"
    || requestClass === "tool"
    || requestClass === "verification"
    || requestClass === "compaction"
    || requestClass === "background"
    || requestClass === "reflection"
  ) {
    return requestClass;
  }
  return "interactive";
}

function usesExternalLocalPath(args: Record<string, unknown>, workspaceRoot: string): boolean {
  if (isExternalLocalPath(workspaceRoot, args.path) || isExternalLocalPath(workspaceRoot, args.cwd)) {
    return true;
  }
  const inputs = args.inputs;
  if (!Array.isArray(inputs)) {
    return false;
  }
  return inputs.some((input) => isExternalLocalPath(workspaceRoot, input));
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "ask" || value === "auto_approve" || value === "full_access" || value === "custom";
}
