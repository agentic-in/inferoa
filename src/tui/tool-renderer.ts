import type { JsonObject, SessionEvent, ToolResult } from "../types.js";
import type { SessionStore } from "../session/store.js";
import { ansi, fg256, padRight, terminalWidth, truncateToWidth, visibleWidth } from "./ansi.js";
import { renderPlanDocumentSurface } from "./plan-view.js";

interface ToolEventGroup {
  id: string;
  name: string;
  args: JsonObject;
  result?: ToolResult;
}

interface RenderedToolGroup {
  group: ToolEventGroup;
  lines: string[];
  compact: boolean;
}

export interface ToolRenderOptions {
  collapseCompact?: boolean;
}

const COMPACT_TOOL_FOLD_THRESHOLD = 5;
const HIDDEN_FAILED_TOOL_TRACE_TOOLS = new Set(["read_file", "read_resource", "write_file"]);
const COMPACT_SUCCESS_TOOLS = new Set([
  "list_dir",
  "glob",
  "file_search",
  "export_resource",
  "read_file",
  "read_resource",
  "web_fetch",
  "web_open",
  "web_search",
  "lsp",
  "codegraph_search",
  "codegraph_status",
  "codegraph_files",
  "skill_list",
  "skill_read",
]);

export function renderToolCards(events: SessionEvent[], store: SessionStore, options: ToolRenderOptions = {}): string[] {
  const groups = groupToolEvents(events).filter((group) => !shouldHideFailedToolTrace(group));
  const rendered = groups.map((group) => {
    const lines = renderToolGroup(group, store);
    return { group, lines, compact: isCompactToolGroup(group, lines) };
  });
  if (options.collapseCompact === false) {
    return rendered.flatMap((item) => item.lines);
  }
  return collapseCompactToolRows(rendered);
}

function groupToolEvents(events: SessionEvent[]): ToolEventGroup[] {
  const groups = new Map<string, ToolEventGroup>();
  for (const event of events) {
    const id = stringField(event.data.tool_call_id) ?? `${event.type}:${groups.size}`;
    const name = stringField(event.data.tool_name) ?? stringField(event.data.name) ?? "tool";
    const current = groups.get(id) ?? { id, name, args: {} };
    if (event.type === "tool.call") {
      current.args = objectField(event.data.arguments);
      current.name = name;
    }
    if (event.type === "tool.result") {
      current.result = objectField(event.data.result) as unknown as ToolResult;
      current.name = name;
    }
    groups.set(id, current);
  }
  return [...groups.values()];
}

function renderToolGroup(group: ToolEventGroup, store: SessionStore): string[] {
  const result = group.result;
  const marker = result?.ok === false ? fg256(203, "×") : result?.ok === true ? fg256(48, "•") : fg256(220, "◦");
  const summary = result?.summary ?? "running";
  const width = terminalWidth();
  const action = toolGroupAction(group);
  const detail = toolGroupDetail(group, summary);
  const separator = detail ? (group.name === "run_command" ? " " : ` ${fg256(244, "·")} `) : "";
  const title = `  ${marker} ${fg256(result?.ok === false ? 203 : 255, ansi.bold + action + ansi.reset)}${separator}${fg256(result?.ok === false ? 203 : 250, truncateToWidth(detail, Math.max(20, width - visibleWidth(action) - 12)))}`;
  const body = renderToolBody(group, store);
  if (!shouldExpandToolGroup(group, body)) {
    return [title];
  }
  let firstBodyLine = true;
  return [
    title,
    ...body.map((line) => {
      if (!line) {
        return "";
      }
      if (isFullWidthSurfaceLine(line)) {
        firstBodyLine = false;
        return line;
      }
      const prefix = firstBodyLine ? fg256(238, "  ⎿ ") : fg256(238, "    ");
      firstBodyLine = false;
      return `${prefix}${line}`;
    }),
  ];
}

