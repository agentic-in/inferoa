#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { EndpointSignals } from "../model/endpoint-signals.js";
import { SessionStore } from "../session/store.js";
import { ToolRegistry } from "../tools/registry.js";
import type { JsonObject, ToolCall, ToolResult, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { ensureDir } from "../util/fs.js";

interface SmokeOptions {
  endpointUrl: string;
  model: string;
  profile: string;
  evidenceDir: string;
  tools: string[];
}

interface SmokeResult {
  name: string;
  status: "pass" | "fail" | "blocked";
  http_status?: number;
  artifact_resource_id?: string;
  artifact_resources?: JsonObject[];
  failure_reason?: string;
  summary?: string;
}

interface SmokeReport {
  timestamp: string;
  profile: string;
  model: string;
  endpoint_url: string;
  session_id: string;
  state_dir: string;
  results: SmokeResult[];
  report_path?: string;
}

const TOOL_CASES: Record<string, Omit<ToolCall, "id">> = {
  vision: {
    name: "vision_understanding",
    arguments: {
      inputs: [onePixelPng()],
      prompt: "Describe the image in one short sentence.",
    },
  },
  image_generation: {
    name: "image_generation",
    arguments: { prompt: "A tiny validation icon", size: "256x256" },
  },
  image_edit: {
    name: "image_edit",
    arguments: { prompt: "Make the image brighter.", images: [validationPng64()] },
  },
  video_generation: {
    name: "video_generation",
    arguments: { prompt: "A one second validation clip.", mode: "async", seconds: "1", size: "256x256", timeout_ms: 120_000, poll_ms: 2_000 },
  },
  video_sync: {
    name: "video_generation",
    arguments: { prompt: "A one second validation clip.", mode: "sync", seconds: "1", size: "256x256" },
  },
  audio_generation: {
    name: "audio_generation",
    arguments: {
      input: "short rain ambience",
      response_format: "wav",
      audio_length: 1,
      num_inference_steps: 4,
      guidance_scale: 6,
      seed: 42,
    },
  },
  speech_generation: {
    name: "speech_generation",
    arguments: { input: "hello from inferoa validation", voice: "vivian", response_format: "wav" },
  },
  speech_voices: {
    name: "speech_voices",
    arguments: {},
  },
};

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2), process.env);
  const report = await runOmniRealSmoke(options);
  console.log(JSON.stringify(report, null, 2));
  if (report.results.some((result) => result.status === "fail")) {
    process.exitCode = 1;
  }
}

