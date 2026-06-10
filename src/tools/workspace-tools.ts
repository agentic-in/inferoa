import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResourceRecord } from "../session/store.js";
import type { JsonObject, ToolResult } from "../types.js";
import { resolveInside, resolveReadablePath, resolveWritablePath, runSmallCommand, toPosixPath } from "../util/fs.js";
import { clampLimit, DEFAULT_LIST_LIMIT, fail, ok, truncateText } from "../util/limit.js";
import type { ToolExecutionContext } from "./context.js";
import { decodeEscapedTextArgument, textArgumentCandidates } from "./text-args.js";
import { workspaceExternalPathsAllowed } from "./permissions.js";
import { runRtkAwareShellCommand, type RtkShellCommandResult } from "../rtk/command.js";
import { extensionForContentType, listResourceSummaries, mediaFromResource, resolveResourceReference, resourceRecordSummary } from "./resource-resolver.js";
import { runSandboxedProcess } from "../sandbox/runner.js";
import { blockedSandboxInfoToJson, type SandboxExecutionInfo } from "../sandbox/types.js";

export async function listDir(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  try {
    const rel = String(args.path ?? ".");
    const readable = resolveWritablePath(context.workspace.root, rel, workspaceExternalPathsAllowed(context.config, context.workspace));
    const dir = readable.file;
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT, 1000);
    const page = Number(args.page ?? 0);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const slice = entries.slice(page, page + limit).map((entry) => ({
      name: entry.name,
      path: readable.external ? path.join(readable.displayPath, entry.name) : toPosixPath(path.relative(context.workspace.root, path.join(dir, entry.name))),
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
    }));
    const hasMore = page + limit < entries.length;
    return {
      ok: true,
      summary: `Listed ${slice.length} entries in ${rel}${hasMore ? ` (${entries.length - page - slice.length} more)` : ""}`,
      data: { entries: slice },
      next_page: hasMore ? String(page + limit) : undefined,
    };
  } catch (error) {
    return fail("list_dir_failed", errorMessage(error));
  }
}

export async function readFile(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  try {
    const rel = String(args.path);
    const readable = resolveReadablePath(context.workspace.root, rel);
    const file = readable.file;
    const text = await fs.readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, Number(args.start_line ?? 1));
    const count = clampLimit(args.line_count, 200, 2000);
    const selected = lines.slice(start - 1, start - 1 + count);
    const content = selected.map((line, index) => `${start + index}: ${line}`).join("\n");
    const truncated = start - 1 + count < lines.length;
    return {
      ok: true,
      summary: `Read ${selected.length} lines from ${readable.displayPath}`,
      data: { path: readable.displayPath, external: readable.external, start_line: start, line_count: selected.length, content, total_lines: lines.length },
      next_page: truncated ? String(start + count) : undefined,
    };
  } catch (error) {
    return fail("read_file_failed", errorMessage(error));
  }
}

export async function readResource(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const uri = String(args.uri ?? "").trim();
  if (!uri || uri === "list" || uri === "*") {
    const resources = listResourceSummaries(context);
    return ok(`Listed ${resources.length} resources`, { resources: resources as never });
  }
  const resolved = resolveResourceReference(uri, context);
  if (!resolved.ok && resolved.failure.code === "resource_uri_ambiguous") {
    return fail("resource_uri_ambiguous", `Resource URI is ambiguous: ${uri}`, {
      uri,
      hint: "Use the full resource URI from available_resources.",
      available_resources: (resolved.failure.ambiguous ?? []).map(resourceRecordSummary) as never,
    });
  }
  if (!resolved.ok) {
    return fail("resource_not_found", `Resource not found: ${uri}`, {
      uri,
      hint: "Use read_resource with uri='list' to discover resources, or pass the full resource:// URI.",
      available_resources: listResourceSummaries(context) as never,
    });
  }
  const resource = resolved.resource;
  const lines = resource.content.split(/\r?\n/);
  const page = Number(args.page ?? 1);
  const start = Math.max(1, page);
  const count = clampLimit(args.line_count, 200, 2000);
  const selected = lines.slice(start - 1, start - 1 + count);
  return {
    ok: true,
    summary: `Read ${selected.length} resource lines from ${resource.uri}`,
    data: {
      uri: resource.uri,
      kind: resource.kind,
      metadata: resource.metadata,
      start_line: start,
      content: selected.map((line, index) => `${start + index}: ${line}`).join("\n"),
      total_lines: lines.length,
    },
    next_page: start - 1 + count < lines.length ? String(start + count) : undefined,
  };
}