function renderToolBody(group: ToolEventGroup, store: SessionStore): string[] {
  const result = group.result;
  const data = objectField(result?.data);
  const lines: string[] = [];
  switch (group.name) {
    case "list_dir":
      lines.push(...renderDirectoryEntries(data));
      break;
    case "run_command":
      lines.push(...renderCommand(data));
      break;
    case "read_process":
    case "write_process":
    case "stop_process":
      lines.push(...renderProcess(data));
      break;
    case "git_diff":
    case "git_show":
      lines.push(...renderDiff(stringField(data.output) ?? resourceText(result?.resource_uri, store)));
      break;
    case "apply_patch":
      lines.push(...renderDiff(stringField(data.diff) ?? stringField(group.args.patch)));
      break;
    case "edit_file":
    case "ast_edit":
      lines.push(...renderEdit(group.args, data));
      break;
    case "write_file":
      lines.push(`${fg256(39, "path")} ${stringField(data.path) ?? stringField(group.args.path) ?? "unknown"}`);
      if (numberField(data.bytes) !== undefined) {
        lines.push(`${fg256(39, "bytes")} ${numberField(data.bytes)}`);
      }
      if (stringField(data.diff)) {
        lines.push(...renderDiff(stringField(data.diff)));
      }
      break;
    case "export_resource":
      lines.push(`${fg256(39, "path")} ${stringField(data.path) ?? "unknown"}`);
      lines.push(`${fg256(39, "mime")} ${stringField(data.mime) ?? "unknown"}`);
      if (numberField(data.size) !== undefined) {
        lines.push(`${fg256(39, "bytes")} ${numberField(data.size)}`);
      }
      break;
    case "read_file":
    case "read_resource":
      lines.push(...renderTextPreview(stringField(data.content) ?? ""));
      break;
    case "codegraph_explore":
    case "codegraph_search":
    case "codegraph_callers":
    case "codegraph_callees":
    case "codegraph_impact":
    case "codegraph_node":
    case "codegraph_status":
    case "codegraph_files":
      lines.push(...renderTextPreview(stringField(data.content) ?? ""));
      break;
    case "file_search":
    case "glob":
      lines.push(...renderMatches(data));
      break;
    case "web_fetch":
      lines.push(...renderWebFetch(data));
      break;
    case "web_open":
      lines.push(...renderWebFetch(data));
      if (stringField(data.note)) {
        lines.push(`${fg256(39, "note")} ${stringField(data.note)}`);
      }
      break;
    case "web_search":
      lines.push(...renderWebSearch(data));
      break;
    case "git_status":
      lines.push(...renderTextPreview(stringField(data.output) ?? resourceText(result?.resource_uri, store) ?? ""));
      break;
    case "todo_write":
      lines.push(...renderTodos(data));
      break;
    case "clarify":
      lines.push(...renderClarifyTool(data));
      break;
    case "goal":
      lines.push(...renderGoalTool(data));
      break;
    case "plan":
      lines.push(...renderPlanTool(data));
      break;
    case "init_experiment":
    case "run_experiment":
    case "log_experiment":
    case "update_notes":
      lines.push(...renderAutoresearchTool(group.name, data));
      break;
    case "complete_step":
      lines.push(`${fg256(39, "step")} ${stringField(data.step_id) ?? stringField(group.args.step_id) ?? "unknown"}`);
      lines.push(...renderEvidenceObject(objectField(data.evidence)));
      break;
    default:
      lines.push(...renderGeneric(data, result?.resource_uri));
  }
  if (result?.resource_uri) {
    lines.push(`${fg256(39, "resource")} ${result.resource_uri}`);
  }
  if (result?.error) {
    lines.push(fg256(203, `${result.error.code}: ${result.error.message}`));
  }
  return lines.length ? lines : [fg256(243, "No display data.")];
}

function isCompactToolGroup(group: ToolEventGroup, lines: string[]): boolean {
  return group.result?.ok === true && lines.length === 1 && COMPACT_SUCCESS_TOOLS.has(group.name);
}

function shouldHideFailedToolTrace(group: ToolEventGroup): boolean {
  if (group.result?.ok !== false) {
    return false;
  }
  if (HIDDEN_FAILED_TOOL_TRACE_TOOLS.has(group.name)) {
    return true;
  }
  if (group.name !== "list_dir") {
    return false;
  }
  const error = objectField(group.result.error);
  const code = stringField(error.code);
  return code === "list_dir_failed" || group.result.summary.startsWith("list_dir_failed:");
}

function shouldExpandToolGroup(group: ToolEventGroup, body: string[]): boolean {
  if (group.result?.ok === false || group.result?.error) {
    return true;
  }
  if (!group.result) {
    return false;
  }
  if (body.length === 0) {
    return false;
  }
  if (
    [
      "apply_patch",
      "edit_file",
      "ast_edit",
      "write_file",
      "git_diff",
      "git_show",
      "git_status",
      "run_command",
      "todo_write",
      "clarify",
      "goal",
      "plan",
      "web_search",
      "init_experiment",
      "run_experiment",
      "log_experiment",
      "update_notes",
      "complete_step",
      "codegraph_explore",
      "codegraph_callers",
      "codegraph_callees",
      "codegraph_impact",
      "codegraph_node",
    ].includes(group.name)
  ) {
    return true;
  }
  return false;
}

function collapseCompactToolRows(rendered: RenderedToolGroup[]): string[] {
  const output: string[] = [];
  let compactRun: RenderedToolGroup[] = [];
  const flushCompactRun = () => {
    if (!compactRun.length) {
      return;
    }
    if (compactRun.length <= COMPACT_TOOL_FOLD_THRESHOLD) {
      output.push(...compactRun.flatMap((item) => item.lines));
      compactRun = [];
      return;
    }
    output.push(...renderToolBatchLines(compactRun));
    compactRun = [];
  };
  for (const item of rendered) {
    if (item.compact) {
      compactRun.push(item);
      continue;
    }
    flushCompactRun();
    output.push(...item.lines);
  }
  flushCompactRun();
  return output;
}

