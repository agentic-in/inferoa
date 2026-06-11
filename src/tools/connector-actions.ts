import type { ModelRequest } from "../types.js";

export type ConnectorActionKind = "read" | "mutation";
export type ConnectorActionSurface = "cli" | "tool" | "first_class";
export type ConnectorCommandActionKind = "mutation";
export type ConnectorActionPolicyDecision = "deny";
export type ConnectorActionPreflightStatus = "allow" | "deny";

export type ConnectorActionRequestClass = NonNullable<ModelRequest["request_class"]>;

export interface ConnectorAction {
  connector: string;
  surface: ConnectorActionSurface;
  command?: string;
  tool_name?: string;
  kind: ConnectorActionKind;
  area: string;
  operation: string;
}

export interface ConnectorCommandAction extends ConnectorAction {
  connector: string;
  surface: "cli";
  command: string;
  kind: ConnectorCommandActionKind;
  area: string;
  operation: string;
}

export interface ConnectorActionPolicyDefinition {
  id: string;
  connector: string;
  surface: ConnectorActionSurface;
  command?: string;
  tool_names: string[];
  kind: ConnectorCommandActionKind;
  request_classes: ConnectorActionRequestClass[];
  decision: ConnectorActionPolicyDecision;
  review_surface: string;
  description: string;
}

export interface ConnectorActionPreflightInput {
  connector?: string;
  surface?: ConnectorActionSurface;
  command?: string;
  tool_name?: string;
  kind?: ConnectorActionKind;
  area?: string;
  operation?: string;
  request_class?: ConnectorActionRequestClass;
}

export interface ConnectorActionPreflightResult {
  status: ConnectorActionPreflightStatus;
  reason: string;
  request_class: ConnectorActionRequestClass;
  needs_review: boolean;
  review_surface?: string;
  policy_id?: string;
  policy_kind?: "connector_mutation";
  action: ConnectorAction;
}

const githubCliMutationPolicy: ConnectorActionPolicyDefinition = {
  id: "github-cli-mutation",
  connector: "github",
  surface: "cli",
  command: "gh",
  tool_names: ["run_command"],
  kind: "mutation",
  request_classes: ["background", "verification"],
  decision: "deny",
  review_surface: "loop inbox action_review",
  description: "Deny known mutating GitHub CLI operations in unattended request classes.",
};

const npmCliMutationPolicy: ConnectorActionPolicyDefinition = {
  id: "npm-cli-package-publish",
  connector: "npm",
  surface: "cli",
  command: "npm",
  tool_names: ["run_command"],
  kind: "mutation",
  request_classes: ["background", "verification"],
  decision: "deny",
  review_surface: "loop inbox action_review",
  description: "Deny npm package publish commands in unattended request classes.",
};

const firstClassConnectorMutationPolicy: ConnectorActionPolicyDefinition = {
  id: "first-class-connector-mutation",
  connector: "*",
  surface: "first_class",
  tool_names: [],
  kind: "mutation",
  request_classes: ["background", "verification"],
  decision: "deny",
  review_surface: "loop inbox action_review",
  description: "Deny first-class connector mutations in unattended request classes before execution.",
};

const githubMutationSubcommands: Record<string, Set<string>> = {
  api: new Set(["delete", "patch", "post", "put"]),
  codespace: new Set(["create", "delete", "rebuild", "stop"]),
  gist: new Set(["create", "delete", "edit", "rename"]),
  issue: new Set(["close", "comment", "create", "delete", "develop", "edit", "lock", "pin", "reopen", "transfer", "unlock", "unpin"]),
  label: new Set(["create", "delete", "edit"]),
  pr: new Set(["close", "comment", "create", "edit", "merge", "ready", "reopen", "review"]),
  project: new Set(["close", "copy", "create", "delete", "edit", "field-create", "field-delete", "field-update", "item-add", "item-archive", "item-create", "item-delete", "item-edit", "item-unarchive", "mark-template", "unlink", "unmark-template"]),
  release: new Set(["create", "delete", "edit", "upload"]),
  repo: new Set(["archive", "create", "delete", "deploy-key", "edit", "fork", "rename", "sync", "unarchive"]),
  run: new Set(["cancel", "delete", "rerun"]),
  secret: new Set(["delete", "set"]),
  variable: new Set(["delete", "set"]),
  workflow: new Set(["disable", "enable", "run"]),
};

