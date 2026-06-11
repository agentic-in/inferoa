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
import { createExperiment, setAutoresearchMode, writeAutoresearchState } from "../src/autoresearch/state.js";
import { completeGoalReflection, createGoalState, readGoalState, replaceGoalPlanning, stageGoalReviewDecision, writeGoalState } from "../src/goals/state.js";
import { runGoalSupervisor } from "../src/goals/supervisor.js";
import { buildGoalVerificationPrompt, parseGoalVerifierArgs } from "../src/goals/verifier.js";
import { readGoalLoopView } from "../src/loop/projection.js";
import { queueGoalVerificationSuite, runGoalVerificationSuite } from "../src/loop/verifier-suite.js";
import { readGoalVerificationRecords, recordGoalVerification } from "../src/loop/verification.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { VllmAgentConfig, WorkspaceIdentity } from "../src/types.js";

const execFileAsync = promisify(execFile);

function config(): VllmAgentConfig {
  const next = structuredClone(DEFAULT_CONFIG);
  next.permissions.mode = "full_access";
  return next;
}

test("goal reflection writes a durable verification record", async () => {
  const fixture = await createFixture("inferoa-loop-verification-reflection-");
  try {
    const registry = new ToolRegistry(config(), fixture.workspace, fixture.store);
    let state = replaceGoalPlanning(createGoalState({ objective: "Verify durable reflection evidence" }), {
      steps: [{ id: "done", title: "Complete implementation", status: "completed" }],
    });
    state = writeGoalState(fixture.store, fixture.session.session_id, state, "run_seed");

    const result = await registry.call(
      {
        id: "reflect_done",
        name: "goal",
        arguments: {
          op: "reflect",
          decision: "done",
          summary: "All checks passed.",
          verification_evidence: { command: "npm test", exit_code: 0 },
        },
      },
      { session_id: fixture.session.session_id, run_id: "run_reflect", request_class: "reflection", visibility: "internal" },
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    const records = readGoalVerificationRecords(fixture.store, fixture.session.session_id, state.goal.id);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.provider, "reflection");
    assert.equal(records[0]?.verdict, "pass");
    assert.equal(records[0]?.run_id, "run_reflect");
    assert.deepEqual(records[0]?.evidence, { command: "npm test", exit_code: 0 });
    assert.equal(readGoalLoopView(fixture.store, fixture.session.session_id).verifications[0]?.verification_id, records[0]?.verification_id);
  } finally {
    await fixture.cleanup();
  }
});

