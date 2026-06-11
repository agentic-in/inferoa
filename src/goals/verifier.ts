import type { GoalRecord } from "./state.js";

export type GoalVerifierRole = "completion" | "implementation" | "tests" | "security" | "docs" | "research";

export interface GoalVerifierPromptOptions {
  rubric?: string;
  role?: GoalVerifierRole;
}

export interface ParsedGoalVerifierArgs {
  role: GoalVerifierRole;
  roles: GoalVerifierRole[];
  rubric?: string;
  background: boolean;
  isolation: "session" | "worktree";
}

interface GoalVerifierRoleSpec {
  label: string;
  focus: string[];
}

export const GOAL_VERIFIER_ROLES: Record<GoalVerifierRole, GoalVerifierRoleSpec> = {
  completion: {
    label: "completion checker",
    focus: [
      "Judge whether the bounded loop task is actually complete.",
      "Prioritize unmet requirements, missing evidence, hidden blockers, and overclaimed completion.",
    ],
  },
  implementation: {
    label: "implementation reviewer",
    focus: [
      "Inspect correctness, integration with existing code, regressions, maintainability, and local conventions.",
      "Treat missing tests or risky code paths as verification concerns.",
    ],
  },
  tests: {
    label: "test and verification reviewer",
    focus: [
      "Inspect whether the right tests, commands, metrics, or manual checks were run.",
      "Require concrete structured evidence before accepting completion.",
    ],
  },
  security: {
    label: "security reviewer",
    focus: [
      "Inspect security, privacy, credential handling, permissions, and unsafe unattended actions.",
      "Fail or block when risk evidence is missing for user-visible or cross-system changes.",
    ],
  },
  docs: {
    label: "documentation reviewer",
    focus: [
      "Inspect user-facing docs, help text, command discoverability, and naming consistency.",
      "Treat stale or misleading documentation as incomplete when it affects the bounded loop task.",
    ],
  },
  research: {
    label: "research verifier",
    focus: [
      "Inspect hypothesis, metric evidence, guardrails, run history, and whether conclusions follow from results.",
      "Prefer hard metric or harness evidence over narrative claims.",
    ],
  },
};

export function buildGoalVerificationPrompt(goal: GoalRecord, options: string | GoalVerifierPromptOptions = {}): string {
  const parsed = typeof options === "string" ? { rubric: options } : options;
  const role = parsed.role ?? "completion";
  const spec = GOAL_VERIFIER_ROLES[role];
  const lines = [
    "Run an independent verification pass for the active loop.",
    "",
    `Reviewer role: ${role} (${spec.label}).`,
    "You are the checker, not the maker. Inspect the current loop state, recent evidence, relevant files, diffs, commands, resources, and test results before deciding.",
    "Do not modify the loop task plan, mark steps, complete the loop, or edit files.",
    "Finish by calling goal op=verify exactly once with provider=checker.",
    "",
    `Loop: ${goal.objective}`,
    `Kind: ${goal.kind}`,
    `Loop task: ${goal.horizon_generation}`,
    "",
    "Use verdict=pass only if the current attempt satisfies the bounded loop task. Use partial when progress is real but incomplete, fail when evidence contradicts completion, blocked when an external decision or missing prerequisite prevents verification, and unknown when evidence is insufficient.",
    "Include summary, confidence, evidence or evidence_resource_uri, and failure_reason when relevant.",
    "",
    "Role focus:",
    ...spec.focus.map((item) => `- ${item}`),
  ];
  if (parsed.rubric?.trim()) {
    lines.push("", `Rubric: ${parsed.rubric.trim()}`);
  }
  return lines.join("\n");
}

export function parseGoalVerifierArgs(args: string[]): ParsedGoalVerifierArgs {
  let role: GoalVerifierRole = "completion";
  let roles: GoalVerifierRole[] | undefined;
  let background = false;
  let isolation: ParsedGoalVerifierArgs["isolation"] = "session";
  const rubric: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--role") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--role requires a value");
      }
      role = parseGoalVerifierRole(value);
      roles = undefined;
      index += 1;
      continue;
    }
    if (arg.startsWith("--role=")) {
      role = parseGoalVerifierRole(arg.slice("--role=".length));
      roles = undefined;
      continue;
    }
    if (arg === "--roles") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--roles requires a comma-separated value");
      }
      roles = parseGoalVerifierRoleList(value);
      role = roles[0] ?? role;
      index += 1;
      continue;
    }
    if (arg.startsWith("--roles=")) {
      roles = parseGoalVerifierRoleList(arg.slice("--roles=".length));
      role = roles[0] ?? role;
      continue;
    }
    if (arg === "--background") {
      background = true;
      continue;
    }
    if (arg === "--worktree") {
      background = true;
      isolation = "worktree";
      continue;
    }
    if (arg === "--session") {
      background = true;
      isolation = "session";
      continue;
    }
    rubric.push(arg);
  }
  const selectedRoles = uniqueGoalVerifierRoles(roles ?? [role]);
  return {
    role: selectedRoles[0] ?? "completion",
    roles: selectedRoles,
    rubric: rubric.join(" ").trim() || undefined,
    background,
    isolation,
  };
}

export function parseGoalVerifierRole(value: string): GoalVerifierRole {
  if (isGoalVerifierRole(value)) {
    return value;
  }
  throw new Error(`Unknown verifier role "${value}". Expected one of: ${Object.keys(GOAL_VERIFIER_ROLES).join(", ")}`);
}

export function isGoalVerifierRole(value: string): value is GoalVerifierRole {
  return Object.prototype.hasOwnProperty.call(GOAL_VERIFIER_ROLES, value);
}

function parseGoalVerifierRoleList(value: string): GoalVerifierRole[] {
  const roles = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseGoalVerifierRole);
  if (!roles.length) {
    throw new Error("--roles requires at least one verifier role");
  }
  return uniqueGoalVerifierRoles(roles);
}

function uniqueGoalVerifierRoles(roles: GoalVerifierRole[]): GoalVerifierRole[] {
  const seen = new Set<GoalVerifierRole>();
  const output: GoalVerifierRole[] = [];
  for (const role of roles) {
    if (!seen.has(role)) {
      seen.add(role);
      output.push(role);
    }
  }
  return output;
}
