import path from "node:path";
import type { LoopBackgroundIsolation, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { SkillRegistry, type SkillDescriptor } from "../skills/registry.js";
import { listExternalMutationPolicyDefinitions } from "../tools/external-mutation-policy.js";
import { effectiveWorkspacePermission } from "../tools/permissions.js";

const LOOP_SKILL_ID = "inferoa-loop-skill";
const WORKSPACE_SKILL_ID = "inferoa-workspace-skill";
const LEGACY_LEARNED_LOOP_SKILL_ID = "workspace-learned-loop-policy";

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
    external_mutation: "deny";
    review_surface: string;
  };
  external_mutation_policy: Array<{
    id: string;
    system: string;
    surface: string;
    command?: string;
    tool_names: string[];
    kind: string;
    request_classes: string[];
    decision: string;
    review_surface: string;
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
  learned_loop_skill: LoopLearnedSkillPolicyItem;
  learned_workspace_skill: LoopLearnedSkillPolicyItem;
  learned_skills: LoopLearnedSkillPolicyItem[];
  legacy_learned_loop_policy?: LoopLearnedSkillPolicyItem;
}

export interface LoopSkillPolicyItem {
  id: string;
  name: string;
  description: string;
  trust: SkillDescriptor["trust"];
  source: string;
  path?: string;
}

export interface LoopLearnedSkillPolicyItem {
  skill_id: string;
  expected_path: string;
  configured: boolean;
  discovered: boolean;
  enabled: boolean;
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
      task_strong_pass_providers: ["command", "human", "checker"],
      research_strong_pass_providers: ["research", "command", "human", "checker"],
      hil_review_policy_requires_human_decision: true,
      background_supervisor_checker_fallback: true,
    },
    unattended_tool_gates: {
      request_classes: ["background", "verification"],
      destructive_shell: "deny",
      external_mutation: "deny",
      review_surface: "loop inbox external_action_approval",
    },
    external_mutation_policy: listExternalMutationPolicyDefinitions().map((definition) => ({
      id: definition.id,
      system: definition.system,
      surface: definition.surface,
      command: definition.command,
      tool_names: definition.tool_names,
      kind: definition.kind,
      request_classes: definition.request_classes,
      decision: definition.decision,
      review_surface: definition.review_surface,
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
  const learnedLoopSkill = learnedSkillPolicyItem(LOOP_SKILL_ID, descriptors, configuredEnabled, enabledIds, workspace);
  const learnedWorkspaceSkill = learnedSkillPolicyItem(WORKSPACE_SKILL_ID, descriptors, configuredEnabled, enabledIds, workspace);
  const legacyLearnedLoopPolicy = learnedSkillPolicyItem(LEGACY_LEARNED_LOOP_SKILL_ID, descriptors, configuredEnabled, enabledIds, workspace);
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
    learned_loop_skill: learnedLoopSkill,
    learned_workspace_skill: learnedWorkspaceSkill,
    learned_skills: [learnedLoopSkill, learnedWorkspaceSkill],
    legacy_learned_loop_policy: legacyLearnedLoopPolicy.discovered || legacyLearnedLoopPolicy.configured ? legacyLearnedLoopPolicy : undefined,
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

function learnedSkillPolicyItem(
  skillId: string,
  descriptors: SkillDescriptor[],
  configuredEnabled: string[],
  enabledIds: Set<string>,
  workspace: WorkspaceIdentity,
): LoopLearnedSkillPolicyItem {
  const descriptor = descriptors.find((item) => item.id === skillId);
  return {
    skill_id: skillId,
    expected_path: path.join(workspace.root, ".inferoa", "skills", skillId, "SKILL.md"),
    configured: configuredEnabled.includes(skillId) || Boolean(descriptor && configuredEnabled.includes(descriptor.name)),
    discovered: Boolean(descriptor),
    enabled: Boolean(descriptor && enabledIds.has(descriptor.id)),
    path: descriptor?.path,
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
