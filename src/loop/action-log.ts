import type { SessionStore } from "../session/store.js";
import type { JsonObject, SessionEvent, WorkspaceIdentity } from "../types.js";

export type LoopConnectorActionAuditStatus = "dry_run" | "executed" | "failed" | "denied";

export interface LoopConnectorActionAuditItem {
  id: string;
  status: LoopConnectorActionAuditStatus;
  connector: string;
  surface: string;
  kind: string;
  area: string;
  operation: string;
  request_class?: string;
  session_id: string;
  session_title: string;
  run_id?: string;
  event_id?: number;
  source: "action_run" | "preflight" | "tool_gate";
  repo?: string;
  number?: number;
  thread?: string;
  target_run_id?: string;
  workflow?: string;
  ref?: string;
  fields?: Array<{ key: string; value: string }>;
  deployment_id?: string;
  state?: string;
  environment_url?: string;
  log_url?: string;
  tag?: string;
  dist_tag?: string;
  access?: string;
  provenance?: boolean;
  title?: string;
  method?: string;
  review_event?: string;
  add_labels?: string[];
  remove_labels?: string[];
  command?: string;
  exit_code?: number;
  reason?: string;
  review_surface?: string;
  created_at: string;
}

export interface LoopConnectorActionAuditReport {
  generated_at: string;
  workspace_id: string;
  workspace_root: string;
  summary: {
    total: number;
    dry_run: number;
    executed: number;
    failed: number;
    denied: number;
    by_status: Record<LoopConnectorActionAuditStatus, number>;
    by_connector: Record<string, number>;
    by_request_class: Record<string, number>;
  };
  actions: LoopConnectorActionAuditItem[];
}

const ACTION_STATUSES: LoopConnectorActionAuditStatus[] = ["dry_run", "executed", "failed", "denied"];

export function readLoopActions(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: { limit?: number } = {},
): LoopConnectorActionAuditReport {
  const actions: LoopConnectorActionAuditItem[] = [];
  for (const session of store.listSessions(workspace.id, { includeArchived: true })) {
    for (const event of store.listEvents(session.session_id)) {
      const item = actionAuditItemFromEvent(event, session.title);
      if (item) {
        actions.push(item);
      }
    }
  }
  actions.sort(compareActions);
  const limited = options.limit && options.limit > 0 ? actions.slice(0, Math.trunc(options.limit)) : actions;
  return {
    generated_at: new Date().toISOString(),
    workspace_id: workspace.id,
    workspace_root: workspace.root,
    summary: {
      total: actions.length,
      dry_run: actions.filter((action) => action.status === "dry_run").length,
      executed: actions.filter((action) => action.status === "executed").length,
      failed: actions.filter((action) => action.status === "failed").length,
      denied: actions.filter((action) => action.status === "denied").length,
      by_status: initializedStatusCounts(actions),
      by_connector: countBy(actions, (action) => action.connector),
      by_request_class: countBy(actions, (action) => action.request_class),
    },
    actions: limited,
  };
}

function actionAuditItemFromEvent(event: SessionEvent, sessionTitle: string): LoopConnectorActionAuditItem | undefined {
  if (event.type === "connector.action.recorded") {
    return recordedActionItem(event, sessionTitle);
  }
  if (event.type === "permission.denied" && stringValue(jsonObject(event.data.decision)?.policy_kind) === "connector_mutation") {
    return deniedActionItem(event, sessionTitle);
  }
  return undefined;
}

function recordedActionItem(event: SessionEvent, sessionTitle: string): LoopConnectorActionAuditItem | undefined {
  const action = jsonObject(event.data.action);
  const status = parseStatus(event.data.status);
  if (!action || !status || status === "denied") {
    return undefined;
  }
  const command = jsonObject(event.data.command);
  const result = jsonObject(event.data.result);
  const preflight = jsonObject(event.data.preflight);
  return {
    id: `connector-action:${event.session_id}:${event.id ?? event.created_at}`,
    status,
    connector: stringValue(action.connector) ?? "unknown",
    surface: stringValue(action.surface) ?? "first_class",
    kind: stringValue(action.kind) ?? "mutation",
    area: stringValue(action.area) ?? "unknown",
    operation: stringValue(action.operation) ?? "unknown",
    request_class: stringValue(event.data.request_class),
    session_id: event.session_id,
    session_title: sessionTitle,
    run_id: event.run_id,
    event_id: event.id,
    source: "action_run",
    repo: stringValue(action.repo),
    number: numberValue(action.number),
    thread: stringValue(action.thread),
    target_run_id: stringValue(action.target_run_id),
    workflow: stringValue(action.workflow),
    ref: stringValue(action.ref),
    fields: workflowFieldsValue(action.fields),
    deployment_id: stringValue(action.deployment_id),
    state: stringValue(action.state),
    environment_url: stringValue(action.environment_url),
    log_url: stringValue(action.log_url),
    tag: stringValue(action.tag),
    dist_tag: stringValue(action.dist_tag),
    access: stringValue(action.access),
    provenance: booleanValue(action.provenance),
    title: stringValue(action.title),
    method: stringValue(action.method),
    review_event: stringValue(action.review_event),
    add_labels: stringArrayValue(action.add_labels),
    remove_labels: stringArrayValue(action.remove_labels),
    command: commandText(command),
    exit_code: numberValue(result?.exit_code),
    reason: stringValue(preflight?.reason),
    review_surface: stringValue(preflight?.review_surface),
    created_at: event.created_at ?? "",
  };
}

