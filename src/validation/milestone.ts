#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { CORE_TOOL_DEFINITIONS } from "../tools/schemas.js";
import { LSP_REGISTRY } from "../tools/code-intelligence.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";

type Milestone =
  | "T0"
  | "T1"
  | "T2"
  | "T3"
  | "T4"
  | "T5"
  | "T6"
  | "T7"
  | "T8"
  | "T9"
  | "T10";

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const milestoneArg = process.argv[2] ?? "T0";
const milestone = milestoneArg as Milestone;

const checks: Record<Milestone, () => Promise<Check[]>> = {
  T0: async () => [
    await file("README.md"),
    await file("docs/roadmap.md"),
    await file("docs/tui-product-design.md"),
    await file("docs/public-source-hygiene.md"),
    await containsCheck("docs/roadmap.md", "`inferoa` launches the TUI by default.", "TUI-first entrypoint contract"),
    await containsCheck("README.md", "Inference Optimized Agent Harness", "README positioning"),
  ],
  T1: async () => [
    await file("src/tui/app.ts"),
    await file("src/tui/slash.ts"),
    await file("src/tui/splash.ts"),
    await containsCheck("src/cli.ts", "new TuiApp", "default CLI launches TUI"),
    await containsCheck("src/tui/app.ts", "readComposer", "custom chat composer"),
    await containsCheck("src/tui/app.ts", "stdout.on(\"resize\"", "resize redraw hooks"),
    await containsCheck("src/tui/app.ts", "chooseSlashCommand", "slash command palette"),
  ],
  T2: async () => [
    await containsCheck("src/tui/app.ts", "renderSetupView", "TUI setup wizard"),
    await containsCheck("src/tui/app.ts", "writeSecret", "vault-backed secret write"),
    await containsCheck("src/tui/app.ts", "api_key_ref", "config stores secret refs"),
    await containsCheck("src/tui/app.ts", "probeChatModels", "chat model probing"),
    await containsCheck("src/tui/app.ts", "TUI_OMNI_SETUP_CAPABILITIES", "Omni setup capability list"),
    await containsCheck("src/config/config.ts", "api_key_env?: string", "legacy env auth cleanup"),
  ],
  T3: async () => [
    await file("src/tui/tool-renderer.ts"),
    await file("src/tui/markdown.ts"),
    await containsCheck("src/tui/app.ts", "MarkdownStreamRenderer", "streaming markdown renderer"),
    await containsCheck("src/tui/tool-renderer.ts", "renderDiff", "diff renderer"),
    await containsCheck("src/tui/tool-renderer.ts", "collapseCompactToolRows", "compact tool batching"),
    await containsCheck("src/tools/workspace-tools.ts", "diff", "write/edit diff evidence"),
    { name: "Required model-facing tools present", pass: requiredTools(["file_search", "read_file", "edit_file", "write_file", "run_command", "git_status", "todo_write", "complete_step", "lsp"]) },
  ],
  T4: async () => [
    await containsCheck("src/session/store.ts", "renameSession", "session rename support"),
    await containsCheck("src/session/store.ts", "archiveSession", "session archive support"),
    await containsCheck("src/session/store.ts", "acquireLock", "single-writer session locks"),
    await containsCheck("src/tui/app.ts", "renderSessionsView", "TUI sessions view"),
    await containsCheck("src/tui/app.ts", "getLock(session.session_id)", "session lock status display"),
  ],
  T5: async () => [
    await file("src/model/endpoint-signals.ts"),
    await file("src/tui/cache-footer.ts"),
    await containsCheck("src/session/store.ts", "recordEndpointEvidence", "endpoint evidence persistence"),
    await containsCheck("src/model/endpoint-signals.ts", "parseCacheMetrics", "prefix-cache metric parsing"),
    await containsCheck("src/tui/cache-footer.ts", "cached === undefined", "hide unavailable cache fields"),
    await containsCheck("src/context/prompt.ts", "tool_schema_hash", "stable tool schema hash evidence"),
  ],
  T6: async () => [
    await file("src/context/compressor.ts"),
    { name: "80% compression threshold configured", pass: DEFAULT_CONFIG.context.compression_threshold === 0.8 },
    await containsCheck("src/runtime.ts", "compression_start", "runtime compression start event"),
    await containsCheck("src/runtime.ts", "compression_end", "runtime compression end event"),
    await containsCheck("src/tui/app.ts", "renderContextView", "TUI context/compression view"),
    await containsCheck("src/context/compressor.ts", "context.compacted", "compaction event persistence"),
  ],
  T7: async () => [
    await containsCheck("docs/roadmap.md", "165.245.131.56", "AMD host 1 documented"),
    await containsCheck("docs/roadmap.md", "134.199.199.149", "AMD host 2 documented"),
    await containsCheck("docs/final-acceptance-task.md", "partial deployments may be stopped", "AMD cleanup policy documented"),
    await containsCheck("src/validation/acceptance.ts", "vision: config.omni.endpoints.vision", "acceptance requires Omni vision endpoint"),
    await containsCheck("src/validation/acceptance.ts", "image_generation", "acceptance requires image generation"),
    await containsCheck("src/validation/acceptance.ts", "video_generation", "acceptance requires video generation"),
  ],
  T8: async () => [
    await containsCheck("src/model/gateway.ts", "x-session-id", "SR receives stable session id"),
    await containsCheck("src/model/gateway.ts", "x-inferoa-session-id", "Inferoa session header"),
    await containsCheck("src/model/endpoint-signals.ts", "x-router-model", "router metadata capture"),
    await containsCheck("src/tui/app.ts", "vLLM Semantic Router", "TUI setup exposes Semantic Router"),
  ],
  T9: async () => [
    await file("src/daemon/supervisor.ts"),
    await containsCheck("src/daemon/supervisor.ts", "attachDaemonJob", "daemon attach"),
    await containsCheck("src/daemon/supervisor.ts", "detachDaemonJob", "daemon detach"),
    await containsCheck("src/daemon/supervisor.ts", "cancelDaemonJob", "daemon cancel"),
    await containsCheck("src/tui/app.ts", "renderJobsView", "TUI daemon jobs view"),
    await containsCheck("src/validation/acceptance.ts", "validateDaemonAcceptance", "final task daemon validation"),
  ],
  T10: async () => [
    await file("src/validation/acceptance.ts"),
    await containsCheck("src/validation/acceptance.ts", "runFinalAcceptance", "final acceptance runner"),
    await containsCheck("src/validation/acceptance.ts", "file_search", "acceptance checks file search"),
    await containsCheck("src/validation/acceptance.ts", "continuedAfterCompression", "acceptance checks post-compression work"),
    await containsCheck("src/validation/acceptance.ts", "direct_cached_token_evidence", "acceptance records cached-token evidence"),
    await containsCheck("src/tui/app.ts", "runFinalAcceptance", "TUI acceptance run entrypoint"),
    { name: "Omni tools present", pass: requiredTools(["vision_understanding", "image_generation", "video_generation"]) },
    { name: "Core tool surface is broad enough", pass: CORE_TOOL_DEFINITIONS.length >= 30, detail: `${CORE_TOOL_DEFINITIONS.length} tools` },
    { name: "Code-intelligence registry covers day-0 languages", pass: LSP_REGISTRY.length >= 15, detail: `${LSP_REGISTRY.length} languages` },
  ],
};

if (!isMilestone(milestoneArg)) {
  console.error(`Unknown milestone ${milestoneArg}. Expected one of ${Object.keys(checks).join(", ")}.`);
  process.exit(1);
}

const result = await checks[milestone]();
const failed = result.filter((check) => !check.pass);
console.log(JSON.stringify({ milestone, ok: failed.length === 0, checks: result }, null, 2));
if (failed.length) {
  process.exitCode = 1;
}

async function file(target: string): Promise<Check> {
  return { name: `${target} exists`, pass: await exists(target) };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(path.resolve(target));
    return true;
  } catch {
    return false;
  }
}

async function containsCheck(target: string, needle: string, name: string): Promise<Check> {
  return { name, pass: await contains(target, needle) };
}

async function contains(target: string, needle: string): Promise<boolean> {
  try {
    return (await fs.readFile(path.resolve(target), "utf8")).includes(needle);
  } catch {
    return false;
  }
}

function requiredTools(names: string[]): boolean {
  const present = new Set(CORE_TOOL_DEFINITIONS.map((tool) => tool.name));
  return names.every((name) => present.has(name));
}

function isMilestone(value: string): value is Milestone {
  return Object.prototype.hasOwnProperty.call(checks, value);
}
