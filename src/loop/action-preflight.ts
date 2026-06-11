import type { SessionStore } from "../session/store.js";
import type { JsonObject, SessionRecord } from "../types.js";
import {
  preflightConnectorAction,
  type ConnectorActionKind,
  type ConnectorActionPreflightInput,
  type ConnectorActionPreflightResult,
  type ConnectorActionRequestClass,
  type ConnectorActionSurface,
} from "../tools/connector-actions.js";

export interface RecordedConnectorActionPreflightResult extends ConnectorActionPreflightResult {
  session_id: string;
  recorded: boolean;
  event_id?: number;
}

export function recordConnectorActionPreflight(
  store: SessionStore,
  session: SessionRecord,
  input: ConnectorActionPreflightInput,
): RecordedConnectorActionPreflightResult {
  const result = preflightConnectorAction(input);
  if (result.status === "allow") {
    return { ...result, session_id: session.session_id, recorded: false };
  }

  const previousStatus = session.status;
  const eventId = store.appendEvent({
    session_id: session.session_id,
    type: "permission.denied",
    data: connectorActionPreflightEventData(result),
  });
  const current = store.getSession(session.session_id);
  if (current && current.status !== previousStatus) {
    store.updateSession(session.session_id, { status: previousStatus });
  }
  return { ...result, session_id: session.session_id, recorded: true, event_id: eventId };
}

export function parseConnectorActionPreflightInput(args: string[]): ConnectorActionPreflightInput {
  const parsed = parseConnectorActionFlags(args);
  const positional = parsed.args;
  if (!parsed.command) {
    parsed.connector ??= positional[0];
    parsed.area ??= positional[1];
    parsed.operation ??= positional[2];
    if (!parsed.connector || !parsed.area || !parsed.operation) {
      throw new Error("Usage: action-preflight <connector> <area> <operation> [--kind read|mutation] [--surface first_class|cli|tool] [--request-class background|verification|interactive]");
    }
  }
  return {
    connector: parsed.connector,
    surface: parsed.surface,
    command: parsed.command,
    tool_name: parsed.tool_name,
    kind: parsed.kind,
    area: parsed.area,
    operation: parsed.operation,
    request_class: parsed.request_class,
  };
}

interface ParsedConnectorActionFlags extends ConnectorActionPreflightInput {
  args: string[];
}

function parseConnectorActionFlags(args: string[]): ParsedConnectorActionFlags {
  const parsed: ParsedConnectorActionFlags = { args: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const inline = parseInlineFlag(arg);
    const flag = inline?.flag ?? arg;
    const inlineValue = inline?.value;
    if (flag === "--connector") {
      parsed.connector = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--surface") {
      parsed.surface = parseSurface(inlineValue ?? requiredFlagValue(args, ++index, flag));
    } else if (flag === "--command") {
      parsed.command = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--tool-name") {
      parsed.tool_name = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--kind") {
      parsed.kind = parseKind(inlineValue ?? requiredFlagValue(args, ++index, flag));
    } else if (flag === "--area") {
      parsed.area = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--operation") {
      parsed.operation = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--request-class") {
      parsed.request_class = parseRequestClass(inlineValue ?? requiredFlagValue(args, ++index, flag));
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown action preflight option: ${arg}`);
    } else {
      parsed.args.push(arg);
    }
  }
  return parsed;
}

function parseInlineFlag(arg: string): { flag: string; value: string } | undefined {
  const index = arg.indexOf("=");
  if (!arg.startsWith("--") || index < 0) {
    return undefined;
  }
  return { flag: arg.slice(0, index), value: arg.slice(index + 1) };
}

function requiredFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseSurface(value: string): ConnectorActionSurface {
  if (value === "cli" || value === "tool" || value === "first_class") {
    return value;
  }
  throw new Error(`Unknown action surface: ${value}`);
}

function parseKind(value: string): ConnectorActionKind {
  if (value === "read" || value === "mutation") {
    return value;
  }
  throw new Error(`Unknown action kind: ${value}`);
}

function parseRequestClass(value: string): ConnectorActionRequestClass {
  if (
    value === "interactive"
    || value === "tool"
    || value === "verification"
    || value === "compaction"
    || value === "background"
    || value === "reflection"
  ) {
    return value;
  }
  throw new Error(`Unknown request class: ${value}`);
}

function connectorActionPreflightEventData(result: ConnectorActionPreflightResult): JsonObject {
  const action = result.action;
  return {
    preflight: true,
    request_class: result.request_class,
    decision: {
      status: result.status,
      reason: result.reason,
      policy_id: result.policy_id,
      policy_kind: result.policy_kind,
      review_surface: result.review_surface,
      connector: action.connector,
      connector_surface: action.surface,
      connector_action: action.kind,
      connector_area: action.area,
      connector_operation: action.operation,
    },
    arguments: {
      connector: action.connector,
      surface: action.surface,
      command: action.command,
      tool_name: action.tool_name,
      kind: action.kind,
      area: action.area,
      operation: action.operation,
    },
  } as JsonObject;
}
