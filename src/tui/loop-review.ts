import type { GoalRecord, GoalReviewDecision } from "../goals/state.js";
import { bgLine, fg256, padRight, truncateToWidth, visibleWidth } from "./ansi.js";
import { applyTextInputToken, createTextInputState, renderTextInputDisplay, type TextInputState } from "./text-input.js";

export interface LoopReviewInputState {
  phase: "choice" | "feedback";
  selectedIndex: number;
  feedback: TextInputState;
  decision?: Exclude<GoalReviewDecision, "approve">;
  notice?: string;
}

export interface LoopReviewInputResponse {
  decision: GoalReviewDecision;
  feedback?: string;
}

export interface LoopReviewInputResult {
  state: LoopReviewInputState;
  response?: LoopReviewInputResponse;
  cancelled?: boolean;
}

const LOOP_REVIEW_CHOICES: readonly {
  value: GoalReviewDecision;
  label: string;
  description: string;
}[] = [
  { value: "approve", label: "Approve", description: "apply the staged loop decision" },
  { value: "revise", label: "Adjust", description: "send feedback and ask the loop to re-plan" },
  { value: "reject", label: "Continue", description: "discard this decision and keep working" },
  { value: "block", label: "Block", description: "pause the loop with a blocker" },
];

export function createLoopReviewInputState(): LoopReviewInputState {
  return {
    phase: "choice",
    selectedIndex: 0,
    feedback: createTextInputState(),
  };
}

export function applyLoopReviewInputToken(state: LoopReviewInputState, key: string): LoopReviewInputResult {
  const next = normalizeLoopReviewInputState(state);
  if (key === "\u0003" || key === "\u001b") {
    return { state: next, cancelled: true };
  }
  if (next.phase === "feedback") {
    if (key === "\r" || key === "\n") {
      const feedback = next.feedback.value.trim();
      if (!feedback) {
        return { state: { ...next, notice: "feedback is required" } };
      }
      return {
        state: next,
        response: {
          decision: next.decision ?? "revise",
          feedback,
        },
      };
    }
    return {
      state: {
        ...next,
        feedback: applyTextInputToken(next.feedback, key),
        notice: undefined,
      },
    };
  }
  if (key === "\u001b[A" || key === "k") {
    return { state: { ...next, selectedIndex: (next.selectedIndex - 1 + LOOP_REVIEW_CHOICES.length) % LOOP_REVIEW_CHOICES.length } };
  }
  if (key === "\u001b[B" || key === "j") {
    return { state: { ...next, selectedIndex: (next.selectedIndex + 1) % LOOP_REVIEW_CHOICES.length } };
  }
  const numeric = Number.parseInt(key, 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= LOOP_REVIEW_CHOICES.length) {
    return responseOrFeedbackPhase(next, LOOP_REVIEW_CHOICES[numeric - 1]!.value);
  }
  if (key === "\r" || key === "\n") {
    return responseOrFeedbackPhase(next, LOOP_REVIEW_CHOICES[next.selectedIndex]!.value);
  }
  return { state: next };
}

export function renderLoopReviewPromptLines(goal: GoalRecord, state: LoopReviewInputState, width: number): string[] {
  const safeWidth = Math.max(40, width);
  const contentWidth = Math.max(16, safeWidth - 6);
  const pending = goal.pending_review_decision;
  const lines: string[] = [];
  const push = (text = "") => lines.push(bgLine(236, text, safeWidth));

  push(`  ${fg256(75, "▌")} ${fg256(39, "loop review")} ${fg256(244, "needs your decision")}`);
  push("");
  appendField(lines, "objective", goal.objective, contentWidth, safeWidth, 250, 39);
  if (pending) {
    appendField(lines, "decision", `${pending.action} from loop task ${pending.source_horizon_generation}`, contentWidth, safeWidth, 250, loopReviewDecisionColor(pending.action));
    if (pending.summary) {
      appendField(lines, "summary", pending.summary, contentWidth, safeWidth, 250, 39);
    }
    if (pending.blocker) {
      appendField(lines, "blocker", pending.blocker, contentWidth, safeWidth, 203, 203);
    }
    if (pending.verification_evidence) {
      appendField(lines, "evidence", compactLoopReviewEvidence(pending.verification_evidence), contentWidth, safeWidth, 244, 39);
    }
    if (pending.steps?.length) {
      push("");
      push(`  ${fg256(39, "Proposed next steps")}`);
      for (const step of pending.steps.slice(0, 4)) {
        appendWrapped(lines, `• ${step.id ? `${step.id} ` : ""}${step.title}${step.status ? ` · ${step.status}` : ""}`, contentWidth, safeWidth, 250, "    ");
      }
      if (pending.steps.length > 4) {
        push(`    ${fg256(244, `+${pending.steps.length - 4} more`)}`);
      }
    }
  }
  push("");
  if (state.phase === "feedback") {
    renderFeedbackPhase(lines, state, contentWidth, safeWidth);
  } else {
    renderChoicePhase(lines, state, safeWidth);
  }
  return lines;
}

