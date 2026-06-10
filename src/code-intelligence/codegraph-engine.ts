import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { JsonObject, ToolDefinition, ToolResult, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { runSmallCommand } from "../util/fs.js";
import { fail, truncateText } from "../util/limit.js";

const require = createRequire(import.meta.url);

export type ContextEngineState = "off" | "idle" | "indexing" | "syncing" | "ready" | "degraded";

export interface ContextEngineStatus {
  provider: "codegraph" | "builtin" | "off";
  state: ContextEngineState;
  phase?: string;
  current?: number;
  total?: number;
  files?: number;
  nodes?: number;
  edges?: number;
  watcher?: "active" | "inactive" | "disabled";
  languages?: string[];
  frameworks?: string[];
  error?: string;
  reason?: string;
}

export interface ContextEngineConfig {
  provider: "auto" | "codegraph" | "builtin" | "off";
  startup: "welcome" | "lazy" | "manual";
  require_ready_before_chat: boolean;
  watch: boolean;
}

interface CodeGraphProgress {
  phase?: string;
  current?: number;
  total?: number;
}

interface CodeGraphIndexResult {
  success?: boolean;
  filesIndexed?: number;
  filesSkipped?: number;
  filesErrored?: number;
  nodesCreated?: number;
  edgesCreated?: number;
  errors?: Array<{ message?: string; severity?: string }>;
  durationMs?: number;
}

interface CodeGraphSyncResult {
  success?: boolean;
  filesChecked?: number;
  filesAdded?: number;
  filesModified?: number;
  filesRemoved?: number;
  filesChanged?: number;
  nodesCreated?: number;
  nodesUpdated?: number;
  edgesCreated?: number;
  errors?: Array<{ message?: string; severity?: string }>;
  durationMs?: number;
}

interface CodeGraphStats {
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  filesByLanguage?: Record<string, number>;
}

interface CodeGraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
}

interface CodeGraphEdge {
  source: string;
  target: string;
  kind: string;
  line?: number;
  column?: number;
}

interface CodeGraphFile {
  path: string;
  language: string;
  size: number;
  nodeCount: number;
}

interface CodeGraphSearchResult {
  node: CodeGraphNode;
  score?: number;
  highlights?: string[];
}

interface CodeGraphSubgraph {
  nodes: Map<string, CodeGraphNode>;
  edges: CodeGraphEdge[];
  roots: string[];
}

interface CodeGraphInstance {
  close(): void;
  clear(): void;
  getDetectedFrameworks(): string[];
  getProjectRoot(): string;
  getStats(): CodeGraphStats;
  buildContext(input: string, options?: { maxCodeBlocks?: number; includeCode?: boolean; format?: "markdown" | "json"; searchLimit?: number; traversalDepth?: number }): Promise<string | unknown>;
  getCallees(nodeId: string, maxDepth?: number): Array<{ node: CodeGraphNode; edge: CodeGraphEdge }>;
  getCallers(nodeId: string, maxDepth?: number): Array<{ node: CodeGraphNode; edge: CodeGraphEdge }>;
  getCode(nodeId: string): Promise<string | null>;
  getFiles(): CodeGraphFile[];
  getImpactRadius(nodeId: string, maxDepth?: number): CodeGraphSubgraph;
  getNodesByName(name: string): CodeGraphNode[];
  indexAll(options?: { onProgress?: (progress: CodeGraphProgress) => void; signal?: AbortSignal }): Promise<CodeGraphIndexResult>;
  isWatching(): boolean;
  searchNodes(query: string, options?: { limit?: number; kinds?: string[] }): CodeGraphSearchResult[];
  sync(options?: { onProgress?: (progress: CodeGraphProgress) => void; signal?: AbortSignal }): Promise<CodeGraphSyncResult>;
  watch(options?: {
    onSyncComplete?: (result: CodeGraphSyncResult) => void;
    onSyncError?: (error: Error) => void;
  }): boolean;
}

