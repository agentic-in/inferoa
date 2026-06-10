import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { JsonObject, ToolResult } from "../types.js";
import { resolveInside, toPosixPath } from "../util/fs.js";
import { fail, ok } from "../util/limit.js";
import type { ToolExecutionContext } from "./context.js";
import { editFile, simpleUnifiedDiff } from "./workspace-tools.js";
import { decodeEscapedTextArgument } from "./text-args.js";
import { runSandboxedProcess } from "../sandbox/runner.js";
import { blockedSandboxInfoToJson } from "../sandbox/types.js";

interface LanguageSpec {
  id: string;
  extensions: string[];
  root_markers: string[];
  commands: string[];
  managed_install?: string;
  fallback_adapter?: string;
}

export const LSP_REGISTRY: LanguageSpec[] = [
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    root_markers: ["tsconfig.json", "package.json"],
    commands: ["typescript-language-server", "vtsls"],
    managed_install: "npm install -g typescript-language-server typescript",
    fallback_adapter: "TypeScript compiler API diagnostics, symbols, hover, references, rename",
  },
  {
    id: "python",
    extensions: [".py"],
    root_markers: ["pyproject.toml", "setup.py", "requirements.txt"],
    commands: ["pyright-langserver", "pylsp"],
    managed_install: "npm install -g pyright",
    fallback_adapter: "python -m py_compile diagnostics and text/AST navigation",
  },
  { id: "go", extensions: [".go"], root_markers: ["go.mod"], commands: ["gopls"], managed_install: "go install golang.org/x/tools/gopls@latest" },
  { id: "rust", extensions: [".rs"], root_markers: ["Cargo.toml"], commands: ["rust-analyzer"], managed_install: "rustup component add rust-analyzer" },
  { id: "cpp", extensions: [".c", ".cc", ".cpp", ".h", ".hpp"], root_markers: ["compile_commands.json", "CMakeLists.txt"], commands: ["clangd"] },
  { id: "java", extensions: [".java"], root_markers: ["pom.xml", "build.gradle"], commands: ["jdtls"] },
  { id: "csharp", extensions: [".cs"], root_markers: ["*.csproj", "*.sln"], commands: ["omnisharp"] },
  { id: "ruby", extensions: [".rb"], root_markers: ["Gemfile"], commands: ["ruby-lsp"] },
  { id: "php", extensions: [".php"], root_markers: ["composer.json"], commands: ["intelephense", "phpactor"] },
  { id: "lua", extensions: [".lua"], root_markers: [".luarc.json"], commands: ["lua-language-server"] },
  { id: "bash", extensions: [".sh", ".bash"], root_markers: [".shellcheckrc"], commands: ["bash-language-server"] },
  { id: "zig", extensions: [".zig"], root_markers: ["build.zig"], commands: ["zls"] },
  { id: "kotlin", extensions: [".kt", ".kts"], root_markers: ["build.gradle.kts"], commands: ["kotlin-language-server"] },
  { id: "swift", extensions: [".swift"], root_markers: ["Package.swift"], commands: ["sourcekit-lsp"] },
  { id: "haskell", extensions: [".hs"], root_markers: ["stack.yaml", "*.cabal"], commands: ["haskell-language-server-wrapper"] },
];

export async function lspTool(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const action = String(args.action);
  if (action === "status") {
    const specs = await Promise.all(
      LSP_REGISTRY.map(async (spec) => {
        const availableCommand = await firstAvailable(spec.commands, context);
        return {
          id: spec.id,
          extensions: spec.extensions,
          commands: spec.commands,
          available: Boolean(availableCommand || spec.fallback_adapter),
          available_command: availableCommand,
          fallback_adapter: spec.fallback_adapter,
          managed_install: spec.managed_install,
          managed_install_mode: context.config.skills.managed_installs,
        };
      }),
    );
    return ok("LSP registry status", { languages: specs as never });
  }
  const rel = typeof args.path === "string" ? args.path : undefined;
  if (!rel) {
    return fail("path_required", `lsp.${action} requires path`);
  }
  const file = resolveInside(context.workspace.root, rel);
  if (action === "diagnostics") {
    return await diagnostics(file, rel, context);
  }
  if (action === "symbols") {
    return await symbols(file, rel);
  }
  if (action === "definition" || action === "references" || action === "hover") {
    return await textNavigation(action, file, rel, args);
  }
  if (action === "rename" && args.apply) {
    return fail("lsp_rename_required", "lsp is read-only; use lsp_rename to apply symbol renames");
  }
  return ok(`LSP action ${action} degraded to registry-only status`, {
    action,
    path: rel,
    reason: "No persistent language-server process is required for day-0 fallback.",
  });
}

