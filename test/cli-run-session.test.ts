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

test("debug run-session runs multiple prompts in one session and reports route/cache turns", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "inferoa-run-session-cli-"));
  const workspaceRoot = path.join(fixture, "workspace");
  const stateDir = path.join(fixture, "state");
  const configPath = path.join(fixture, "config.yaml");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  let requestCount = 0;
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
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }
    requestCount += 1;
    const isSecondRequest = requestCount === 2;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-vsr-selected-model": isSecondRequest ? "qwen/qwen3.6-rocm" : "qwen/qwen3.6-small",
      "x-vsr-selected-decision": isSecondRequest ? "complex_general" : "simple_general",
      "x-vsr-selected-category": "decision",
      "x-vsr-selected-confidence": isSecondRequest ? "0.91" : "0.86",
      "x-vsr-session-phase": isSecondRequest ? "user_turn" : "new_session",
      "x-vsr-learning-methods": "session_aware",
      "x-vsr-learning-actions": isSecondRequest ? "session_aware=stay" : "session_aware=select",
      "x-vsr-learning-reasons": isSecondRequest ? "session_aware=cache_protected" : "session_aware=select",
      "x-vsr-learning-scopes": "session_aware=conversation",
      "x-vsr-learning-modes": "session_aware=apply",
      "x-vsr-cache-hit": isSecondRequest ? "true" : "false",
      "x-vsr-replay-id": isSecondRequest ? "replay_2" : "replay_1",
    });
    writeSse(res, {
      id: `resp_${requestCount}`,
      model: isSecondRequest ? "qwen/qwen3.6-rocm" : "qwen/qwen3.6-small",
      choices: [{ delta: { content: isSecondRequest ? "two" : "one" } }],
    });
    writeSse(res, {
      id: `resp_${requestCount}`,
      model: isSecondRequest ? "qwen/qwen3.6-rocm" : "qwen/qwen3.6-small",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: isSecondRequest ? 120 : 100,
        completion_tokens: 3,
        total_tokens: isSecondRequest ? 123 : 103,
        prompt_tokens_details: { cached_tokens: isSecondRequest ? 90 : 80 },
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
        "debug",
        "run-session",
        "--max-tool-rounds",
        "0",
        "--prompt",
        "say one",
        "--prompt",
        "say two",
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(output.stdout) as {
      session: { session_id: string };
      continued_session: boolean;
      run_count: number;
      runs: Array<{
        status: string;
        model_turns: Array<{
          selected_model?: string;
          decision?: string;
          phase?: string;
          learning?: string;
          prompt_tokens?: number;
          cached_prompt_tokens?: number;
          cache_hit_rate?: number;
          cache_gap_tokens?: number;
          cache_gap_rate?: number;
        }>;
      }>;
      summary: {
        learning?: Record<string, number>;
        cache: { prompt_tokens?: number; cached_prompt_tokens?: number; cache_gap_tokens?: number; cache_hit_rate?: number };
      };
    };

    assert.match(report.session.session_id, /^s_/);
    assert.equal(report.continued_session, false);
    assert.equal(report.run_count, 2);
    assert.equal(report.runs.length, 2);
    assert.equal(report.runs[0]?.status, "completed");
    assert.equal(report.runs[1]?.status, "completed");
    assert.equal(requestCount, 2);

    const firstTurn = report.runs[0]?.model_turns[0];
    assert.equal(firstTurn?.selected_model, "qwen/qwen3.6-small");
    assert.equal(firstTurn?.decision, "simple_general");
    assert.equal(firstTurn?.phase, "new_session");
    assert.match(firstTurn?.learning ?? "", /action=select/);
    assert.equal(firstTurn?.prompt_tokens, 100);
    assert.equal(firstTurn?.cached_prompt_tokens, 80);
    assert.equal(firstTurn?.cache_hit_rate, 0.8);
    assert.equal(firstTurn?.cache_gap_tokens, 20);
    assert.equal(firstTurn?.cache_gap_rate, 0.2);

    const secondTurn = report.runs[1]?.model_turns[0];
    assert.equal(secondTurn?.selected_model, "qwen/qwen3.6-rocm");
    assert.equal(secondTurn?.decision, "complex_general");
    assert.equal(secondTurn?.phase, "user_turn");
    assert.match(secondTurn?.learning ?? "", /action=stay/);
    assert.equal(secondTurn?.prompt_tokens, 120);
    assert.equal(secondTurn?.cached_prompt_tokens, 90);
    assert.equal(secondTurn?.cache_gap_tokens, 30);
    assert.equal(report.summary.cache.prompt_tokens, 220);
    assert.equal(report.summary.cache.cached_prompt_tokens, 170);
    assert.equal(report.summary.cache.cache_gap_tokens, 50);
    assert.equal(report.summary.cache.cache_hit_rate, 0.7727);
    assert.equal(report.summary.learning?.["session_aware.select"], 1);
    assert.equal(report.summary.learning?.["session_aware.stay"], 1);
  } finally {
    server.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

function writeSse(res: ServerResponse, payload: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
