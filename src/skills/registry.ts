import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { JsonObject, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { pathExists } from "../util/fs.js";

export interface SkillDescriptor {
  id: string;
  name: string;
  description: string;
  source: string;
  path?: string;
  trust: "package" | "user" | "workspace" | "imported";
  required_tools: string[];
  activation: string[];
}

export interface Skill extends SkillDescriptor {
  body: string;
}

export class SkillRegistry {
  constructor(
    private readonly workspace: WorkspaceIdentity,
    private readonly config: VllmAgentConfig,
  ) {}

  async discover(): Promise<SkillDescriptor[]> {
    const descriptors: SkillDescriptor[] = [];
    const roots = await this.discoveryRoots();
    for (const root of roots) {
      if (!(await pathExists(root.path))) {
        continue;
      }
      if (root.importer) {
        descriptors.push(...(await this.discoverImported(root.path, root.trust)));
      } else {
        descriptors.push(...(await this.discoverNative(root.path, root.trust)));
      }
    }
    return sortDescriptors(dedupe(descriptors));
  }

  async loadEnabled(descriptors?: SkillDescriptor[]): Promise<Skill[]> {
    descriptors ??= await this.discover();
    return this.loadSelected(descriptors, this.config.skills.enabled);
  }

  async loadSelected(descriptors: SkillDescriptor[], enabledNames: string[]): Promise<Skill[]> {
    const enabled = new Set(enabledNames);
    const loaded: Skill[] = [];
    for (const descriptor of descriptors) {
      if (!enabled.has(descriptor.id) && !enabled.has(descriptor.name)) {
        continue;
      }
      if (descriptor.path) {
        loaded.push({ ...descriptor, body: await fs.readFile(descriptor.path, "utf8") });
      }
    }
    return loaded;
  }

  private async discoveryRoots(): Promise<{ path: string; trust: SkillDescriptor["trust"]; importer?: boolean }[]> {
    const home = os.homedir();
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const roots: { path: string; trust: SkillDescriptor["trust"]; importer?: boolean }[] = [
      { path: path.join(packageRoot, "skills"), trust: "package" },
      { path: path.join(home, ".inferoa", "skills"), trust: "user" },
      { path: path.join(this.workspace.root, ".inferoa", "skills"), trust: "workspace" },
      { path: path.join(home, ".agents", "skills"), trust: "user" },
      { path: path.join(this.workspace.root, "AGENTS.md"), trust: "imported", importer: true },
    ];
    roots.push(...configuredRoots("INFEROA_SKILL_ROOTS", "user"));
    roots.push(...configuredRoots("INFEROA_INSTRUCTION_ROOTS", "imported", true));
    roots.push(...(await findNestedSkillRoots(path.join(home, ".inferoa", "plugins", "cache"))));
    return roots;
  }

  private async discoverNative(root: string, trust: SkillDescriptor["trust"]): Promise<SkillDescriptor[]> {
    const entries = sortDirents(await fs.readdir(root, { withFileTypes: true }).catch(() => []));
    const descriptors: SkillDescriptor[] = [];
    for (const entry of entries) {
      const skillPath = entry.isDirectory() ? path.join(root, entry.name, "SKILL.md") : path.join(root, entry.name);
      if (!skillPath.endsWith(".md") || !(await pathExists(skillPath))) {
        continue;
      }
      const body = await fs.readFile(skillPath, "utf8");
      const meta = parseFrontmatter(body);
      const name = String(meta.name ?? path.basename(path.dirname(skillPath)));
      descriptors.push({
        id: slug(name),
        name,
        description: String(meta.description ?? firstParagraph(body) ?? ""),
        source: root,
        path: skillPath,
        trust,
        required_tools: arrayOfStrings(meta.required_tools),
        activation: arrayOfStrings(meta.activation),
      });
    }
    return descriptors;
  }

  private async discoverImported(target: string, trust: SkillDescriptor["trust"]): Promise<SkillDescriptor[]> {
    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat) {
      return [];
    }
    const files = stat.isDirectory()
      ? sortDirents(await fs.readdir(target, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && /\.(md|mdc|txt)$/.test(entry.name))
          .map((entry) => path.join(target, entry.name))
      : [target];
    return await Promise.all(
      files.map(async (file) => {
        const body = await fs.readFile(file, "utf8");
        const name = path.basename(file).replace(/\.(md|mdc|txt)$/, "");
        return {
          id: slug(name),
          name,
          description: firstParagraph(body) ?? "Imported local instruction",
          source: file,
          path: file,
          trust,
          required_tools: [],
          activation: [],
        };
      }),
    );
  }
}

function parseFrontmatter(body: string): JsonObject {
  const match = /^---\n([\s\S]*?)\n---/.exec(body);
  if (!match) {
    return {};
  }
  const out: JsonObject = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv?.[1]) {
      out[kv[1]] = kv[2]?.replace(/^["']|["']$/g, "") ?? "";
    }
  }
  return out;
}

function firstParagraph(body: string): string | undefined {
  return body
    .replace(/^---[\s\S]*?---/, "")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find(Boolean);
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function dedupe(items: SkillDescriptor[]): SkillDescriptor[] {
  const seen = new Set<string>();
  const out: SkillDescriptor[] = [];
  for (const item of items) {
    const key = `${item.id}:${item.path ?? item.source}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function sortDirents<T extends { name: string }>(entries: T[]): T[] {
  return entries.slice().sort((left, right) => left.name.localeCompare(right.name));
}

function sortDescriptors(items: SkillDescriptor[]): SkillDescriptor[] {
  return items.slice().sort((left, right) => {
    const id = left.id.localeCompare(right.id);
    if (id !== 0) return id;
    const source = left.source.localeCompare(right.source);
    if (source !== 0) return source;
    return (left.path ?? "").localeCompare(right.path ?? "");
  });
}

async function findNestedSkillRoots(root: string): Promise<{ path: string; trust: SkillDescriptor["trust"] }[]> {
  const out: { path: string; trust: SkillDescriptor["trust"] }[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 6) {
      return;
    }
    const entries = sortDirents(await fs.readdir(dir, { withFileTypes: true }).catch(() => []));
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.name === "skills") {
        out.push({ path: full, trust: "user" });
        continue;
      }
      await visit(full, depth + 1);
    }
  }
  await visit(root, 0);
  return out.sort((left, right) => left.path.localeCompare(right.path));
}

function configuredRoots(envName: string, trust: SkillDescriptor["trust"], importer = false): { path: string; trust: SkillDescriptor["trust"]; importer?: boolean }[] {
  return (process.env[envName] ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => ({
      path: expandHome(item),
      trust,
      importer,
    }));
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