interface CodeGraphConstructor {
  init(projectRoot: string, options?: { index?: boolean; onProgress?: (progress: CodeGraphProgress) => void }): Promise<CodeGraphInstance>;
  isInitialized(projectRoot: string): boolean;
  open(projectRoot: string, options?: { sync?: boolean; readOnly?: boolean }): Promise<CodeGraphInstance>;
}

interface CodeGraphModule {
  CodeGraph: CodeGraphConstructor;
}

export type ContextEngineListener = (status: ContextEngineStatus) => void;

export class CodeGraphContextEngine {
  private active: Promise<ContextEngineStatus> | undefined;
  private cg: CodeGraphInstance | undefined;
  private catchUp: Promise<void> | undefined;
  private readonly listeners = new Set<ContextEngineListener>();
  private statusSnapshot: ContextEngineStatus;

  constructor(
    private readonly config: ContextEngineConfig,
    private readonly workspace: WorkspaceIdentity,
    private readonly agentConfig?: VllmAgentConfig,
  ) {
    this.statusSnapshot = this.enabled()
      ? { provider: "codegraph", state: "idle", watcher: "inactive" }
      : this.disabledStatus();
  }

  dispose(): void {
    this.listeners.clear();
    this.cg?.close();
    this.cg = undefined;
  }

  enabled(): boolean {
    if (this.config.provider === "codegraph") {
      return true;
    }
    return this.config.provider === "auto" && Boolean(this.workspace.gitRoot);
  }

  handlesTool(name: string): boolean {
    return this.enabled() && this.toolDefinitions().some((tool) => tool.name === name);
  }