export async function lspRenameTool(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const rel = typeof args.path === "string" ? args.path : undefined;
  if (!rel) {
    return fail("path_required", "lsp_rename requires path");
  }
  const file = resolveInside(context.workspace.root, rel);
  return await renameSymbol(file, rel, String(args.symbol ?? args.query ?? ""), String(args.new_name ?? ""), context);
}

export async function astGrep(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const rel = String(args.path);
  const file = resolveInside(context.workspace.root, rel);
  const text = await fs.readFile(file, "utf8");
  const language = String(args.language);
  const selector = String(args.selector);
  const limit = typeof args.limit === "number" ? Math.max(1, Math.min(args.limit, 500)) : 100;
  const matches = language.startsWith("python")
    ? pythonMatches(text, selector, rel)
    : tsMatches(text, selector, rel, languageForFile(file));
  return ok(`Found ${Math.min(matches.length, limit)} AST matches`, { matches: matches.slice(0, limit) as never });
}

export async function astEdit(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const rel = String(args.path);
  const file = resolveInside(context.workspace.root, rel);
  const text = await fs.readFile(file, "utf8");
  const language = String(args.language);
  const selector = String(args.selector);
  const operation = String(args.operation);
  const rawContent = typeof args.content === "string" ? args.content : "";
  const content = decodeEscapedTextArgument(rawContent);
  const beforeOk = language.startsWith("python") ? await validatePython(text, context) : validateTypeScript(text, languageForFile(file)).ok;
  if (!beforeOk) {
    return fail("parse_failed_before", `File did not parse before AST edit: ${rel}`);
  }
  const matches = language.startsWith("python") ? pythonMatches(text, selector, rel) : tsMatches(text, selector, rel, languageForFile(file));
  const match = matches[0];
  if (!match) {
    return fail("selector_not_found", `No AST match for ${selector} in ${rel}`);
  }
  const start = Number(match.start_offset);
  const end = Number(match.end_offset);
  let updated: string;
  if (operation === "replace_node") {
    updated = `${text.slice(0, start)}${content}${text.slice(end)}`;
  } else if (operation === "insert_before") {
    updated = `${text.slice(0, start)}${content}${content.endsWith("\n") ? "" : "\n"}${text.slice(start)}`;
  } else if (operation === "insert_after") {
    updated = `${text.slice(0, end)}${text[end - 1] === "\n" ? "" : "\n"}${content}${content.endsWith("\n") ? "" : "\n"}${text.slice(end)}`;
  } else if (operation === "delete_node") {
    updated = `${text.slice(0, start)}${text.slice(end)}`;
  } else {
    return fail("unsupported_ast_operation", `Unsupported operation: ${operation}`);
  }
  const afterOk = language.startsWith("python") ? await validatePython(updated, context) : validateTypeScript(updated, languageForFile(file)).ok;
  if (!afterOk) {
    return fail("parse_failed_after", `AST edit would make file invalid: ${rel}`);
  }
  await fs.writeFile(file, updated, "utf8");
  return ok(`Applied ${operation} to ${rel}`, {
    path: rel,
    selector,
    operation,
    decoded_escapes: content !== rawContent,
    match: match as never,
    diff: simpleUnifiedDiff(rel, text, updated, false),
  });
}

