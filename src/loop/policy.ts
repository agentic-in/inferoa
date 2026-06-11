import path from "node:path";
import type { LoopBackgroundIsolation, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { SkillRegistry, type SkillDescriptor } from "../skills/registry.js";
import { listConnectorActionPolicyDefinitions } from "../tools/connector-actions.js";
import { effectiveWorkspacePermission } from "../tools/permissions.js";
import { listConnectorActionRunnerDefinitions } from "./actions.js";
import { listConnectorVerifierDefinitions } from "./connector-verifiers.js";

const LEARNED_LOOP_SKILL_ID = "workspace-learned-loop-policy";

export interface LoopPolicyReport {
  workspace_id: string;
  workspace_root: string;
  generated_at: string;
  default_background_isolation: LoopBackgroundIsolation;
  workspace_permission: {
    mode: string;
    source: "workspace" | "default";
    external_local_paths_allowed: boolean;
  };
  unattended_completion: {
    request_classes: string[];
    reflection_only_sufficient: boolean;
    task_strong_pass_providers: string[];
    research_strong_pass_providers: string[];
    hil_review_policy_requires_human_decision: boolean;
    background_supervisor_checker_fallback: boolean;
  };
  unattended_tool_gates: {
    request_classes: string[];
    destructive_shell: "deny";
    connector_mutation: "deny";
    read_only_connector_inspection: "allow";
    review_surface: string;
  };
  connector_verifiers: Array<{
    id: string;
    connector: string;
    cli_command: string;
    tui_action: string;
  }>;
  connector_action_policies: Array<{
    id: string;
    connector: string;
    surface: string;
    command?: string;
    tool_names: string[];
    kind: string;
    request_classes: string[];
    decision: string;
    review_surface: string;
  }>;
  connector_action_runners: Array<{
    id: string;
    connector: string;
    area: string;
    operation: string;
    default_mode: string;
    cli_command: string;
    tui_action: string;
  }>;
  skill_policy: LoopSkillPolicyReport;
}

export interface LoopSkillPolicyReport {
  prompt_contract: {
    catalog_visible: boolean;
    enabled_list_visible: boolean;
    skill_bodies_embedded: boolean;
    skill_body_access: "on_demand_skill_read";
    learned_skill_adoption: "explicit_adopt_or_skill_enable";
  };
  configured_enabled: string[];
  discovered_count: number;
  enabled_count: number;
  loaded_count: number;
  missing_enabled: string[];
  enabled: LoopSkillPolicyItem[];
  learned_workspace_skill: {
    skill_id: string;
    expected_path: string;
    configured: boolean;
    discovered: boolean;
    enabled: boolean;
    path?: string;
  };
}

export interface LoopSkillPolicyItem {
  id: string;
  name: string;
  description: string;
  trust: SkillDescriptor["trust"];
  source: string;
  path?: string;
}

export async function readLoopPolicy(config: VllmAgentConfig, workspace: WorkspaceIdentity): Promise<LoopPolicyReport> {
  const permission = effectiveWorkspacePermission(config, workspace);
  const skillPolicy = await readLoopSkillPolicy(config, workspace);
  return {
    workspace_id: workspace.id,
    workspace_root: workspace.root,
    generated_at: new Date().toISOString(),
    default_background_isolation: loopBackgroundIsolationDefault(config),
    workspace_permission: {
      mode: permission.mode,
      source: permission.source,
      external_local_paths_allowed: permission.mode === "full_access",
    },
    unattended_completion: {
      request_classes: ["background"],
      reflection_only_sufficient: false,
      task_strong_pass_providers: ["command", "connector", "human", "checker"],
      research_strong_pass_providers: ["research", "command", "connector", "human", "checker"],
      hil_review_policy_requires_human_decision: true,
      background_supervisor_checker_fallback: true,
    },
    unattended_tool_gates: {
      request_classes: ["background", "verification"],
      destructive_shell: "deny",
      connector_mutation: "deny",
      read_only_connector_inspection: "allow",
      review_surface: "loop inbox action_review",
    },
    connector_verifiers: listConnectorVerifierDefinitions().map((definition) => ({
      id: definition.id,
      connector: definition.connector,
      cli_command: definition.cli_command,
      tui_action: definition.tui_action,
    })),
    connector_action_policies: listConnectorActionPolicyDefinitions().map((definition) => ({
      id: definition.id,
      connector: definition.connector,
      surface: definition.surface,
      command: definition.command,
      tool_names: definition.tool_names,
      kind: definition.kind,
      request_classes: definition.request_classes,
      decision: definition.decision,
      review_surface: definition.review_surface,
    })),
    connector_action_runners: listConnectorActionRunnerDefinitions().map((definition) => ({
      id: definition.id,
      connector: definition.connector,
      area: definition.area,
      operation: definition.operation,
      default_mode: definition.default_mode,
      cli_command: definition.cli_command,
      tui_action: definition.tui_action,
    })),
    skill_policy: skillPolicy,
  };
}

export async function readLoopSkillPolicy(config: VllmAgentConfig, workspace: WorkspaceIdentity): Promise<LoopSkillPolicyReport> {
  const registry = new SkillRegistry(workspace, config);
  const descriptors = await registry.discover();
  const configuredEnabled = [...new Set(config.skills.enabled.map((item) => item.trim()).filter(Boolean))].sort();
  const byConfiguredName = new Map<string, SkillDescriptor>();
  for (const descriptor of descriptors) {
    if (!byConfiguredName.has(descriptor.id)) {
      byConfiguredName.set(descriptor.id, descriptor);
    }
    if (!byConfiguredName.has(descriptor.name)) {
      byConfiguredName.set(descriptor.name, descriptor);
    }
  }

  const enabledIds = new Set<string>();
  const missingEnabled: string[] = [];
  for (const configured of configuredEnabled) {
    const descriptor = byConfiguredName.get(configured);
    if (descriptor) {
      enabledIds.add(descriptor.id);
    } else {
      missingEnabled.push(configured);
    }
  }

  const enabled = descriptors
    .filter((descriptor) => enabledIds.has(descriptor.id))
    .map(skillPolicyItem)
    .sort((left, right) => left.id.localeCompare(right.id) || left.source.localeCompare(right.source));
  const loadedCount = (await registry.loadEnabled(descriptors)).length;
  const learned = descriptors.find((descriptor) => descriptor.id === LEARNED_LOOP_SKILL_ID);
  return {
    prompt_contract: {
      catalog_visible: true,
      enabled_list_visible: true,
      skill_bodies_embedded: false,
      skill_body_access: "on_demand_skill_read",
      learned_skill_adoption: "explicit_adopt_or_skill_enable",
    },
    configured_enabled: configuredEnabled,
    discovered_count: descriptors.length,
    enabled_count: enabled.length,
    loaded_count: loadedCount,
    missing_enabled: missingEnabled.sort(),
    enabled,
    learned_workspace_skill: {
      skill_id: LEARNED_LOOP_SKILL_ID,
      expected_path: path.join(workspace.root, ".inferoa", "skills", LEARNED_LOOP_SKILL_ID, "SKILL.md"),
      configured: configuredEnabled.includes(LEARNED_LOOP_SKILL_ID) || Boolean(learned && configuredEnabled.includes(learned.name)),
      discovered: Boolean(learned),
      enabled: Boolean(learned && enabledIds.has(learned.id)),
      path: learned?.path,
    },
  };
}

function skillPolicyItem(skill: SkillDescriptor): LoopSkillPolicyItem {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    trust: skill.trust,
    source: skill.source,
    path: skill.path,
  };
}

export function loopBackgroundIsolationDefault(config: VllmAgentConfig): LoopBackgroundIsolation {
  return normalizeLoopBackgroundIsolation(config.loop?.default_background_isolation);
}

export function resolveLoopBackgroundIsolation(
  explicit: LoopBackgroundIsolation | undefined,
  config: VllmAgentConfig,
): LoopBackgroundIsolation {
  return explicit ?? loopBackgroundIsolationDefault(config);
}

export function normalizeLoopBackgroundIsolation(value: unknown): LoopBackgroundIsolation {
  return value === "worktree" ? "worktree" : "active_checkout";
}
