import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createGoalState, writeGoalState } from "../src/goals/state.js";
import { readGoalLoopView } from "../src/loop/projection.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { SessionStore } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { VllmAgentConfig, WorkspaceIdentity } from "../src/types.js";

test("SkillRegistry discovers native and imported skills and tools read details on demand", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-skills-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const skillDir = path.join(dir, ".inferoa", "skills", "demo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: Demo Skill\ndescription: Demonstrates progressive skill loading.\n---\n\nUse this only when the task says demo.\n",
      "utf8",
    );
    const loopSkillDir = path.join(dir, ".inferoa", "skills", "inferoa-loop-skill");
    const workspaceSkillDir = path.join(dir, ".inferoa", "skills", "inferoa-workspace-skill");
    await mkdir(loopSkillDir, { recursive: true });
    await mkdir(workspaceSkillDir, { recursive: true });
    await writeFile(
      path.join(loopSkillDir, "SKILL.md"),
      "---\nname: Inferoa Loop Skill\ndescription: Learned loop control policy.\n---\n\nWhen completion evidence is soft-only, verify before done.\n",
      "utf8",
    );
    await writeFile(
      path.join(workspaceSkillDir, "SKILL.md"),
      "---\nname: Inferoa Workspace Skill\ndescription: Learned workspace workflow policy.\n---\n\nRun `npm test` before completion.\n",
      "utf8",
    );
    await writeFile(path.join(dir, "AGENTS.md"), "Workspace instruction import.\n\nPrefer small patches.\n", "utf8");
    const workspace: WorkspaceIdentity = { id: "w_skills", root: dir, alias: "skills" };
    const config: VllmAgentConfig = structuredClone(DEFAULT_CONFIG);
    config.skills.enabled = ["demo-skill", "inferoa-loop-skill", "inferoa-workspace-skill"];
    const registry = new SkillRegistry(workspace, config);
    const discovered = await registry.discover();
    assert.ok(discovered.some((skill) => skill.id === "demo-skill"));
    assert.ok(discovered.some((skill) => skill.id === "agents" && skill.trust === "imported"));

    const session = store.createSession(workspace, "skills");
    const goal = createGoalState({ objective: "Use the demo skill" });
    writeGoalState(store, session.session_id, goal, "run_goal");
    const tools = new ToolRegistry(config, workspace, store);
    const listed = await tools.call({ id: "tc1", name: "skill_list", arguments: { query: "demo" } }, { session_id: session.session_id });
    assert.equal(listed.ok, true);
    assert.equal(listed.summary, "Listed 1 skill");
    assert.match(JSON.stringify(listed.data), /demo-skill/);
    const read = await tools.call({ id: "tc2", name: "skill_read", arguments: { id: "demo-skill" } }, { session_id: session.session_id });
    assert.equal(read.ok, true);
    assert.match(JSON.stringify(read.data), /progressive skill loading/);
    const loadedEvents = store.listEvents(session.session_id).filter((event) => event.type === "skill.body.loaded");
    assert.equal(loadedEvents.length, 1);
    assert.equal(loadedEvents[0]?.data.skill_id, "demo-skill");
    assert.match(String(loadedEvents[0]?.data.body_hash), /^[a-f0-9]{64}$/);
    assert.equal(loadedEvents[0]?.data.path, path.join(skillDir, "SKILL.md"));
    assert.equal(loadedEvents[0]?.data.total_lines, 7);
    assert.equal(loadedEvents[0]?.data.goal_id, goal.goal.id);
    const view = readGoalLoopView(store, session.session_id);
    assert.equal(view.skill_body_loads.length, 1);
    assert.equal(view.skill_body_loads[0]?.skill_id, "demo-skill");
    assert.equal(view.skill_body_loads[0]?.body_hash, loadedEvents[0]?.data.body_hash);

    const readLoop = await tools.call({ id: "tc3", name: "skill_read", arguments: { id: "inferoa-loop-skill" } }, { session_id: session.session_id, run_id: "run_loop_skill" });
    assert.equal(readLoop.ok, true);
    const readWorkspace = await tools.call({ id: "tc4", name: "skill_read", arguments: { id: "inferoa-workspace-skill" } }, { session_id: session.session_id, run_id: "run_workspace_skill" });
    assert.equal(readWorkspace.ok, true);
    const verify = await tools.call(
      {
        id: "tc5",
        name: "goal",
        arguments: {
          op: "verify",
          provider: "command",
          verdict: "pass",
          confidence: "hard",
          evidence: { command: "npm test", status: "pass" },
          summary: "npm test passed",
        },
      },
      { session_id: session.session_id, run_id: "run_verify" },
    );
    assert.equal(verify.ok, true, JSON.stringify(verify));
    const reflect = await tools.call(
      {
        id: "tc6",
        name: "goal",
        arguments: {
          op: "reflect",
          decision: "done",
          summary: "Verified with npm test.",
          verification_evidence: { command: "npm test", status: "pass" },
        },
      },
      { session_id: session.session_id, run_id: "run_reflect", request_class: "reflection", visibility: "internal" },
    );
    assert.equal(reflect.ok, true, JSON.stringify(reflect));
    const appliedEvents = store.listEvents(session.session_id).filter((event) => event.type === "skill.rule.applied");
    assert.equal(appliedEvents.length, 2);
    assert.deepEqual(appliedEvents.map((event) => event.data.skill_id).sort(), ["inferoa-loop-skill", "inferoa-workspace-skill"]);
    assert.ok(appliedEvents.some((event) => event.data.rule_id === "workspace-command-verifier-used" && event.data.body_hash));
    assert.ok(appliedEvents.some((event) => event.data.rule_id === "loop-reflection-verification-used" && event.data.body_hash));
    const viewAfterApply = readGoalLoopView(store, session.session_id);
    assert.equal(viewAfterApply.skill_rule_applications.length, 2);
    assert.deepEqual(viewAfterApply.skill_rule_applications.map((item) => item.skill_id).sort(), ["inferoa-loop-skill", "inferoa-workspace-skill"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing learned skills are reported as not adopted without a failed tool call", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-missing-learned-skills-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace: WorkspaceIdentity = { id: "w_missing_learned_skills", root: dir, alias: "missing-learned-skills" };
    const config: VllmAgentConfig = structuredClone(DEFAULT_CONFIG);
    config.skills.enabled = ["inferoa-loop-skill", "inferoa-workspace-skill"];
    const registry = new SkillRegistry(workspace, config);
    const discovered = await registry.discover();
    assert.deepEqual(registry.enabledSkillIds(discovered), []);
    assert.deepEqual(registry.missingEnabledSkillNames(discovered), ["inferoa-loop-skill", "inferoa-workspace-skill"]);

    const session = store.createSession(workspace, "missing learned skills");
    const tools = new ToolRegistry(config, workspace, store);
    const read = await tools.call(
      { id: "read_missing_loop_skill", name: "skill_read", arguments: { id: "inferoa-loop-skill" } },
      { session_id: session.session_id, run_id: "run_missing_loop_skill" },
    );

    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal((read.data as { status?: string } | undefined)?.status, "not_adopted");
    const readWorkspace = await tools.call(
      { id: "read_missing_workspace_skill", name: "skill_read", arguments: { id: "inferoa-workspace-skill" } },
      { session_id: session.session_id, run_id: "run_missing_workspace_skill" },
    );

    assert.equal(readWorkspace.ok, true, JSON.stringify(readWorkspace));
    assert.equal((readWorkspace.data as { status?: string } | undefined)?.status, "not_adopted");
    const readAlias = await tools.call(
      { id: "read_missing_loop_skill_alias", name: "skill_read", arguments: { id: "loop_skill" } },
      { session_id: session.session_id, run_id: "run_missing_loop_skill_alias" },
    );

    assert.equal(readAlias.ok, true, JSON.stringify(readAlias));
    assert.equal((readAlias.data as { id?: string; status?: string } | undefined)?.id, "inferoa-loop-skill");
    assert.equal((readAlias.data as { status?: string } | undefined)?.status, "not_adopted");
    assert.equal(store.listEvents(session.session_id).filter((event) => event.type === "skill.body.loaded").length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