export function listConnectorActionPolicyDefinitions(): ConnectorActionPolicyDefinition[] {
  return [githubCliMutationPolicy, npmCliMutationPolicy, firstClassConnectorMutationPolicy].map((definition) => ({
    ...definition,
    tool_names: [...definition.tool_names],
    request_classes: [...definition.request_classes],
  }));
}

export function classifyConnectorToolAction(toolName: string, args: Record<string, unknown>): ConnectorCommandAction | undefined {
  if (githubCliMutationPolicy.tool_names.includes(toolName) && typeof args.command === "string") {
    return classifyConnectorCommandAction(args.command);
  }
  return undefined;
}

export function classifyConnectorCommandAction(command: string): ConnectorCommandAction | undefined {
  for (const segment of shellCommandSegments(command)) {
    const words = shellWords(segment);
    const action = classifyGitHubCliSegment(words) ?? classifyNpmCliSegment(words);
    if (action) {
      return action;
    }
  }
  return undefined;
}

export function preflightConnectorAction(input: ConnectorActionPreflightInput): ConnectorActionPreflightResult {
  const requestClass = normalizeRequestClass(input.request_class);
  const action = actionFromPreflightInput(input);
  return decideConnectorActionPolicy(action, requestClass);
}

export function decideConnectorActionPolicy(
  action: ConnectorAction,
  requestClass: ConnectorActionRequestClass = "interactive",
): ConnectorActionPreflightResult {
  const policy = matchingConnectorActionPolicy(action, requestClass);
  if (!policy) {
    return {
      status: "allow",
      reason: action.kind === "mutation"
        ? "connector mutation is allowed for this request class"
        : "no connector mutation policy matched",
      request_class: requestClass,
      needs_review: false,
      action,
    };
  }
  return {
    status: policy.decision,
    reason: "unattended connector mutation requires explicit interactive approval",
    request_class: requestClass,
    needs_review: true,
    review_surface: policy.review_surface,
    policy_id: policy.id,
    policy_kind: "connector_mutation",
    action,
  };
}

function actionFromPreflightInput(input: ConnectorActionPreflightInput): ConnectorAction {
  if (input.command) {
    const classified = classifyConnectorCommandAction(input.command);
    if (classified) {
      return classified;
    }
  }
  const commandName = input.command ? commandNameFromCommand(input.command) : undefined;
  return {
    connector: normalizeIdentifier(input.connector) ?? (commandName === "gh" ? "github" : commandName === "npm" ? "npm" : "unknown"),
    surface: input.surface ?? (input.command ? "cli" : "first_class"),
    command: commandName,
    tool_name: normalizeIdentifier(input.tool_name),
    kind: input.kind ?? (input.command ? "read" : "mutation"),
    area: normalizeIdentifier(input.area) ?? "unknown",
    operation: normalizeIdentifier(input.operation) ?? "unknown",
  };
}

function matchingConnectorActionPolicy(
  action: ConnectorAction,
  requestClass: ConnectorActionRequestClass,
): ConnectorActionPolicyDefinition | undefined {
  return listConnectorActionPolicyDefinitions().find((definition) => {
    if (definition.surface !== action.surface) {
      return false;
    }
    if (definition.connector !== "*" && definition.connector !== action.connector) {
      return false;
    }
    if (definition.command && definition.command !== action.command) {
      return false;
    }
    if (definition.kind !== action.kind) {
      return false;
    }
    return definition.request_classes.includes(requestClass);
  });
}

function normalizeRequestClass(value: ConnectorActionRequestClass | undefined): ConnectorActionRequestClass {
  return value ?? "background";
}

function normalizeIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return normalized || undefined;
}