function responseOrFeedbackPhase(state: LoopReviewInputState, decision: GoalReviewDecision): LoopReviewInputResult {
  if (decision === "approve") {
    return { state, response: { decision } };
  }
  return {
    state: {
      ...state,
      phase: "feedback",
      decision,
      feedback: createTextInputState(),
      notice: undefined,
    },
  };
}

function normalizeLoopReviewInputState(state: LoopReviewInputState): LoopReviewInputState {
  return {
    ...state,
    selectedIndex: Math.max(0, Math.min(state.selectedIndex, LOOP_REVIEW_CHOICES.length - 1)),
  };
}

function renderChoicePhase(lines: string[], state: LoopReviewInputState, width: number): void {
  lines.push(bgLine(236, `  ${fg256(39, "Decision")}`, width));
  LOOP_REVIEW_CHOICES.forEach((choice, index) => {
    const active = index === state.selectedIndex;
    const marker = active ? fg256(75, "›") : fg256(244, " ");
    const hotkey = active ? fg256(75, `[${index + 1}]`) : fg256(244, `[${index + 1}]`);
    const label = active ? fg256(252, choice.label) : fg256(250, choice.label);
    lines.push(bgLine(236, `  ${marker} ${hotkey} ${padRight(label, 10)} ${fg256(244, choice.description)}`, width));
  });
  lines.push(bgLine(236, "", width));
  lines.push(bgLine(236, `  ${fg256(244, "↑/↓ choose · enter select · number select · esc cancel")}`, width));
}

function renderFeedbackPhase(lines: string[], state: LoopReviewInputState, contentWidth: number, width: number): void {
  const display = renderTextInputDisplay(state.feedback, Math.max(8, contentWidth - 4));
  const cursor = fg256(75, "▌");
  const label = state.decision === "block" ? "Block reason" : "Feedback";
  lines.push(bgLine(236, `  ${fg256(39, label)} ${fg256(244, loopReviewFeedbackHint(state.decision ?? "revise"))}`, width));
  lines.push(bgLine(236, `  ${fg256(75, "›")} ${display.beforeCursor}${cursor}${display.afterCursor}${state.feedback.value ? "" : ` ${fg256(238, "type feedback")}`}`, width));
  if (state.notice) {
    lines.push(bgLine(236, `  ${fg256(203, state.notice)}`, width));
  }
  lines.push(bgLine(236, "", width));
  lines.push(bgLine(236, `  ${fg256(244, "enter submit · esc cancel")}`, width));
}

function loopReviewFeedbackHint(decision: GoalReviewDecision): string {
  switch (decision) {
    case "block":
      return "required";
    case "reject":
      return "optional direction for continuing";
    case "revise":
      return "what should change before continuing";
    case "approve":
      return "";
  }
}

function appendField(lines: string[], label: string, value: string, contentWidth: number, width: number, valueColor: number, labelColor: number): void {
  const chunks = wrapLoopReviewText(value, Math.max(12, contentWidth - 10));
  chunks.forEach((chunk, index) => {
    const prefix = index === 0 ? `${fg256(labelColor, padRight(label, 9))} ` : `${" ".repeat(10)}`;
    lines.push(bgLine(236, `  ${prefix}${fg256(valueColor, chunk)}`, width));
  });
}

function loopReviewDecisionColor(action: string): number {
  if (action === "blocked" || action === "block") {
    return 203;
  }
  if (action === "done") {
    return 48;
  }
  if (action === "expand") {
    return 75;
  }
  return 244;
}

function appendWrapped(lines: string[], text: string, contentWidth: number, width: number, color: number, indent = "  "): void {
  for (const chunk of wrapLoopReviewText(text, Math.max(12, contentWidth - visibleWidth(indent)))) {
    lines.push(bgLine(236, `${indent}${fg256(color, chunk)}`, width));
  }
}

function wrapLoopReviewText(text: string, width: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [""];
  }
  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
    }
    current = visibleWidth(word) > width ? truncateToWidth(word, width) : word;
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

function compactLoopReviewEvidence(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return String(value);
  }
  return Object.entries(value as Record<string, unknown>)
    .slice(0, 6)
    .map(([key, item]) => `${key}=${compactLoopReviewEvidenceValue(item)}`)
    .join(" · ");
}

function compactLoopReviewEvidenceValue(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return truncateToWidth(value.replace(/\s+/g, " ").trim(), 48);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }
  if (typeof value === "object") {
    return "{...}";
  }
  return String(value);
}
