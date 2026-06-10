import type { JsonObject, SessionEvent } from "../types.js";
import { fg256, padRight, stripAnsi, terminalWidth, truncateToWidth, visibleWidth } from "./ansi.js";
import { formatDuration } from "./cache-footer.js";

type TodoStatus = "done" | "in_progress" | "pending" | "blocked";

interface TodoCounts {
  done: number;
  in_progress: number;
  pending: number;
  blocked: number;
}

export function renderTodoEventLines(events: SessionEvent[], width = terminalWidth()): string[] {
  if (events.length === 0) {
    return ["No matching events."];
  }

  const latest = events.at(-1)!;
  const todos = arrayObjects(latest.data.items);
  const counts = countTodos(todos);
  const lines = [
    `${fg256(39, "snapshot")} ${timestampLabel(latest.created_at)} · ${todoCountLabel(counts)}`,
  ];

  if (todos.length === 0) {
    lines.push(fg256(244, "No todo items."));
    return clipLines(lines, width);
  }

  const preview = todos.slice(0, 14);
  preview.forEach((todo, index) => {
    const status = normalizedTodoStatus(todo);
    const title = stringField(todo.content) ?? stringField(todo.title) ?? stringField(todo.id) ?? "untitled";
    lines.push(`${fg256(244, String(index + 1).padStart(2, "0"))} ${todoMarker(status)} ${todoStatusLabel(status)} ${title}`);
  });

  const hidden = todos.length - preview.length;
  if (hidden > 0) {
    lines.push(`${fg256(244, "...")} ${hidden} more`);
  }

  return clipLines(lines, width);
}

export function renderSessionActivityLines(events: SessionEvent[], width = terminalWidth()): string[] {
  if (events.length === 0) {
    return ["No matching events."];
  }

  const lines = events
    .slice(-10)
    .flatMap((event) => renderActivityEvent(event))
    .slice(-18);
  return fitActivityLines(lines.length ? lines : ["No matching events."], width);
}

export function renderEvidenceEventLines(events: SessionEvent[], width = terminalWidth()): string[] {
  return renderSessionActivityLines(events, width);
}

export function renderCompactEventLine(event: SessionEvent, width = terminalWidth()): string {
  if (event.type === "todo.updated") {
    const counts = countTodos(arrayObjects(event.data.items));
    return clipLines([`${fg256(244, timestampLabel(event.created_at))} · ${fg256(39, "todo")} updated · ${todoCountLabel(counts)}`], width)[0] ?? "";
  }
  return clipLines([renderActivityEvent(event)[0] ?? ""], width)[0] ?? "";
}

function renderActivityEvent(event: SessionEvent): string[] {
  const stamp = fg256(244, timestampLabel(event.created_at));
  const data = event.data;

  switch (event.type) {
    case "evidence.step.completed": {
      const stepId = stringField(data.step_id) ?? "unknown";
      const evidence = objectField(data.evidence);
      const summary = keyValueSummary(evidence, 5);
      return [`${stamp} · ${fg256(39, "step")} ${stepId}${summary ? ` · ${summary}` : ""}`];
    }
    case "evidence.context_compression": {
      const reason = labeled("reason", data.reason);
      const headline = `${stamp} · ${fg256(39, "context")} compacted${reason ? ` · ${reason}` : ""}`;
      const detail = [
        labeled("tokens", tokenPair(data.estimated_tokens, data.threshold_tokens)),
        labeled("archived", data.archived_events),
        labeled("protected", protectedCompressionLabel(data.protected_tail_events, protectedPromptCount(data))),
        labeled("epoch", data.epoch_id),
      ].filter(Boolean);
      return [headline, ...(detail.length ? [`${fg256(244, "  ")}${detail.join(" · ")}`] : [])];
    }
    case "resource.created": {
      const kind = compactValue(data.kind) || "resource";
      const bytes = byteLabel(data.bytes);
      return [`${stamp} · ${fg256(39, "saved")} ${kind}${bytes ? ` · ${bytes}` : ""}`];
    }
    case "endpoint.evidence.recorded": {
      const headline = [
        `${stamp} · ${fg256(39, "model turn")}`,
        compactValue(data.mode),
        compactValue(data.request_class),
        compactInlineString(data.model, 42),
      ].filter(Boolean).join(" · ");
      const details = [
        promptTokenLabel(data.prompt_tokens),
        cachedTokenLabel(data.cached_prompt_tokens),
        prefixCacheLabel(data.cache_hit_rate),
        labeled("epoch", data.prompt_epoch_id),
      ].filter(Boolean);
      return [headline, ...(details.length ? [`${fg256(244, "  ")}${details.join(" · ")}`] : [])];
    }
    case "goal.completion_report": {
      const durationMs = numberField(data.duration_ms);
      const parts = [
        labeled("loops", data.tool_rounds),
        labeled("tools", data.tool_calls),
        labeled("horizons", data.horizons ?? data.horizon_count),
        durationMs !== undefined ? `${fg256(39, "time")} ${formatDuration(durationMs)}` : "",
        labeled("tokens", data.tokens),
      ].filter(Boolean);
      const detail = [
        labeled("objective", compactInlineString(data.goal_objective, 96)),
        labeled("summary", data.completion_summary),
      ].filter(Boolean);
      const report = labeled("report", compactInlineString(data.report, 160));
      return [
        `${stamp} · ${fg256(39, "goal")} complete${parts.length ? ` · ${parts.join(" · ")}` : ""}`,
        detail.length ? `${fg256(244, "  ")}${detail.join(" · ")}` : undefined,
        report ? `${fg256(244, "  ")}${report}` : undefined,
      ].filter((line): line is string => Boolean(line));
    }
    case "goal.horizon.expanded": {
      const parts = [
        labeled("horizon", data.horizon_generation),
        labeled("previous", data.previous_horizon_generation),
        labeled("steps", data.step_count),
        labeled("active", data.active_step_id),
      ].filter(Boolean);
      return [`${stamp} · ${fg256(39, "goal horizon started")}${parts.length ? ` · ${parts.join(" · ")}` : ""}`];
    }
    case "run.completed":
    case "run.stopped":
    case "run.failed":
      return [renderRunLifecycleEvent(event, stamp)];
    default: {
      const summary = keyValueSummary(data, 6);
      return [`${stamp} · ${fg256(39, event.type)}${summary ? ` · ${summary}` : ""}`];
    }
  }
}

