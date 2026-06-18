import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

const execFileAsync = promisify(execFile);

const ROUTES = [
  { decision: "simple_math_fast_path", model: "qwen/qwen3.6-rocm" },
  { decision: "domain_code", model: "google/gemini-2.5-flash-lite" },
  { decision: "domain_business", model: "google/gemini-2.5-flash-lite" },
  { decision: "complex_general", model: "google/gemini-3.1-pro" },
  { decision: "local_privacy_policy", model: "qwen/qwen3.6-rocm" },
];

const SCOPE_ROUTES = [
  { decision: "domain_code_complex", model: "google/gemini-3.1-pro", action: "select", scope: "conversation", phase: "user_turn" },
  { decision: "simple_math_fast_path", model: "qwen/qwen3.6-rocm", action: "select", scope: "conversation", phase: "user_turn" },
  { decision: "local_privacy_policy", model: "qwen/qwen3.6-rocm", action: "bypass", scope: "conversation", phase: "user_turn" },
];

test("eval --profile=agentic-routing fetches replay diagnostics and reports cache-aware cost", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "inferoa-agentic-routing-eval-"));
  const workspaceRoot = path.join(fixture, "workspace");
  const stateDir = path.join(fixture, "state");
  const configPath = path.join(fixture, "config.yaml");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  let requestCount = 0;
  let replayFetchCount = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "vllm-sr/auto" }] }));
      return;
    }
    if (req.method === "GET" && (req.url === "/load" || req.url === "/metrics")) {
      res.writeHead(200, { "content-type": req.url === "/metrics" ? "text/plain" : "application/json" });
      res.end(req.url === "/metrics" ? "" : "{}");
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/v1/router_replay/")) {
      const replayId = req.url.split("/").pop() ?? "";
      const index = Number(replayId.replace("replay_", "")) - 1;
      const route = ROUTES[index] ?? ROUTES[0]!;
      replayFetchCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: replayId,
          decision: route.decision,
          selected_model: route.model,
          original_model: "vllm-sr/auto",
          route_diagnostics: {
            decision: route.decision,
            decision_tier: index + 1,
            decision_priority: 300 - index,
            selection_method: index === 0 ? "direct" : "hybrid",
            original_model: "vllm-sr/auto",
            proposal_model: route.model,
            previous_model: "",
            selected_model: route.model,
            session_policy_applied: false,
            session_action: "select",
            session_phase: "new_session",
            session_reason: "select",
          },
          learning: {
            adaptations: {
              session_aware: {
                mode: "apply",
                action: "select",
                reason: "select",
                scope: "conversation",
                current_model: "",
                base_selected_model: route.model,
                selected_model: route.model,
                phase: "new_session",
                memory_prompt_tokens: 100 + index,
                memory_cached_tokens: 70 + index,
                cache_warmth: 0.7,
              },
            },
          },
          session_policy: {
            current_model: "",
            base_selected_model: route.model,
            selected_model: route.model,
            decision_reason: "select",
            cache_warmth: 0.7,
            continuation_mass: 0.1,
          },
        }),
      );
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }

    requestCount += 1;
    const route = ROUTES[requestCount - 1] ?? ROUTES[0]!;
    const replayId = `replay_${requestCount}`;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-vsr-selected-model": route.model,
      "x-vsr-selected-decision": route.decision,
      "x-vsr-selected-confidence": "0.91",
      "x-vsr-session-phase": "new_session",
      "x-vsr-learning-methods": "session_aware",
      "x-vsr-learning-actions": "session_aware=select",
      "x-vsr-learning-reasons": "session_aware=select",
      "x-vsr-learning-scopes": "session_aware=conversation",
      "x-vsr-learning-modes": "session_aware=apply",
      "x-vsr-replay-id": replayId,
    });
    writeSse(res, {
      id: `resp_${requestCount}`,
      model: route.model,
      choices: [{ delta: { content: "ok" } }],
    });
    writeSse(res, {
      id: `resp_${requestCount}`,
      model: route.model,
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100 + requestCount,
        completion_tokens: 3,
        total_tokens: 103 + requestCount,
        prompt_tokens_details: { cached_tokens: 70 + requestCount },
      },
    });
    res.end("data: [DONE]\n\n");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.model_setup.mode = "auto";
    config.model_setup.router = "vllm-sr";
    config.model_setup.base_url = `http://127.0.0.1:${address.port}/v1`;
    config.model_setup.model = "vllm-sr/auto";
    config.rtk.enabled = false;
    await writeFile(configPath, YAML.stringify(config), "utf8");

    const cliPath = path.resolve("dist/src/cli.js");
    const output = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "--config",
        configPath,
        "--state-dir",
        stateDir,
        "--workspace",
        workspaceRoot,
        "--json",
        "eval",
        "--profile=agentic-routing",
        "--scenario=matrix",
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(output.stdout) as {
      passed: boolean;
      summary: { failed_checks: number; check_count: number };
      telemetry?: { saar_actions?: Record<string, number> };
      routing_quality?: { acceptable_runs?: number; findings?: unknown[] };
      cost?: {
        actual?: { total_cost?: number; prefix_cache_discount?: number };
        baselines?: Record<string, { savings_vs_baseline?: number; savings_pct_vs_baseline?: number }>;
        prefix_cache?: { cached_prompt_tokens?: number; observed_cache_discount?: number };
      };
      scenarios: Array<{
        name: string;
        runs: Array<{
          routing_outcome?: { acceptable?: boolean };
          model_turns: Array<{
            learning?: string;
            route_diagnostics?: { decision?: string; selected_model?: string };
            replay?: {
              learning?: { adaptations?: { session_aware?: { action?: string; selected_model?: string } } };
              session_policy?: { selected_model?: string };
            };
            cost?: { actual?: { total_cost?: number } };
          }>;
        }>;
      }>;
    };

    assert.equal(report.passed, true);
    assert.equal(report.summary.failed_checks, 0);
    assert.equal(report.scenarios[0]?.name, "fresh_decision_matrix");
    assert.equal(requestCount, ROUTES.length);
    assert.equal(replayFetchCount, ROUTES.length);
    assert.ok(report.summary.check_count > ROUTES.length);
    assert.equal(report.routing_quality?.acceptable_runs, ROUTES.length);
    assert.deepEqual(report.routing_quality?.findings, []);
    assert.equal(report.telemetry?.saar_actions?.select, ROUTES.length);
    assert.ok((report.cost?.actual?.total_cost ?? -1) >= 0);
    assert.ok((report.cost?.baselines?.["google/gemini-3.1-pro"]?.savings_vs_baseline ?? Number.NEGATIVE_INFINITY) > 0);
    assert.ok((report.cost?.prefix_cache?.cached_prompt_tokens ?? 0) > 0);
    assert.equal(report.scenarios[0]?.runs[0]?.model_turns[0]?.route_diagnostics?.decision, "simple_math_fast_path");
    assert.equal(report.scenarios[0]?.runs[4]?.model_turns[0]?.route_diagnostics?.selected_model, "qwen/qwen3.6-rocm");
    assert.equal(report.scenarios[0]?.runs[0]?.routing_outcome?.acceptable, true);
    assert.ok((report.scenarios[0]?.runs[1]?.model_turns[0]?.cost?.actual?.total_cost ?? -1) > 0);
    assert.match(report.scenarios[0]?.runs[0]?.model_turns[0]?.learning ?? "", /session_aware/);
    assert.equal(report.scenarios[0]?.runs[0]?.model_turns[0]?.replay?.learning?.adaptations?.session_aware?.action, "select");
    assert.equal(report.scenarios[0]?.runs[1]?.model_turns[0]?.replay?.session_policy?.selected_model, "google/gemini-2.5-flash-lite");
  } finally {
    server.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("eval --profile=agentic-routing scope scenario distinguishes conversation scope and privacy bypass", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "inferoa-agentic-routing-scope-"));
  const workspaceRoot = path.join(fixture, "workspace");
  const stateDir = path.join(fixture, "state");
  const configPath = path.join(fixture, "config.yaml");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  let requestCount = 0;
  let replayFetchCount = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "vllm-sr/auto" }] }));
      return;
    }
    if (req.method === "GET" && (req.url === "/load" || req.url === "/metrics")) {
      res.writeHead(200, { "content-type": req.url === "/metrics" ? "text/plain" : "application/json" });
      res.end(req.url === "/metrics" ? "" : "{}");
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/v1/router_replay/")) {
      const replayId = req.url.split("/").pop() ?? "";
      const index = Number(replayId.replace("scope_replay_", "")) - 1;
      const route = SCOPE_ROUTES[index] ?? SCOPE_ROUTES[0]!;
      replayFetchCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: replayId,
          decision: route.decision,
          selected_model: route.model,
          original_model: "vllm-sr/auto",
          route_diagnostics: {
            decision: route.decision,
            decision_tier: index + 1,
            decision_priority: 300 - index,
            selection_method: "static",
            original_model: "vllm-sr/auto",
            proposal_model: route.model,
            previous_model: index === 1 ? SCOPE_ROUTES[0]!.model : "",
            selected_model: route.model,
            session_policy_applied: route.action !== "bypass",
            session_action: route.action,
            session_phase: route.phase,
            session_reason: route.action,
          },
          learning: {
            adaptations: {
              session_aware: {
                mode: route.action === "bypass" ? "bypass" : "apply",
                action: route.action,
                reason: route.action,
                scope: route.scope,
                current_model: index === 1 ? SCOPE_ROUTES[0]!.model : "",
                base_selected_model: route.model,
                selected_model: route.model,
                phase: route.phase,
                memory_prompt_tokens: 100 + index,
                memory_cached_tokens: 50 + index,
                cache_warmth: 0.5,
              },
            },
          },
        }),
      );
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }

    requestCount += 1;
    const route = SCOPE_ROUTES[requestCount - 1] ?? SCOPE_ROUTES[0]!;
    const replayId = `scope_replay_${requestCount}`;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-vsr-selected-model": route.model,
      "x-vsr-selected-decision": route.decision,
      "x-vsr-selected-confidence": "0.91",
      "x-vsr-session-phase": route.phase,
      "x-vsr-learning-methods": "session_aware",
      "x-vsr-learning-actions": `session_aware=${route.action}`,
      "x-vsr-learning-reasons": `session_aware=${route.action}`,
      "x-vsr-learning-scopes": `session_aware=${route.scope}`,
      "x-vsr-learning-modes": `session_aware=${route.action === "bypass" ? "bypass" : "apply"}`,
      "x-vsr-replay-id": replayId,
    });
    writeSse(res, {
      id: `scope_resp_${requestCount}`,
      model: route.model,
      choices: [{ delta: { content: "ok" } }],
    });
    writeSse(res, {
      id: `scope_resp_${requestCount}`,
      model: route.model,
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100 + requestCount,
        completion_tokens: 3,
        total_tokens: 103 + requestCount,
        prompt_tokens_details: { cached_tokens: 60 + requestCount },
      },
    });
    res.end("data: [DONE]\n\n");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.model_setup.mode = "auto";
    config.model_setup.router = "vllm-sr";
    config.model_setup.base_url = `http://127.0.0.1:${address.port}/v1`;
    config.model_setup.model = "vllm-sr/auto";
    config.rtk.enabled = false;
    await writeFile(configPath, YAML.stringify(config), "utf8");

    const cliPath = path.resolve("dist/src/cli.js");
    const output = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "--config",
        configPath,
        "--state-dir",
        stateDir,
        "--workspace",
        workspaceRoot,
        "--json",
        "eval",
        "--profile=agentic-routing",
        "--scenario=scope",
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(output.stdout) as {
      passed: boolean;
      summary: { failed_checks: number };
      scenarios: Array<{
        checks: Array<{ name: string; passed: boolean; actual?: unknown }>;
      }>;
    };

    assert.equal(report.passed, true);
    assert.equal(report.summary.failed_checks, 0);
    assert.equal(requestCount, SCOPE_ROUTES.length);
    assert.equal(replayFetchCount, SCOPE_ROUTES.length);
    assert.equal(report.scenarios[0]?.checks.find((check) => check.name.endsWith(".conversation_scope_allows_new_conversation_reselect"))?.passed, true);
    assert.equal(report.scenarios[0]?.checks.find((check) => check.name.endsWith(".privacy_bypass_stays_local"))?.passed, true);
  } finally {
    server.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

function writeSse(res: ServerResponse, payload: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