export async function exportResource(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  try {
    const uri = String(args.uri ?? "").trim();
    if (!uri || uri === "list" || uri === "*") {
      return fail("resource_uri_required", "export_resource requires a concrete managed resource URI.", {
        available_resources: listResourceSummaries(context) as never,
      });
    }
    const resolved = resolveResourceReference(uri, context);
    if (!resolved.ok && resolved.failure.code === "resource_uri_ambiguous") {
      return fail("resource_uri_ambiguous", `Resource URI is ambiguous: ${uri}`, {
        uri,
        hint: "Use the full resource URI from available_resources.",
        available_resources: (resolved.failure.ambiguous ?? []).map(resourceRecordSummary) as never,
      });
    }
    if (!resolved.ok) {
      return fail("resource_not_found", `Resource not found: ${uri}`, {
        uri,
        hint: "Use read_resource with uri='list' to discover resources, or pass the full resource:// URI.",
        available_resources: listResourceSummaries(context) as never,
      });
    }

    const exported = exportPayloadForResource(resolved.resource, context, Number(args.media_index ?? 0));
    if (!exported.ok) {
      return fail(exported.code, exported.message, { uri, kind: resolved.resource.kind, metadata: resolved.resource.metadata });
    }
    const extension = extensionForContentType(exported.contentType);
    const defaultPath = path.join(".inferoa", "exports", `${resourceId(exported.sourceUri)}.${extension}`);
    const writable = resolveWritablePath(context.workspace.root, String(args.path ?? defaultPath), workspaceExternalPathsAllowed(context.config, context.workspace));
    await fs.mkdir(path.dirname(writable.file), { recursive: true });
    await fs.writeFile(writable.file, exported.bytes);
    return ok(`Exported ${exported.contentType} resource to ${writable.displayPath}`, {
      uri: resolved.resource.uri,
      source_resource_uri: exported.sourceUri,
      path: writable.displayPath,
      mime: exported.contentType,
      size: exported.bytes.length,
      extension,
      kind: resolved.resource.kind,
      external: writable.external,
    });
  } catch (error) {
    return fail("export_resource_failed", errorMessage(error));
  }
}

export async function globPaths(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  try {
    const pattern = String(args.pattern);
    const cwd = resolveInside(context.workspace.root, String(args.cwd ?? "."));
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT, 2000);
    const all = await walkFiles(cwd, context.workspace.root, limit * 5);
    const regex = globToRegExp(pattern);
    const page = Number(args.page ?? 0);
    const matches = all.filter((file) => regex.test(file)).slice(page, page + limit);
    const totalMatches = all.filter((file) => regex.test(file)).length;
    return {
      ok: true,
      summary: `Found ${matches.length} paths for ${pattern}`,
      data: { matches },
      next_page: page + limit < totalMatches ? String(page + limit) : undefined,
    };
  } catch (error) {
    return fail("glob_failed", errorMessage(error));
  }
}

