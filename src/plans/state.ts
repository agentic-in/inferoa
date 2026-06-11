import type { JsonObject, SessionEvent } from "../types.js";
import { SessionStore } from "../session/store.js";
import { randomId } from "../util/hash.js";
import { escapeXmlText } from "../goals/state.js";
import { truncateText } from "../util/limit.js";

export type PlanStatus = "drafting" | "paused" | "approved" | "dropped";

const PLAN_PROMPT_BODY_LIMIT = 6000;

export interface PlanRecord {
  id: string;
  objective: string;
  status: PlanStatus;
  body?: string;
  summary?: string;
  created_at: string;
  updated_at: string;
}

export interface PlanState {
  enabled: boolean;
  plan: PlanRecord;
}

export interface PlanCreateInput {
  objective: string;
  body?: string;
}

export function readPlanState(store: SessionStore, sessionId: string): PlanState | undefined {
  const event = store.latestEventOfTypes(sessionId, ["plan.updated"]);
  if (!event) {
    return undefined;
  }
  return parsePlanState(event.data);
}

export function createPlanState(input: PlanCreateInput, now = new Date()): PlanState {
  const objective = input.objective.trim();
  if (!objective) {
    throw new Error("objective is required");
  }
  const timestamp = now.toISOString();
  return {
    enabled: true,
    plan: {
      id: randomId("plan"),
      objective,
      status: "drafting",
      body: cleanOptionalString(input.body),
      created_at: timestamp,
      updated_at: timestamp,
    },
  };
}

export function writePlanState(store: SessionStore, sessionId: string, state: PlanState, runId?: string): PlanState {
  const cloned = clonePlanState(state);
  store.appendEvent({
    session_id: sessionId,
    run_id: runId,
    type: "plan.updated",
    data: planStateToJson(cloned),
  });
  return cloned;
}

export function planStateToJson(state: PlanState): JsonObject {
  return {
    enabled: state.enabled,
    plan: state.plan as unknown as JsonObject,
  };
}

export function clonePlanState(state: PlanState): PlanState {
  return {
    enabled: state.enabled,
    plan: { ...state.plan },
  };
}

export function renderPlanModeSection(state: PlanState | undefined): string | undefined {
  if (!state?.enabled || state.plan.status !== "drafting") {
    return undefined;
  }
  const plan = state.plan;
  return [
    "Plan mode is active for this session.",
    renderTrustedPlanObjective(plan.objective),
    "status: drafting",
    "An active draft plan already exists; use plan get/update for it. Do not call plan create again unless no active plan exists.",
    "Planning is governed by instructions, not runtime tool blocking: prefer inspection and analysis while drafting.",
    "Do not edit files, change configuration, run destructive commands, start long-running mutating processes, or commit changes while drafting unless the user explicitly asks for that specific action before approval.",
    "If a command or tool may mutate state, explain why it is needed first; otherwise gather evidence with low-risk inspection.",
    "Keep the plan self-contained: requirements, decisions, files to modify, and verification.",
    "Ask clarifying questions early when requirements, constraints, risk tolerance, scope, tradeoffs, or execution preferences are unclear. For non-trivial plans, prefer at least one concise clarify question unless the user already gave exact constraints.",
    "Before asking for approval, make sure known open questions are resolved; if any remain, ask clarify instead of finalizing.",
    "Use the plan tool with op=update as findings change. When the proposed plan is ready, call plan approve immediately to ask the user to implement it or type revision feedback before any execution tools run.",
    "If approval is declined with feedback, revise the plan with op=update and ask for approval again.",
    plan.summary ? `Current summary: ${escapeXmlText(plan.summary)}` : undefined,
    plan.body?.trim() ? `Current plan:\n${escapeXmlText(truncateText(plan.body.trim(), PLAN_PROMPT_BODY_LIMIT).text)}` : "Current plan: not written yet",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function planApprovalBlockMessage(state: PlanState): string | undefined {
  if (!state.plan.body?.trim()) {
    return "Plan approval requires a written plan body. Continue planning, update the plan body, then approve.";
  }
  return undefined;
}

export function renderTrustedPlanObjective(objective: string): string {
  return `<objective>\n${escapeXmlText(objective)}\n</objective>`;
}

function latestPlanEvent(events: SessionEvent[]): SessionEvent | undefined {
  return events.filter((event) => event.type === "plan.updated").at(-1);
}

function parsePlanState(data: JsonObject): PlanState | undefined {
  const plan = data.plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return undefined;
  }
  const candidate = plan as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const objective = typeof candidate.objective === "string" ? candidate.objective : "";
  const status = parsePlanStatus(candidate.status);
  if (!id || !objective || !status) {
    return undefined;
  }
  return {
    enabled: data.enabled === true,
    plan: {
      id,
      objective,
      status,
      body: cleanOptionalString(candidate.body),
      summary: cleanOptionalString(candidate.summary),
      created_at: typeof candidate.created_at === "string" ? candidate.created_at : "",
      updated_at: typeof candidate.updated_at === "string" ? candidate.updated_at : "",
    },
  };
}

function parsePlanStatus(value: unknown): PlanStatus | undefined {
  return value === "drafting" || value === "paused" || value === "approved" || value === "dropped" ? value : undefined;
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
