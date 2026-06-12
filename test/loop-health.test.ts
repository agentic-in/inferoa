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
import { createLoopAutomationSchedule } from "../src/loop/automation.js";
import { createLoopDiscoverySchedule } from "../src/loop/discovery.js";
import { readLoopDashboard } from "../src/loop/dashboard.js";
import { readLoopHealth } from "../src/loop/health.js";
import { recordGoalVerification } from "../src/loop/verification.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("loop health summarizes structured loop state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-health-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "loop health goal");
    const goalState = createGoalState({ objective: "Observe loop health" }, new Date("2026-06-11T00:00:00.000Z"));
    goalState.goal.pending_review_decision = {
      id: "review_health",
      action: "done",
      source_horizon_generation: 0,
      summary: "needs review",
      requested_decision: ["approve", "reject"],
      created_at: "2026-06-11T00:00:00.000Z",
    };
    writeGoalState(store, session.session_id, goalState, "run_goal");
    const job = store.createSupervisorJob(session.session_id, workspace.root, "continue goal", { kind: "goal", goal_id: goalState.goal.id });
    store.updateSupervisorJob(job.job_id, { status: "failed" });
    createLoopAutomationSchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: "2026-06-10T23:59:00.000Z",
      session_id: session.session_id,
      prompt: "review loop",
    });
    createLoopAutomationSchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: "2026-06-10T23:58:00.000Z",
      session_id: session.session_id,
      prompt: "review before loop",
      review_policy: "review",
    });
    const discovery = createLoopDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: "2026-06-10T23:59:00.000Z",
      session_id: session.session_id,
      command: "printf '[]'",
    });
    store.updateDiscoverySchedule(discovery.schedule_id, { last_error: "source unavailable" });
    store.upsertDiscoveryCandidate({
      candidate_id: "cand_health",
      schedule_id: discovery.schedule_id,
      workspace_id: workspace.id,
      session_id: session.session_id,
      title: "Fix CI",
      prompt: "Inspect CI",
      priority: "high",
      dedupe_key: "ci-health",
      source: { kind: "test" },
    });
    recordGoalVerification(store, session.session_id, {
      provider: "command",
      verdict: "fail",
      confidence: "hard",
      goal_id: goalState.goal.id,
      horizon_generation: 0,
      run_id: "run_verify",
      summary: "test failed",
    });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_verify",
      type: "goal.learning_signal.recorded",
      data: {
        signal_id: "sig_health_negative",
        category: "verification",
        polarity: "negative",
        goal_id: goalState.goal.id,
        source_run_id: "run_verify",
        summary: "verification command failed",
      },
    });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_review",
      type: "goal.learning_signal.recorded",
      data: {
        signal_id: "sig_health_constraint",
        category: "human_feedback",
        polarity: "constraint",
        goal_id: goalState.goal.id,
        source_run_id: "run_review",
        summary: "human feedback constrained completion",
      },
    });

    const health = await readLoopHealth(store, workspace, { now: new Date("2026-06-11T00:01:00.000Z") });
    assert.equal(health.severity, "attention");
    assert.equal(health.goals.pending_review, 1);
    assert.equal(health.jobs.by_status.failed, 1);
    assert.equal(health.jobs.active, 0);
    assert.equal(health.automation.due, 2);
    assert.equal(health.automation.active_checkout, 2);
    assert.equal(health.automation.worktree_isolated, 0);
    assert.equal(health.automation.review_gated, 1);
    assert.equal(health.automation.review_pending, 1);
    assert.equal(health.discovery.due, 1);
    assert.equal(health.discovery.last_error, 1);
    assert.equal(health.discovery.candidates_open, 1);
    assert.equal(health.inbox.high, 4);
    assert.equal(health.verification.by_verdict.fail, 1);
    assert.equal(health.verification.by_provider.command, 1);
    assert.equal(health.learning_signals.total, 2);
    assert.equal(health.learning_signals.by_category.verification, 1);
    assert.equal(health.learning_signals.by_category.human_feedback, 1);
    assert.equal(health.learning_signals.by_polarity.negative, 1);
    assert.equal(health.learning_signals.by_polarity.constraint, 1);
    assert.ok(health.reasons.includes("job_attention"));
    assert.ok(health.reasons.includes("discovery_error_attention"));
    assert.ok(health.reasons.includes("verification_failure_attention"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop dashboard combines health, metrics, inbox, and roadmap edges", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-dashboard-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "loop dashboard goal");
    const goalState = createGoalState({ objective: "Observe loop dashboard" }, new Date("2026-06-11T00:00:00.000Z"));
    goalState.goal.pending_review_decision = {
      id: "review_dashboard",
      action: "done",
      source_horizon_generation: 0,
      summary: "needs dashboard review",
      requested_decision: ["approve", "reject"],
      created_at: "2026-06-11T00:00:00.000Z",
    };
    writeGoalState(store, session.session_id, goalState, "run_goal");
    const job = store.createSupervisorJob(session.session_id, workspace.root, "continue dashboard goal", { kind: "goal", goal_id: goalState.goal.id });
    store.updateSupervisorJob(job.job_id, { status: "failed" });
    createLoopAutomationSchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: "2000-01-01T00:00:00.000Z",
      session_id: session.session_id,
      prompt: "review dashboard loop",
      review_policy: "review",
    });
    const discovery = createLoopDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: "2000-01-01T00:00:00.000Z",
      session_id: session.session_id,
      command: "printf '[]'",
    });
    store.updateDiscoverySchedule(discovery.schedule_id, { last_error: "source unavailable" });
    recordGoalVerification(store, session.session_id, {
      provider: "command",
      verdict: "fail",
      confidence: "hard",
      goal_id: goalState.goal.id,
      horizon_generation: 0,
      run_id: "run_verify_dashboard",
      summary: "dashboard verifier failed",
    });
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_verify_dashboard",
      type: "goal.learning_signal.recorded",
      data: {
        signal_id: "sig_dashboard_negative",
        category: "verification",
        polarity: "negative",
        goal_id: goalState.goal.id,
        source_run_id: "run_verify_dashboard",
        summary: "dashboard saw failed verification",
      },
    });

    const dashboard = await readLoopDashboard(store, workspace);
    assert.equal(dashboard.status.severity, "attention");
    assert.equal(dashboard.status.pending_reviews, 1);
    assert.equal(dashboard.status.high_inbox_items > 0, true);
    assert.equal(dashboard.totals.goals, 1);
    assert.equal(dashboard.totals.verifications, 1);
    assert.equal(dashboard.totals.learning_signals, 1);
    assert.equal(dashboard.verification.fail, 1);
    assert.equal(dashboard.operations.automation_review_pending, 1);
    assert.equal(dashboard.operations.discovery_errors, 1);
    assert.equal(dashboard.attention.inbox_items.length > 0, true);
    assert.equal(dashboard.attention.roadmap_edges.some((item) => item.id === "policy-unattended-safety"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop health command returns workspace health as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-health-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
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
      "health",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as { severity?: string; workspace_root?: string; inbox?: { open?: number } };
    assert.equal(parsed.severity, "ok");
    assert.ok(parsed.workspace_root?.endsWith("/workspace"));
    assert.equal(parsed.inbox?.open, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop dashboard command returns workspace dashboard as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-dashboard-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
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
      "dashboard",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as {
      status?: { severity?: string };
      totals?: { sessions?: number; verifications?: number };
      attention?: { roadmap_edges?: Array<{ id?: string }> };
    };
    assert.equal(parsed.status?.severity, "ok");
    assert.equal(parsed.totals?.sessions, 0);
    assert.equal(parsed.totals?.verifications, 0);
    assert.ok(parsed.attention?.roadmap_edges?.some((item) => item.id === "policy-unattended-safety"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removed loop connector/action commands are not part of the public loop surface", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-surface-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  try {
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const baseArgs = [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
    ];
    for (const removed of ["connectors", "connector", "action-preflight", "action", "action-run", "action-execute", "actions", "action-log"]) {
      await assert.rejects(
        execFileAsync(process.execPath, [...baseArgs, "loop", removed], { maxBuffer: 1024 * 1024 }),
        /Usage: inferoa loop/,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop policy command returns configured default background isolation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-policy-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  const demoSkillDir = path.join(workspaceRoot, ".inferoa", "skills", "demo-loop");
  const loopSkillDir = path.join(workspaceRoot, ".inferoa", "skills", "inferoa-loop-skill");
  const workspaceSkillDir = path.join(workspaceRoot, ".inferoa", "skills", "inferoa-workspace-skill");
  await mkdir(demoSkillDir, { recursive: true });
  await mkdir(loopSkillDir, { recursive: true });
  await mkdir(workspaceSkillDir, { recursive: true });
  await writeFile(path.join(demoSkillDir, "SKILL.md"), "---\nname: Demo Loop Skill\ndescription: Demo loop policy skill\n---\n\nUse verifier evidence.\n", "utf8");
  await writeFile(path.join(loopSkillDir, "SKILL.md"), "---\nname: Inferoa Loop Skill\ndescription: Learned loop control policy\n---\n\nUse structured loop evidence.\n", "utf8");
  await writeFile(path.join(workspaceSkillDir, "SKILL.md"), "---\nname: Inferoa Workspace Skill\ndescription: Learned workspace workflow policy\n---\n\nRun npm test before completion.\n", "utf8");
  const config = structuredClone(DEFAULT_CONFIG);
  config.loop.default_background_isolation = "worktree";
  config.skills.enabled = ["demo-loop-skill", "inferoa-loop-skill", "inferoa-workspace-skill", "missing-loop-skill"];
  await writeFile(configPath, YAML.stringify(config), "utf8");
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
      "policy",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as {
      default_background_isolation?: string;
      workspace_root?: string;
      unattended_completion?: { reflection_only_sufficient?: boolean; task_strong_pass_providers?: string[] };
      unattended_tool_gates?: { destructive_shell?: string; external_mutation?: string };
      external_mutation_policy?: Array<{
        id?: string;
        system?: string;
        surface?: string;
        command?: string;
        tool_names?: string[];
        kind?: string;
        request_classes?: string[];
        decision?: string;
        review_surface?: string;
      }>;
      workspace_permission?: { mode?: string; source?: string };
      skill_policy?: {
        configured_enabled?: string[];
        discovered_count?: number;
        enabled_count?: number;
        loaded_count?: number;
        missing_enabled?: string[];
        enabled?: Array<{ id?: string; trust?: string; path?: string }>;
        learned_loop_skill?: { configured?: boolean; discovered?: boolean; enabled?: boolean; expected_path?: string; path?: string };
        learned_workspace_skill?: { configured?: boolean; discovered?: boolean; enabled?: boolean; expected_path?: string; path?: string };
        learned_skills?: Array<{ skill_id?: string; configured?: boolean; discovered?: boolean; enabled?: boolean; expected_path?: string; path?: string }>;
        prompt_contract?: { skill_bodies_embedded?: boolean; skill_body_access?: string; learned_skill_adoption?: string };
      };
    };
    assert.equal(parsed.default_background_isolation, "worktree");
    assert.ok(parsed.workspace_root?.endsWith("/workspace"));
    assert.equal(parsed.workspace_permission?.mode, "full_access");
    assert.equal(parsed.workspace_permission?.source, "default");
    assert.equal(parsed.unattended_completion?.reflection_only_sufficient, false);
    assert.ok(parsed.unattended_completion?.task_strong_pass_providers?.includes("command"));
    assert.equal(parsed.unattended_tool_gates?.destructive_shell, "deny");
    assert.equal(parsed.unattended_tool_gates?.external_mutation, "deny");
    assert.ok(parsed.external_mutation_policy?.some((item) =>
      item.id === "github-cli-mutation"
      && item.system === "github"
      && item.surface === "cli"
      && item.command === "gh"
      && item.kind === "mutation"
      && item.decision === "deny"
      && item.tool_names?.includes("run_command")
      && item.request_classes?.includes("background")
      && item.request_classes?.includes("verification")
      && item.review_surface === "loop inbox external_action_approval"
    ));
    assert.ok(parsed.external_mutation_policy?.some((item) =>
      item.id === "npm-cli-package-publish"
      && item.system === "npm"
      && item.surface === "cli"
      && item.command === "npm"
      && item.kind === "mutation"
      && item.decision === "deny"
      && item.tool_names?.includes("run_command")
      && item.request_classes?.includes("background")
      && item.request_classes?.includes("verification")
      && item.review_surface === "loop inbox external_action_approval"
    ));
    assert.equal(parsed.skill_policy?.prompt_contract?.skill_bodies_embedded, false);
    assert.equal(parsed.skill_policy?.prompt_contract?.skill_body_access, "on_demand_skill_read");
    assert.equal(parsed.skill_policy?.prompt_contract?.learned_skill_adoption, "explicit_adopt_or_skill_enable");
    assert.ok(parsed.skill_policy?.configured_enabled?.includes("inferoa-loop-skill"));
    assert.ok(parsed.skill_policy?.configured_enabled?.includes("inferoa-workspace-skill"));
    assert.equal(parsed.skill_policy?.missing_enabled?.includes("missing-loop-skill"), true);
    assert.ok((parsed.skill_policy?.discovered_count ?? 0) >= 3);
    assert.equal(parsed.skill_policy?.enabled_count, 3);
    assert.equal(parsed.skill_policy?.loaded_count, 3);
    assert.ok(parsed.skill_policy?.enabled?.some((item) => item.id === "demo-loop-skill" && item.trust === "workspace"));
    assert.equal(parsed.skill_policy?.learned_loop_skill?.configured, true);
    assert.equal(parsed.skill_policy?.learned_loop_skill?.discovered, true);
    assert.equal(parsed.skill_policy?.learned_loop_skill?.enabled, true);
    assert.ok(parsed.skill_policy?.learned_loop_skill?.expected_path?.endsWith("/.inferoa/skills/inferoa-loop-skill/SKILL.md"));
    assert.equal(parsed.skill_policy?.learned_workspace_skill?.configured, true);
    assert.equal(parsed.skill_policy?.learned_workspace_skill?.discovered, true);
    assert.equal(parsed.skill_policy?.learned_workspace_skill?.enabled, true);
    assert.ok(parsed.skill_policy?.learned_workspace_skill?.expected_path?.endsWith("/.inferoa/skills/inferoa-workspace-skill/SKILL.md"));
    assert.deepEqual(parsed.skill_policy?.learned_skills?.map((item) => item.skill_id).sort(), ["inferoa-loop-skill", "inferoa-workspace-skill"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop roadmap command returns structured coverage as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-roadmap-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
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
      "roadmap",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as {
      closure_status?: string;
      full_product_model_status?: string;
      summary?: { implemented?: number; partially_implemented?: number; future_product_work?: number };
      capabilities?: Array<{ id?: string; status?: string; evidence?: string[] }>;
      current_closure?: string[];
      future_product_extensions?: string[];
      guardrails?: string[];
    };
    assert.equal(parsed.closure_status, "goal_native_closure_implemented");
    assert.equal(parsed.full_product_model_status, "partially_implemented");
    assert.ok((parsed.summary?.implemented ?? 0) > 0);
    assert.ok((parsed.summary?.partially_implemented ?? 0) > 0);
    assert.ok(parsed.capabilities?.some((item) => item.id === "memory-spine" && item.status === "implemented"));
    assert.equal(parsed.capabilities?.some((item) => item.id === "connectors-plugins"), false);
    assert.ok(parsed.capabilities?.some((item) => item.id === "policy-unattended-safety" && item.evidence?.includes("external mutation policy")));
    assert.ok(parsed.current_closure?.includes("Self-improve and structured replay/gating"));
    assert.equal(parsed.future_product_extensions?.some((item) => /Broader connectors/.test(item)), false);
    assert.ok(parsed.guardrails?.some((item) => /speculative scanners/.test(item)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