export async function fileSearch(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const query = String(args.query);
  const limit = clampLimit(args.limit, 50, 500);
  const cwd = resolveInside(context.workspace.root, String(args.path ?? "."));
  const options: SearchOptions = {
    caseSensitive: Boolean(args.case_sensitive),
    regex: Boolean(args.regex),
    glob: typeof args.glob === "string" && args.glob ? args.glob : undefined,
  };
  const rgArgs = ["--line-number", "--column", "--no-heading", "--color", "never"];
  if (!options.regex) {
    rgArgs.push("--fixed-strings");
  }
  if (!options.caseSensitive) {
    rgArgs.push("--ignore-case");
  }
  if (options.glob) {
    rgArgs.push("--glob", options.glob);
  }
  rgArgs.push("--", query, cwd);
  const rg = await runSmallCommand("rg", rgArgs, context.workspace.root, 15_000, { config: context.config, workspace: context.workspace });
  if (rg.code === 0 || rg.stdout.trim()) {
    const lines = rg.stdout.split(/\r?\n/).filter(Boolean).slice(0, limit);
    const matches = lines.map(parseRgLine).filter(Boolean);
    return {
      ok: true,
      summary: `Found ${matches.length} matches for ${query}`,
      data: { query, matches },
      resource_uri: rg.stdout.length > 20_000 ? context.store.putResource(context.session_id, "file_search.raw", rg.stdout, { query }).uri : undefined,
    };
  }
  if (rg.code === 1) {
    return ok(`Found 0 matches for ${query}`, { query, matches: [] });
  }
  if (rg.code !== 127 && rg.stderr.trim()) {
    return fail("file_search_failed", rg.stderr.trim());
  }
  const grep = await grepSearch(cwd, context.workspace.root, query, options, limit, context);
  if (grep.ok) {
    return ok(`Found ${grep.matches.length} matches for ${query}`, { query, matches: grep.matches });
  }
  try {
    const fallback = await fallbackSearch(cwd, context.workspace.root, query, options, limit);
    return ok(`Found ${fallback.length} matches for ${query}`, { query, matches: fallback });
  } catch (error) {
    return fail("file_search_failed", grep.error || errorMessage(error));
  }
}

export async function writeFile(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  try {
    const rel = String(args.path);
    const writable = resolveWritablePath(context.workspace.root, rel, workspaceExternalPathsAllowed(context.config, context.workspace));
    const target = writable.file;
    const overwrite = Boolean(args.overwrite);
    let previous: string | undefined;
    try {
      await fs.access(target);
      if (!overwrite) {
        return fail("file_exists", `File exists and overwrite was not true: ${writable.displayPath}`);
      }
      previous = await fs.readFile(target, "utf8");
    } catch {
      // New file.
    }
    const next = String(args.content);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, next, "utf8");
    return ok(`Wrote ${writable.displayPath}`, {
      path: writable.displayPath,
      external: writable.external,
      bytes: Buffer.byteLength(next),
      diff: simpleUnifiedDiff(writable.displayPath, previous ?? "", next, previous === undefined),
    });
  } catch (error) {
    return fail("write_file_failed", errorMessage(error));
  }
}

export async function editFile(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  try {
    const rel = String(args.path);
    const writable = resolveWritablePath(context.workspace.root, rel, workspaceExternalPathsAllowed(context.config, context.workspace));
    const target = writable.file;
    const rawOldText = String(args.old_text);
    const rawNewText = String(args.new_text);
    const occurrence = Math.max(1, Number(args.occurrence ?? 1));
    if (!rawOldText) {
      return fail("old_text_required", `old_text must not be empty for ${writable.displayPath}`);
    }
    const text = await fs.readFile(target, "utf8");
    const match = findOccurrence(text, textArgumentCandidates(rawOldText), occurrence);
    if (!match) {
      return fail("old_text_not_found", `Could not find occurrence ${occurrence} in ${writable.displayPath}`, {
        path: writable.displayPath,
        external: writable.external,
        occurrence,
        hint: "edit_file requires exact text. Use read_file around a similar line, or use apply_patch for structured edits.",
        similar_lines: similarTextSnippets(text, rawOldText) as never,
      });
    }
    const newText = match.decoded_escapes ? decodeEscapedTextArgument(rawNewText) : rawNewText;
    const updated = `${text.slice(0, match.index)}${newText}${text.slice(match.index + match.old_text.length)}`;
    await fs.writeFile(target, updated, "utf8");
    return ok(`Edited ${writable.displayPath}`, {
      path: writable.displayPath,
      external: writable.external,
      occurrence,
      decoded_escapes: match.decoded_escapes,
      diff: simpleUnifiedDiff(writable.displayPath, text, updated, false),
    });
  } catch (error) {
    return fail("edit_file_failed", errorMessage(error));
  }
}