function renderToolBatchLines(items: RenderedToolGroup[]): string[] {
  const width = terminalWidth();
  const summary = compactToolRunSummary(items);
  const first = compactToolBrief(items[0]);
  const last = compactToolBrief(items.at(-1));
  const detail = [`${items.length} calls`, summary, "Ctrl+T expand"].filter(Boolean).join(" · ");
  const lines = [`  ${fg256(48, "•")} ${fg256(75, "Tool batch")} ${fg256(244, "·")} ${fg256(250, truncateToWidth(detail, Math.max(20, width - 18)))}`];
  if (first) {
    lines.push(`    ${fg256(238, "├")} ${fg256(244, truncateToWidth(first, Math.max(20, width - 8)))}`);
  }
  if (last && last !== first) {
    lines.push(`    ${fg256(238, "╰")} ${fg256(244, truncateToWidth(last, Math.max(20, width - 8)))}`);
  }
  return lines;
}

function compactToolBrief(item: RenderedToolGroup | undefined): string | undefined {
  const summary = item?.group.result?.summary;
  if (!summary) {
    return undefined;
  }
  return truncateToWidth(summary, 24);
}

function compactToolRunSummary(items: RenderedToolGroup[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.group.name, (counts.get(item.group.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name, count]) => `${count} ${compactToolName(name)}`)
    .join(", ");
}

function compactToolName(name: string): string {
  switch (name) {
    case "list_dir":
      return "list";
    case "glob":
      return "scan";
    case "read_file":
      return "read";
    case "file_search":
      return "search";
    case "web_fetch":
      return "fetch";
    case "web_search":
      return "web";
    case "codegraph_explore":
      return "context";
    case "codegraph_search":
      return "semantic";
    case "codegraph_node":
      return "symbol";
    case "codegraph_callers":
    case "codegraph_callees":
    case "codegraph_impact":
      return "trace";
    case "codegraph_files":
      return "files";
    case "codegraph_status":
      return "context-status";
    default:
      return name.replace(/_/g, "-");
  }
}

function renderCommand(data: JsonObject): string[] {
  const lines = [
    `${fg256(39, "cmd")} ${stringField(data.command) ?? "unknown"}`,
    `${fg256(39, "cwd")} ${stringField(data.cwd) ?? "."}`,
    `${fg256(39, "exit")} ${numberField(data.code) ?? "running"}${data.timed_out ? " timeout" : ""}`,
  ];
  const output = stringField(data.output);
  if (output) {
    lines.push(...renderIndentedPreview(output, 10, "out"));
  }
  return lines;
}

function renderDirectoryEntries(data: JsonObject): string[] {
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (!entries.length) {
    return [fg256(243, "No entries.")];
  }
  return entries.slice(0, 12).map((item) => {
    const entry = objectField(item);
    const type = stringField(entry.type) ?? "item";
    const icon = type === "directory" ? fg256(75, "dir ") : type === "file" ? fg256(250, "file") : fg256(244, type.padEnd(4).slice(0, 4));
    return `${icon} ${stringField(entry.path) ?? stringField(entry.name) ?? compactObject(entry)}`;
  });
}

function renderProcess(data: JsonObject): string[] {
  const lines = [
    `${fg256(39, "process")} ${stringField(data.process_id) ?? "unknown"}`,
    `${fg256(39, "live")} ${data.live === true ? "yes" : data.live === false ? "no" : "unknown"}`,
  ];
  const output = stringField(data.output);
  if (output) {
    lines.push(...renderIndentedPreview(output, 10, "out"));
  }
  return lines;
}

function renderEdit(args: JsonObject, data: JsonObject): string[] {
  const path = stringField(data.path) ?? stringField(args.path) ?? "unknown";
  const diff = stringField(data.diff);
  const oldText = stringField(args.old_text);
  const newText = stringField(args.new_text) ?? stringField(args.content);
  const lines = [`${fg256(39, "path")} ${path}`];
  if (diff) {
    lines.push(...renderDiff(diff));
  } else if (oldText || newText) {
    lines.push(...renderDiff(simplePatch(path, oldText ?? "", newText ?? "")));
  }
  return lines;
}

function renderMatches(data: JsonObject): string[] {
  const matches = Array.isArray(data.matches) ? data.matches : [];
  if (!matches.length) {
    return [fg256(243, "No matches.")];
  }
  return matches.slice(0, 12).map((item) => {
    if (typeof item === "string") {
      return `${fg256(39, "path")} ${item}`;
    }
    const match = objectField(item);
    const location = `${stringField(match.path) ?? "unknown"}:${numberField(match.line) ?? "?"}`;
    return `${fg256(39, location)} ${stringField(match.snippet) ?? ""}`;
  });
}

