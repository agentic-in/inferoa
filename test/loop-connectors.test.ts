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
import {
  createGitChangesDiscoverySchedule,
  createGitHubIssuesDiscoverySchedule,
  createHttpHealthDiscoverySchedule,
} from "../src/loop/discovery.js";
import { readLoopConnectors } from "../src/loop/connectors.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("loop connectors projects discovery, verifier, and action policy catalog", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-connectors-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const git = createGitChangesDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: "2026-06-10T00:00:00.000Z",
    });
    const github = createGitHubIssuesDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: "2026-06-10T00:00:00.000Z",
      repo: "owner/repo",
    });
    const http = createHttpHealthDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: "2026-06-10T00:00:00.000Z",
      url: "https://example.test/health",
      expected_status: 204,
    });
    store.updateDiscoverySchedule(http.schedule_id, { status: "paused" });
    store.upsertDiscoveryCandidate({
      candidate_id: "disc_cand_github",
      schedule_id: github.schedule_id,
      workspace_id: workspace.id,
      session_id: github.session_id,
      title: "GitHub issue #12: verifier policy",
      prompt: "Inspect GitHub issue #12.",
      priority: "high",
      dedupe_key: "github-issue:owner/repo:12",
      source: {
        kind: "github-issues",
        provider: "github",
        number: 12,
      },
    });
    const httpCandidate = store.upsertDiscoveryCandidate({
      candidate_id: "disc_cand_http",
      schedule_id: http.schedule_id,
      workspace_id: workspace.id,
      session_id: http.session_id,
      title: "HTTP health status 503",
      prompt: "Inspect HTTP health.",
      priority: "medium",
      dedupe_key: "http-health:https://example.test/health",
      source: {
        kind: "http-health",
        status: 503,
        expected_status: 204,
      },
    });
    store.updateDiscoveryCandidate(httpCandidate.candidate_id, { status: "dismissed" });

    const report = readLoopConnectors(store, workspace, new Date("2026-06-11T00:00:00.000Z"));
    assert.equal(report.summary.connectors, 4);
    assert.equal(report.summary.configured_connectors, 3);
    assert.equal(report.summary.discovery_sources, 12);
    assert.equal(report.summary.schedules, 3);
    assert.equal(report.summary.enabled_schedules, 2);
    assert.equal(report.summary.paused_schedules, 1);
    assert.equal(report.summary.due_schedules, 2);
    assert.equal(report.summary.open_candidates, 1);
    assert.equal(report.summary.high_open_candidates, 1);
    assert.equal(report.summary.verifiers, 12);
    assert.equal(report.summary.action_policies, 2);
    assert.equal(report.summary.action_runners, 14);
    assert.equal(report.summary.global_action_policies, 1);

    const githubCatalog = report.connectors.find((connector) => connector.connector === "github");
    assert.equal(githubCatalog?.status, "configured");
    assert.equal(githubCatalog?.summary.discovery_sources, 9);
    assert.equal(githubCatalog?.summary.schedules, 1);
    assert.equal(githubCatalog?.summary.open_candidates, 1);
    assert.equal(githubCatalog?.summary.high_open_candidates, 1);
    assert.equal(githubCatalog?.summary.verifiers, 9);
    assert.equal(githubCatalog?.summary.action_policies, 1);
    assert.equal(githubCatalog?.summary.action_runners, 13);
    assert.ok(githubCatalog?.discovery_sources.some((source) => source.id === "github-issues" && source.schedules === 1 && source.open_candidates === 1));
    assert.ok(githubCatalog?.discovery_sources.some((source) => source.id === "github-draft-releases"));
    assert.ok(githubCatalog?.discovery_sources.some((source) => source.id === "github-deployments"));
    assert.ok(githubCatalog?.verifiers.some((verifier) => verifier.id === "github-pr-status"));
    assert.ok(githubCatalog?.verifiers.some((verifier) => verifier.id === "github-workflow-run-status"));
    assert.ok(githubCatalog?.verifiers.some((verifier) => verifier.id === "github-deployment-status"));
    assert.ok(githubCatalog?.verifiers.some((verifier) => verifier.id === "github-release-status"));
    assert.ok(githubCatalog?.action_policies.some((policy) => policy.id === "github-cli-mutation"));
    assert.ok(githubCatalog?.action_runners.some((runner) => runner.id === "github-pr-merge"));
    assert.ok(githubCatalog?.action_runners.some((runner) => runner.id === "github-pr-review"));
    assert.ok(githubCatalog?.action_runners.some((runner) => runner.id === "github-pr-comment"));
    assert.ok(githubCatalog?.action_runners.some((runner) => runner.id === "github-pr-label"));
    assert.ok(githubCatalog?.action_runners.some((runner) => runner.id === "github-issue-close"));
    assert.ok(githubCatalog?.action_runners.some((runner) => runner.id === "github-issue-comment"));
    assert.ok(githubCatalog?.action_runners.some((runner) => runner.id === "github-issue-label"));
    assert.ok(githubCatalog?.action_runners.some((runner) => runner.id === "github-notification-mark-read"));
    assert.ok(githubCatalog?.action_runners.some((runner) => runner.id === "github-run-rerun"));
    assert.ok(githubCatalog?.action_runners.some((runner) => runner.id === "github-workflow-dispatch"));
    assert.ok(githubCatalog?.action_runners.some((runner) => runner.id === "github-deployment-create-status"));
    assert.ok(githubCatalog?.action_runners.some((runner) => runner.id === "github-release-create-draft"));
    assert.ok(githubCatalog?.action_runners.some((runner) => runner.id === "github-release-publish-draft"));

    const gitCatalog = report.connectors.find((connector) => connector.connector === "git");
    assert.equal(gitCatalog?.summary.discovery_sources, 1);
    assert.equal(gitCatalog?.summary.schedules, 1);
    assert.equal(gitCatalog?.summary.verifiers, 1);
    assert.equal(git.schedule_id.startsWith("disc_"), true);

    const httpCatalog = report.connectors.find((connector) => connector.connector === "http");
    assert.equal(httpCatalog?.summary.paused_schedules, 1);
    assert.equal(httpCatalog?.summary.open_candidates, 0);
    assert.equal(httpCatalog?.summary.verifiers, 1);

    const npmCatalog = report.connectors.find((connector) => connector.connector === "npm");
    assert.equal(npmCatalog?.status, "available");
    assert.equal(npmCatalog?.summary.discovery_sources, 1);
    assert.equal(npmCatalog?.summary.verifiers, 1);
    assert.equal(npmCatalog?.summary.action_policies, 1);
    assert.equal(npmCatalog?.summary.action_runners, 1);
    assert.ok(npmCatalog?.discovery_sources.some((source) => source.id === "npm-package-status"));
    assert.ok(npmCatalog?.verifiers.some((verifier) => verifier.id === "npm-package-status"));
    assert.ok(npmCatalog?.action_policies.some((policy) => policy.id === "npm-cli-package-publish"));
    assert.ok(npmCatalog?.action_runners.some((runner) => runner.id === "npm-package-publish"));

    assert.ok(report.global_action_policies.some((policy) => policy.id === "first-class-connector-mutation"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop connectors command returns connector catalog as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-connectors-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const schedule = createGitHubIssuesDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: "2026-06-10T00:00:00.000Z",
      repo: "owner/repo",
    });
    store.upsertDiscoveryCandidate({
      candidate_id: "disc_cand_cli_github",
      schedule_id: schedule.schedule_id,
      workspace_id: workspace.id,
      session_id: schedule.session_id,
      title: "GitHub issue #88: connector catalog",
      prompt: "Inspect GitHub issue #88.",
      priority: "medium",
      dedupe_key: "github-issue:owner/repo:88",
      source: { kind: "github-issues", provider: "github", number: 88 },
    });
  } finally {
    store.close();
  }

  try {
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
      "connectors",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as {
      summary?: { connectors?: number; open_candidates?: number; action_runners?: number; global_action_policies?: number };
      connectors?: Array<{ connector?: string; summary?: { schedules?: number; open_candidates?: number; verifiers?: number; action_policies?: number; action_runners?: number } }>;
      global_action_policies?: Array<{ id?: string }>;
    };
    assert.ok((parsed.summary?.connectors ?? 0) >= 3);
    assert.equal(parsed.summary?.open_candidates, 1);
    assert.equal(parsed.summary?.action_runners, 14);
    assert.equal(parsed.summary?.global_action_policies, 1);
    const github = parsed.connectors?.find((connector) => connector.connector === "github");
    assert.equal(github?.summary?.schedules, 1);
    assert.equal(github?.summary?.open_candidates, 1);
    assert.equal(github?.summary?.verifiers, 9);
    assert.equal(github?.summary?.action_policies, 1);
    assert.equal(github?.summary?.action_runners, 13);
    assert.ok(parsed.global_action_policies?.some((policy) => policy.id === "first-class-connector-mutation"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