export async function applyPatchTool(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const patch = String(args.patch);
  const result = await runSandboxedProcess({
    config: context.config,
    workspace: context.workspace,
    command: "git",
    args: ["apply", "--whitespace=nowarn"],
    shell: false,
    cwd: context.workspace.root,
    env: process.env,
    timeoutMs: 120_000,
    stdin: patch,
    capabilities: ["git_metadata_write"],
  });
  const sandbox = blockedSandboxInfoToJson(result.sandbox);
  if (result.code === 0) {
    return ok("Patch applied", { stdout: result.stdout, diff: patch, sandbox });
  }
  return fail(result.sandbox.blocked ? "sandbox_blocked" : "patch_failed", result.stderr || `git apply exited ${result.code}`, {
    stdout: result.stdout,
    stderr: result.stderr,
    diff: patch,
    sandbox,
  });
}

export async function gitStatus(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const cwd = resolveInside(context.workspace.root, String(args.cwd ?? "."));
  const result = await runRtkAwareShellCommand({
    config: context.config,
    store: context.store,
    session_id: context.session_id,
    run_id: context.run_id,
    tool_call_id: context.tool_call_id,
    tool_name: context.tool_name ?? "git_status",
    command: "git status --short --branch",
    cwd,
    workspace: context.workspace,
    timeout_ms: 10_000,
  });
  return commandResult("git_status", result, context, "git.status");
}

export async function gitDiff(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const cwd = resolveInside(context.workspace.root, String(args.cwd ?? "."));
  const pathArg = typeof args.path === "string" ? args.path : ".";
  const command = ["git", "diff", args.staged ? "--staged" : "", "--", shellQuote(pathArg)].filter(Boolean).join(" ");
  const result = await runRtkAwareShellCommand({
    config: context.config,
    store: context.store,
    session_id: context.session_id,
    run_id: context.run_id,
    tool_call_id: context.tool_call_id,
    tool_name: context.tool_name ?? "git_diff",
    command,
    cwd,
    workspace: context.workspace,
    timeout_ms: 10_000,
  });
  return commandResult("git_diff", result, context, "git.diff");
}

export async function gitShow(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const cwd = resolveInside(context.workspace.root, String(args.cwd ?? "."));
  const rev = shellQuote(String(args.rev));
  const command = typeof args.path === "string" ? `git show --stat --patch ${rev} -- ${shellQuote(args.path)}` : `git show --stat --patch ${rev}`;
  const result = await runRtkAwareShellCommand({
    config: context.config,
    store: context.store,
    session_id: context.session_id,
    run_id: context.run_id,
    tool_call_id: context.tool_call_id,
    tool_name: context.tool_name ?? "git_show",
    command,
    cwd,
    workspace: context.workspace,
    timeout_ms: 10_000,
  });
  return commandResult("git_show", result, context, "git.show");
}

export async function todoWrite(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const items = Array.isArray(args.items) ? args.items : [];
  context.store.appendEvent({
    session_id: context.session_id,
    run_id: context.run_id,
    type: "todo.updated",
    data: { items: items as never },
  });
  return ok(`Updated ${items.length} todo items`, { items: items as never });
}

export async function completeStep(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  context.store.appendEvent({
    session_id: context.session_id,
    run_id: context.run_id,
    type: "evidence.step.completed",
    data: { step_id: String(args.step_id), evidence: (args.evidence ?? {}) as JsonObject },
  });
  return ok(`Completed ${String(args.step_id)}`, { step_id: String(args.step_id), evidence: (args.evidence ?? {}) as JsonObject });
}

export async function sessionNote(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  context.store.appendEvent({
    session_id: context.session_id,
    run_id: context.run_id,
    type: "session.note",
    data: { note: String(args.note), tags: Array.isArray(args.tags) ? (args.tags as never) : [] },
  });
  return ok("Session note recorded", { note: String(args.note) });
}

