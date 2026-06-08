#!/usr/bin/env node
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { Runtime, type RuntimeStatusEvent } from "../runtime.js";
import { SessionStore } from "../session/store.js";
import type { JsonObject, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { ensureDir } from "../util/fs.js";

interface E2EOptions {
  omniEndpointUrl: string;
  omniModel: string;
  profile: string;
  evidenceDir: string;
  tool: string;
}

interface E2EReport {
  timestamp: string;
  profile: string;
  omni_endpoint_url: string;
  omni_model: string;
  controller_requests: number;
  session_id: string;
  run_id: string;
  state_dir: string;
  tool_rounds: number;
  tool_calls: number;
  final_content: string;
  tool: string;
  status: "pass" | "fail";
  checks: Array<{ name: string; pass: boolean; detail?: string }>;
  status_events: RuntimeStatusEvent[];
  tool_results: JsonObject[];
  resources: JsonObject[];
  endpoint_evidence_events: JsonObject[];
  report_path?: string;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2), process.env);
  const report = await runOmniRuntimeE2E(options);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "pass") {
    process.exitCode = 1;
  }
}

export async function runOmniRuntimeE2E(options: E2EOptions): Promise<E2EReport> {
  await ensureDir(options.evidenceDir);
  const toolCase = toolCaseFor(options.tool);
  const controller = new ScriptedController(toolCase);
  await controller.start();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "inferoa-omni-e2e-workspace-"));
  const stateDir = path.join(options.evidenceDir, "state");
  const store = await SessionStore.open(stateDir);
  try {
    const config = configFor(options, controller.baseUrl());
    const workspace: WorkspaceIdentity = { id: "w_omni_e2e_runtime", root: workspaceRoot, alias: "omni-e2e-runtime" };
    const runtime = new Runtime(config, workspace, store);
    const statusEvents: RuntimeStatusEvent[] = [];
    const result = await runtime.run({
      title: `omni-e2e-${options.profile}`,
      prompt: `Run the remote Omni ${options.tool} validation now. Use ${toolCase.name}, then summarize the result.`,
      client_id: "omni-e2e-runtime",
      onStatus: (event) => statusEvents.push(event),
      request_class: "background",
    });
    const events = store.listEvents(result.session.session_id);
    const toolResults = events.filter((event) => event.type === "tool.result").map((event) => event.data);
    const resources = store.listResources(result.session.session_id, 20).map((resource) => ({
      uri: resource.uri,
      kind: resource.kind,
      metadata: resource.metadata,
      content_bytes: Buffer.byteLength(resource.content),
    }));
    const endpointEvidenceEvents = events
      .filter((event) => event.type === "model.response.settled" || event.type === "tool.result")
      .map((event) => ({ type: event.type, data: event.data }));
    const checks = [
      { name: "runtime made two controller model requests", pass: controller.requests.length === 2, detail: `${controller.requests.length}` },
      { name: "runtime executed at least one tool round", pass: result.tool_rounds >= 1, detail: `${result.tool_rounds}` },
      { name: `runtime executed ${toolCase.name}`, pass: statusEvents.some((event) => event.type === "tool_end" && event.tool_name === toolCase.name && event.ok) },
      { name: "remote Omni result reached tool result", pass: toolResults.some((data) => /"ok":true/.test(JSON.stringify(data)) && toolCase.resultPattern.test(JSON.stringify(data))) },
      { name: "managed resource persisted", pass: !toolCase.requiresResource || resources.some((resource) => String(resource.kind).startsWith("omni.")) },
      { name: "final model turn consumed tool result", pass: /OMNI_E2E_RUNTIME_OK/.test(result.content), detail: result.content.slice(0, 200) },
    ];
    const report: E2EReport = {
      timestamp: new Date().toISOString(),
      profile: options.profile,
      omni_endpoint_url: options.omniEndpointUrl,
      omni_model: options.omniModel,
      controller_requests: controller.requests.length,
      session_id: result.session.session_id,
      run_id: result.run_id,
      state_dir: stateDir,
      tool_rounds: result.tool_rounds,
      tool_calls: result.tool_calls,
      final_content: result.content,
      tool: options.tool,
      status: checks.every((check) => check.pass) ? "pass" : "fail",
      checks,
      status_events: statusEvents,
      tool_results: toolResults,
      resources,
      endpoint_evidence_events: endpointEvidenceEvents,
    };
    const reportPath = path.join(options.evidenceDir, `${safeFilePart(options.profile)}-${safeFilePart(options.tool)}-runtime-e2e-${Date.now()}.json`);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    report.report_path = reportPath;
    return report;
  } finally {
    store.close();
    await controller.stop();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

interface RuntimeToolCase {
  name: string;
  arguments: JsonObject;
  endpoint: "vision" | "image_generation" | "image_edit" | "video_generation" | "audio_generation" | "speech";
  resultPattern: RegExp;
  requiresResource: boolean;
}

const TOOL_CASES: Record<string, RuntimeToolCase> = {
  vision: {
    name: "vision_understanding",
    endpoint: "vision",
    arguments: {
      inputs: [onePixelPng()],
      prompt: "Describe this validation image in one short sentence.",
    },
    resultPattern: /"capability":"vision"/,
    requiresResource: true,
  },
  image_generation: {
    name: "image_generation",
    endpoint: "image_generation",
    arguments: { prompt: "A tiny validation icon", size: "256x256" },
    resultPattern: /"capability":"image_generation"/,
    requiresResource: true,
  },
  image_edit: {
    name: "image_edit",
    endpoint: "image_edit",
    arguments: { prompt: "Make this validation image brighter.", images: [validationPng64()] },
    resultPattern: /"capability":"image_edit"/,
    requiresResource: true,
  },
  video_generation: {
    name: "video_generation",
    endpoint: "video_generation",
    arguments: { prompt: "A one second validation clip.", mode: "sync", seconds: "1", size: "256x256" },
    resultPattern: /"capability":"video_generation"/,
    requiresResource: true,
  },
  video_generation_async: {
    name: "video_generation",
    endpoint: "video_generation",
    arguments: { prompt: "A one second validation clip.", mode: "async", seconds: "1", size: "256x256", timeout_ms: 120_000, poll_ms: 2_000 },
    resultPattern: /"capability":"video_generation"/,
    requiresResource: true,
  },
  audio_generation: {
    name: "audio_generation",
    endpoint: "audio_generation",
    arguments: {
      input: "short rain ambience",
      response_format: "wav",
      audio_length: 1,
      num_inference_steps: 4,
      guidance_scale: 6,
      seed: 42,
    },
    resultPattern: /"capability":"audio_generation"/,
    requiresResource: true,
  },
  speech_generation: {
    name: "speech_generation",
    endpoint: "speech",
    arguments: { input: "hello from inferoa validation", voice: "vivian", response_format: "wav" },
    resultPattern: /"capability":"speech_generation"/,
    requiresResource: true,
  },
  speech_voices: {
    name: "speech_voices",
    endpoint: "speech",
    arguments: {},
    resultPattern: /"capability":"speech_voices"|"voices":/,
    requiresResource: false,
  },
};

class ScriptedController {
  readonly requests: JsonObject[] = [];
  constructor(private readonly toolCase: RuntimeToolCase) {}

  private server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      json(res, { object: "list", data: [{ id: "scripted-controller", object: "model", owned_by: "inferoa-validation" }] });
      return;
    }
    if (req.method === "GET" && (req.url === "/health" || req.url === "/v1/health")) {
      json(res, { ok: true });
      return;
    }
    if (req.method === "GET" && req.url === "/openapi.json") {
      json(res, { openapi: "3.1.0", paths: { "/v1/chat/completions": { post: {} }, "/v1/models": { get: {} } } });
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      this.requests.push(JSON.parse(body) as JsonObject);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (this.requests.length === 1) {
        const toolCallId = `call_omni_${safeFilePart(this.toolCase.name).replace(/[.-]+/g, "_")}`;
        writeSse(res, {
          id: "resp_omni_e2e_tool",
          model: "scripted-controller",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: toolCallId,
                    type: "function",
                    function: {
                      name: this.toolCase.name,
                      arguments: JSON.stringify(this.toolCase.arguments),
                    },
                  },
                ],
              },
            },
          ],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 64, completion_tokens: 4 } });
      } else {
        writeSse(res, {
          id: "resp_omni_e2e_final",
          model: "scripted-controller",
          choices: [{ delta: { content: `OMNI_E2E_RUNTIME_OK remote ${this.toolCase.name} completed through Inferoa runtime.` } }],
        });
        writeSse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 32, completion_tokens: 8 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });

  async start(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
  }

  baseUrl(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/v1`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function parseOptions(argv: string[], env: NodeJS.ProcessEnv): E2EOptions {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      continue;
    }
    args.set(arg.slice(2), argv[++i] ?? "");
  }
  const omniEndpointUrl = args.get("omni-endpoint") ?? env.INFEROA_OMNI_REAL_BASE_URL;
  const omniModel = args.get("omni-model") ?? env.INFEROA_OMNI_REAL_MODEL;
  if (!omniEndpointUrl || !omniModel) {
    throw new Error("Omni runtime E2E requires --omni-endpoint/INFEROA_OMNI_REAL_BASE_URL and --omni-model/INFEROA_OMNI_REAL_MODEL.");
  }
  return {
    omniEndpointUrl: omniEndpointUrl.replace(/\/$/, ""),
    omniModel,
    profile: args.get("profile") ?? env.INFEROA_OMNI_REAL_PROFILE ?? "manual",
    evidenceDir: path.resolve(args.get("evidence-dir") ?? env.INFEROA_OMNI_REAL_EVIDENCE_DIR ?? ".inferoa/omni-evidence"),
    tool: args.get("tool") ?? env.INFEROA_OMNI_E2E_TOOL ?? "vision",
  };
}

function configFor(options: E2EOptions, controllerBaseUrl: string): VllmAgentConfig {
  const toolCase = toolCaseFor(options.tool);
  const config = structuredClone(DEFAULT_CONFIG);
  config.model_setup.base_url = controllerBaseUrl;
  config.model_setup.model = "scripted-controller";
  config.model_setup.provider = "vllm";
  config.omni.enabled = true;
  config.omni.endpoints[toolCase.endpoint] = { base_url: options.omniEndpointUrl, model: options.omniModel };
  return config;
}

function toolCaseFor(name: string): RuntimeToolCase {
  const toolCase = TOOL_CASES[name];
  if (!toolCase) {
    throw new Error(`Unsupported Omni runtime E2E tool: ${name}. Supported tools: ${Object.keys(TOOL_CASES).join(", ")}`);
  }
  return toolCase;
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function writeSse(res: ServerResponse, value: unknown): void {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
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
