import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { CodeIntelligenceHub } from "../src/code-intelligence/hub.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { VllmAgentConfig, WorkspaceIdentity } from "../src/types.js";

function config(): VllmAgentConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function gitWorkspace(id: string, root: string, alias: string): WorkspaceIdentity {
  return { id, root, alias, gitRoot: root };
}

test("ToolRegistry exposes CodeGraph native tools by default in a git workspace and keeps builtin code intelligence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-codegraph-tools-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = gitWorkspace("w_codegraph_tools", dir, "codegraph-tools");
    const registry = new ToolRegistry(config(), workspace, store);
    const names = registry.list().map((tool) => tool.name);
    const codegraph = registry.list().find((tool) => tool.name === "codegraph");
    const variants = (codegraph?.parameters.oneOf as Array<{ properties?: Record<string, { const?: string }>; required?: string[] }> | undefined) ?? [];

    assert.ok(names.includes("codegraph"));
    assert.equal(names.some((name) => name.startsWith("codegraph_")), false);
    assert.deepEqual(variants.map((variant) => variant.properties?.op?.const), ["explore", "search", "node", "callers", "callees", "impact", "files", "status"]);
    assert.deepEqual(variants[0]?.required, ["op", "query"]);
    assert.deepEqual(variants[2]?.required, ["op", "symbol"]);
    assert.ok(names.includes("lsp"));
    assert.ok(names.includes("ast_grep"));
    assert.ok(names.includes("ast_edit"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CodeGraph tools are removable through context.engine.provider=off", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-codegraph-off-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const cfg = config();
    cfg.context.engine!.provider = "off";
    const workspace: WorkspaceIdentity = { id: "w_codegraph_off", root: dir, alias: "codegraph-off" };
    const names = new ToolRegistry(cfg, workspace, store).list().map((tool) => tool.name);

    assert.equal(names.includes("codegraph"), false);
    assert.equal(names.some((name) => name.startsWith("codegraph_")), false);
    assert.ok(names.includes("lsp"));
    assert.ok(names.includes("ast_grep"));
    assert.ok(names.includes("ast_edit"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CodeGraph auto mode does not start indexing outside a git workspace", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-codegraph-no-git-"));
  try {
    const cfg = config();
    const workspace: WorkspaceIdentity = { id: "w_codegraph_no_git", root: dir, alias: "codegraph-no-git" };
    const hub = new CodeIntelligenceHub(cfg, workspace);

    assert.equal(hub.shouldStartOnWelcome(), false);
    assert.equal(hub.requireReadyBeforeChat(), false);
    assert.equal(hub.status().codegraph.state, "off");
    assert.equal((await hub.startIndexing("test")).state, "off");
    hub.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CodeGraph projectPath is restricted to the active workspace", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-codegraph-guard-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "inferoa-codegraph-outside-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = gitWorkspace("w_codegraph_guard", dir, "codegraph-guard");
    const session = store.createSession(workspace, "guard");
    const registry = new ToolRegistry(config(), workspace, store);
    const result = await registry.call(
      { id: "cg_guard", name: "codegraph", arguments: { op: "status", projectPath: outside } },
      { session_id: session.session_id },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "external_project_denied");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("CodeIntelligenceHub builds a small CodeGraph index and serves native tool results", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-codegraph-index-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, "lib"));
    await writeFile(
      path.join(dir, "src", "sample.ts"),
      "export function greet(name: string) {\n  return `hello ${name}`;\n}\n\nexport function run() {\n  return greet('vllm');\n}\n",
      "utf8",
    );
    await writeFile(
      path.join(dir, "lib", "other.ts"),
      "export function greetOther(name: string) {\n  return `hi ${name}`;\n}\n",
      "utf8",
    );
    const cfg = config();
    cfg.context.engine!.watch = false;
    const workspace = gitWorkspace("w_codegraph_index", dir, "codegraph-index");
    const hub = new CodeIntelligenceHub(cfg, workspace);
    const status = await hub.startIndexing("test");

    assert.equal(status.state, "ready", status.error);
    assert.ok((status.files ?? 0) >= 1);

    const session = store.createSession(workspace, "codegraph");
    const registry = new ToolRegistry(cfg, workspace, store, hub);
    const result = await registry.call(
      { id: "cg_search", name: "codegraph", arguments: { op: "search", query: "greet", limit: 5 } },
      { session_id: session.session_id },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(String(result.data?.content ?? ""), /greet/);

    const pathFilteredSearch = await registry.call(
      { id: "cg_search_path", name: "codegraph", arguments: { op: "search", query: "greet", path: "src", limit: 10 } },
      { session_id: session.session_id },
    );
    assert.equal(pathFilteredSearch.ok, true, JSON.stringify(pathFilteredSearch));
    assert.match(String(pathFilteredSearch.data?.content ?? ""), /src\/sample\.ts/);
    assert.doesNotMatch(String(pathFilteredSearch.data?.content ?? ""), /lib\/other\.ts/);

    const files = await registry.call(
      { id: "cg_files", name: "codegraph", arguments: { op: "files", path: "src", pattern: "*.ts", format: "flat" } },
      { session_id: session.session_id },
    );
    assert.equal(files.ok, true, JSON.stringify(files));
    assert.match(String(files.data?.content ?? ""), /src\/sample\.ts/);

    const statusWithBlankProjectPath = await registry.call(
      { id: "cg_status_blank_project", name: "codegraph", arguments: { op: "status", projectPath: "" } },
      { session_id: session.session_id },
    );
    assert.equal(statusWithBlankProjectPath.ok, true, JSON.stringify(statusWithBlankProjectPath));

    hub.dispose();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CodeIntelligenceHub reopens an existing context index without degrading", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-context-reopen-"));
  try {
    await mkdir(path.join(dir, "src"));
    await writeFile(
      path.join(dir, "src", "sample.ts"),
      "export function greet(name: string) {\n  return `hello ${name}`;\n}\n",
      "utf8",
    );
    const cfg = config();
    cfg.context.engine!.watch = false;
    const workspace = gitWorkspace("w_context_reopen", dir, "context-reopen");

    const initialHub = new CodeIntelligenceHub(cfg, workspace);
    const initial = await initialHub.startIndexing("initial");
    assert.equal(initial.state, "ready", initial.error);
    initialHub.dispose();

    const reopenedHub = new CodeIntelligenceHub(cfg, workspace);
    const reopened = await reopenedHub.startIndexing("welcome");
    assert.equal(reopened.state, "ready", reopened.error);
    assert.ok((reopened.files ?? 0) >= 1);
    reopenedHub.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
