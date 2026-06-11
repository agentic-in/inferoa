import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { WorkspaceIdentity } from "../src/types.js";

test("AST tools find and edit TypeScript functions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-ast-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "sample.ts"), "export function greet() {\n  return 'hi';\n}\n", "utf8");
    const workspace: WorkspaceIdentity = { id: "w_ast", root: dir, alias: "ast" };
    const session = store.createSession(workspace, "ast");
    const registry = new ToolRegistry(structuredClone(DEFAULT_CONFIG), workspace, store);
    const grep = await registry.call(
      { id: "tc1", name: "ast_grep", arguments: { language: "typescript", path: "src/sample.ts", selector: "function:greet" } },
      { session_id: session.session_id },
    );
    assert.equal(grep.ok, true);
    const namedFunctions = await registry.call(
      { id: "tc1_named", name: "ast_grep", arguments: { language: "typescript", path: "src/sample.ts", selector: "function:name" } },
      { session_id: session.session_id },
    );
    assert.equal(namedFunctions.ok, true);
    assert.deepEqual(
      (namedFunctions.data?.matches as Array<{ name?: string }>).map((match) => match.name),
      ["greet"],
    );
    const edit = await registry.call(
      {
        id: "tc2",
        name: "ast_edit",
        arguments: {
          language: "typescript",
          path: "src/sample.ts",
          selector: "function:greet",
          operation: "replace_node",
          content: "export function greet() {\n  return 'hello';\n}",
        },
      },
      { session_id: session.session_id },
    );
    assert.equal(edit.ok, true);
    assert.match(await readFile(path.join(dir, "src", "sample.ts"), "utf8"), /hello/);

    await writeFile(path.join(dir, "src", "escaped.ts"), "export const value = 1;\n", "utf8");
    const escaped = await registry.call(
      {
        id: "tc3",
        name: "ast_edit",
        arguments: {
          language: "typescript",
          path: "src/escaped.ts",
          selector: "text:export const",
          operation: "insert_before",
          content: "// inserted via escaped content\\n",
        },
      },
      { session_id: session.session_id },
    );
    assert.equal(escaped.ok, true);
    assert.equal((await readFile(path.join(dir, "src", "escaped.ts"), "utf8")).startsWith("// inserted via escaped content\nexport const"), true);
    assert.match(String(escaped.data?.diff ?? ""), /\+\/\/ inserted via escaped content/);

    await writeFile(path.join(dir, "src", "sample.py"), "import os\nfrom pathlib import Path\n\nprint('x')\n", "utf8");
    const pythonImports = await registry.call(
      { id: "tc4", name: "ast_grep", arguments: { language: "python", path: "src/sample.py", selector: "import" } },
      { session_id: session.session_id },
    );
    assert.equal(pythonImports.ok, true);
    const firstMatch = (pythonImports.data?.matches as Array<{ line_text?: string; text?: string }>)[0];
    assert.equal(firstMatch?.line_text, "import os");
    assert.equal(firstMatch?.text, "import os");
    const unsupportedLanguage = await registry.call(
      { id: "tc4_unsupported", name: "ast_grep", arguments: { language: "go", path: "src/sample.ts", selector: "function:main" } },
      { session_id: session.session_id },
    );
    assert.equal(unsupportedLanguage.ok, false);
    assert.equal(unsupportedLanguage.error?.code, "invalid_tool_arguments");
    const directoryPath = await registry.call(
      { id: "tc4_directory", name: "ast_grep", arguments: { language: "typescript", path: "src", selector: "function:name" } },
      { session_id: session.session_id },
    );
    assert.equal(directoryPath.ok, false);
    assert.equal(directoryPath.error?.code, "ast_path_must_be_file");

    const lspStatus = await registry.call({ id: "tc5", name: "lsp", arguments: { action: "status" } }, { session_id: session.session_id });
    assert.equal(lspStatus.ok, true);
    const tsStatus = (lspStatus.data?.languages as Array<{ id: string; available?: boolean; fallback_adapter?: string }>).find(
      (language) => language.id === "typescript",
    );
    assert.equal(tsStatus?.available, true);
    assert.match(String(tsStatus?.fallback_adapter ?? ""), /TypeScript compiler API/);

    await writeFile(path.join(dir, "src", "rename.ts"), "export function greet() {\n  return greet.name;\n}\n", "utf8");
    const legacyRename = await registry.call(
      {
        id: "tc6",
        name: "lsp",
        arguments: { action: "rename", path: "src/rename.ts", symbol: "greet", new_name: "hello", apply: true },
      },
      { session_id: session.session_id },
    );
    assert.equal(legacyRename.ok, false);
    assert.equal(legacyRename.error?.code, "invalid_tool_arguments");
    assert.match(legacyRename.error?.message ?? "", /arguments\.action/);
    assert.match(await readFile(path.join(dir, "src", "rename.ts"), "utf8"), /greet/);

    const rename = await registry.call(
      {
        id: "tc7",
        name: "lsp_rename",
        arguments: { path: "src/rename.ts", symbol: "greet", new_name: "hello" },
      },
      { session_id: session.session_id },
    );
    assert.equal(rename.ok, true, JSON.stringify(rename));
    const renamed = await readFile(path.join(dir, "src", "rename.ts"), "utf8");
    assert.match(renamed, /function hello/);
    assert.doesNotMatch(renamed, /\bgreet\b/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
