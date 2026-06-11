import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { completeGoalReflection, createGoalState, replaceGoalPlanning, writeGoalState, type GoalReflectionDecision } from "../src/goals/state.js";
import { readGoalLoopView } from "../src/loop/projection.js";
import { optLiteAdopt, optLitePropose, optLiteReplay } from "../src/opt/opt-lite.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { WorkspaceIdentity } from "../src/types.js";

test("self-improve e2e proves Loop Skill and Workspace Skill change later loop behavior", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-self-improve-e2e-"));
  const previousStateDir = process.env.INFEROA_STATE_DIR;
  process.env.INFEROA_STATE_DIR = path.join(dir, "user-state");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_loop_self_improve_e2e", root: dir, alias: "loop-self-improve-e2e" };
    addHistoricalLoopEvidence(store, workspace, "Initial docs change missed hard verification", "Do not claim done without npm test.");
    addHistoricalLoopEvidence(store, workspace, "Second loop used npm test before done");
    addHistoricalLoopEvidence(store, workspace, "Third loop preserved verifier evidence");

    const proposal = await optLitePropose(store, workspace);
    assert.deepEqual(proposal.skill_targets?.map((target) => target.skill_id).sort(), ["inferoa-loop-skill", "inferoa-workspace-skill"]);
    assert.match(proposal.skill_targets?.find((target) => target.target === "workspace_skill")?.body ?? "", /npm test/);
    const replay = await optLiteReplay(store, workspace, proposal.id);
    assert.equal(replay.status, "accepted");
    const config = structuredClone(DEFAULT_CONFIG);
    const adopted = await optLiteAdopt(store, workspace, config, proposal.id);
    assert.equal(adopted.status, "adopted");
    assert.equal(config.skills.enabled.includes("inferoa-loop-skill"), true);
    assert.equal(config.skills.enabled.includes("inferoa-workspace-skill"), true);

    const session = store.createSession(workspace, "post-adoption loop");
    const registry = new ToolRegistry(config, workspace, store);
    const goal = replaceGoalPlanning(createGoalState({ objective: "Ship a workspace docs update using learned loop policy" }), {
      steps: [{ id: "done", title: "Complete docs update", status: "completed" }],
    });
    writeGoalState(store, session.session_id, goal, "run_seed");

    const earlyReflect = await registry.call(
      {
        id: "early_reflect",
        name: "goal",
        arguments: {
          op: "reflect",
          decision: "done",
          summary: "Looks done from reflection only.",
          verification_evidence: { self_check: true },
        },
      },
      { session_id: session.session_id, run_id: "run_early_reflect", request_class: "reflection", visibility: "internal" },
    );
    assert.equal(earlyReflect.ok, true, JSON.stringify(earlyReflect));

    const blocked = await registry.call(
      { id: "blocked_complete", name: "goal", arguments: { op: "complete", summary: "Done." } },
      { session_id: session.session_id, run_id: "run_blocked_complete", control_plane: true },
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "goal_skill_policy_required");

    const readLoopSkill = await registry.call(
      { id: "read_loop_skill", name: "skill_read", arguments: { id: "inferoa-loop-skill" } },
      { session_id: session.session_id, run_id: "run_read_loop_skill" },
    );
    assert.equal(readLoopSkill.ok, true, JSON.stringify(readLoopSkill));
    const readWorkspaceSkill = await registry.call(
      { id: "read_workspace_skill", name: "skill_read", arguments: { id: "inferoa-workspace-skill" } },
      { session_id: session.session_id, run_id: "run_read_workspace_skill" },
    );
    assert.equal(readWorkspaceSkill.ok, true, JSON.stringify(readWorkspaceSkill));

    const verify = await registry.call(
      {
        id: "workspace_verify",
        name: "goal",
        arguments: {
          op: "verify",
          provider: "command",
          verdict: "pass",
          confidence: "hard",
          evidence: { command: "npm test", status: "pass" },
          summary: "npm test passed after reading Workspace Skill.",
        },
      },
      { session_id: session.session_id, run_id: "run_workspace_verify" },
    );
    assert.equal(verify.ok, true, JSON.stringify(verify));

    const learnedReflect = await registry.call(
      {
        id: "learned_reflect",
        name: "goal",
        arguments: {
          op: "reflect",
          decision: "done",
          summary: "Verified with npm test after reading learned skills.",
          verification_evidence: { command: "npm test", status: "pass" },
        },
      },
      { session_id: session.session_id, run_id: "run_learned_reflect", request_class: "reflection", visibility: "internal" },
    );
    assert.equal(learnedReflect.ok, true, JSON.stringify(learnedReflect));

    const completed = await registry.call(
      { id: "learned_complete", name: "goal", arguments: { op: "complete", summary: "Done with learned Loop/Workspace Skill evidence." } },
      { session_id: session.session_id, run_id: "run_learned_complete", control_plane: true },
    );
    assert.equal(completed.ok, true, JSON.stringify(completed));

    const view = readGoalLoopView(store, session.session_id);
    assert.deepEqual(view.skill_body_loads.map((load) => load.skill_id).sort(), ["inferoa-loop-skill", "inferoa-workspace-skill"]);
    assert.ok(view.skill_rule_applications.some((item) => item.skill_id === "inferoa-workspace-skill" && item.rule_id === "workspace-command-verifier-used"));
    assert.ok(view.skill_rule_applications.some((item) => item.skill_id === "inferoa-loop-skill" && item.rule_id === "loop-reflection-verification-used"));
    assert.ok(view.skill_rule_applications.some((item) => item.skill_id === "inferoa-loop-skill" && item.rule_id === "loop-completion-gate-satisfied"));

    const caseDir = path.join(workspace.root, ".inferoa", "generated", "loop-self-improve-case");
    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, "evidence.json"), `${JSON.stringify({
      proposal_id: proposal.id,
      replay_id: replay.id,
      replay_status: replay.status,
      adopted_skill_ids: adopted.skill_targets?.map((target) => target.skill_id),
      blocked_before_skill_read: blocked.error?.code,
      skill_body_loads: view.skill_body_loads,
      skill_rule_applications: view.skill_rule_applications,
      verification_records: view.verifications,
    }, null, 2)}\n`, "utf8");
    await writeFile(path.join(caseDir, "README.md"), renderCaseReport(proposal.id, replay.id, view), "utf8");

    const report = await readFile(path.join(caseDir, "README.md"), "utf8");
    assert.match(report, /blocked_before_skill_read: goal_skill_policy_required/);
    assert.match(report, /workspace-command-verifier-used/);
    assert.match(report, /loop-completion-gate-satisfied/);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.INFEROA_STATE_DIR;
    } else {
      process.env.INFEROA_STATE_DIR = previousStateDir;
    }
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function addHistoricalLoopEvidence(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  objective: string,
  feedback?: string,
): void {
  const session = store.createSession(workspace, objective);
  let state = replaceGoalPlanning(createGoalState({ objective }), {
    steps: [{ id: "done", title: "Complete implementation", status: "completed" }],
  });
  writeGoalState(store, session.session_id, state, `run_seed_${session.session_id}`);
  state = completeGoalReflection(
    state,
    {
      decision: "done" as GoalReflectionDecision,
      summary: "Verified with npm test.",
      verification_evidence: { command: "npm test", status: "pass" },
    },
    `run_reflect_${session.session_id}`,
  );
  writeGoalState(store, session.session_id, state, `run_reflect_${session.session_id}`);
  store.appendEvent({
    session_id: session.session_id,
    run_id: `run_reflect_${session.session_id}`,
    type: "goal.reflection.completed",
    data: {
      goal_id: state.goal.id,
      source_horizon_generation: 0,
      horizon_generation: 0,
      decision: "done",
      summary: state.goal.last_reflection_summary,
      verification_evidence: state.goal.verification_evidence,
    },
  });
  if (feedback) {
    store.appendEvent({
      session_id: session.session_id,
      run_id: `run_review_${session.session_id}`,
      type: "goal.review.resolved",
      data: {
        goal_id: state.goal.id,
        decision: "revise",
        action: "done",
        feedback,
      },
    });
  }
}

function renderCaseReport(proposalId: string, replayId: string, view: ReturnType<typeof readGoalLoopView>): string {
  return [
    "# Loop Self-Improve Case Evidence",
    "",
    `proposal_id: ${proposalId}`,
    `replay_id: ${replayId}`,
    "blocked_before_skill_read: goal_skill_policy_required",
    "",
    "## Skill Body Loads",
    "",
    ...view.skill_body_loads.map((load) => `- ${load.skill_id} ${load.body_hash}`),
    "",
    "## Skill Rule Applications",
    "",
    ...view.skill_rule_applications.map((application) => `- ${application.skill_id} ${application.rule_id} ${application.body_hash}`),
    "",
  ].join("\n");
}
