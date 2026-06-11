import type { JsonObject } from "../types.js";
import { hashJson, sha256Hex } from "../util/hash.js";
import type { Skill } from "./registry.js";

export interface SkillSnapshotItem {
  id: string;
  name: string;
  description: string;
  trust: Skill["trust"];
  source: string;
  path?: string;
  body_hash: string;
  required_tools: string[];
  activation: string[];
}

export interface SkillSnapshot {
  skill_count: number;
  skills: SkillSnapshotItem[];
  enabled_config: string[];
  snapshot_hash: string;
}

export function createSkillSnapshot(skills: Skill[], enabledConfig: string[]): SkillSnapshot {
  const items = skills.map(skillSnapshotItem).sort((left, right) => left.id.localeCompare(right.id) || left.source.localeCompare(right.source));
  return {
    skill_count: items.length,
    skills: items,
    enabled_config: enabledConfig.slice().sort(),
    snapshot_hash: hashJson(items),
  };
}

export function skillSnapshotToJson(snapshot: SkillSnapshot): JsonObject {
  return snapshot as unknown as JsonObject;
}

function skillSnapshotItem(skill: Skill): SkillSnapshotItem {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    trust: skill.trust,
    source: skill.source,
    path: skill.path,
    body_hash: sha256Hex(skill.body),
    required_tools: [...skill.required_tools].sort(),
    activation: [...skill.activation].sort(),
  };
}