test("human review resolution writes human verification evidence", async () => {
  const fixture = await createFixture("inferoa-loop-verification-human-");
  try {
    const registry = new ToolRegistry(config(), fixture.workspace, fixture.store);
    let state = createGoalState({ objective: "Review durable human evidence", hil_policy: "review" });
    state = stageGoalReviewDecision(state, {
      decision: "done",
      summary: "Looks ready.",
      verification_evidence: { checked: true },
    }, "run_reflect_pending");
    writeGoalState(fixture.store, fixture.session.session_id, state, "run_reflect_pending");

    const result = await registry.call(
      {
        id: "review_revise",
        name: "goal",
        arguments: {
          op: "review_decision",
          review_decision: "revise",
          feedback: "Missing regression coverage.",
        },
      },
      { session_id: fixture.session.session_id, run_id: "run_human_review", request_class: "interactive", visibility: "normal", control_plane: true },
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    const records = readGoalVerificationRecords(fixture.store, fixture.session.session_id, state.goal.id);
    const human = records.find((record) => record.provider === "human");
    assert.equal(human?.verdict, "fail");
    assert.equal(human?.confidence, "hard");
    assert.equal(human?.source_run_id, "run_reflect_pending");
    assert.match(human?.failure_reason ?? "", /regression coverage/i);
  } finally {
    await fixture.cleanup();
  }
});

test("verification runs can record checker verdicts without mutating goal state", async () => {
  const fixture = await createFixture("inferoa-loop-verification-checker-");
  try {
    const registry = new ToolRegistry(config(), fixture.workspace, fixture.store);
    const state = writeGoalState(fixture.store, fixture.session.session_id, createGoalState({ objective: "Check independently" }), "run_seed");
    fixture.store.appendEvent({
      session_id: fixture.session.session_id,
      run_id: "run_checker",
      type: "goal.verification.requested",
      data: {
        goal_id: state.goal.id,
        horizon_generation: state.goal.horizon_generation,
        role: "security",
        source: "test",
      },
    });

    const blockedMutation = await registry.call(
      { id: "verify_mutation", name: "goal", arguments: { op: "update_step", step_id: "read_objective_and_constraints", status: "completed" } },
      { session_id: fixture.session.session_id, run_id: "run_checker", request_class: "verification", visibility: "internal" },
    );
    assert.equal(blockedMutation.ok, false);
    assert.equal(blockedMutation.error?.code, "goal_verification_read_only");

    const recorded = await registry.call(
      {
        id: "verify_record",
        name: "goal",
        arguments: {
          op: "verify",
          verdict: "partial",
          confidence: "soft",
          summary: "Evidence is promising but incomplete.",
          failure_reason: "No test run recorded yet.",
          evidence: { inspected: ["goal", "events"] },
        },
      },
      { session_id: fixture.session.session_id, run_id: "run_checker", request_class: "verification", visibility: "internal" },
    );
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    const records = readGoalVerificationRecords(fixture.store, fixture.session.session_id, state.goal.id);
    assert.equal(records[0]?.provider, "checker");
    assert.equal(records[0]?.verdict, "partial");
    assert.equal(records[0]?.verifier_role, "security");
    assert.equal(records[0]?.failure_reason, "No test run recorded yet.");
  } finally {
    await fixture.cleanup();
  }
});

test("goal verifier roles shape prompt and parse explicit role flags", () => {
  const state = createGoalState({ objective: "Verify role prompt" });
  const parsed = parseGoalVerifierArgs(["--role", "tests", "Require", "npm", "test"]);
  assert.equal(parsed.role, "tests");
  assert.deepEqual(parsed.roles, ["tests"]);
  assert.equal(parsed.rubric, "Require npm test");
  assert.equal(parsed.background, false);
  assert.equal(parsed.isolation, "session");
  const prompt = buildGoalVerificationPrompt(state.goal, parsed);
  assert.match(prompt, /Reviewer role: tests/);
  assert.match(prompt, /test and verification reviewer/);
  assert.match(prompt, /Rubric: Require npm test/);
  const suite = parseGoalVerifierArgs(["--roles", "tests,security,tests", "Require", "evidence"]);
  assert.equal(suite.role, "tests");
  assert.deepEqual(suite.roles, ["tests", "security"]);
  assert.equal(suite.rubric, "Require evidence");
  const background = parseGoalVerifierArgs(["--roles", "tests,security", "--background", "--worktree", "Require", "evidence"]);
  assert.equal(background.background, true);
  assert.equal(background.isolation, "worktree");
  assert.equal(background.rubric, "Require evidence");
  assert.throws(() => parseGoalVerifierArgs(["--role", "unknown"]), /Unknown verifier role/);
});

test("goal verification suite runs multiple named checker roles with durable records", async () => {
  const fixture = await createFixture("inferoa-loop-verification-suite-");
  try {
    const registry = new ToolRegistry(config(), fixture.workspace, fixture.store);
    const state = writeGoalState(fixture.store, fixture.session.session_id, createGoalState({ objective: "Run verifier suite" }), "run_seed");
    const seenRoles: string[] = [];
    const result = await runGoalVerificationSuite({
      store: fixture.store,
      runtime: {
        async run(request) {
          const role = request.prompt.match(/Reviewer role: ([a-z_]+)/)?.[1] ?? "unknown";
          seenRoles.push(role);
          const recorded = await registry.call(
            {
              id: `verify_${role}`,
              name: "goal",
              arguments: {
                op: "verify",
                verdict: role === "security" ? "partial" : "pass",
                confidence: "soft",
                summary: `${role} reviewed the horizon.`,
              },
            },
            { session_id: fixture.session.session_id, run_id: request.run_id ?? `run_${role}`, request_class: "verification", visibility: "internal" },
          );
          assert.equal(recorded.ok, true, JSON.stringify(recorded));
          return {
            session: fixture.session,
            run_id: request.run_id ?? `run_${role}`,
            content: `${role} done`,
            tool_rounds: 1,
            tool_calls: 1,
            duration_ms: 1,
            tokens_used: 10,
            rtk: {
              tool_calls: 0,
              rtk_tool_calls: 0,
              rtk_commands: 0,
              input_tokens: 0,
              output_tokens: 0,
              saved_tokens: 0,
              savings_pct: 0,
              estimated_without_rtk_tokens: 0,
              status: "disabled",
            },
          };
        },
      },
      session_id: fixture.session.session_id,
      goal: state.goal,
      roles: ["tests", "security", "tests"],
      rubric: "Require concrete evidence.",
      source: "cli",
    });

    assert.deepEqual(result.roles, ["tests", "security"]);
    assert.deepEqual(seenRoles, ["tests", "security"]);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0]?.verification?.verifier_role, "tests");
    assert.equal(result.results[1]?.verification?.verifier_role, "security");
    const records = readGoalVerificationRecords(fixture.store, fixture.session.session_id, state.goal.id);
    assert.equal(records.some((record) => record.verifier_role === "tests" && record.verdict === "pass"), true);
    assert.equal(records.some((record) => record.verifier_role === "security" && record.verdict === "partial"), true);
    const events = fixture.store.listEvents(fixture.session.session_id);
    assert.equal(events.some((event) => event.type === "goal.verification.suite.requested"), true);
    assert.equal(events.some((event) => event.type === "goal.verification.suite.completed"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("isolated verification suite queues child verifier sessions and projects child evidence", async () => {
  const fixture = await createFixture("inferoa-loop-verification-isolated-suite-");
  try {
    const state = writeGoalState(fixture.store, fixture.session.session_id, createGoalState({ objective: "Review in isolated sessions" }), "run_seed");
    const queued = await queueGoalVerificationSuite({
      store: fixture.store,
      workspace: fixture.workspace,
      session_id: fixture.session.session_id,
      goal_state: state,
      roles: ["tests", "security", "tests"],
      rubric: "Check evidence only.",
      source: "cli",
      isolation: "session",
      config_path: path.join(fixture.dir, ".inferoa", "config.yaml"),
    });

    assert.deepEqual(queued.roles, ["tests", "security"]);
    assert.equal(queued.jobs.length, 2);
    const first = queued.jobs[0]!;
    const childGoal = readGoalState(fixture.store, first.session_id);
    assert.equal(childGoal?.goal.id, state.goal.id);
    const job = fixture.store.getSupervisorJob(first.job_id);
    assert.equal(job?.session_id, first.session_id);
    assert.equal(job?.metadata.request_class, "verification");
    assert.equal(job?.metadata.skip_goal_supervisor, true);
    assert.equal(job?.metadata.parent_session_id, fixture.session.session_id);
    assert.equal(job?.metadata.verifier_role, first.role);

    recordGoalVerification(fixture.store, first.session_id, {
      provider: "checker",
      verdict: "pass",
      confidence: "soft",
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      run_id: "child_verify_run",
      verifier_role: first.role,
      summary: "Child verifier passed.",
    }, "child_verify_run");
    const view = readGoalLoopView(fixture.store, fixture.session.session_id);
    const childRecord = view.verifications.find((record) => record.source_session_id === first.session_id);
    assert.equal(childRecord?.verdict, "pass");
    assert.equal(childRecord?.verifier_role, first.role);
    assert.equal(childRecord?.summary, "Child verifier passed.");
    const events = fixture.store.listEvents(fixture.session.session_id);
    assert.equal(events.some((event) => event.type === "goal.verification.suite.queued"), true);
    assert.equal(events.filter((event) => event.type === "goal.verification.child_session.created").length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("verify command can queue an isolated background verifier suite", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-verification-cli-queue-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "cli isolated verification");
    writeGoalState(store, session.session_id, createGoalState({ objective: "Queue verifier suite" }), "run_seed");
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
      "verify",
      session.session_id.slice(0, 12),
      "--roles",
      "tests,security",
      "--background",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as { isolation?: string; jobs?: Array<{ role?: string; session_id?: string; job_id?: string }> };
    assert.equal(parsed.isolation, "session");
    assert.equal(parsed.jobs?.length, 2);
    assert.deepEqual(parsed.jobs?.map((job) => job.role), ["tests", "security"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("declared command verifier policy records command verification and gates completion", async () => {
  const fixture = await createFixture("inferoa-loop-verification-command-");
  try {
    const registry = new ToolRegistry(config(), fixture.workspace, fixture.store);
    let state = replaceGoalPlanning(createGoalState({ objective: "Gate completion on explicit command verifier" }), {
      steps: [{ id: "done", title: "Complete implementation", status: "completed" }],
    });
    state = writeGoalState(fixture.store, fixture.session.session_id, state, "run_seed");
    const command = `"${process.execPath}" -e "process.exit(0)"`;

    const policy = await registry.call(
      {
        id: "set_policy",
        name: "goal",
        arguments: {
          op: "set_verifier_policy",
          command_verifiers: [{ id: "unit", command, required: true }],
        },
      },
      { session_id: fixture.session.session_id, run_id: "run_policy" },
    );
    assert.equal(policy.ok, true, JSON.stringify(policy));
    assert.equal(readGoalState(fixture.store, fixture.session.session_id)?.goal.verifier_policy?.command_verifiers[0]?.id, "unit");

    const reflected = await registry.call(
      {
        id: "reflect_done",
        name: "goal",
        arguments: {
          op: "reflect",
          decision: "done",
          summary: "Implementation is ready.",
          verification_evidence: { review: "ready for command gate" },
        },
      },
      { session_id: fixture.session.session_id, run_id: "run_reflect", request_class: "reflection", visibility: "internal" },
    );
    assert.equal(reflected.ok, true, JSON.stringify(reflected));

    const blocked = await registry.call(
      { id: "complete_blocked", name: "goal", arguments: { op: "complete", summary: "Done." } },
      { session_id: fixture.session.session_id, run_id: "run_complete_blocked", control_plane: true },
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "goal_verifier_policy_required");

    const commandResult = await registry.call(
      { id: "run_unit", name: "run_command", arguments: { command, timeout_ms: 10_000 } },
      { session_id: fixture.session.session_id, run_id: "run_command" },
    );
    assert.equal(commandResult.ok, true, JSON.stringify(commandResult));
    const commandRecord = readGoalVerificationRecords(fixture.store, fixture.session.session_id, state.goal.id).find((record) => record.provider === "command");
    assert.equal(commandRecord?.verdict, "pass");
    assert.equal(commandRecord?.confidence, "hard");
    assert.equal(commandRecord?.evidence?.verifier_id, "unit");
    assert.equal(commandRecord?.evidence?.command, command);

    const completed = await registry.call(
      { id: "complete_allowed", name: "goal", arguments: { op: "complete", summary: "Done." } },
      { session_id: fixture.session.session_id, run_id: "run_complete_allowed", control_plane: true },
    );
    assert.equal(completed.ok, true, JSON.stringify(completed));
  } finally {
    await fixture.cleanup();
  }
});

test("unattended completion requires strong non-reflection verification", async () => {
  const fixture = await createFixture("inferoa-loop-verification-unattended-");
  try {
    const registry = new ToolRegistry(config(), fixture.workspace, fixture.store);
    let state = replaceGoalPlanning(createGoalState({ objective: "Gate unattended completion" }), {
      steps: [{ id: "done", title: "Complete implementation", status: "completed" }],
    });
    state = writeGoalState(fixture.store, fixture.session.session_id, state, "run_seed");

    const reflected = await registry.call(
      {
        id: "reflect_done",
        name: "goal",
        arguments: {
          op: "reflect",
          decision: "done",
          summary: "The producer believes the horizon is done.",
          verification_evidence: { self_check: true },
        },
      },
      { session_id: fixture.session.session_id, run_id: "run_reflect", request_class: "reflection", visibility: "internal" },
    );
    assert.equal(reflected.ok, true, JSON.stringify(reflected));

    const blocked = await registry.call(
      { id: "background_complete_blocked", name: "goal", arguments: { op: "complete", summary: "Done." } },
      { session_id: fixture.session.session_id, run_id: "run_background_complete", request_class: "background", control_plane: true },
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "goal_verifier_policy_required");
    assert.match(blocked.error?.message ?? "", /Reflection-only evidence is not enough/);

    const checker = await registry.call(
      {
        id: "checker_pass",
        name: "goal",
        arguments: {
          op: "verify",
          verdict: "pass",
          summary: "Independent checker accepts the current horizon.",
        },
      },
      { session_id: fixture.session.session_id, run_id: "run_checker", request_class: "verification", visibility: "internal" },
    );
    assert.equal(checker.ok, true, JSON.stringify(checker));

    const completed = await registry.call(
      { id: "background_complete_allowed", name: "goal", arguments: { op: "complete", summary: "Done." } },
      { session_id: fixture.session.session_id, run_id: "run_background_complete_allowed", request_class: "background", control_plane: true },
    );
    assert.equal(completed.ok, true, JSON.stringify(completed));
  } finally {
    await fixture.cleanup();
  }
});

test("completion requires enabled Loop Skill body to be loaded before claiming done", async () => {
  const fixture = await createFixture("inferoa-loop-verification-loop-skill-gate-");
  try {
    const loopSkillDir = path.join(fixture.workspace.root, ".inferoa", "skills", "inferoa-loop-skill");
    await mkdir(loopSkillDir, { recursive: true });
    await writeFile(
      path.join(loopSkillDir, "SKILL.md"),
      "---\nname: Inferoa Loop Skill\ndescription: Learned loop control policy.\n---\n\nRead this before completion.\n",
      "utf8",
    );
    const nextConfig = config();
    nextConfig.skills.enabled = ["inferoa-loop-skill"];
    const registry = new ToolRegistry(nextConfig, fixture.workspace, fixture.store);
    let state = replaceGoalPlanning(createGoalState({ objective: "Require learned loop policy before completion" }), {
      steps: [{ id: "done", title: "Complete implementation", status: "completed" }],
    });
    state = writeGoalState(fixture.store, fixture.session.session_id, state, "run_seed");

    const reflected = await registry.call(
      {
        id: "reflect_done",
        name: "goal",
        arguments: {
          op: "reflect",
          decision: "done",
          summary: "Implementation is ready.",
          verification_evidence: { command: "npm test", status: "pass" },
        },
      },
      { session_id: fixture.session.session_id, run_id: "run_reflect", request_class: "reflection", visibility: "internal" },
    );
    assert.equal(reflected.ok, true, JSON.stringify(reflected));

    const blocked = await registry.call(
      { id: "complete_blocked_by_skill", name: "goal", arguments: { op: "complete", summary: "Done." } },
      { session_id: fixture.session.session_id, run_id: "run_complete_blocked", control_plane: true },
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "goal_skill_policy_required");
    assert.match(blocked.error?.message ?? "", /Loop Skill body/);

    const read = await registry.call(
      { id: "read_loop_skill", name: "skill_read", arguments: { id: "inferoa-loop-skill" } },
      { session_id: fixture.session.session_id, run_id: "run_skill_read" },
    );
    assert.equal(read.ok, true, JSON.stringify(read));

    const completed = await registry.call(
      { id: "complete_allowed_after_skill", name: "goal", arguments: { op: "complete", summary: "Done." } },
      { session_id: fixture.session.session_id, run_id: "run_complete_allowed", control_plane: true },
    );
    assert.equal(completed.ok, true, JSON.stringify(completed));
    const applications = readGoalLoopView(fixture.store, fixture.session.session_id).skill_rule_applications;
    assert.ok(applications.some((application) =>
      application.skill_id === "inferoa-loop-skill"
      && application.rule_id === "loop-completion-gate-satisfied"
      && application.body_hash
    ));
  } finally {
    await fixture.cleanup();
  }
});

test("goal supervisor can orchestrate an independent checker before unattended completion", async () => {
  const fixture = await createFixture("inferoa-loop-verification-orchestrated-checker-");
  try {
    const registry = new ToolRegistry(config(), fixture.workspace, fixture.store);
    const state = replaceGoalPlanning(createGoalState({ objective: "Orchestrate checker before completion" }), {
      steps: [{ id: "done", title: "Complete implementation", status: "completed" }],
    });
    writeGoalState(fixture.store, fixture.session.session_id, state, "run_seed");
    const seen: string[] = [];

    const result = await runGoalSupervisor({
      store: fixture.store,
      sessionId: fixture.session.session_id,
      supervisor: "test",
      maxIterations: 1,
      autoVerifyCompletion: true,
      runTurn: async (request) => {
        seen.push(request.requestClass ?? "unknown");
        if (request.requestClass === "reflection") {
          const reflected = await registry.call(
            {
              id: "reflect_done",
              name: "goal",
              arguments: {
                op: "reflect",
                decision: "done",
                summary: "The producer believes the horizon is done.",
                verification_evidence: { self_check: true },
              },
            },
            { session_id: fixture.session.session_id, run_id: request.runId ?? "run_reflect", request_class: "reflection", visibility: "internal" },
          );
          assert.equal(reflected.ok, true, JSON.stringify(reflected));
          return { run_id: request.runId ?? "run_reflect" };
        }
        if (request.requestClass === "verification") {
          const verified = await registry.call(
            {
              id: "checker_pass",
              name: "goal",
              arguments: {
                op: "verify",
                verdict: "pass",
                confidence: "soft",
                summary: "Independent checker accepts the current horizon.",
              },
            },
            { session_id: fixture.session.session_id, run_id: request.runId ?? "run_checker", request_class: "verification", visibility: "internal" },
          );
          assert.equal(verified.ok, true, JSON.stringify(verified));
          return { run_id: request.runId ?? "run_checker" };
        }
        return { run_id: request.runId ?? "run_work" };
      },
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(seen, ["reflection", "verification"]);
    const current = readGoalState(fixture.store, fixture.session.session_id)?.goal;
    assert.equal(current?.status, "complete");
    const records = readGoalVerificationRecords(fixture.store, fixture.session.session_id, state.goal.id);
    assert.equal(records.some((record) => record.provider === "checker" && record.verdict === "pass"), true);
    assert.equal(fixture.store.listEvents(fixture.session.session_id).some((event) => event.type === "goal.verification.requested"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("research experiment logs write durable verification records", async () => {
  const fixture = await createFixture("inferoa-loop-verification-research-");
  try {
    const registry = new ToolRegistry(config(), fixture.workspace, fixture.store);
    const state = writeGoalState(fixture.store, fixture.session.session_id, createGoalState({ objective: "Improve benchmark", kind: "research" }), "run_goal");
    setAutoresearchMode(fixture.store, fixture.session.session_id, { mode: "on", goal: state.goal.objective }, "run_goal");
    const experiment = createExperiment({
      name: "latency",
      goal: state.goal.objective,
      primary_metric: "latency_ms",
      direction: "lower",
    });
    writeAutoresearchState(fixture.store, fixture.session.session_id, {
      enabled: true,
      goal: state.goal.objective,
      active_experiment_name: experiment.name,
      experiments: [{
        ...experiment,
        pending_run: {
          id: 1,
          command: "bash autoresearch.sh",
          exit_code: 0,
          duration_ms: 42,
          parsed_metrics: { latency_ms: 10 },
          parsed_primary: 10,
          asi: { candidate: "a" },
          completed_at: new Date().toISOString(),
        },
      }],
    }, "run_pending");

    const result = await registry.call(
      {
        id: "log_experiment",
        name: "log_experiment",
        arguments: { status: "keep", description: "Latency improved.", metric: 10 },
      },
      { session_id: fixture.session.session_id, run_id: "run_log" },
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    const records = readGoalVerificationRecords(fixture.store, fixture.session.session_id, state.goal.id);
    assert.equal(records[0]?.provider, "research");
    assert.equal(records[0]?.verdict, "pass");
    assert.equal(records[0]?.confidence, "hard");
    assert.equal(records[0]?.metrics?.latency_ms, 10);
    assert.equal(readGoalLoopView(fixture.store, fixture.session.session_id).verifications[0]?.provider, "research");
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(prefix: string): Promise<{
  dir: string;
  store: SessionStore;
  workspace: WorkspaceIdentity;
  session: ReturnType<SessionStore["createSession"]>;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const store = await SessionStore.open(path.join(dir, "state"));
  const workspace: WorkspaceIdentity = { id: `w_${prefix.replace(/[^a-z0-9]/gi, "_")}`, root: dir, alias: prefix };
  const session = store.createSession(workspace, prefix);
  return {
    dir,
    store,
    workspace,
    session,
    cleanup: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