function renderWebSearch(data: JsonObject): string[] {
  const lines: string[] = [];
  const provider = stringField(data.provider);
  const query = stringField(data.query);
  if (provider) {
    lines.push(`${fg256(39, "provider")} ${provider}${data.fallback === true ? fg256(244, " · fallback") : ""}`);
  }
  if (query) {
    lines.push(`${fg256(39, "query")} ${query}`);
  }
  const results = Array.isArray(data.results) ? data.results.map(objectField) : [];
  if (results.length) {
    lines.push(`${fg256(39, "results")} ${results.length}`);
    for (const [index, result] of results.slice(0, 5).entries()) {
      const title = stringField(result.title) ?? stringField(result.name) ?? stringField(result.url) ?? "Untitled";
      const url = stringField(result.url) ?? stringField(result.link) ?? stringField(result.href);
      const snippet = stringField(result.snippet) ?? stringField(result.description) ?? stringField(result.content);
      lines.push(`${fg256(244, String(index + 1).padStart(2, "0"))} ${truncateToWidth(title, Math.max(24, terminalWidth() - 16))}`);
      if (url) {
        lines.push(`   ${fg256(39, truncateToWidth(url, Math.max(24, terminalWidth() - 12)))}`);
      }
      if (snippet) {
        lines.push(`   ${fg256(244, truncateToWidth(snippet.replace(/\s+/g, " "), Math.max(24, terminalWidth() - 12)))}`);
      }
    }
    return lines;
  }
  const text = stringField(data.results_text);
  if (text) {
    lines.push(...renderIndentedPreview(text, 8, "results"));
    return lines;
  }
  return lines.length ? lines : [fg256(243, "No search results.")];
}

function renderWebFetch(data: JsonObject): string[] {
  const lines = [
    `${fg256(39, "url")} ${stringField(data.final_url) ?? stringField(data.url) ?? "unknown"}`,
    `${fg256(39, "status")} ${numberField(data.status) ?? "unknown"} · ${stringField(data.content_type) ?? "unknown"}`,
  ];
  const title = stringField(data.title);
  if (title) {
    lines.push(`${fg256(39, "title")} ${title}`);
  }
  const text = stringField(data.text);
  if (text) {
    lines.push(...renderIndentedPreview(text, 10, "text"));
  }
  return lines;
}

function renderTodos(data: JsonObject): string[] {
  const items = Array.isArray(data.items) ? data.items.map(objectField) : [];
  if (!items.length) {
    return [fg256(243, "No todo items.")];
  }
  const done = items.filter((item) => normalizedTodoStatus(item) === "done").length;
  const active = items.filter((item) => normalizedTodoStatus(item) === "in_progress").length;
  const queued = items.filter((item) => normalizedTodoStatus(item) === "pending").length;
  return [
    `${fg256(39, "progress")} ${done} done · ${active} active · ${queued} queued`,
    ...items.slice(0, 16).map((todo, index) => {
      const status = normalizedTodoStatus(todo);
      const marker = todoMarker(status);
      const label = todoStatusLabel(status);
      const number = fg256(244, String(index + 1).padStart(2, "0"));
      const content = stringField(todo.content) ?? stringField(todo.title) ?? stringField(todo.id) ?? compactObject(todo);
      const id = stringField(todo.id);
      const suffix = id && id !== content ? fg256(238, ` #${id}`) : "";
      return `${number} ${marker} ${label} ${truncateToWidth(content, Math.max(24, terminalWidth() - 24))}${suffix}`;
    }),
  ];
}

