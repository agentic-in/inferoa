import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createGoalState, writeGoalState } from "../src/goals/state.js";
import { createLoopDiscoverySchedule } from "../src/loop/discovery.js";
import { readLoopMetrics } from "../src/loop/metrics.js";
import { recordGoalVerification } from "../src/loop/verification.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("loop metrics projects token cost, source attribution, and checker quality", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-metrics-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "metrics goal");
    const goalState = createGoalState({ objective: "Measure loop metrics" }, new Date("2026-06-11T00:00:00.000Z"));
    writeGoalState(store, session.session_id, goalState, "run_cost");
    const discovery = createLoopDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: "2026-06-11T00:00:00.000Z",
      session_id: session.session_id,
      command: "printf '[]'",
      metadata: { source: "github-actions" },
    });
    store.upsertDiscoveryCandidate({
      candidate_id: "cand_metrics",
      schedule_id: discovery.schedule_id,
      workspace_id: workspace.id,
      session_id: session.session_id,
      title: "CI failed",
      prompt: "Inspect failing CI",
      priority: "high",
      dedupe_key: "ci-metrics",
      source: { kind: "github-actions", provider: "github", repo: "owner/repo" },
    });
    const job = store.createSupervisorJob(session.session_id, workspace.root, "fix ci", {
      metadata: {
        discovery_candidate_id: "cand_metrics",
        discovery_schedule_id: discovery.schedule_id,
        worktree_id: "wt_metrics",
      },
    });
    store.updateSupervisorJob(job.job_id, { run_id: "run_cost", metadata: job.metadata });
    store.createManagedWorktree({
      worktree_id: "wt_metrics",
      workspace_id: workspace.id,
      base_root: workspace.root,
      path: path.join(dir, "wt_metrics"),
      branch: "loop/wt_metrics",
      base_ref: "HEAD",
      session_id: session.session_id,
      job_id: job.job_id,
      metadata: { purpose: "metrics-test" },
    });
    store.recordEndpointEvidence(session.session_id, "run_cost", "test-provider", {
      mode: "direct",
      provider_id: "test-provider",
      model: "metrics-model",
      request_class: "background",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cached_prompt_tokens: 25,
      },
    });
    recordGoalVerification(store, session.session_id, {
      provider: "checker",
      verdict: "pass",
      confidence: "hard",
      goal_id: goalState.goal.id,
      horizon_generation: 0,
      run_id: "run_cost",
      summary: "checker accepted",
    });
    recordGoalVerification(store, session.session_id, {
      provider: "command",
      verdict: "fail",
      confidence: "hard",
      goal_id: goalState.goal.id,
      horizon_generation: 0,
      run_id: "run_cost",
      summary: "command failed",
    });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_cost",
      type: "goal.learning_signal.recorded",
      data: {
        signal_id: "sig_metrics_positive",
        category: "verification",
        polarity: "positive",
        goal_id: goalState.goal.id,
        source_run_id: "run_cost",
        summary: "checker accepted",
      },
    });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_cost",
      type: "goal.learning_signal.recorded",
      data: {
        signal_id: "sig_metrics_negative",
        category: "verification",
        polarity: "negative",
        goal_id: goalState.goal.id,
        source_run_id: "run_cost",
        summary: "command failed",
      },
    });

    const metrics = readLoopMetrics(store, workspace);
    assert.equal(metrics.totals.sessions, 1);
    assert.equal(metrics.totals.runs, 1);
    assert.equal(metrics.totals.model_calls, 1);
    assert.equal(metrics.tokens.total_tokens, 150);
    assert.equal(metrics.tokens.cached_prompt_tokens, 25);
    assert.equal(metrics.tokens.cache_hit_rate, 0.25);
    assert.equal(metrics.by_goal.find((item) => item.key === goalState.goal.id)?.tokens.total_tokens, 150);
    assert.equal(metrics.by_source.find((item) => item.key === "github-actions")?.tokens.total_tokens, 150);
    assert.equal(metrics.by_connector.find((item) => item.key === "github")?.tokens.total_tokens, 150);
    assert.equal(metrics.by_worktree.find((item) => item.key === "wt_metrics")?.tokens.total_tokens, 150);
    assert.equal(metrics.by_request_class.find((item) => item.key === "background")?.tokens.total_tokens, 150);
    assert.equal(metrics.verification.summary.total, 2);
    assert.equal(metrics.verification.summary.pass, 1);
    assert.equal(metrics.verification.summary.fail, 1);
    assert.equal(metrics.verification.checker_effectiveness.total, 1);
    assert.equal(metrics.verification.checker_effectiveness.pass_rate, 1);
    assert.equal(metrics.learning_signals.total, 2);
    assert.equal(metrics.learning_signals.positive, 1);
    assert.equal(metrics.learning_signals.negative, 1);
    assert.equal(metrics.learning_signals.by_category.verification, 2);
    assert.equal(metrics.learning_signals.by_polarity.positive, 1);
    assert.equal(metrics.trends.daily.length, 1);
    assert.equal(metrics.trends.daily[0]?.checker.pass, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop metrics command returns workspace metrics as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-metrics-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "cli metrics");
    store.recordEndpointEvidence(session.session_id, "run_cli_metrics", "test-provider", {
      mode: "direct",
      provider_id: "test-provider",
      model: "metrics-model",
      request_class: "interactive",
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    });
    store.close();
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const output = await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "loop",
      "metrics",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as { totals?: { model_calls?: number }; tokens?: { total_tokens?: number }; by_request_class?: Array<{ key?: string; tokens?: { total_tokens?: number } }> };
    assert.equal(parsed.totals?.model_calls, 1);
    assert.equal(parsed.tokens?.total_tokens, 10);
    assert.equal(parsed.by_request_class?.find((item) => item.key === "interactive")?.tokens?.total_tokens, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
