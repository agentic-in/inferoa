import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, ToolResult } from "../types.js";
import { saveUserConfig } from "../config/config.js";
import { readGoalState } from "../goals/state.js";
import { SkillRegistry } from "../skills/registry.js";
import { sha256Hex } from "../util/hash.js";
import { clampLimit, fail, ok } from "../util/limit.js";
import type { ToolExecutionContext } from "./context.js";

const LEARNED_WORKSPACE_SKILL_ALIASES = new Map([
  ["inferoa-loop-skill", "inferoa-loop-skill"],
  ["Inferoa Loop Skill", "inferoa-loop-skill"],
  ["loop_skill", "inferoa-loop-skill"],
  ["inferoa-workspace-skill", "inferoa-workspace-skill"],
  ["Inferoa Workspace Skill", "inferoa-workspace-skill"],
  ["workspace_skill", "inferoa-workspace-skill"],
]);

export async function skillList(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
  const includeDisabled = args.include_disabled !== false;
  const limit = clampLimit(args.limit, 50, 500);
  const enabled = new Set(context.config.skills.enabled);
  const skills = await new SkillRegistry(context.workspace, context.config).discover();
  const filtered = skills
    .filter((skill) => includeDisabled || enabled.has(skill.id) || enabled.has(skill.name))
    .filter((skill) => !query || `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(query))
    .slice(0, limit)
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      trust: skill.trust,
      source: skill.source,
      enabled: enabled.has(skill.id) || enabled.has(skill.name),
      required_tools: skill.required_tools,
      activation: skill.activation,
    }));
  return ok(`Listed ${formatSkillCount(filtered.length)}`, { skills: filtered });
}

export async function skillRead(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const requestedId = String(args.id ?? "");
  const id = LEARNED_WORKSPACE_SKILL_ALIASES.get(requestedId) ?? requestedId;
  if (!id) {
    return fail("skill_id_required", "skill_read requires id");
  }
  const skills = await new SkillRegistry(context.workspace, context.config).discover();
  const skill = skills.find((item) => item.id === id || item.name === id || item.id === requestedId || item.name === requestedId);
  if (!skill?.path) {
    if (LEARNED_WORKSPACE_SKILL_ALIASES.has(requestedId) || LEARNED_WORKSPACE_SKILL_ALIASES.has(id)) {
      return ok(`Skill ${id} has not been adopted in this workspace.`, {
        id,
        requested_id: requestedId,
        status: "not_adopted",
        configured_enabled: context.config.skills.enabled.includes(id),
        expected_path: path.join(context.workspace.root, ".inferoa", "skills", id, "SKILL.md"),
        next: "Complete a verified /loop, then run /self-improve learn and approve adoption before relying on this learned skill.",
      });
    }
    return fail("skill_not_found", `Skill not found: ${id}`);
  }
  const body = await fs.readFile(skill.path, "utf8");
  const lines = body.split(/\r?\n/);
  const lineCount = clampLimit(args.line_count, 240, 2000);
  const content = lines.slice(0, lineCount).map((line, index) => `${index + 1}: ${line}`).join("\n");
  const resource =
    lines.length > lineCount || body.length > 24_000
      ? context.store.putResource(context.session_id, "skill.body", body, {
          id: skill.id,
          name: skill.name,
          source: skill.source,
        }).uri
      : undefined;
  const activeGoal = readGoalState(context.store, context.session_id)?.goal;
  context.store.appendEvent({
    session_id: context.session_id,
    run_id: context.run_id,
    type: "skill.body.loaded",
    data: {
      skill_id: skill.id,
      name: skill.name,
      trust: skill.trust,
      source: skill.source,
      path: skill.path,
      body_hash: sha256Hex(body),
      total_lines: lines.length,
      returned_lines: Math.min(lines.length, lineCount),
      resource_uri: resource,
      goal_id: activeGoal?.id,
      horizon_generation: activeGoal?.horizon_generation,
    },
  });
  return {
    ...ok(`Read skill ${skill.id}`, {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      trust: skill.trust,
      source: skill.source,
      content,
      total_lines: lines.length,
    }),
    resource_uri: resource,
  };
}

export async function skillEnable(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const requested = parseSkillIds(args);
  if (!requested.length) {
    return fail("skill_ids_required", "skill_enable requires ids");
  }
  const skills = await new SkillRegistry(context.workspace, context.config).discover();
  const resolved = resolveSkills(requested, skills);
  if (resolved.missing.length) {
    return fail("skill_not_found", `Skill not found: ${resolved.missing.join(", ")}`);
  }
  const enabled = new Set(context.config.skills.enabled);
  for (const skill of resolved.ids) {
    enabled.add(skill);
  }
  context.config.skills.enabled = [...enabled].sort();
  const target = await saveUserConfig(context.config);
  return ok(`Enabled ${formatSkillCount(resolved.ids.length)}`, {
    enabled: context.config.skills.enabled,
    config_path: target,
  });
}

export async function skillDisable(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const requested = parseSkillIds(args);
  if (!requested.length) {
    return fail("skill_ids_required", "skill_disable requires ids");
  }
  const skills = await new SkillRegistry(context.workspace, context.config).discover();
  const resolved = resolveSkills(requested, skills, true);
  const enabled = new Set(context.config.skills.enabled);
  for (const id of resolved.ids) {
    enabled.delete(id);
  }
  context.config.skills.enabled = [...enabled].sort();
  const target = await saveUserConfig(context.config);
  return ok(`Disabled ${formatSkillCount(resolved.ids.length)}`, {
    disabled: resolved.ids,
    missing: resolved.missing,
    enabled: context.config.skills.enabled,
    config_path: target,
  });
}

function formatSkillCount(count: number): string {
  return `${count} ${count === 1 ? "skill" : "skills"}`;
}

function parseSkillIds(args: JsonObject): string[] {
  const ids = Array.isArray(args.ids) ? args.ids : [];
  return ids.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean);
}

function resolveSkills(
  ids: string[],
  skills: Awaited<ReturnType<SkillRegistry["discover"]>>,
  allowEnabledEntries = false,
): { ids: string[]; missing: string[] } {
  const byId = new Map(skills.flatMap((skill) => [[skill.id, skill.id], [skill.name, skill.id]]));
  const resolved: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const match = byId.get(id);
    if (match) {
      resolved.push(match);
    } else if (allowEnabledEntries) {
      resolved.push(id);
    } else {
      missing.push(id);
    }
  }
  return { ids: [...new Set(resolved)], missing };
}