function tsMatches(text: string, selector: string, rel: string, scriptKind: ts.ScriptKind): JsonObject[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind);
  const matches: JsonObject[] = [];
  const parsed = parseAstSelector(selector);
  const lines = text.split(/\r?\n/);
  function visit(node: ts.Node): void {
    const name = nodeName(node);
    const include =
      selector === "import"
        ? ts.isImportDeclaration(node)
        : parsed.kind === "function"
          ? isFunctionLike(node) && selectorNameMatches(name, parsed.value)
          : parsed.kind === "class"
            ? ts.isClassDeclaration(node) && selectorNameMatches(name, parsed.value)
            : parsed.kind === "interface"
              ? ts.isInterfaceDeclaration(node) && selectorNameMatches(name, parsed.value)
              : parsed.kind === "text"
                ? node.getText(source).includes(parsed.value ?? "")
              : name === selector;
    if (include) {
      const start = node.getStart(source);
      const end = node.getEnd();
      const startLC = source.getLineAndCharacterOfPosition(start);
      const endLC = source.getLineAndCharacterOfPosition(end);
      matches.push({
        path: rel,
        kind: ts.SyntaxKind[node.kind],
        name: name ?? "",
        start_line: startLC.line + 1,
        start_character: startLC.character + 1,
        end_line: endLC.line + 1,
        end_character: endLC.character + 1,
        start_offset: start,
        end_offset: end,
        line_text: lines[startLC.line] ?? "",
        text: node.getText(source).slice(0, 500),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return matches;
}

function pythonMatches(text: string, selector: string, rel: string): JsonObject[] {
  const lines = text.split(/\r?\n/);
  const parsed = parseAstSelector(selector);
  const matches: JsonObject[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    const nameMatch = /^(async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
    const include =
      parsed.kind === "function"
        ? (nameMatch?.[1] === "def" || nameMatch?.[1] === "async def") && selectorNameMatches(nameMatch?.[2], parsed.value)
        : parsed.kind === "class"
          ? nameMatch?.[1] === "class" && selectorNameMatches(nameMatch?.[2], parsed.value)
          : parsed.kind === "import"
            ? trimmed.startsWith("import ") || trimmed.startsWith("from ")
            : parsed.kind === "text"
              ? line.includes(parsed.value ?? "")
              : nameMatch?.[2] === selector;
    if (include) {
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      let endLine = i + 1;
      let endOffset = offset + line.length;
      if (parsed.kind !== "import" && parsed.kind !== "text") {
        let cursorOffset = offset + line.length + 1;
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j] ?? "";
          if (next.trim() && (next.match(/^\s*/)?.[0].length ?? 0) <= indent) {
            break;
          }
          endLine = j + 1;
          endOffset = cursorOffset + next.length;
          cursorOffset += next.length + 1;
        }
      }
      matches.push({
        path: rel,
        kind: nameMatch?.[1] ?? "text",
        name: nameMatch?.[2] ?? "",
        start_line: i + 1,
        start_character: indent + 1,
        end_line: endLine,
        end_character: 1,
        start_offset: offset,
        end_offset: endOffset,
        line_text: line,
        text: lines.slice(i, endLine).join("\n").slice(0, 500),
      });
    }
    offset += line.length + 1;
  }
  return matches;
}

function parseAstSelector(selector: string): { kind: string; value?: string } {
  const separator = selector.indexOf(":");
  if (separator < 0) {
    return { kind: selector };
  }
  const kind = selector.slice(0, separator);
  const value = selector.slice(separator + 1);
  return { kind, value };
}

function selectorNameMatches(name: string | undefined, value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  if (value === "" || value === "name") {
    return Boolean(name);
  }
  return name === value;
}

async function diagnostics(file: string, rel: string, context: ToolExecutionContext): Promise<ToolResult> {
  if (file.endsWith(".py")) {
    const result = await runSandboxedProcess({
      config: context.config,
      workspace: context.workspace,
      command: "python3",
      args: ["-m", "py_compile", file],
      cwd: path.dirname(file),
      env: process.env,
      timeoutMs: 20_000,
    });
    return ok(`Python diagnostics for ${rel}`, {
      diagnostics: result.code === 0 ? [] : [{ severity: "error", message: result.stderr || result.stdout }],
      code: result.code,
      sandbox: blockedSandboxInfoToJson(result.sandbox),
    });
  }
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    const text = await fs.readFile(file, "utf8");
    const validation = validateTypeScript(text, languageForFile(file));
    return ok(`TypeScript diagnostics for ${rel}`, { diagnostics: validation.diagnostics as never });
  }
  return ok(`No diagnostics adapter for ${rel}`, { diagnostics: [] });
}

async function symbols(file: string, rel: string): Promise<ToolResult> {
  const text = await fs.readFile(file, "utf8");
  const matches = file.endsWith(".py")
    ? [...pythonMatches(text, "text:", rel)].filter((match) => ["def", "async def", "class"].includes(String(match.kind)))
    : tsSymbolMatches(text, rel, languageForFile(file));
  return ok(`Found ${matches.length} symbols`, { symbols: matches as never });
}

async function textNavigation(action: string, file: string, rel: string, args: JsonObject): Promise<ToolResult> {
  const text = await fs.readFile(file, "utf8");
  const symbol = String(args.symbol ?? args.query ?? "");
  const targetLine = typeof args.line === "number" ? args.line : undefined;
  const targetChar = typeof args.character === "number" ? args.character : undefined;
  const lines = text.split(/\r?\n/);
  const matches: JsonObject[] = [];
  // When line/character are provided, try exact position first, then fall back to text search
  if (symbol && targetLine && targetChar) {
    const lineText = lines[targetLine - 1];
    if (lineText !== undefined) {
      matches.push({ path: rel, line: targetLine, character: targetChar, snippet: lineText });
      return ok(`${action} fallback at specified position`, { action, symbol, line: targetLine, character: targetChar, matches: matches as never });
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    const column = lines[i]?.indexOf(symbol) ?? -1;
    if (symbol && column >= 0) {
      matches.push({ path: rel, line: i + 1, character: column + 1, snippet: lines[i] });
    }
  }
  return ok(`${action} fallback found ${matches.length} text matches`, { action, symbol, matches: matches as never });
}

async function renameSymbol(
  file: string,
  rel: string,
  symbol: string,
  newName: string,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  if (!symbol || !newName) {
    return fail("rename_args_required", "rename requires symbol and new_name");
  }
  const text = await fs.readFile(file, "utf8");
  const regex = new RegExp(`\\b${escapeRegex(symbol)}\\b`, "g");
  const updated = text.replace(regex, newName);
  if (updated === text) {
    return fail("symbol_not_found", `Symbol not found: ${symbol}`);
  }
  return await editFile({ path: rel, old_text: text, new_text: updated, occurrence: 1 }, context);
}

function tsSymbolMatches(text: string, rel: string, scriptKind: ts.ScriptKind): JsonObject[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind);
  const out: JsonObject[] = [];
  function visit(node: ts.Node): void {
    const name = nodeName(node);
    if (name && (isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isVariableStatement(node))) {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source));
      out.push({
        path: rel,
        name,
        kind: ts.SyntaxKind[node.kind],
        line: start.line + 1,
        character: start.character + 1,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return out;
}

function nodeName(node: ts.Node): string | undefined {
  const named = node as ts.Node & { name?: ts.Node };
  if (named.name && ts.isIdentifier(named.name)) {
    return named.name.text;
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations
      .map((decl) => (ts.isIdentifier(decl.name) ? decl.name.text : undefined))
      .filter(Boolean)
      .join(",");
  }
  return undefined;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function validateTypeScript(text: string, scriptKind: ts.ScriptKind): { ok: boolean; diagnostics: JsonObject[] } {
  const source = ts.createSourceFile("file.ts", text, ts.ScriptTarget.Latest, true, scriptKind);
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const diagnostics = parseDiagnostics.map((diag) => {
    const pos = diag.start !== undefined ? source.getLineAndCharacterOfPosition(diag.start) : undefined;
    return {
      severity: "error",
      message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
      line: pos ? pos.line + 1 : undefined,
      character: pos ? pos.character + 1 : undefined,
    };
  });
  return { ok: diagnostics.length === 0, diagnostics };
}

async function validatePython(text: string, context: ToolExecutionContext): Promise<boolean> {
  const result = await runSandboxedProcess({
    config: context.config,
    workspace: context.workspace,
    command: "python3",
    args: ["-c", "import ast,sys; ast.parse(sys.stdin.read())"],
    cwd: context.workspace.root,
    env: process.env,
    timeoutMs: 20_000,
    stdin: text,
  });
  return result.code === 0;
}

function languageForFile(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

async function firstAvailable(commands: string[], context: ToolExecutionContext): Promise<string | undefined> {
  for (const command of commands) {
    const result = await runSandboxedProcess({
      config: context.config,
      workspace: context.workspace,
      command: `command -v ${shellQuote(command)}`,
      shell: true,
      cwd: context.workspace.root,
      env: process.env,
      timeoutMs: 1000,
    });
    if (result.code === 0) {
      return result.stdout.trim();
    }
  }
  return undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
