export type LoopRoadmapStatus = "implemented" | "partially_implemented" | "future_product_work";

export interface LoopRoadmapCapability {
  id: string;
  name: string;
  status: LoopRoadmapStatus;
  current_state: string;
  roadmap_position: string;
  evidence: string[];
}

export interface LoopRoadmapReport {
  generated_at: string;
  closure_status: "goal_native_closure_implemented";
  full_product_model_status: "partially_implemented";
  scope_note: string;
  summary: {
    implemented: number;
    partially_implemented: number;
    future_product_work: number;
  };
  capabilities: LoopRoadmapCapability[];
  current_closure: string[];
  future_product_extensions: string[];
  guardrails: string[];
  recommended_priority: string[];
}

const capabilities: LoopRoadmapCapability[] = [
  {
    id: "recursive-goal-loop",
    name: "Recursive goal loop",
    status: "implemented",
    current_state: "Goal supervisor, horizons, task/research kind, HIL review policy, and completion gates are native product surfaces.",
    roadmap_position: "Current closure implemented",
    evidence: ["goal state", "goal supervisor", "GoalLoopView", "goal panel"],
  },
  {
    id: "memory-spine",
    name: "Memory spine",
    status: "implemented",
    current_state: "Session events/resources, model step ids, goal projection, horizon projection, evidence report, inbox projection, verification records, learning signals, and skill snapshots are durable.",
    roadmap_position: "Current closure implemented; internal query/report projections can stay available without becoming public product concepts",
    evidence: ["SessionStore", "GoalLoopView", "loop evidence", "LoopInbox", "loop trace", "loop metrics"],
  },
  {
    id: "verification",
    name: "Verification",
    status: "implemented",
    current_state: "Reflection, research metrics, human review, checker runs, command verifier policy, internal verifier helpers for GitHub/npm/git/http facts, and unattended completion gates exist.",
    roadmap_position: "Current closure implemented; add verifier helpers only for real workflow evidence gaps",
    evidence: ["goal.verification.recorded", "inferoa verify", "GitHub workflow run status verifier", "GitHub deployment status verifier", "GitHub release status verifier", "npm package status verifier", "git-clean verifier", "loop metrics"],
  },
  {
    id: "human-review",
    name: "Human review",
    status: "implemented",
    current_state: "Goal HIL policy, pending review decisions, foreground between-run review prompts, resolution commands, daemon pause surfacing, and human verification records exist.",
    roadmap_position: "Current closure implemented",
    evidence: ["GoalRecord.hil_policy", "goal review prompt", "goal review", "LoopInbox goal_review", "human verification records"],
  },
  {
    id: "skills",
    name: "Skills",
    status: "implemented",
    current_state: "Skill registry, explicit read/enable, goal-associated snapshots, staged/adopted Loop Skill and Workspace Skill events, learned skill adoption, and skill policy projection exist.",
    roadmap_position: "Current closure implemented",
    evidence: ["SkillRegistry", "skill.snapshot.created", "skill.proposal.staged", "skill.proposal.adopted", "inferoa self-improve adopt", "loop policy skill_policy"],
  },
  {
    id: "self-improve-learning",
    name: "Self-improve and learning",
    status: "partially_implemented",
    current_state: "Self-improve status/learn/adopt uses verified loop evidence, learning signals, separate Loop Skill and Workspace Skill proposals, durable optimizer run metadata, durable self-improve events, structured replay gates, and adopt preview confirmation.",
    roadmap_position: "Target-split self-improve closure is partially implemented; skill body load/apply telemetry, impact measurement, live model-rerun replay, and broader training jobs remain future product work",
    evidence: ["goal.learning_signal.recorded", "skill.proposal.staged", "skill.proposal.adopted", "self_improve.replay.recorded", "inferoa self-improve learn", "inferoa self-improve adopt", "/self-improve"],
  },
  {
    id: "automation-heartbeat",
    name: "Automation and heartbeat",
    status: "implemented",
    current_state: "Daemon queue, recurring schedules, review-gated schedules, scheduled discovery, native discovery sources including label-filtered GitHub issue/PR discovery, GitHub draft release, Deployment, and npm package status discovery, inbox promotion, and stale-work surfacing exist.",
    roadmap_position: "Current closure implemented; add more discovery only for real sources",
    evidence: ["daemon jobs", "automation schedules", "discovery schedules", "GitHub issue/PR label filters", "LoopInbox", "loop health"],
  },
  {
    id: "work-isolation",
    name: "Work isolation",
    status: "implemented",
    current_state: "Managed worktree lifecycle, daemon binding, inbox promotion binding, adoption, cleanup, and health exist.",
    roadmap_position: "Current closure implemented",
    evidence: ["managed worktrees", "inferoa worktree", "worktree health", "worktree adoption"],
  },
  {
    id: "sub-agent-checker-split",
    name: "Sub-agents and checker split",
    status: "partially_implemented",
    current_state: "Independent checker runs, named verifier roles, synchronous multi-role suites, isolated background verifier queues, a model-facing subagent tool, internal job projection, and one-shot background checker orchestration exist.",
    roadmap_position: "The default loop controller remains reflection; sub-agents are delegated explicitly by the main agent during a horizon, and verifier runs are used only when stricter evidence is needed.",
    evidence: ["subagent tool", "inferoa verify", "verifier roles", "verification suites", "isolated verifier queue", "internal job projection", "loop.subagent.queued", "goal.verification.requested"],
  },
  {
    id: "triage-inbox",
    name: "Loop attention inbox",
    status: "implemented",
    current_state: "Inbox projection, minimal lifecycle, goal/review owner projection, stale work, external action approval surfacing, and promotion exist.",
    roadmap_position: "Current closure implemented; keep it as an attention queue rather than a manual triage system",
    evidence: ["LoopInbox", "inferoa inbox", "inbox promote", "external_action_approval"],
  },
  {
    id: "policy-unattended-safety",
    name: "Policy and unattended safety",
    status: "partially_implemented",
    current_state: "Unattended completion gate, one-shot checker, destructive shell denial, external mutation policy, GitHub and npm CLI mutation policies, blocked external mutation inbox approval, and isolation policies exist.",
    roadmap_position: "Additional deployment or release systems remain product-specific and must route through this policy before execution",
    evidence: ["PermissionPolicy", "external mutation policy", "npm CLI package publish policy", "loop policy", "LoopInbox external_action_approval"],
  },
  {
    id: "observability-cost",
    name: "Observability and cost",
    status: "implemented",
    current_state: "Tokenmaxxing, endpoint evidence, usage accounting, loop health, worktree health, and internal evidence/trace/metrics/action projections exist.",
    roadmap_position: "Current closure implemented; keep public observability small and leave detailed projections as internal/debug surfaces",
    evidence: ["loop health", "loop evidence", "loop trace", "loop metrics", "tokenmaxxing", "worktree health"],
  },
  {
    id: "hosted-dashboards",
    name: "Hosted dashboards",
    status: "future_product_work",
    current_state: "Hosted or graphical dashboards are intentionally out of scope. The current product should make /loop stronger and expose only small health/status surfaces by default.",
    roadmap_position: "Do not implement dashboard product work for this roadmap",
    evidence: ["loop health", "internal projections"],
  },
];