function deniedActionItem(event: SessionEvent, sessionTitle: string): LoopConnectorActionAuditItem {
  const decision = jsonObject(event.data.decision) ?? {};
  const args = jsonObject(event.data.arguments) ?? {};
  const source = event.data.action_run === true
    ? "action_run"
    : event.data.preflight === true
      ? "preflight"
      : "tool_gate";
  return {
    id: `connector-action-denied:${event.session_id}:${event.id ?? event.created_at}`,
    status: "denied",
    connector: stringValue(decision.connector) ?? stringValue(args.connector) ?? "unknown",
    surface: stringValue(decision.connector_surface) ?? stringValue(args.surface) ?? "unknown",
    kind: stringValue(decision.connector_action) ?? stringValue(args.kind) ?? "mutation",
    area: stringValue(decision.connector_area) ?? stringValue(args.area) ?? "unknown",
    operation: stringValue(decision.connector_operation) ?? stringValue(args.operation) ?? "unknown",
    request_class: stringValue(event.data.request_class),
    session_id: event.session_id,
    session_title: sessionTitle,
    run_id: event.run_id,
    event_id: event.id,
    source,
    repo: stringValue(args.repo),
    number: numberValue(args.number),
    thread: stringValue(args.thread),
    target_run_id: stringValue(args.target_run_id),
    workflow: stringValue(args.workflow),
    ref: stringValue(args.ref),
    fields: workflowFieldsValue(args.fields),
    deployment_id: stringValue(args.deployment_id),
    state: stringValue(args.state),
    environment_url: stringValue(args.environment_url),
    log_url: stringValue(args.log_url),
    tag: stringValue(args.tag),
    dist_tag: stringValue(args.dist_tag),
    access: stringValue(args.access),
    provenance: booleanValue(args.provenance),
    title: stringValue(args.title),
    method: stringValue(args.method),
    review_event: stringValue(args.review_event),
    add_labels: stringArrayValue(args.add_labels),
    remove_labels: stringArrayValue(args.remove_labels),
    command: permissionCommand(args),
    reason: stringValue(decision.reason),
    review_surface: stringValue(decision.review_surface),
    created_at: event.created_at ?? "",
  };
}

function compareActions(left: LoopConnectorActionAuditItem, right: LoopConnectorActionAuditItem): number {
  return right.created_at.localeCompare(left.created_at)
    || (right.event_id ?? 0) - (left.event_id ?? 0)
    || left.id.localeCompare(right.id);
}

function initializedStatusCounts(actions: LoopConnectorActionAuditItem[]): Record<LoopConnectorActionAuditStatus, number> {
  const counts = Object.fromEntries(ACTION_STATUSES.map((status) => [status, 0])) as Record<LoopConnectorActionAuditStatus, number>;
  for (const action of actions) {
    counts[action.status] += 1;
  }
  return counts;
}

function countBy<T>(items: T[], keyFn: (item: T) => string | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!key) {
      continue;
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function parseStatus(value: unknown): LoopConnectorActionAuditStatus | undefined {
  return value === "dry_run" || value === "executed" || value === "failed" || value === "denied" ? value : undefined;
}

function commandText(command: JsonObject | undefined): string | undefined {
  const executable = stringValue(command?.executable);
  const args = command?.args;
  if (!executable) {
    return undefined;
  }
  if (!Array.isArray(args)) {
    return executable;
  }
  return [executable, ...args.map((item) => String(item))].join(" ");
}

function permissionCommand(args: JsonObject): string | undefined {
  const command = stringValue(args.command);
  if (command) {
    return command;
  }
  const connector = stringValue(args.connector);
  const area = stringValue(args.area);
  const operation = stringValue(args.operation);
  return [connector, area, operation].filter((item): item is string => Boolean(item)).join(" ") || undefined;
}

function jsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  return items.length ? items : undefined;
}

function workflowFieldsValue(value: unknown): Array<{ key: string; value: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const fields: Array<{ key: string; value: string }> = [];
  for (const item of value) {
    const object = jsonObject(item);
    const key = stringValue(object?.key);
    if (!key) {
      continue;
    }
    fields.push({ key, value: String(object?.value ?? "") });
  }
  return fields.length ? fields : undefined;
}