async function commandResult(
  name: string,
  result: { code: number | null; stdout: string; stderr: string; rtk?: RtkShellCommandResult["rtk"]; sandbox?: SandboxExecutionInfo },
  context: ToolExecutionContext,
  kind: string,
): Promise<ToolResult> {
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const truncated = truncateText(text);
  const resource =
    truncated.truncated || text.length > 20_000
      ? context.store.putResource(context.session_id, kind, text, { command: name, code: result.code }).uri
      : undefined;
  return {
    ok: result.code === 0,
    summary: `${name} exited ${result.code}`,
    data: { code: result.code, output: truncated.text, sandbox: blockedSandboxInfoToJson(result.sandbox) },
    resource_uri: resource,
    error: result.code === 0 ? undefined : { code: result.sandbox?.blocked ? "sandbox_blocked" : `${name}_failed`, message: result.stderr || result.stdout },
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function walkFiles(dir: string, root: string, max: number): Promise<string[]> {
  const out: string[] = [];
  async function visit(current: string): Promise<void> {
    if (out.length >= max) {
      return;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        out.push(toPosixPath(path.relative(root, full)));
      }
      if (out.length >= max) {
        return;
      }
    }
  }
  await visit(dir);
  return out;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`);
}

function parseRgLine(line: string): JsonObject | undefined {
  const match = /^(.*?):(\d+):(\d+):(.*)$/.exec(line);
  if (!match) {
    return undefined;
  }
  return {
    path: match[1],
    line: Number(match[2]),
    column: Number(match[3]),
    snippet: match[4],
  };
}

type SearchOptions = {
  caseSensitive: boolean;
  regex: boolean;
  glob?: string;
};

async function grepSearch(
  cwd: string,
  root: string,
  query: string,
  options: SearchOptions,
  limit: number,
  context: ToolExecutionContext,
): Promise<{ ok: true; matches: JsonObject[] } | { ok: false; error?: string }> {
  const grepArgs = ["-R", "-n", "-I", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=dist"];
  grepArgs.push(options.regex ? "-E" : "-F");
  if (!options.caseSensitive) {
    grepArgs.push("-i");
  }
  if (options.glob) {
    grepArgs.push("--include", options.glob);
  }
  grepArgs.push("--", query, ".");
  const result = await runSmallCommand("grep", grepArgs, cwd, 15_000, { config: context.config, workspace: context.workspace });
  if (result.code === 0 || result.stdout.trim()) {
    const matches = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, limit)
      .map((line) => parseGrepLine(line, cwd, root, query, options))
      .filter((match): match is JsonObject => Boolean(match));
    return { ok: true, matches };
  }
  if (result.code === 1) {
    return { ok: true, matches: [] };
  }
  return { ok: false, error: result.stderr.trim() };
}

function parseGrepLine(line: string, cwd: string, root: string, query: string, options: SearchOptions): JsonObject | undefined {
  const match = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!match) {
    return undefined;
  }
  const fullPath = path.resolve(cwd, match[1]!.replace(/^\.\//, ""));
  return {
    path: toPosixPath(path.relative(root, fullPath)),
    line: Number(match[2]),
    column: findMatchColumn(match[3] ?? "", query, options),
    snippet: match[3],
  };
}

function findMatchColumn(line: string, query: string, options: SearchOptions): number {
  if (options.regex) {
    try {
      const match = new RegExp(query, options.caseSensitive ? "" : "i").exec(line);
      return match?.index === undefined ? 1 : match.index + 1;
    } catch {
      return 1;
    }
  }
  const haystack = options.caseSensitive ? line : line.toLowerCase();
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const index = haystack.indexOf(needle);
  return index < 0 ? 1 : index + 1;
}

export function simpleUnifiedDiff(rel: string, oldText: string, newText: string, isNewFile: boolean): string {
  const oldLines = splitForDiff(oldText);
  const newLines = splitForDiff(newText);
  const oldStart = isNewFile ? 0 : 1;
  const oldCount = isNewFile ? 0 : oldLines.length;
  const newCount = newLines.length;
  return [
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -${oldStart},${oldCount} +1,${newCount} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function findOccurrence(
  text: string,
  candidates: Array<{ text: string; decoded_escapes: boolean }>,
  occurrence: number,
): { index: number; old_text: string; decoded_escapes: boolean } | undefined {
  for (const candidate of candidates) {
    let index = -1;
    let cursor = 0;
    for (let i = 0; i < occurrence; i += 1) {
      index = text.indexOf(candidate.text, cursor);
      if (index < 0) {
        break;
      }
      cursor = index + candidate.text.length;
    }
    if (index >= 0) {
      return { index, old_text: candidate.text, decoded_escapes: candidate.decoded_escapes };
    }
  }
  return undefined;
}

function similarTextSnippets(text: string, needle: string): JsonObject[] {
  const decoded = decodeEscapedTextArgument(needle);
  const query = decoded
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!query) {
    return [];
  }
  const queryTokens = new Set(query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line, score: scoreSimilarLine(line, query, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, 5)
    .map(({ line, text }) => ({ line, text }));
}

function scoreSimilarLine(line: string, query: string, queryTokens: Set<string>): number {
  const lowerLine = line.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 0;
  if (lowerLine.includes(lowerQuery)) {
    score += 100;
  }
  if (lowerQuery.includes(lowerLine.trim().toLowerCase()) && line.trim()) {
    score += 40;
  }
  for (const token of queryTokens) {
    if (lowerLine.includes(token)) {
      score += 5;
    }
  }
  return score;
}

function splitForDiff(text: string): string[] {
  if (!text) {
    return [];
  }
  return text.endsWith("\n") ? text.slice(0, -1).split(/\r?\n/) : text.split(/\r?\n/);
}

async function fallbackSearch(
  cwd: string,
  root: string,
  query: string,
  options: SearchOptions,
  limit: number,
): Promise<JsonObject[]> {
  const files = await walkFiles(cwd, root, limit * 10);
  const globRegex = options.glob ? globToRegExp(options.glob) : undefined;
  const matcher = createSearchMatcher(query, options);
  const matches: JsonObject[] = [];
  for (const file of files) {
    if (globRegex && !globRegex.test(file)) {
      continue;
    }
    const full = path.join(root, file);
    let text = "";
    try {
      text = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const column = matcher(line);
      if (column > 0) {
        matches.push({ path: file, line: i + 1, column, snippet: line });
        if (matches.length >= limit) {
          return matches;
        }
      }
    }
  }
  return matches;
}

function createSearchMatcher(query: string, options: SearchOptions): (line: string) => number {
  if (options.regex) {
    const regex = new RegExp(query, options.caseSensitive ? "" : "i");
    return (line) => {
      const match = regex.exec(line);
      return match?.index === undefined ? 0 : match.index + 1;
    };
  }
  const needle = options.caseSensitive ? query : query.toLowerCase();
  return (line) => {
    const haystack = options.caseSensitive ? line : line.toLowerCase();
    const index = haystack.indexOf(needle);
    return index < 0 ? 0 : index + 1;
  };
}

function exportPayloadForResource(
  resource: ResourceRecord,
  context: ToolExecutionContext,
  mediaIndex: number,
): { ok: true; bytes: Buffer; contentType: string; sourceUri: string } | { ok: false; code: string; message: string } {
  const media = mediaFromResource(resource, context, Number.isFinite(mediaIndex) ? mediaIndex : 0);
  if (media.ok) {
    if (!media.media.bytes) {
      return {
        ok: false,
        code: "resource_export_url_only",
        message: `Resource contains only a remote media URL and no embedded bytes: ${media.media.remoteUrl ?? resource.uri}`,
      };
    }
    return {
      ok: true,
      bytes: media.media.bytes,
      contentType: media.media.contentType,
      sourceUri: media.media.sourceResource.uri,
    };
  }
  if (media.failure.code === "resource_has_remote_url_only") {
    return { ok: false, code: "resource_export_url_only", message: media.failure.message };
  }
  const contentType = stringMetadata(resource.metadata.content_type) ?? contentTypeForTextResource(resource);
  return {
    ok: true,
    bytes: Buffer.from(resource.content, "utf8"),
    contentType,
    sourceUri: resource.uri,
  };
}

function contentTypeForTextResource(resource: ResourceRecord): string {
  if (resource.kind.endsWith(".json") || looksLikeJson(resource.content)) {
    return "application/json";
  }
  return "text/plain";
}

function looksLikeJson(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function resourceId(uri: string): string {
  return (uri.split("/").pop() ?? "resource").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
