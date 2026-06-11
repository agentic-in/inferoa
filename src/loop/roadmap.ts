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
    current_state: "Reflection, research metrics, human review, checker runs, command verifier policy, connector verifiers including GitHub workflow latest-run status, deployment status, release status, npm package status, local Git clean-state verification, and unattended completion gates exist.",
    roadmap_position: "Current closure implemented; add connector-specific verifiers only for real workflows",
    evidence: ["goal.verification.recorded", "inferoa verify", "connector verifier registry", "GitHub workflow run status verifier", "GitHub deployment status verifier", "GitHub release status verifier", "npm package status verifier", "git-clean verifier", "loop metrics"],
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
    current_state: "Skill registry, explicit read/enable, goal-associated snapshots, staged/adopted learned workspace skill events, learned workspace skill adoption, and skill policy projection exist.",
    roadmap_position: "Current closure implemented",
    evidence: ["SkillRegistry", "skill.snapshot.created", "skill.proposal.staged", "skill.proposal.adopted", "inferoa self-improve adopt", "loop policy skill_policy"],
  },
  {
    id: "self-improve-learning",
    name: "Self-improve and learning",
    status: "partially_implemented",
    current_state: "Self-improve status/propose/run --replay/report/replay/adopt uses verified loop evidence, learning signals, staged skill proposals, durable self-improve events, and structured replay gates.",
    roadmap_position: "Current self-improve closure implemented; live model-rerun replay and broader training jobs remain optional future product work",
    evidence: ["goal.learning_signal.recorded", "skill.proposal.staged", "skill.proposal.adopted", "self_improve.replay.recorded", "inferoa self-improve propose", "inferoa self-improve run --replay", "inferoa self-improve report", "inferoa self-improve adopt", "/self-improve"],
  },
  {
    id: "automation-heartbeat",
    name: "Automation and heartbeat",
    status: "implemented",
    current_state: "Daemon queue, recurring schedules, review-gated schedules, scheduled discovery, native discovery sources including label-filtered GitHub issue/PR discovery, GitHub draft release, Deployment, and npm package status discovery, inbox promotion, and stale-work surfacing exist.",
    roadmap_position: "Current closure implemented; add more connector-specific discovery only for real sources",
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
    id: "connectors-plugins",
    name: "Connectors and plugins",
    status: "partially_implemented",
    current_state: "GitHub, local Git, HTTP, and npm have native discovery/verification/safety slices where real workflows exist. Connector catalogs, connector-specific verifiers, and dry-run-gated action runners are internal harness capabilities, not the default user-facing loop model.",
    roadmap_position: "Keep connector work workflow-driven; productize additional real loop surfaces only where useful",
    evidence: ["GitHub discovery", "GitHub issue/PR label-filtered discovery", "GitHub draft release discovery", "GitHub Deployment discovery", "npm package status discovery", "GitHub connector verifiers", "GitHub workflow run status verifier", "GitHub deployment status verifier", "GitHub release status verifier", "GitHub action runners", "npm package status verifier", "npm package publish action runner", "local git changes discovery", "git-clean verifier", "HTTP health discovery", "HTTP health verifier"],
  },
  {
    id: "triage-inbox",
    name: "Triage inbox",
    status: "implemented",
    current_state: "Inbox projection, lifecycle, assignment, filters, route rules, goal/review owner projection, mute policy, stale work, and promotion exist.",
    roadmap_position: "Current closure implemented; broader ownership automation only if usage needs it",
    evidence: ["LoopInbox", "inferoa inbox", "inbox routes", "inbox mute", "inbox promote"],
  },
  {
    id: "policy-unattended-safety",
    name: "Policy and unattended safety",
    status: "partially_implemented",
    current_state: "Unattended completion gate, one-shot checker, destructive shell denial, connector action policy registry, GitHub and npm CLI mutation policies, internal connector action preflight/run/audit paths, blocked action inbox review, and isolation policies exist.",
    roadmap_position: "Additional deployment systems, richer deployment probes, and mutating connector tools remain product-specific and must route through this policy before execution",
    evidence: ["PermissionPolicy", "connector action policy registry", "npm CLI package publish policy", "internal connector action preflight", "internal connector action audit", "loop policy", "LoopInbox action_review"],
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
      "Broader connectors/plugins for real product systems beyond the native catalog",
      "Richer multi-agent orchestration beyond the built-in sub-agent tool when broader workflows justify it",
      "Additional connector-specific verification for real deployment or staging surfaces beyond the current GitHub Deployment discovery/status and HTTP health slices",
      "Broader ownership automation if explicit assignment, routes, and mute are not enough",
      "Additional mutating connector tools beyond the current dry-run-gated action runners for broader deploy or release automation flows when real product workflows justify them",
    ],
    guardrails: [
      "Do not add speculative scanners or connectors just to satisfy a checklist.",
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
      "Connectors / plugins",
      "Opt",
    ],
  };
}