export function readLoopRoadmap(): LoopRoadmapReport {
  const summary = {
    implemented: capabilities.filter((item) => item.status === "implemented").length,
    partially_implemented: capabilities.filter((item) => item.status === "partially_implemented").length,
    future_product_work: capabilities.filter((item) => item.status === "future_product_work").length,
  };
  return {
    generated_at: new Date().toISOString(),
    closure_status: "goal_native_closure_implemented",
    full_product_model_status: "partially_implemented",
    scope_note: "The implemented status means the first goal-native loop closure is usable and tested; the broader loop-engineering product model is still partial.",
    summary,
    capabilities: capabilities.map((capability) => ({
      ...capability,
      evidence: [...capability.evidence],
    })),
    current_closure: [
      "Goal harness backbone",
      "Memory spine and evidence projection",
      "Human review boundary",
      "Skills as loop policy",
      "Automation and inbox",
      "Work isolation",
      "Checker split and verifier policy",
      "Sub-agent tool as a model-facing capability",
      "Self-improve and structured replay/gating",
    ],
    future_product_extensions: [
      "Richer multi-agent orchestration beyond the built-in sub-agent tool when broader workflows justify it",
      "Additional verification helpers for real deployment or staging surfaces beyond the current GitHub Deployment discovery/status and HTTP health slices",
      "External action request lifecycle if real deploy or release automation needs human approval plus system execution",
    ],
    guardrails: [
      "Do not add speculative scanners or integration surfaces just to satisfy a checklist.",
      "Do not infer ownership, verifier choice, or risk from natural-language prose.",
      "Do not auto-merge, publish, deploy, or mutate external systems without explicit configured policy.",
      "Keep opt explicit, staged, reviewable, and skill-focused.",
    ],
    recommended_priority: [
      "Memory spine",
      "Verification",
      "Skills",
      "Automation / heartbeat",
      "Work isolation",
      "Sub-agents / checker split",
      "Opt",
    ],
  };
}
