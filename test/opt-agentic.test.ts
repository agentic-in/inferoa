import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { completeGoalReflection, createGoalState, writeGoalState } from "../src/goals/state.js";
import { SELF_IMPROVE_OPTIMIZER_TOOL_NAMES, buildAgenticEvidencePacket, parseAgenticProposalJsonWithMetadata, runtimeAgenticOptimizer, type AgenticSkillProposalDraft } from "../src/opt/agentic-propose.js";
import { optLitePropose, optLiteReplay } from "../src/opt/opt-lite.js";
import { SessionStore } from "../src/session/store.js";
import type { WorkspaceIdentity } from "../src/types.js";

test("agentic evidence packet assigns signal tiers and keeps citation ids", async () => {
  const fixture = await createFixture("inferoa-opt-agentic-packet-");
  try {
    const { store, workspace } = fixture;
    const session = addVerifiedGoal(store, workspace);
    store.appendEvent({
      session_id: session.session_id,
      run_id: "run_review",
      type: "goal.review.resolved",
      data: {
        goal_id: "g_missing",
        decision: "revise",
        action: "done",
        feedback: "For docs changes, run npm test before claiming completion.",
      },
    });

    const packet = buildAgenticEvidencePacket(store, workspace);

    assert.equal(packet.workspace.id, workspace.id);
    assert.equal(packet.signals.some((signal) => signal.tier === "T1" && signal.summary.includes("command")), true);
    assert.equal(packet.signals.some((signal) => signal.tier === "T0" && signal.summary.includes("human review")), true);
    assert.equal(packet.source_events.some((event) => event.type === "goal.review.resolved" && event.event_id !== undefined), true);
    assert.equal(packet.signals.every((signal) => signal.signal_id), true);
  } finally {
    await fixture.cleanup();
  }
});

test("self-improve propose uses model-authored bounded edits when optimizer returns cited proposal", async () => {
  const fixture = await createFixture("inferoa-opt-agentic-propose-");
  try {
    const { store, workspace } = fixture;
    addVerifiedGoal(store, workspace);
    const proposal = await optLitePropose(store, workspace, {
      config: structuredClone(DEFAULT_CONFIG),
      optimizer: {
        async propose(packet): Promise<AgenticSkillProposalDraft> {
          const signal = packet.signals.find((item) => item.tier === "T1") ?? packet.signals[0]!;
          return {
            edits: [
              {
                target: "workspace_skill",
                op: "add",
                section: "testing",
                content: "When editing docs in this repository, run `npm test` because the slug fixture catches broken duplicate heading anchors.",
                rationale: "The cited command verifier passed on the docs-related slug task and is reusable for this workspace.",
                expected_behavior_change: "Future docs tasks select npm test before completion.",
                eval_plan: "Run npm test on the slug fixture after a docs-only change.",
                source_event_ids: [],
                source_signal_ids: [signal.signal_id],
              },
            ],
            rejected_signals: [],
          };
        },
      },
    });

    assert.equal(proposal.proposal_source, "agentic");
    assert.equal(proposal.model_proposal?.edits.length, 1);
    assert.equal(proposal.model_proposal?.edits[0]?.source_signal_ids.length, 1);
    assert.deepEqual(proposal.skill_targets?.map((target) => target.skill_id), ["inferoa-workspace-skill"]);
    const workspaceTarget = proposal.skill_targets?.find((target) => target.target === "workspace_skill");
    assert.match(workspaceTarget?.body ?? "", /slug fixture catches broken duplicate heading anchors/);
    assert.doesNotMatch(workspaceTarget?.body ?? "", /When code or documentation changes need repo validation, prefer the observed verifier command/);
    assert.match(await readFile(workspaceTarget!.staged_skill_path, "utf8"), /Expected behavior change/);
  } finally {
    await fixture.cleanup();
  }
});