function normalizedTodoStatus(todo: JsonObject): "done" | "in_progress" | "pending" | "blocked" {
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

function todoMarker(status: "done" | "in_progress" | "pending" | "blocked"): string {
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

function todoStatusLabel(status: "done" | "in_progress" | "pending" | "blocked"): string {
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

function renderClarifyTool(data: JsonObject): string[] {
  const answer = stringField(data.answer) ?? "unknown";
  return [`${fg256(39, "answer")} ${answer}`];
}

function renderGoalTool(data: JsonObject): string[] {
  const goal = objectField(data.goal);
  if (!Object.keys(goal).length) {
    return [fg256(243, "No active goal.")];
  }
  const lines: string[] = [];
  const summary = stringField(goal.summary);
  if (summary) {
    lines.push(`${fg256(39, "summary")} ${summary}`);
  }
  const completionReport = stringField(data.completion_budget_report);
  if (completionReport) {
    lines.push(`${fg256(39, "report")} ${completionReport}`);
  }
  const remaining = numberField(data.remaining_tokens);
  if (remaining !== undefined) {
    lines.push(`${fg256(39, "remaining")} ${remaining} tokens`);
  }
  const planning = objectField(goal.planning);
  const horizons = Array.isArray(data.horizons) ? data.horizons.map(objectField) : [];
  if (horizons.length) {
    lines.push(...renderGoalHorizonsTool(horizons));
  }
  if (Object.keys(planning).length) {
    lines.push(...renderGoalPlanningTool(planning));
  }
  const plan = objectField(goal.plan);
  if (Object.keys(plan).length) {
    lines.push(`${fg256(39, "plan")} ${stringField(plan.summary) ?? stringField(plan.objective) ?? "approved"}`);
  }
  return lines.length ? lines : [fg256(243, "Goal state saved.")];
}

function renderGoalHorizonsTool(horizons: JsonObject[]): string[] {
  return horizons.flatMap((horizon) => {
    const generation = numberField(horizon.generation) ?? 0;
    const current = horizon.current === true ? " current" : "";
    const steps = Array.isArray(horizon.steps) ? horizon.steps.map(objectField) : [];
    const title = stringField(horizon.title) ?? stringField(horizon.summary);
    const heading = `${fg256(39, "horizon")} ${generation}${title ? ` · ${title}` : ""}${current}`;
    const stepLines = steps.map((step) => {
      const id = stringField(step.id) ?? "step";
      const title = stringField(step.title) ?? "";
      return `${fg256(39, "sub-goal")} ${goalStepJsonMarker(stringField(step.status))} ${id} ${title}`;
    });
    return stepLines.length ? [heading, ...stepLines] : [heading, `${fg256(39, "sub-goal")} ${fg256(244, "none")}`];
  });
}

function renderGoalPlanningTool(planning: JsonObject): string[] {
  const steps = Array.isArray(planning.steps) ? planning.steps.map(objectField) : [];
  const summary = goalPlanningJsonSummary(steps);
  const activeStepId = stringField(planning.active_step_id);
  const lines = [`${fg256(39, "plan")} ${summary}`];
  const activeStep = activeStepId ? steps.find((step) => stringField(step.id) === activeStepId) : undefined;
  if (activeStep) {
    const id = stringField(activeStep.id) ?? "step";
    lines.push(`${fg256(39, "now")} ${goalStepJsonMarker(stringField(activeStep.status))} ${id} ${stringField(activeStep.title) ?? ""}`);
  }
  return lines;
}

function goalPlanningJsonSummary(steps: JsonObject[]): string {
  const labels: Array<[string, string]> = [
    ["completed", "completed"],
    ["in_progress", "in progress"],
    ["blocked", "blocked"],
    ["pending", "pending"],
    ["skipped", "skipped"],
  ];
  const parts = labels
    .map(([status, label]) => {
      const count = steps.filter((step) => stringField(step.status) === status).length;
      return count > 0 ? `${count} ${label}` : undefined;
    })
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : "no steps";
}

function goalStepJsonMarker(status: string | undefined): string {
  switch (status) {
    case "completed":
      return fg256(48, "x");
    case "in_progress":
      return fg256(220, "*");
    case "blocked":
      return fg256(203, "!");
    case "skipped":
      return fg256(244, "-");
    default:
      return fg256(244, " ");
  }
}

function renderPlanTool(data: JsonObject): string[] {
  const plan = objectField(data.plan);
  if (!Object.keys(plan).length) {
    return [fg256(243, "No active plan.")];
  }
  const lines: string[] = [];
  const summary = stringField(plan.summary);
  const body = stringField(plan.body);
  if (!body) {
    lines.push(
      `${fg256(39, "objective")} ${stringField(plan.objective) ?? "unknown"}`,
      `${fg256(39, "status")} ${stringField(plan.status) ?? "unknown"}`,
    );
  } else if (summary) {
    lines.push(`${fg256(39, "summary")} ${summary}`);
  }
  if (stringField(plan.status) === "drafting" || stringField(plan.status) === "paused") {
    lines.push(`${fg256(39, "review")} ${body?.trim() ? "ready for approval" : fg256(244, "needs plan body")}`);
  }
  if (body) {
    lines.push(
      ...renderPlanDocumentSurface(
        {
          id: stringField(plan.id) ?? "plan",
          objective: stringField(plan.objective) ?? "unknown",
          status: planStatusField(plan.status),
          summary,
          body,
          created_at: "",
          updated_at: "",
        },
        { width: terminalWidth(), maxBodyLines: Number.POSITIVE_INFINITY },
      ),
    );
  }
  return lines;
}

function isFullWidthSurfaceLine(line: string): boolean {
  return line.startsWith("\x1b[48;5;");
}

function planStatusField(value: unknown): "drafting" | "paused" | "approved" | "dropped" {
  return value === "paused" || value === "approved" || value === "dropped" ? value : "drafting";
}

function renderAutoresearchTool(name: string, data: JsonObject): string[] {
  if (name === "log_experiment") {
    const result = objectField(data.result);
    const progress = objectField(data.progress);
    if (!Object.keys(result).length && Object.keys(progress).length) {
      return renderAutoresearchProgressLines(progress);
    }
    return [
      `${fg256(39, "run")} ${numberField(result.run_id) ?? "unknown"}`,
      `${fg256(39, "status")} ${stringField(result.status) ?? "unknown"}`,
      `${fg256(39, "metric")} ${metricField(result.metric)}`,
      ...renderAutoresearchProgressLines(progress),
      ...(stringField(result.description) ? [`${fg256(39, "description")} ${stringField(result.description)}`] : []),
    ];
  }
  if (name === "run_experiment") {
    const progress = objectField(data.progress);
    const pendingRun = objectField(data.pending_run);
    if (Object.keys(pendingRun).length) {
      return [
        `${fg256(39, "pending run")} ${numberField(pendingRun.id) ?? "unknown"}`,
        `${fg256(39, "pending status")} ${booleanField(pendingRun.timed_out) ? "timeout" : `exit ${numberField(pendingRun.exit_code) ?? "unknown"}`}`,
        ...renderAutoresearchProgressLines(progress),
        ...(stringField(pendingRun.output_resource_uri) ? [`${fg256(39, "output")} ${stringField(pendingRun.output_resource_uri)}`] : []),
      ];
    }
    if (numberField(data.duration_ms) === undefined && numberField(data.exit_code) === undefined && Object.keys(progress).length) {
      return renderAutoresearchProgressLines(progress);
    }
    return [
      `${fg256(39, "status")} ${booleanField(data.timed_out) ? "timeout" : `exit ${numberField(data.exit_code) ?? "unknown"}`}`,
      `${fg256(39, "duration")} ${numberField(data.duration_ms) ?? "unknown"}ms`,
      `${fg256(39, "primary")} ${numberField(data.parsed_primary) ?? "missing"}`,
      ...(booleanField(data.output_truncated) ? [`${fg256(39, "output")} truncated`] : []),
      ...renderAutoresearchProgressLines(progress),
      ...(stringField(data.output_resource_uri) ? [`${fg256(39, "output")} ${stringField(data.output_resource_uri)}`] : []),
    ];
  }
  if (name === "init_experiment") {
    const state = objectField(data.autoresearch);
    const experiment = objectField(state.experiment);
    const progress = objectField(data.progress);
    const harness = objectField(data.harness_status);
    if (!Object.keys(experiment).length) {
      const lines = [
        ...(stringField(state.goal) ? [`${fg256(39, "goal")} ${stringField(state.goal)}`] : []),
        ...(stringField(harness.message) ? [`${fg256(39, "harness")} ${stringField(harness.message)}`] : []),
        ...renderAutoresearchProgressLines(progress),
      ];
      return lines.length ? lines : [fg256(243, "Autoresearch initialization did not produce an experiment.")];
    }
    return [
      `${fg256(39, "experiment")} ${stringField(experiment.name) ?? "unknown"}`,
      `${fg256(39, "metric")} ${stringField(experiment.primary_metric) ?? "unknown"}`,
      ...renderAutoresearchProgressLines(progress),
      ...(stringField(harness.message) ? [`${fg256(39, "harness")} ${stringField(harness.message)}`] : []),
    ];
  }
  const notes = stringField(data.notes);
  return notes ? renderIndentedPreview(notes, 6, "notes") : [fg256(243, "Autoresearch notes updated.")];
}

function renderAutoresearchProgressLines(progress: JsonObject): string[] {
  const logged = numberField(progress.logged_runs);
  if (logged === undefined) {
    return [];
  }
  const kept = numberField(progress.kept_runs) ?? 0;
  const cap = numberField(progress.keep_cap);
  const pending = numberField(progress.pending_runs) ?? 0;
  return [`${fg256(39, "progress")} ${logged} logged · ${kept}${cap === undefined ? "" : `/${cap}`} keep${pending ? ` · ${pending} pending` : ""}`];
}

function renderGeneric(data: JsonObject, resourceUri?: string): string[] {
  if (Object.keys(data).length === 0) {
    return resourceUri ? [] : [fg256(243, "No structured result.")];
  }
  return renderKeyValueObject(data);
}

function renderEvidenceObject(data: JsonObject): string[] {
  const rows = renderKeyValueObject(data);
  return rows.length ? rows.map((row, index) => (index === 0 ? `${fg256(39, "evidence")} ${row}` : `         ${row}`)) : [fg256(243, "No evidence fields.")];
}

function renderKeyValueObject(data: JsonObject): string[] {
  const entries = Object.entries(data);
  if (!entries.length) {
    return [];
  }
  return entries.slice(0, 12).map(([key, value]) => `${fg256(39, key)} ${compactValue(value)}`);
}

function compactValue(value: unknown): string {
  if (value === null || value === undefined) {
    return fg256(244, "none");
  }
  if (typeof value === "string") {
    return truncateToWidth(value, Math.max(24, terminalWidth() - 20));
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => compactValue(item)).join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 6)
      .map(([key, item]) => `${key}=${compactValue(item)}`)
      .join(" · ");
  }
  return String(value);
}

function compactObject(value: JsonObject): string {
  return compactValue(value) || "item";
}

function renderDiff(text?: string): string[] {
  if (!text) {
    return [fg256(243, "No diff output.")];
  }
  const source = text.split(/\r?\n/).slice(0, 120);
  const output: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index] ?? "";
    if (line.startsWith("diff --git")) {
      output.push(fg256(171, line));
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) {
      output.push(fg256(243, line));
      continue;
    }
    if (line.startsWith("@@")) {
      const parsed = parseHunkHeader(line);
      if (parsed) {
        oldLine = parsed.oldStart;
        newLine = parsed.newStart;
      }
      output.push(fg256(45, line));
      continue;
    }
    const next = source[index + 1] ?? "";
    if (line.startsWith("-") && !line.startsWith("---") && next.startsWith("+") && !next.startsWith("+++")) {
      output.push(formatDiffRow({ oldLine, newLine: undefined, marker: "-", content: highlightChangedText(line.slice(1), next.slice(1), 203), color: 203 }));
      oldLine += 1;
      output.push(formatDiffRow({ oldLine: undefined, newLine, marker: "+", content: highlightChangedText(next.slice(1), line.slice(1), 48), color: 48 }));
      newLine += 1;
      index += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      output.push(formatDiffRow({ oldLine, newLine: undefined, marker: "-", content: markIndent(line.slice(1)), color: 203 }));
      oldLine += 1;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      output.push(formatDiffRow({ oldLine: undefined, newLine, marker: "+", content: markIndent(line.slice(1)), color: 48 }));
      newLine += 1;
      continue;
    }
    const content = line.startsWith(" ") ? line.slice(1) : line;
    output.push(formatDiffRow({ oldLine, newLine, marker: " ", content: markIndent(content), color: 250 }));
    oldLine += 1;
    newLine += 1;
  }
  if (source.length >= 120) {
    output.push(fg256(243, "... diff truncated"));
  }
  return output;
}

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | undefined {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/.exec(line);
  if (!match) {
    return undefined;
  }
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

function formatDiffRow(input: { oldLine?: number; newLine?: number; marker: string; content: string; color: number }): string {
  const oldNo = input.oldLine === undefined ? "    " : String(input.oldLine).padStart(4);
  const newNo = input.newLine === undefined ? "    " : String(input.newLine).padStart(4);
  const gutter = `${fg256(243, oldNo)} ${fg256(243, newNo)} ${fg256(input.color, input.marker)} ${fg256(238, "│")}`;
  const room = Math.max(24, Math.min(120, terminalWidth() - 8) - visibleWidth(gutter) - 1);
  return `${gutter} ${fgLine(input.color, truncateToWidth(input.content, room))}`;
}

function markIndent(text: string): string {
  const match = /^(\s+)(.*)$/.exec(text);
  if (!match) {
    return text;
  }
  return `${fg256(238, (match[1] ?? "").replaceAll(" ", "·").replaceAll("\t", "→   "))}${match[2] ?? ""}`;
}

function highlightChangedText(text: string, other: string, color: number): string {
  const marked = markIndent(text);
  const plainText = text.trimStart();
  const plainOther = other.trimStart();
  let prefix = 0;
  while (prefix < plainText.length && prefix < plainOther.length && plainText[prefix] === plainOther[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix + prefix < plainText.length &&
    suffix + prefix < plainOther.length &&
    plainText[plainText.length - 1 - suffix] === plainOther[plainOther.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (prefix + suffix >= plainText.length) {
    return marked;
  }
  const leadingWhitespace = text.length - plainText.length;
  const start = leadingWhitespace + prefix;
  const end = Math.max(start, text.length - suffix);
  return `${markIndent(text.slice(0, start))}${ansi.bold}${fg256(color, text.slice(start, end))}${ansi.reset}${markIndent(text.slice(end))}`;
}

function fgLine(code: number, text: string): string {
  const open = `\x1b[38;5;${code}m`;
  return `${open}${text.replaceAll(ansi.reset, `${ansi.reset}${open}`)}${ansi.reset}`;
}

function renderTextPreview(text: string, maxLines = 12): string[] {
  const lines = text.split(/\r?\n/);
  const preview = lines.slice(0, maxLines);
  if (lines.length > preview.length) {
    preview.push(fg256(243, `... ${lines.length - preview.length} more lines`));
  }
  return preview;
}

function renderIndentedPreview(text: string, maxLines: number, label: string): string[] {
  return renderTextPreview(text, maxLines).map((line, index) => (index === 0 ? `${fg256(39, label)} ${line}` : `    ${line}`));
}

function simplePatch(file: string, oldText: string, newText: string): string {
  const oldLines = oldText.split(/\r?\n/).slice(0, 20);
  const newLines = newText.split(/\r?\n/).slice(0, 20);
  return [`--- ${file}`, `+++ ${file}`, ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)].join("\n");
}

function resourceText(uri: string | undefined, store: SessionStore): string | undefined {
  if (!uri) {
    return undefined;
  }
  return store.readResource(uri)?.content;
}

function toolGroupAction(group: ToolEventGroup): string {
  const name = group.name;
  const ok = group.result?.ok;
  const failed = ok === false ? " failed" : "";
  switch (name) {
    case "run_command":
      return `Ran${failed}`;
    case "list_dir":
      return `Listed directory${failed}`;
    case "glob":
      return `Scanned files${failed}`;
    case "file_search":
      return `Searched workspace${failed}`;
    case "read_file":
    case "read_resource":
      return `Read file${failed}`;
    case "codegraph_explore":
      return `Explored context${failed}`;
    case "codegraph_search":
      return `Searched semantic index${failed}`;
    case "codegraph_node":
      return `Read indexed symbol${failed}`;
    case "codegraph_callers":
    case "codegraph_callees":
    case "codegraph_impact":
      return `Traced semantic index${failed}`;
    case "codegraph_files":
    case "codegraph_status":
      return `Checked context engine${failed}`;
    case "write_file":
      return `Wrote file${failed}`;
    case "edit_file":
    case "ast_edit":
      return `Edited file${failed}`;
    case "apply_patch":
      return `Applied patch${failed}`;
    case "git_status":
      return `Checked git status${failed}`;
    case "git_diff":
    case "git_show":
      return `Read git data${failed}`;
    case "todo_write":
      return `Updated todo${failed}`;
    case "clarify":
      return ok === false ? "Question failed" : "Questions answered";
    case "goal":
      return `Updated goal${failed}`;
    case "plan":
      return `Updated plan${failed}`;
    case "init_experiment":
      return `Initialized experiment${failed}`;
    case "run_experiment":
      return `Ran experiment${failed}`;
    case "log_experiment":
      return `Logged experiment${failed}`;
    case "update_notes":
      return `Updated notes${failed}`;
    case "complete_step":
      return `Recorded evidence${failed}`;
    case "web_search":
      return `Searched web${failed}`;
    case "web_fetch":
      return `Fetched URL${failed}`;
    case "web_open":
      return `Opened URL${failed}`;
    default:
      if (name.includes("skill")) return `Updated skills${failed}`;
      if (name.includes("process")) return `Managed process${failed}`;
      if (name.includes("image") || name.includes("video") || name.includes("vision") || name.includes("audio")) return `Used Omni${failed}`;
      return ok === undefined ? `Running ${name}` : `Used tool${failed}`;
  }
}

function toolGroupDetail(group: ToolEventGroup, summary: string): string {
  const data = objectField(group.result?.data);
  switch (group.name) {
    case "run_command": {
      const command = stringField(data.command) ?? stringField(group.args.command);
      const code = numberField(data.code);
      if (command && code !== undefined) {
        return `${command} · exited ${code}`;
      }
      return command ?? compactSummary(summary);
    }
    case "list_dir":
      return stringField(group.args.path) ?? stringField(data.path) ?? compactSummary(summary);
    case "glob":
      return stringField(group.args.pattern) ?? compactSummary(summary);
    case "file_search":
      return stringField(group.args.query) ?? compactSummary(summary);
    case "export_resource":
      return stringField(data.path) ?? stringField(group.args.uri) ?? compactSummary(summary);
    case "read_file":
    case "read_resource":
      return stringField(group.args.path) ?? stringField(group.args.uri) ?? compactSummary(summary);
    case "codegraph_explore":
      return stringField(group.args.query) ?? compactSummary(summary);
    case "codegraph_search":
      return stringField(group.args.query) ?? compactSummary(summary);
    case "codegraph_node":
    case "codegraph_callers":
    case "codegraph_callees":
    case "codegraph_impact":
      return stringField(group.args.symbol) ?? compactSummary(summary);
    case "codegraph_files":
      return stringField(group.args.path) ?? stringField(group.args.pattern) ?? compactSummary(summary);
    case "codegraph_status":
      return compactSummary(summary);
    case "write_file":
    case "edit_file":
    case "ast_edit":
      return stringField(data.path) ?? stringField(group.args.path) ?? compactSummary(summary);
    case "git_diff":
    case "git_show":
      return stringField(group.args.path) ?? stringField(group.args.rev) ?? compactSummary(summary);
    case "todo_write":
      return compactSummary(summary);
    case "clarify":
      return stringField(data.question) ?? stringField(group.args.question) ?? compactSummary(summary);
    case "goal": {
      const goal = objectField(data.goal);
      return [stringField(goal.objective), stringField(goal.status)].filter(Boolean).join(" · ") || compactSummary(summary);
    }
    case "plan": {
      const plan = objectField(data.plan);
      return [stringField(plan.objective), stringField(plan.status)].filter(Boolean).join(" · ") || compactSummary(summary);
    }
    case "log_experiment": {
      const result = objectField(data.result);
      const run = numberField(result.run_id);
      const status = stringField(result.status);
      const metric = result.metric === undefined ? undefined : `metric ${metricField(result.metric)}`;
      return [`run ${run ?? "?"}`, status, metric].filter(Boolean).join(" · ") || compactSummary(summary);
    }
    case "run_experiment": {
      const pendingRun = objectField(data.pending_run);
      const pendingId = numberField(pendingRun.id);
      if (pendingId !== undefined) {
        return `pending run ${pendingId}`;
      }
      const primary = numberField(data.parsed_primary);
      const exit = numberField(data.exit_code);
      const status = booleanField(data.timed_out) ? "timeout" : `exit ${exit ?? "?"}`;
      return [status, primary === undefined ? "primary missing" : `primary ${primary}`].join(" · ");
    }
    case "init_experiment": {
      const harness = objectField(data.harness_status);
      const harnessMessage = stringField(harness.message);
      if (harnessMessage) {
        return harnessMessage;
      }
      const state = objectField(data.autoresearch);
      const experiment = objectField(state.experiment);
      return stringField(experiment.name) ?? compactSummary(summary);
    }
    case "update_notes":
      return compactSummary(summary);
    case "web_search":
      return stringField(group.args.query) ?? compactSummary(summary);
    case "web_fetch":
    case "web_open":
      return stringField(group.args.url) ?? stringField(data.final_url) ?? compactSummary(summary);
    default:
      return compactSummary(summary);
  }
}

function compactSummary(summary: string): string {
  return summary
    .replace(/^Command exited\s+0$/i, "exited 0")
    .replace(/^Command exited\s+(\d+)$/i, "exited $1")
    .replace(/\s+/g, " ")
    .trim();
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

function metricField(value: unknown): string {
  const metric = numberField(value);
  if (metric !== undefined) {
    return String(metric);
  }
  return value === null ? "missing" : "unknown";
}

function booleanField(value: unknown): boolean {
  return value === true;
}