export async function runOmniRealSmoke(options: SmokeOptions): Promise<SmokeReport> {
  await ensureDir(options.evidenceDir);
  const config = configFor(options);
  const workspace: WorkspaceIdentity = { id: "w_omni_real_smoke", root: process.cwd(), alias: "omni-real-smoke" };
  const stateDir = path.join(options.evidenceDir, "state");
  const store = await SessionStore.open(stateDir);
  store.upsertWorkspace(workspace);
  const session = store.createSession(workspace, `omni-real-${options.profile}`);
  const registry = new ToolRegistry(config, workspace, store);

  const results: SmokeResult[] = [];
  try {
    if (options.tools.includes("routes")) {
      results.push(await routeResult(config));
    }
    if (options.tools.includes("chat")) {
      results.push(await chatResult(options));
    }
    for (const toolName of options.tools) {
      const toolCase = TOOL_CASES[toolName];
      if (!toolCase) {
        continue;
      }
      const result = await registry.call({ id: `omni-real-${toolName}`, ...toolCase }, { session_id: session.session_id, run_id: "omni-real-smoke" });
      results.push(resultFromTool(toolName, result));
    }
  } finally {
    store.close();
  }

  const report: SmokeReport = {
    timestamp: new Date().toISOString(),
    profile: options.profile,
    model: options.model,
    endpoint_url: options.endpointUrl,
    session_id: session.session_id,
    state_dir: stateDir,
    results,
  };
  const reportPath = path.join(options.evidenceDir, `${safeFilePart(options.profile)}-${Date.now()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  report.report_path = reportPath;
  return report;
}

function parseOptions(argv: string[], env: NodeJS.ProcessEnv): SmokeOptions {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      continue;
    }
    args.set(arg.slice(2), argv[++i] ?? "");
  }
  const endpointUrl = args.get("endpoint") ?? env.INFEROA_OMNI_REAL_BASE_URL ?? env.INFEROA_BASE_URL;
  const model = args.get("model") ?? env.INFEROA_OMNI_REAL_MODEL ?? env.INFEROA_MODEL;
  if (!endpointUrl || !model) {
    throw new Error("Omni real smoke requires --endpoint/INFEROA_OMNI_REAL_BASE_URL and --model/INFEROA_OMNI_REAL_MODEL.");
  }
  return {
    endpointUrl: endpointUrl.replace(/\/$/, ""),
    model,
    profile: args.get("profile") ?? env.INFEROA_OMNI_REAL_PROFILE ?? "manual",
    evidenceDir: path.resolve(args.get("evidence-dir") ?? env.INFEROA_OMNI_REAL_EVIDENCE_DIR ?? ".inferoa/omni-evidence"),
    tools: (args.get("tools") ?? env.INFEROA_OMNI_REAL_TOOLS ?? "routes,chat").split(",").map((item) => item.trim()).filter(Boolean),
  };
}

function configFor(options: SmokeOptions): VllmAgentConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.model_setup.base_url = options.endpointUrl;
  config.model_setup.model = options.model;
  config.model_setup.provider = "vllm";
  config.omni.enabled = true;
  for (const key of ["vision", "image_generation", "image_edit", "video_understanding", "video_generation", "audio_understanding", "audio_generation", "speech"] as const) {
    config.omni.endpoints[key] = { base_url: options.endpointUrl, model: options.model };
  }
  return config;
}

async function routeResult(config: VllmAgentConfig): Promise<SmokeResult> {
  const snapshot = await new EndpointSignals(config).snapshot();
  const missing = (snapshot.omni_capabilities ?? []).filter((capability) => capability.configured && capability.route_present === false);
  return {
    name: "routes",
    status: missing.length ? "fail" : "pass",
    summary: `${(snapshot.omni_capabilities ?? []).filter((capability) => capability.route_present).length} route(s) present`,
    failure_reason: missing.length ? missing.map((capability) => `${capability.name}: ${capability.unavailable_reason ?? "route missing"}`).join("; ") : undefined,
  };
}

async function chatResult(options: SmokeOptions): Promise<SmokeResult> {
  const response = await fetch(`${options.endpointUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: options.model,
      messages: [{ role: "user", content: "Reply with exactly: OMNI_REAL_CHAT_OK" }],
      temperature: 0,
      max_tokens: 32,
    }),
  });
  const text = await response.text();
  return {
    name: "chat",
    status: response.ok && /OMNI_REAL_CHAT_OK/i.test(text) ? "pass" : "fail",
    http_status: response.status,
    summary: text.slice(0, 500),
    failure_reason: response.ok ? undefined : text.slice(0, 500),
  };
}

function resultFromTool(name: string, result: ToolResult): SmokeResult {
  const status = result.ok ? "pass" : likelyProfileBlocked(result) ? "blocked" : "fail";
  return {
    name,
    status,
    http_status: statusCode(result),
    artifact_resource_id: result.resource_uri,
    artifact_resources: Array.isArray(result.data?.resources) ? (result.data.resources as JsonObject[]) : undefined,
    failure_reason: result.error?.message,
    summary: result.summary,
  };
}

function statusCode(result: ToolResult): number | undefined {
  const text = result.error?.message ?? result.summary;
  const match = /^(\d{3}):/.exec(text);
  return match ? Number(match[1]) : undefined;
}

function likelyProfileBlocked(result: ToolResult): boolean {
  const text = `${result.summary} ${result.error?.message ?? ""}`.toLowerCase();
  return /profile|dedicated|diffusion|stage|not support|not supported|model|engine|expected .*sampling params/.test(text);
}

function onePixelPng(): string {
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
}

function validationPng64(): string {
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAZUlEQVR42u3QQREAAAQAMBFFFEwXcjh7rMAiq+ezECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAu5bGeiylVW0Mr0AAAAASUVORK5CYII=";
}

function safeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "manual";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