test("self-improve propose accepts more than five bounded cited edits", async () => {
  const fixture = await createFixture("inferoa-opt-agentic-many-edits-");
  try {
    const { store, workspace } = fixture;
    addVerifiedGoal(store, workspace);
    const proposal = await optLitePropose(store, workspace, {
      config: structuredClone(DEFAULT_CONFIG),
      optimizer: {
        async propose(packet): Promise<AgenticSkillProposalDraft> {
          const signal = packet.signals.find((item) => item.tier === "T1") ?? packet.signals[0]!;
          return {
            edits: Array.from({ length: 6 }, (_, index) => ({
              target: index % 2 === 0 ? "loop_skill" : "workspace_skill",
              op: "add",
              section: index % 2 === 0 ? "completion" : "testing",
              content: `Bounded learned rule ${index + 1}: cite concrete verifier evidence before changing completion behavior.`,
              rationale: "The cited signal is verified and reusable.",
              expected_behavior_change: "Future loop/workspace policy has one more bounded rule.",
              eval_plan: "Replay the cited verification sample.",
              source_event_ids: [],
              source_signal_ids: [signal.signal_id],
            })),
            rejected_signals: [],
          };
        },
      },
    });

    assert.equal(proposal.proposal_source, "agentic");
    assert.equal(proposal.model_proposal?.edits.length, 6);
    assert.equal(proposal.agentic_error, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("self-improve preserves and normalizes rich model learning instead of falling back on shape drift", async () => {
  const fixture = await createFixture("inferoa-opt-agentic-normalize-");
  try {
    const { store, workspace } = fixture;
    addVerifiedGoal(store, workspace);
    let citedSignalId = "";
    const proposal = await optLitePropose(store, workspace, {
      config: structuredClone(DEFAULT_CONFIG),
      optimizer: {
        async propose(packet): Promise<AgenticSkillProposalDraft> {
          const signal = packet.signals.find((item) => item.tier === "T1") ?? packet.signals[0]!;
          citedSignalId = signal.signal_id;
          return {
            observations: [
              "The previous loop stayed in one file and accepted shallow confidence fixes after human feedback asked for deeper looper coverage.",
            ],
            edits: [
              {
                target: "loop_skill",
                type: "verification_breadth",
                summary: "When feedback says the bug hunt was not deep enough, expand verification breadth before completion.",
                content: {
                  file_breadth_checklist: [
                    "src/semantic-router/pkg/looper/confidence.go",
                    "src/semantic-router/pkg/looper/base.go",
                    "src/semantic-router/pkg/looper/ratings.go",
                  ],
                  required_checks: [
                    "Check goroutine or timeout leaks.",
                    "Check sort/shuffle behavior and duplicate extraction.",
                  ],
                },
                signal_ids: [signal.signal_id],
              },
              {
                target: "workspace_skill",
                type: "bug_surface_coverage",
                summary: "For semantic-router looper bugs, inspect the looper package broadly before patching one confidence file.",
                content: {
                  package_scope: "src/semantic-router/pkg/looper",
                  checklist: [
                    "confidence scoring",
                    "ratings aggregation",
                    "base loop orchestration",
                  ],
                },
                source_signal_ids: [signal.signal_id],
              },
            ],
            rejected_signals: [
              {
                signal_id: signal.signal_id,
                reason: "Accepted as hard evidence for concrete edits; not rejected.",
              },
            ],
          } as unknown as AgenticSkillProposalDraft;
        },
      },
    });

    assert.equal(proposal.proposal_source, "agentic");
    assert.equal(proposal.agentic_error, undefined);
    assert.equal(proposal.model_proposal?.edits.length, 2);
    assert.equal(proposal.model_proposal?.edits[0]?.op, "add");
    assert.equal(proposal.model_proposal?.edits[0]?.section, "verification");
    assert.equal(proposal.model_proposal?.edits[1]?.section, "testing");
    assert.match(proposal.normalization_warnings?.join("\n") ?? "", /defaulted to add/);
    assert.match(proposal.normalization_warnings?.join("\n") ?? "", /structured content object/);
    assert.match(JSON.stringify(proposal.raw_model_proposal), /verification_breadth/);
    assert.equal(proposal.model_proposal?.rejected_signals?.[0]?.source_signal_id, citedSignalId);
    assert.deepEqual(proposal.skill_targets?.map((target) => target.skill_id), ["inferoa-loop-skill", "inferoa-workspace-skill"]);
    assert.match(proposal.skill_targets?.find((target) => target.target === "loop_skill")?.body ?? "", /ratings\.go/);
    assert.match(proposal.skill_targets?.find((target) => target.target === "workspace_skill")?.body ?? "", /base loop orchestration/);
  } finally {
    await fixture.cleanup();
  }
});

test("agentic proposal parser keeps full JSON when string content contains nested code fences", () => {
  const raw = [
    "Based on deep code inspection, here is the analysis.",
    "",
    "```json",
    "{",
    '  "failure_modes": [',
    "    {",
    '      "mode_id": "fm_repeated_human_fail",',
    '      "sig_ids": ["sig_hard"],',
    '      "pattern": "Human review said not deep after shallow fixes.",',
    '      "root_cause": "The loop accepted self-reflection as validation."',
    "    }",
    "  ],",
    '  "observations": [',
    "    {",
    '      "file": "src/semantic-router/pkg/looper/remom.go",',
    '      "summary": "Semaphore acquisition does not select on ctx.Done()."',
    "    }",
    "  ],",
    '  "edits": [',
    "    {",
    '      "target": {"type": "workspace_skill", "file": "src/semantic-router/pkg/looper/remom.go", "lines": [68, 112]},',
    '      "source_signal_ids": ["sig_hard"],',
    '      "description": "Fix goroutine leak in remomRunOneParallelCall semaphore acquisition",',
    '      "content": "Replace bare semaphore send with:\\n```go\\nselect {\\ncase sem <- struct{}{}:\\ncase <-ctx.Done():\\n    return err\\n}\\n```\\nThis prevents leaked goroutines."',
    "    }",
    "  ],",
    '  "rejected_signals": []',
    "}",
    "```",
  ].join("\n");

  const parsed = parseAgenticProposalJsonWithMetadata(raw);

  assert.equal(Array.isArray(parsed.raw_proposal?.edits) ? parsed.raw_proposal.edits.length : 0, 1);
  assert.equal(parsed.draft.edits.some((edit) => edit.target === "workspace_skill"), true);
  assert.equal(parsed.draft.edits.some((edit) => edit.target === "loop_skill"), true);
  assert.match(parsed.normalization_warnings.join("\n"), /Extracted JSON object/);
  assert.match(parsed.normalization_warnings.join("\n"), /source-code patch target/);
  assert.match(parsed.normalization_warnings.join("\n"), /Synthesized skill policy edits/);
  assert.match(parsed.draft.edits.find((edit) => edit.target === "workspace_skill")?.content ?? "", /not an automatic code patch/);
});

test("runtime-backed agentic optimizer records a first-class read-only self-improve run", async () => {
  const fixture = await createFixture("inferoa-opt-agentic-runtime-");
  try {
    const { store, workspace } = fixture;
    addVerifiedGoal(store, workspace);
    const config = structuredClone(DEFAULT_CONFIG);
    config.model_setup.base_url = "http://127.0.0.1:65535/v1";
    config.model_setup.model = "optimizer-model";
    const runtimeCalls: Array<{ prompt: string; title?: string; request_class?: string; visibility?: string; max_tool_rounds?: number; tool_names?: string[]; session_id?: string }> = [];
    const optimizer = runtimeAgenticOptimizer(config, {
      async run(options) {
        runtimeCalls.push(options);
        const packetStart = options.prompt.lastIndexOf('{\n  "workspace"');
        assert.notEqual(packetStart, -1);
        const packet = JSON.parse(options.prompt.slice(packetStart)) as ReturnType<typeof buildAgenticEvidencePacket>;
        const signal = packet.signals[0]!;
        return {
          session: { session_id: "s_self_improve_optimizer", title: "self-improve optimizer" },
          run_id: "run_self_improve_optimizer",
          content: JSON.stringify({
            edits: [
              {
                target: "workspace_skill",
                op: "add",
                section: "testing",
                content: "When docs touch slug behavior, run `npm test` before completion.",
                rationale: "The cited command verifier passed for this workspace.",
                expected_behavior_change: "Future docs tasks select the same real verifier.",
                eval_plan: "Run npm test after slug docs changes.",
                source_event_ids: [],
                source_signal_ids: [signal.signal_id],
              },
            ],
            rejected_signals: [],
          }),
          tool_rounds: 0,
          tool_calls: 0,
          duration_ms: 12,
          tokens_used: 42,
          rtk: { tool_calls: 0, rtk_tool_calls: 0, rtk_commands: 0, input_tokens: 0, output_tokens: 0, saved_tokens: 0, savings_pct: 0, estimated_without_rtk_tokens: 0, status: "ok" },
        };
      },
    });
    assert.ok(optimizer);

    const proposal = await optLitePropose(store, workspace, { config, optimizer });

    assert.equal(proposal.proposal_source, "agentic");
    assert.deepEqual(proposal.agentic_run, {
      session_id: "s_self_improve_optimizer",
      run_id: "run_self_improve_optimizer",
      title: "self-improve optimizer",
      request_class: "background",
    });
    assert.equal(runtimeCalls[0]?.title, "self-improve optimizer");
    assert.equal(runtimeCalls[0]?.request_class, "background");
    assert.equal(runtimeCalls[0]?.visibility, "internal");
    assert.equal(runtimeCalls[0]?.session_id, undefined);
    assert.equal(runtimeCalls[0]?.max_tool_rounds, undefined);
    assert.deepEqual(runtimeCalls[0]?.tool_names, [...SELF_IMPROVE_OPTIMIZER_TOOL_NAMES]);
    const optimizerToolNames = runtimeCalls[0]?.tool_names as string[] | undefined;
    assert.equal(optimizerToolNames?.includes("edit_file"), false);
    assert.equal(optimizerToolNames?.includes("apply_patch"), false);
    assert.equal(optimizerToolNames?.includes("run_command"), false);
    assert.match(runtimeCalls[0]?.prompt ?? "", /Return only JSON/);
    assert.match(runtimeCalls[0]?.prompt ?? "", /proposal-only learning session/);
    assert.match(runtimeCalls[0]?.prompt ?? "", /Do not propose source-code patches/);
  } finally {
    await fixture.cleanup();
  }
});

test("self-improve propose rejects uncited model edits and records deterministic fallback source", async () => {
  const fixture = await createFixture("inferoa-opt-agentic-fallback-");
  try {
    const { store, workspace } = fixture;
    addVerifiedGoal(store, workspace);
    const proposal = await optLitePropose(store, workspace, {
      config: structuredClone(DEFAULT_CONFIG),
      optimizer: {
        async propose(): Promise<AgenticSkillProposalDraft> {
          return {
            edits: [
              {
                target: "loop_skill",
                op: "add",
                section: "completion",
                content: "Always finish quickly.",
                rationale: "No citation.",
                expected_behavior_change: "Faster completion.",
                eval_plan: "None.",
                source_event_ids: [],
                source_signal_ids: [],
              },
            ],
            rejected_signals: [],
          };
        },
      },
    });

    assert.equal(proposal.proposal_source, "deterministic_fallback");
    assert.match(proposal.agentic_error ?? "", /citation/i);
    assert.match(proposal.skill_targets?.find((target) => target.target === "loop_skill")?.body ?? "", /soft-only completion/i);
  } finally {
    await fixture.cleanup();
  }
});

test("self-improve propose does not fallback when optimizer rejects all evidence", async () => {
  const fixture = await createFixture("inferoa-opt-agentic-noop-");
  try {
    const { store, workspace } = fixture;
    addVerifiedGoal(store, workspace);
    await assert.rejects(
      () => optLitePropose(store, workspace, {
        config: structuredClone(DEFAULT_CONFIG),
        optimizer: {
          async propose(packet): Promise<AgenticSkillProposalDraft> {
            return {
              edits: [],
              rejected_signals: packet.signals.map((signal) => ({
                source_signal_id: signal.signal_id,
                reason: "soft-only evidence is not enough to learn a skill edit",
              })),
            };
          },
        },
      }),
      /no skill edits|no edits|rejected all evidence/i,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("self-improve propose does not fallback when optimizer run is aborted", async () => {
  const fixture = await createFixture("inferoa-opt-agentic-abort-");
  try {
    const { store, workspace } = fixture;
    addVerifiedGoal(store, workspace);
    await assert.rejects(
      () => optLitePropose(store, workspace, {
        config: structuredClone(DEFAULT_CONFIG),
        optimizer: {
          async propose(): Promise<AgenticSkillProposalDraft> {
            throw new Error("User exited TUI");
          },
        },
      }),
      /User exited TUI/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("agentic proposal patches existing learned skill without replacing unrelated content", async () => {
  const fixture = await createFixture("inferoa-opt-agentic-patch-");
  try {
    const { store, workspace } = fixture;
    addVerifiedGoal(store, workspace);
    const skillDir = path.join(workspace.root, ".inferoa", "skills", "inferoa-workspace-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: Inferoa Workspace Skill\ndescription: Existing learned workspace skill.\n---\n\n# Inferoa Workspace Skill\n\n## Existing Rules\n\n- Keep the existing release checklist intact.\n",
      "utf8",
    );

    const proposal = await optLitePropose(store, workspace, {
      config: structuredClone(DEFAULT_CONFIG),
      optimizer: {
        async propose(packet): Promise<AgenticSkillProposalDraft> {
          const signal = packet.signals[0]!;
          return {
            edits: [
              {
                target: "workspace_skill",
                op: "add",
                section: "testing",
                content: "When changing slug documentation, run `npm test` before completion.",
                rationale: "The cited verifier shows npm test is the relevant workspace eval.",
                expected_behavior_change: "Docs tasks keep using the real command verifier.",
                eval_plan: "Run npm test after a docs-only slug update.",
                source_event_ids: [],
                source_signal_ids: [signal.signal_id],
              },
            ],
            rejected_signals: [],
          };
        },
      },
    });

    const body = proposal.skill_targets?.find((target) => target.target === "workspace_skill")?.body ?? "";
    assert.match(body, /Keep the existing release checklist intact/);
    assert.match(body, /When changing slug documentation, run `npm test` before completion/);
    assert.match(body, /## Testing/);
    assert.match(body, /## Self-Improve Patch Notes/);
  } finally {
    await fixture.cleanup();
  }
});

test("agentic replace and delete edits apply bounded anchored patches", async () => {
  const fixture = await createFixture("inferoa-opt-agentic-ops-");
  try {
    const { store, workspace } = fixture;
    addVerifiedGoal(store, workspace);
    const skillDir = path.join(workspace.root, ".inferoa", "skills", "inferoa-workspace-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Inferoa Workspace Skill",
        "description: Existing learned workspace skill.",
        "---",
        "",
        "# Inferoa Workspace Skill",
        "",
        "## Testing",
        "",
        "- Keep unrelated regression coverage intact.",
        "- Old docs verifier command.",
        "- Remove stale reflection-only completion rule.",
        "",
      ].join("\n"),
      "utf8",
    );

    const proposal = await optLitePropose(store, workspace, {
      config: structuredClone(DEFAULT_CONFIG),
      optimizer: {
        async propose(packet): Promise<AgenticSkillProposalDraft> {
          const signal = packet.signals[0]!;
          return {
            edits: [
              {
                target: "workspace_skill",
                op: "replace",
                section: "Testing",
                anchor: "- Old docs verifier command.",
                content: "- When changing slug documentation, run `npm test` before completion.",
                rationale: "The cited verifier identifies npm test as the workspace command.",
                expected_behavior_change: "Docs tasks use the real command verifier.",
                eval_plan: "Run npm test after a slug docs update.",
                source_event_ids: [],
                source_signal_ids: [signal.signal_id],
              },
              {
                target: "workspace_skill",
                op: "delete",
                section: "Testing",
                anchor: "- Remove stale reflection-only completion rule.",
                content: "Delete the stale reflection-only completion rule.",
                rationale: "The cited verifier requires hard command evidence instead.",
                expected_behavior_change: "Completion no longer follows stale soft-only guidance.",
                eval_plan: "Replay rejects reflection-only completion.",
                source_event_ids: [],
                source_signal_ids: [signal.signal_id],
              },
            ],
            rejected_signals: [],
          };
        },
      },
    });

    const body = proposal.skill_targets?.find((target) => target.target === "workspace_skill")?.body ?? "";
    assert.match(body, /Keep unrelated regression coverage intact/);
    assert.match(body, /When changing slug documentation, run `npm test` before completion/);
    assert.doesNotMatch(body, /Old docs verifier command/);
    assert.doesNotMatch(body, /Remove stale reflection-only completion rule/);
    assert.match(body, /replace Testing/);
    assert.match(body, /delete Testing/);
  } finally {
    await fixture.cleanup();
  }
});

test("agentic replay marks edits cited only by reflection evidence as needs evidence", async () => {
  const fixture = await createFixture("inferoa-opt-agentic-needs-evidence-");
  try {
    const { store, workspace } = fixture;
    addReflectionOnlyGoal(store, workspace);
    addVerifiedGoal(store, workspace);

    const proposal = await optLitePropose(store, workspace, {
      config: structuredClone(DEFAULT_CONFIG),
      optimizer: {
        async propose(packet): Promise<AgenticSkillProposalDraft> {
          const softSignal = packet.signals.find((signal) => signal.tier === "T2") ?? packet.signals[0]!;
          return {
            edits: [
              {
                target: "loop_skill",
                op: "add",
                section: "completion",
                content: "When a reflection says docs look complete, mark the loop done immediately.",
                rationale: "This cites only the reflection signal and should not be accepted.",
                expected_behavior_change: "Reflection-only completion gets faster.",
                eval_plan: "No hard verifier.",
                source_event_ids: [],
                source_signal_ids: [softSignal.signal_id],
              },
            ],
            rejected_signals: [],
          };
        },
      },
    });
    assert.equal(proposal.proposal_source, "agentic");

    const replay = await optLiteReplay(store, workspace, proposal.id);

    assert.equal(replay.status, "rejected");
    assert.equal(replay.edit_verdicts?.[0]?.status, "needs_evidence");
    assert.match(replay.edit_verdicts?.[0]?.reason ?? "", /T2|hard evidence|soft/i);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(prefix: string): Promise<{
  dir: string;
  store: SessionStore;
  workspace: WorkspaceIdentity;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const store = await SessionStore.open(path.join(dir, "state"));
  const workspace: WorkspaceIdentity = { id: `w_${prefix.replace(/[^a-z0-9]/gi, "_")}`, root: dir, alias: prefix };
  return {
    dir,
    store,
    workspace,
    cleanup: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function addReflectionOnlyGoal(store: SessionStore, workspace: WorkspaceIdentity): ReturnType<SessionStore["createSession"]> {
  const session = store.createSession(workspace, "Reflection-only docs task");
  let goal = createGoalState({ objective: "Update README docs from reflection only" });
  writeGoalState(store, session.session_id, goal, "run_goal_soft");
  goal = completeGoalReflection(
    goal,
    {
      decision: "done",
      summary: "Looks complete from self-review.",
      verification_evidence: { self_check: true },
    },
    "run_reflect_soft",
  );
  writeGoalState(store, session.session_id, goal, "run_reflect_soft");
  store.appendEvent({
    session_id: session.session_id,
    run_id: "run_reflect_soft",
    type: "goal.reflection.completed",
    data: {
      goal_id: goal.goal.id,
      source_horizon_generation: 0,
      horizon_generation: 0,
      decision: "done",
      summary: goal.goal.last_reflection_summary,
      verification_evidence: goal.goal.verification_evidence,
    },
  });
  return session;
}

function addVerifiedGoal(store: SessionStore, workspace: WorkspaceIdentity): ReturnType<SessionStore["createSession"]> {
  const session = store.createSession(workspace, "Update slug docs and tests");
  let goal = createGoalState({ objective: "Update README docs for duplicate heading slug behavior" });
  writeGoalState(store, session.session_id, goal, "run_goal");
  goal = completeGoalReflection(
    goal,
    {
      decision: "done",
      summary: "Verified with npm test.",
      verification_evidence: { command: "npm test", status: "pass" },
    },
    "run_reflect",
  );
  writeGoalState(store, session.session_id, goal, "run_reflect");
  store.appendEvent({
    session_id: session.session_id,
    run_id: "run_reflect",
    type: "goal.reflection.completed",
    data: {
      goal_id: goal.goal.id,
      source_horizon_generation: 0,
      horizon_generation: 0,
      decision: "done",
      summary: goal.goal.last_reflection_summary,
      verification_evidence: goal.goal.verification_evidence,
    },
  });
  store.appendEvent({
    session_id: session.session_id,
    run_id: "run_command",
    type: "goal.verification.recorded",
    data: {
      verification_id: "verifier_slug_docs",
      provider: "command",
      verdict: "pass",
      confidence: "hard",
      goal_id: goal.goal.id,
      horizon_generation: 0,
      evidence: { command: "npm test", status: "pass" },
      summary: "npm test passed for slug docs task.",
    },
  });
  return session;
}