function promptTokenLabel(value: unknown): string {
  const tokens = numberField(value);
  return tokens === undefined ? "" : `${fg256(39, "tokens")} ${tokens} prompt`;
}

function cachedTokenLabel(value: unknown): string {
  const tokens = numberField(value);
  return tokens === undefined ? "" : `${tokens} cached`;
}

function prefixCacheLabel(value: unknown): string {
  const percent = percentLabel(value);
  return percent ? `${fg256(39, "prefix cache")} ${percent}` : "";
}

function renderRunLifecycleEvent(event: SessionEvent, stamp: string): string {
  const data = event.data;
  const durationMs = numberField(data.duration_ms);
  const parts = [
    event.type === "run.stopped" ? labeled("reason", runStopReason(data.reason)) : "",
    event.type === "run.failed" ? labeled("error", data.error) : "",
    labeled("loops", data.tool_rounds),
    labeled("tools", data.tool_calls),
    durationMs !== undefined ? `${fg256(39, "time")} ${formatDuration(durationMs)}` : "",
    labeled("tokens", data.tokens),
    rtkSavedLabel(data.rtk),
  ].filter(Boolean);
  return `${stamp} · ${fg256(39, "run")} ${runLifecycleLabel(event.type)}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

function rtkSavedLabel(value: unknown): string {
  const rtk = objectField(value);
  const saved = numberField(rtk.saved_tokens);
  return saved === undefined || saved <= 0 ? "" : `${fg256(39, "rtk saved")} ${saved}`;
}

function runLifecycleLabel(type: string): string {
  switch (type) {
    case "run.completed":
      return "complete";
    case "run.stopped":
      return "stopped";
    case "run.failed":
      return "failed";
    default:
      return type;
  }
}

function runStopReason(value: unknown): string | undefined {
  const reason = stringField(value);
  if (!reason) {
    return undefined;
  }
  const readable = reason.replaceAll("_", " ");
  if (readable === "max tool rounds") {
    return "tool-round limit";
  }
  return readable;
}

function countTodos(todos: JsonObject[]): TodoCounts {
  return todos.reduce<TodoCounts>(
    (counts, todo) => {
      counts[normalizedTodoStatus(todo)] += 1;
      return counts;
    },
    { done: 0, in_progress: 0, pending: 0, blocked: 0 },
  );
}

function todoCountLabel(counts: TodoCounts): string {
  const parts = [
    `${counts.done} done`,
    `${counts.in_progress} active`,
    `${counts.pending} queued`,
  ];
  if (counts.blocked > 0) {
    parts.push(`${counts.blocked} blocked`);
  }
  return parts.join(" · ");
}

function normalizedTodoStatus(todo: JsonObject): TodoStatus {
  const status = (stringField(todo.status) ?? stringField(todo.state) ?? "pending").toLowerCase();
  if (status === "done" || status === "completed" || status === "complete") {
    return "done";
  }
  if (status === "in_progress" || status === "active" || status === "running") {
    return "in_progress";
  }
  if (status === "blocked" || status === "failed") {
    return "blocked";
  }
  return "pending";
}

function todoMarker(status: TodoStatus): string {
  switch (status) {
    case "done":
      return fg256(48, "■");
    case "in_progress":
      return fg256(75, "▶");
    case "blocked":
      return fg256(203, "!");
    case "pending":
      return fg256(244, "□");
  }
}

function todoStatusLabel(status: TodoStatus): string {
  switch (status) {
    case "done":
      return fg256(48, padRight("done", 9));
    case "in_progress":
      return fg256(75, padRight("active", 9));
    case "blocked":
      return fg256(203, padRight("blocked", 9));
    case "pending":
      return fg256(244, padRight("queued", 9));
  }
}

function keyValueSummary(data: JsonObject, limit: number): string {
  return Object.entries(data)
    .slice(0, limit)
    .map(([key, value]) => labeled(key, value))
    .filter(Boolean)
    .join(" · ");
}

function labeled(label: string, value: unknown): string {
  const text = compactValue(value);
  return text ? `${fg256(39, label)} ${text}` : "";
}

function compactValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(compactValue).filter(Boolean).slice(0, 6).join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 4)
      .map(([key, item]) => `${key}=${compactValue(item)}`)
      .filter((item) => !item.endsWith("="))
      .join(" · ");
  }
  return String(value);
}

function compactInlineString(value: unknown, maxWidth: number): string {
  const text = stringField(value)?.replace(/\s+/g, " ").trim();
  return text ? truncateToWidth(text, maxWidth) : "";
}

function tokenPair(primary: unknown, secondary: unknown, secondaryLabel = "threshold"): string {
  const left = numberField(primary);
  const right = numberField(secondary);
  if (left === undefined && right === undefined) {
    return "";
  }
  if (left !== undefined && right !== undefined) {
    return `${left}/${right}${secondaryLabel === "threshold" ? "" : ` ${secondaryLabel}`}`;
  }
  if (left !== undefined) {
    return String(left);
  }
  return `${right} ${secondaryLabel}`;
}

function protectedCompressionLabel(tailEvents: unknown, promptCount: unknown): string {
  const tail = numberField(tailEvents);
  const prompts = numberField(promptCount);
  if (tail === undefined && prompts === undefined) {
    return "";
  }
  if (tail !== undefined && prompts !== undefined) {
    return `${tail} tail / ${prompts} prompts`;
  }
  if (tail !== undefined) {
    return `${tail} tail`;
  }
  return `${prompts} prompts`;
}

function protectedPromptCount(data: JsonObject): number | undefined {
  const explicit = numberField(data.protected_prompt_count);
  if (explicit !== undefined) {
    return explicit;
  }
  return Array.isArray(data.protected_user_prompts) ? data.protected_user_prompts.length : undefined;
}

function byteLabel(value: unknown): string {
  const bytes = numberField(value);
  if (bytes === undefined) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function percentLabel(value: unknown): string {
  const rate = numberField(value);
  if (rate === undefined) {
    return "";
  }
  return `${(Math.max(0, Math.min(1, rate)) * 100).toFixed(1)}%`;
}

function clipLines(lines: string[], width: number): string[] {
  return lines.map((line) => truncateToWidth(line, Math.max(20, width)));
}

function fitActivityLines(lines: string[], width: number): string[] {
  const safeWidth = Math.max(20, width);
  return lines.flatMap((line) => {
    if (visibleWidth(line) <= safeWidth) {
      return [line];
    }
    return wrapPlainLine(stripAnsi(line), safeWidth);
  });
}

function wrapPlainLine(line: string, width: number): string[] {
  const chunks: string[] = [];
  let rest = line;
  while (visibleWidth(rest) > width) {
    const end = fittingEnd(rest, width);
    const preferred = preferredWrapEnd(rest, end, width);
    chunks.push(rest.slice(0, preferred).trimEnd());
    rest = `  ${rest.slice(preferred).trimStart()}`;
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks;
}

function fittingEnd(text: string, width: number): number {
  let count = 0;
  let end = 0;
  for (const char of text) {
    const next = count + visibleWidth(char);
    if (next > width) {
      break;
    }
    count = next;
    end += char.length;
  }
  return Math.max(1, end);
}

function preferredWrapEnd(text: string, hardEnd: number, width: number): number {
  const candidate = text.slice(0, hardEnd);
  const minWidth = Math.max(8, Math.floor(width * 0.45));
  let whitespaceEnd = 0;
  let separatorEnd = 0;
  for (let index = 0; index < candidate.length;) {
    const char = [...candidate.slice(index)][0] ?? "";
    if (!char) {
      break;
    }
    const nextIndex = index + char.length;
    const beforeWidth = visibleWidth(candidate.slice(0, index));
    if (beforeWidth >= minWidth && /\s/.test(char)) {
      whitespaceEnd = index;
    }
    if (beforeWidth >= minWidth && /[·/._?&=-]/.test(char)) {
      separatorEnd = nextIndex;
    }
    index = nextIndex;
  }
  return whitespaceEnd || separatorEnd || hardEnd;
}

function timestampLabel(value?: string): string {
  if (!value) {
    return "recent";
  }
  return value.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function arrayObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function objectField(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