function commandNameFromCommand(command: string): string | undefined {
  for (const segment of shellCommandSegments(command)) {
    const words = shellWords(segment);
    const start = executableIndex(words);
    if (start !== undefined) {
      return commandName(words[start]!);
    }
  }
  return undefined;
}

function classifyGitHubCliSegment(words: string[]): ConnectorCommandAction | undefined {
  const start = executableIndex(words);
  if (start === undefined || commandName(words[start]!) !== "gh") {
    return undefined;
  }
  const area = words[start + 1];
  if (!area || area.startsWith("-")) {
    return undefined;
  }
  const normalizedArea = area.toLowerCase();
  if (normalizedArea === "api") {
    const method = githubApiMutationMethod(words.slice(start + 2));
    return method
      ? {
          connector: "github",
          surface: "cli",
          command: "gh",
          kind: "mutation",
          area: normalizedArea,
          operation: method,
        }
      : undefined;
  }
  const action = words.slice(start + 2).find((word) => !word.startsWith("-"));
  if (!action) {
    return undefined;
  }
  const normalizedAction = action.toLowerCase();
  return githubMutationSubcommands[normalizedArea]?.has(normalizedAction)
    ? {
        connector: "github",
        surface: "cli",
        command: "gh",
        kind: "mutation",
        area: normalizedArea,
        operation: normalizedAction,
      }
    : undefined;
}

function classifyNpmCliSegment(words: string[]): ConnectorCommandAction | undefined {
  const start = executableIndex(words);
  if (start === undefined || commandName(words[start]!) !== "npm") {
    return undefined;
  }
  const action = words[start + 1];
  if (action?.toLowerCase() !== "publish" || npmPublishIsDryRun(words.slice(start + 2))) {
    return undefined;
  }
  return {
    connector: "npm",
    surface: "cli",
    command: "npm",
    kind: "mutation",
    area: "package",
    operation: "publish",
  };
}

function npmPublishIsDryRun(args: string[]): boolean {
  return args.some((arg) => arg === "--dry-run" || arg === "--dry-run=true");
}

function githubApiMutationMethod(args: string[]): string | undefined {
  let explicitMethod: string | undefined;
  let hasWriteParameters = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    const lower = word.toLowerCase();
    if (lower === "--method" || lower === "-x") {
      explicitMethod = args[index + 1]?.toLowerCase();
      index += 1;
      continue;
    }
    const inlineMethod = /^--method=(.+)$/i.exec(word);
    if (inlineMethod) {
      explicitMethod = inlineMethod[1]!.toLowerCase();
      continue;
    }
    const shortInlineMethod = /^-x=?(.+)$/i.exec(word);
    if (shortInlineMethod) {
      explicitMethod = shortInlineMethod[1]!.toLowerCase();
      continue;
    }
    if (lower === "--field" || lower === "-f" || lower === "--raw-field" || lower === "--input") {
      hasWriteParameters = true;
      index += 1;
      continue;
    }
    if (/^(--field=|-f|--raw-field=|--input=)/i.test(word)) {
      hasWriteParameters = true;
    }
  }
  if (explicitMethod !== undefined) {
    return explicitMethod !== "get" ? explicitMethod : undefined;
  }
  if (hasWriteParameters) {
    return "post";
  }
  return undefined;
}

function executableIndex(words: string[]): number | undefined {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (!word || isEnvAssignment(word)) {
      continue;
    }
    if (word === "env" || word === "command" || word === "sudo") {
      continue;
    }
    if (word.startsWith("-")) {
      continue;
    }
    return index;
  }
  return undefined;
}

function commandName(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function shellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const next = command[index + 1];
    if (char === "\n" || char === ";" || char === "|" || char === "&" || (char === ">" && next === ">")) {
      const trimmed = current.trim();
      if (trimmed) {
        segments.push(trimmed);
      }
      current = "";
      if ((char === "|" || char === "&") && next === char) {
        index += 1;
      }
      continue;
    }
    current += char;
  }
  const trimmed = current.trim();
  if (trimmed) {
    segments.push(trimmed);
  }
  return segments;
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    words.push(current);
  }
  return words;
}

function isEnvAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word);
}