  onStatus(listener: ContextEngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  requireReadyBeforeChat(): boolean {
    return this.enabled() && this.config.require_ready_before_chat;
  }

  shouldStartOnWelcome(): boolean {
    return this.enabled() && this.config.startup === "welcome";
  }

  status(): ContextEngineStatus {
    return { ...this.statusSnapshot };
  }

  toolDefinitions(): ToolDefinition[] {
    if (!this.enabled()) {
      return [];
    }
    return CODEGRAPH_TOOL_DEFINITIONS;
  }

  startIndexing(reason: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<ContextEngineStatus> {
    if (!this.enabled()) {
      this.update({ ...this.disabledStatus(), reason });
      return Promise.resolve(this.status());
    }
    if (this.active && !options.force) {
      return this.active;
    }
    this.active = this.runIndexLifecycle(reason, options).finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  async waitUntilReady(reason: string, signal?: AbortSignal): Promise<ContextEngineStatus> {
    const current = this.status();
    if (!this.enabled() || current.state === "ready" || current.state === "off") {
      return current;
    }
    return await this.startIndexing(reason, { signal });
  }

  async callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<ToolResult> {
    if (!this.handlesTool(name)) {
      return fail("unknown_context_engine_tool", `Unknown context engine tool: ${name}`);
    }
    const guardedArgs = this.guardProjectPath(args);
    if (!guardedArgs.ok) {
      return guardedArgs.result;
    }
    const ready = await this.waitUntilReady(`tool:${name}`, signal);
    if (ready.state !== "ready" || !this.cg) {
      return fail("context_engine_unavailable", ready.error ?? "Context engine is not ready", { status: ready as unknown as JsonObject });
    }
    if (this.catchUp) {
      await this.catchUp.catch(() => undefined);
      this.catchUp = undefined;
    }
    const content = await this.executeNativeTool(name, guardedArgs.args);
    return toVllmToolResult(name, content);
  }

  private async runIndexLifecycle(reason: string, options: { force?: boolean; signal?: AbortSignal }): Promise<ContextEngineStatus> {
    this.update({ provider: "codegraph", state: "indexing", phase: "initializing", current: undefined, total: undefined, error: undefined, reason });
    try {
      await ensureCodeGraphIgnored(this.workspace, this.agentConfig);
      const { CodeGraph } = loadCodeGraphModule();
      const initialized = CodeGraph.isInitialized(this.workspace.root);
      const cg = initialized ? await CodeGraph.open(this.workspace.root) : await CodeGraph.init(this.workspace.root, { index: false });
      if (this.cg && this.cg !== cg) {
        this.cg.close();
      }
      this.cg = cg;

      if (options.force && initialized) {
        cg.clear();
      }

      if (!initialized || options.force) {
        this.update({ provider: "codegraph", state: "indexing", phase: "scanning", watcher: "inactive", reason });
        const result = await cg.indexAll({ onProgress: (progress) => this.onProgress("indexing", progress), signal: options.signal });
        if (result.success === false) {
          throw new Error(indexErrors(result.errors) || "Context index failed");
        }
      } else {
        this.update({ provider: "codegraph", state: "syncing", phase: "catch-up", watcher: "inactive", reason });
        const sync = cg.sync({ onProgress: (progress) => this.onProgress("syncing", progress), signal: options.signal });
        this.catchUp = sync.then(() => undefined);
        const result = await sync;
        if (result.success === false) {
          throw new Error(indexErrors(result.errors) || "Context index sync failed");
        }
      }

      const watcher = this.config.watch ? (cg.watch({
        onSyncComplete: (result) => {
          if (result.success === false) {
            this.update({ ...this.statusSnapshot, state: "degraded", error: indexErrors(result.errors) || "Context index sync failed" });
            return;
          }
          if ((result.filesChanged ?? 0) > 0 || (result.filesAdded ?? 0) + (result.filesModified ?? 0) + (result.filesRemoved ?? 0) > 0) {
            this.refreshReadyStatus("watch-sync");
          }
        },
        onSyncError: (error) => {
          this.update({ ...this.statusSnapshot, state: "degraded", error: error.message });
        },
      }) ? "active" : "inactive") : "disabled";
      this.refreshReadyStatus(reason, watcher);
      return this.status();
    } catch (error) {
      this.update({ provider: "codegraph", state: "degraded", watcher: "disabled", error: errorMessage(error), reason });
      return this.status();
    }
  }

  private refreshReadyStatus(reason: string, watcherOverride?: "active" | "inactive" | "disabled"): void {
    const stats = this.cg?.getStats() ?? {};
    const watcher = watcherOverride ?? (this.cg?.isWatching() ? "active" : this.config.watch ? "inactive" : "disabled");
    this.update({
      provider: "codegraph",
      state: "ready",
      phase: undefined,
      current: undefined,
      total: undefined,
      files: stats.fileCount,
      nodes: stats.nodeCount,
      edges: stats.edgeCount,
      watcher,
      languages: languagesFromStats(stats),
      frameworks: this.cg?.getDetectedFrameworks(),
      error: undefined,
      reason,
    });
  }

  private disabledStatus(): ContextEngineStatus {
    return {
      provider: this.config.provider === "builtin" ? "builtin" : "off",
      state: "off",
      watcher: "disabled",
      reason: this.config.provider === "auto" && !this.workspace.gitRoot ? "not_git_workspace" : undefined,
    };
  }

  private guardProjectPath(args: JsonObject): { ok: true; args: JsonObject } | { ok: false; result: ToolResult } {
    const projectPath = args.projectPath;
    if (projectPath === undefined || projectPath === null) {
      return { ok: true, args };
    }
    if (typeof projectPath !== "string") {
      return { ok: false, result: fail("project_path_invalid", "projectPath must be a non-empty string") };
    }
    const resolved = projectPath.trim() ? path.resolve(this.workspace.root, projectPath) : this.workspace.root;
    const relative = path.relative(this.workspace.root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return {
        ok: false,
        result: fail("external_project_denied", "projectPath must stay inside the current workspace", {
          projectPath,
          workspace: this.workspace.root,
        }),
      };
    }
    return { ok: true, args: { ...args, projectPath: resolved } };
  }

  private onProgress(state: "indexing" | "syncing", progress: CodeGraphProgress): void {
    this.update({
      ...this.statusSnapshot,
      provider: "codegraph",
      state,
      phase: progress.phase,
      current: progress.current,
      total: progress.total,
    });
  }

  private update(status: ContextEngineStatus): void {
    this.statusSnapshot = status;
    for (const listener of this.listeners) {
      listener(this.status());
    }
  }

  private async executeNativeTool(name: string, args: JsonObject): Promise<string> {
    const cg = this.cg;
    if (!cg) {
      throw new Error("Context engine is not open");
    }
    switch (name) {
      case "codegraph_status":
        return formatStatus(this.status(), cg);
      case "codegraph_files":
        return formatFiles(cg, args);
      case "codegraph_search":
        return formatSearch(cg, args);
      case "codegraph_explore":
        return await formatExplore(cg, args);
      case "codegraph_node":
        return await formatNodeDetails(cg, args);
      case "codegraph_callers":
        return formatRelatedNodes(cg, args, "callers");
      case "codegraph_callees":
        return formatRelatedNodes(cg, args, "callees");
      case "codegraph_impact":
        return formatImpact(cg, args);
      default:
        throw new Error(`Unknown context engine tool: ${name}`);
    }
  }
}

export function normalizeContextEngineConfig(config: VllmAgentConfig): ContextEngineConfig {
  return {
    provider: config.context.engine?.provider ?? "auto",
    startup: config.context.engine?.startup ?? "welcome",
    require_ready_before_chat: config.context.engine?.require_ready_before_chat ?? true,
    watch: config.context.engine?.watch ?? true,
  };
}

const CODEGRAPH_TOOL_DEFINITIONS: ToolDefinition[] = ([
  {
    name: "codegraph_search",
    description: "Quick indexed symbol search by name. Returns symbol locations only; use codegraph_explore when you need source context.",
    permission: "read",
    parameters: objectSchema({
      query: stringSchema("Symbol name or partial name."),
      kind: { type: "string", description: "Optional node kind filter.", enum: ["function", "method", "class", "interface", "type", "variable", "route", "component"] },
      limit: numberSchema("Maximum results. Defaults to 10."),
      projectPath: projectPathSchema(),
    }, ["query"]),
  },
  {
    name: "codegraph_callers",
    description: "List functions that call a symbol.",
    permission: "read",
    parameters: objectSchema({
      symbol: stringSchema("Function, method, or class name."),
      limit: numberSchema("Maximum callers. Defaults to 20."),
      projectPath: projectPathSchema(),
    }, ["symbol"]),
  },
  {
    name: "codegraph_callees",
    description: "List functions called by a symbol.",
    permission: "read",
    parameters: objectSchema({
      symbol: stringSchema("Function, method, or class name."),
      limit: numberSchema("Maximum callees. Defaults to 20."),
      projectPath: projectPathSchema(),
    }, ["symbol"]),
  },
  {
    name: "codegraph_impact",
    description: "List symbols affected by changing a symbol. Use before refactors.",
    permission: "read",
    parameters: objectSchema({
      symbol: stringSchema("Symbol to analyze."),
      depth: numberSchema("Traversal depth. Defaults to 2."),
      projectPath: projectPathSchema(),
    }, ["symbol"]),
  },
  {
    name: "codegraph_node",
    description: "Get details for one symbol, optionally including source code.",
    permission: "read",
    parameters: objectSchema({
      symbol: stringSchema("Symbol to inspect."),
      includeCode: { type: "boolean", description: "Include source code. Defaults to false." },
      file: stringSchema("Optional file path or basename to disambiguate."),
      line: numberSchema("Optional line number to disambiguate."),
      projectPath: projectPathSchema(),
    }, ["symbol"]),
  },
  {
    name: "codegraph_explore",
    description: "Primary repository-wide code intelligence tool. Use first for architecture, bug investigation, call flows, and cross-file understanding.",
    permission: "read",
    parameters: objectSchema({
      query: stringSchema("Natural-language question, symbol names, file names, or code terms to explore."),
      maxFiles: numberSchema("Maximum source files/code blocks to include. Defaults to 8."),
      projectPath: projectPathSchema(),
    }, ["query"]),
  },
  {
    name: "codegraph_status",
    description: "Context index health, graph size, language coverage, and watcher state.",
    permission: "read",
    parameters: objectSchema({
      projectPath: projectPathSchema(),
    }),
  },
  {
    name: "codegraph_files",
    description: "Indexed file tree with language and symbol counts.",
    permission: "read",
    parameters: objectSchema({
      path: stringSchema("Optional path prefix."),
      pattern: stringSchema("Optional wildcard pattern such as *.ts or **/*.test.ts."),
      format: { type: "string", description: "Output format.", enum: ["tree", "flat", "grouped"] },
      projectPath: projectPathSchema(),
    }),
  },
] satisfies ToolDefinition[]).sort((a, b) => a.name.localeCompare(b.name));

function objectSchema(properties: Record<string, JsonObject>, required: string[] = []): JsonObject {
  return { type: "object", additionalProperties: false, properties, required };
}

function stringSchema(description: string): JsonObject {
  return { type: "string", description };
}

function projectPathSchema(): JsonObject {
  return {
    type: "string",
    description: "Optional project path inside the current workspace. Omit this field or use '.' for the current workspace; do not send an empty string.",
    minLength: 1,
  };
}

function numberSchema(description: string): JsonObject {
  return { type: "number", description };
}

function loadCodeGraphModule(): CodeGraphModule {
  return require("@colbymchenry/codegraph") as CodeGraphModule;
}

function formatStatus(status: ContextEngineStatus, cg: CodeGraphInstance): string {
  const stats = cg.getStats();
  const languages = languagesFromStats(stats);
  return [
    "# Context Optimization Status",
    "",
    `State: ${status.state}`,
    `Root: ${cg.getProjectRoot()}`,
    `Files: ${stats.fileCount ?? 0}`,
    `Nodes: ${stats.nodeCount ?? 0}`,
    `Edges: ${stats.edgeCount ?? 0}`,
    `Watcher: ${status.watcher ?? (cg.isWatching() ? "active" : "inactive")}`,
    `Languages: ${languages?.length ? languages.join(", ") : "none"}`,
    `Frameworks: ${cg.getDetectedFrameworks().length ? cg.getDetectedFrameworks().join(", ") : "none"}`,
  ].join("\n");
}

function formatFiles(cg: CodeGraphInstance, args: JsonObject): string {
  const prefix = typeof args.path === "string" && args.path ? normalizeIndexPath(args.path) : undefined;
  const pattern = typeof args.pattern === "string" && args.pattern ? args.pattern : undefined;
  const format = typeof args.format === "string" ? args.format : "tree";
  const files = cg.getFiles()
    .filter((file) => !prefix || indexPathMatchesPrefix(file.path, prefix))
    .filter((file) => !pattern || indexPathMatchesPattern(pattern, file.path, prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) {
    return "No indexed files matched.";
  }
  if (format === "grouped") {
    const groups = new Map<string, CodeGraphFile[]>();
    for (const file of files) {
      const bucket = groups.get(file.language) ?? [];
      bucket.push(file);
      groups.set(file.language, bucket);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([language, entries]) => [`## ${language} (${entries.length})`, ...entries.slice(0, 200).map(fileLine)].join("\n"))
      .join("\n\n");
  }
  const title = format === "flat" ? "# Indexed Files" : "# Indexed File Tree";
  return [title, "", ...files.slice(0, 500).map(fileLine), files.length > 500 ? `... ${files.length - 500} more` : ""].filter(Boolean).join("\n");
}

function formatSearch(cg: CodeGraphInstance, args: JsonObject): string {
  const query = stringArg(args.query, "query");
  const limit = limitArg(args.limit, 10, 100);
  const kind = typeof args.kind === "string" && args.kind ? args.kind : undefined;
  const results = cg.searchNodes(query, { limit, kinds: kind ? [kind] : undefined });
  if (!results.length) {
    return `No results found for "${query}".`;
  }
  return [`# Search: ${query}`, "", ...results.map((result, index) => `${index + 1}. ${nodeLine(result.node)}${result.score !== undefined ? ` · score ${result.score.toFixed(3)}` : ""}`)].join("\n");
}

async function formatExplore(cg: CodeGraphInstance, args: JsonObject): Promise<string> {
  const query = stringArg(args.query, "query");
  const maxFiles = limitArg(args.maxFiles, 8, 20);
  const context = await cg.buildContext(query, { format: "markdown", includeCode: true, maxCodeBlocks: maxFiles, searchLimit: Math.max(5, maxFiles), traversalDepth: 2 });
  return typeof context === "string" ? context : JSON.stringify(context, null, 2);
}

async function formatNodeDetails(cg: CodeGraphInstance, args: JsonObject): Promise<string> {
  const symbol = stringArg(args.symbol, "symbol");
  const matches = findSymbols(cg, symbol, 50).filter((node) => matchesFileAndLine(node, args));
  if (!matches.length) {
    return `Symbol "${symbol}" not found.`;
  }
  const includeCode = args.includeCode === true;
  const sections: string[] = [`# Symbol: ${symbol}`];
  for (const node of matches.slice(0, 10)) {
    sections.push("", `## ${nodeLine(node)}`);
    if (node.signature) sections.push(`Signature: ${node.signature}`);
    if (node.docstring) sections.push(`Doc: ${node.docstring}`);
    if (includeCode) {
      const code = await cg.getCode(node.id);
      if (code) {
        sections.push("", "```", code, "```");
      }
    }
  }
  return sections.join("\n");
}

function formatRelatedNodes(cg: CodeGraphInstance, args: JsonObject, direction: "callers" | "callees"): string {
  const symbol = stringArg(args.symbol, "symbol");
  const limit = limitArg(args.limit, 20, 100);
  const matches = findSymbols(cg, symbol, 20);
  if (!matches.length) {
    return `Symbol "${symbol}" not found.`;
  }
  const seen = new Set<string>();
  const related: CodeGraphNode[] = [];
  for (const node of matches) {
    const rows = direction === "callers" ? cg.getCallers(node.id) : cg.getCallees(node.id);
    for (const row of rows) {
      if (!seen.has(row.node.id)) {
        seen.add(row.node.id);
        related.push(row.node);
      }
    }
  }
  if (!related.length) {
    return `No ${direction} found for "${symbol}".`;
  }
  return [`# ${capitalize(direction)} of ${symbol}`, "", ...related.slice(0, limit).map((node, index) => `${index + 1}. ${nodeLine(node)}`)].join("\n");
}

function formatImpact(cg: CodeGraphInstance, args: JsonObject): string {
  const symbol = stringArg(args.symbol, "symbol");
  const depth = limitArg(args.depth, 2, 10);
  const matches = findSymbols(cg, symbol, 10);
  if (!matches.length) {
    return `Symbol "${symbol}" not found.`;
  }
  const nodes = new Map<string, CodeGraphNode>();
  const edges: CodeGraphEdge[] = [];
  for (const match of matches) {
    const graph = cg.getImpactRadius(match.id, depth);
    for (const [id, node] of graph.nodes) {
      nodes.set(id, node);
    }
    edges.push(...graph.edges);
  }
  return [
    `# Impact: ${symbol}`,
    "",
    `Nodes: ${nodes.size}`,
    `Edges: ${edges.length}`,
    "",
    ...[...nodes.values()].slice(0, 100).map((node, index) => `${index + 1}. ${nodeLine(node)}`),
  ].join("\n");
}

function findSymbols(cg: CodeGraphInstance, symbol: string, limit: number): CodeGraphNode[] {
  const exact = cg.getNodesByName(symbol);
  const fuzzy = cg.searchNodes(symbol, { limit }).map((result) => result.node);
  const nodes = new Map<string, CodeGraphNode>();
  for (const node of [...exact, ...fuzzy]) {
    nodes.set(node.id, node);
  }
  return [...nodes.values()].slice(0, limit);
}

function matchesFileAndLine(node: CodeGraphNode, args: JsonObject): boolean {
  if (typeof args.file === "string" && args.file) {
    const file = args.file.replace(/^\.\//, "");
    if (node.filePath !== file && path.basename(node.filePath) !== path.basename(file) && !node.filePath.endsWith(file)) {
      return false;
    }
  }
  if (typeof args.line === "number" && Number.isFinite(args.line)) {
    return args.line >= node.startLine && args.line <= node.endLine;
  }
  return true;
}

function nodeLine(node: CodeGraphNode): string {
  const signature = node.signature ? ` · ${node.signature}` : "";
  return `${node.name} (${node.kind}) ${node.filePath}:${node.startLine}-${node.endLine}${signature}`;
}

function fileLine(file: CodeGraphFile): string {
  return `- ${file.path} · ${file.language} · ${file.nodeCount} symbols · ${file.size} bytes`;
}

function normalizeIndexPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function indexPathMatchesPrefix(filePath: string, prefix: string): boolean {
  const normalized = normalizeIndexPath(filePath);
  return normalized === prefix || normalized.startsWith(`${prefix}/`);
}

function indexPathMatchesPattern(pattern: string, filePath: string, prefix: string | undefined): boolean {
  const normalized = normalizeIndexPath(filePath);
  if (wildcardMatch(pattern, normalized) || wildcardMatch(pattern, path.posix.basename(normalized))) {
    return true;
  }
  if (!prefix || !indexPathMatchesPrefix(normalized, prefix)) {
    return false;
  }
  const relative = normalized.slice(prefix.length).replace(/^\/+/, "");
  return wildcardMatch(pattern, relative);
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function limitArg(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(value), max));
}

function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.split(/(\*\*|\*)/).filter((part): part is string => part !== undefined).map((part) => {
    if (part === "**") return ".*";
    if (part === "*") return "[^/]*";
    return part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }).join("");
  return new RegExp(`^${escaped}$`).test(value);
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function toVllmToolResult(toolName: string, text: string): ToolResult {
  const truncated = truncateText(text, 24_000);
  return { ok: true, summary: summarizeCodeGraphResult(toolName, truncated.text), data: { content: truncated.text, truncated: truncated.truncated } };
}

function summarizeCodeGraphResult(toolName: string, text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim();
  const label = contextToolLabel(toolName);
  const base = firstLine ? firstLine.slice(0, 120) : `${label} returned no content`;
  return `${label} returned: ${base}`;
}

function contextToolLabel(toolName: string): string {
  switch (toolName) {
    case "codegraph_explore":
      return "context explore";
    case "codegraph_search":
      return "semantic search";
    case "codegraph_node":
      return "indexed symbol";
    case "codegraph_callers":
      return "callers";
    case "codegraph_callees":
      return "callees";
    case "codegraph_impact":
      return "impact analysis";
    case "codegraph_status":
      return "context status";
    case "codegraph_files":
      return "indexed files";
    default:
      return "context tool";
  }
}

function languagesFromStats(stats: CodeGraphStats): string[] | undefined {
  if (!stats.filesByLanguage) {
    return undefined;
  }
  return Object.entries(stats.filesByLanguage)
    .filter(([, count]) => count > 0)
    .map(([language]) => language)
    .sort();
}

async function ensureCodeGraphIgnored(workspace: WorkspaceIdentity, config?: VllmAgentConfig): Promise<void> {
  if (config?.sandbox.mode && config.sandbox.mode !== "off") {
    return;
  }
  const workspaceRoot = workspace.root;
  const result = await runSmallCommand("git", ["rev-parse", "--git-dir"], workspaceRoot, 2000, config ? { config, workspace } : undefined);
  if (result.code !== 0 || !result.stdout.trim()) {
    return;
  }
  const rawGitDir = result.stdout.trim();
  const gitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.join(workspaceRoot, rawGitDir);
  const excludePath = path.join(gitDir, "info", "exclude");
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const current = await fs.readFile(excludePath, "utf8").catch(() => "");
  if (/^\.codegraph\/?$/m.test(current)) {
    return;
  }
  const prefix = current.endsWith("\n") || current.length === 0 ? "" : "\n";
  await fs.appendFile(excludePath, `${prefix}# inferoa local context engine index\n.codegraph/\n`, "utf8");
}

function indexErrors(errors: CodeGraphIndexResult["errors"] | CodeGraphSyncResult["errors"]): string | undefined {
  return errors?.map((error) => error.message).filter(Boolean).join("; ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
