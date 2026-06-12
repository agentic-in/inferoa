import type { ModelRequest } from "../types.js";

export type ExternalMutationKind = "mutation";
export type ExternalMutationSurface = "cli";
export type ExternalMutationPolicyDecision = "deny";
export type ExternalMutationPolicyStatus = "allow" | "deny";
export type ExternalMutationRequestClass = NonNullable<ModelRequest["request_class"]>;

export interface ExternalMutationAction {
  system: string;
  surface: ExternalMutationSurface;
  command: string;
  kind: ExternalMutationKind;
  area: string;
  operation: string;
}

export interface ExternalMutationPolicyDefinition {
  id: string;
  system: string;
  surface: ExternalMutationSurface;
  command: string;
  tool_names: string[];
  kind: ExternalMutationKind;
  request_classes: ExternalMutationRequestClass[];
  decision: ExternalMutationPolicyDecision;
  review_surface: string;
  description: string;
}

export interface ExternalMutationPolicyResult {
  status: ExternalMutationPolicyStatus;
  reason: string;
  request_class: ExternalMutationRequestClass;
  needs_review: boolean;
  review_surface?: string;
  policy_id?: string;
  policy_kind?: "external_mutation";
  action: ExternalMutationAction;
}

const githubCliMutationPolicy: ExternalMutationPolicyDefinition = {
  id: "github-cli-mutation",
  system: "github",
  surface: "cli",
  command: "gh",
  tool_names: ["run_command"],
  kind: "mutation",
  request_classes: ["background", "verification"],
  decision: "deny",
  review_surface: "loop inbox external_action_approval",
  description: "Deny known mutating GitHub CLI operations in unattended request classes.",
};

const npmCliMutationPolicy: ExternalMutationPolicyDefinition = {
  id: "npm-cli-package-publish",
  system: "npm",
  surface: "cli",
  command: "npm",
  tool_names: ["run_command"],
  kind: "mutation",
  request_classes: ["background", "verification"],
  decision: "deny",
  review_surface: "loop inbox external_action_approval",
  description: "Deny npm package publish commands in unattended request classes.",
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

export function listExternalMutationPolicyDefinitions(): ExternalMutationPolicyDefinition[] {
  return [githubCliMutationPolicy, npmCliMutationPolicy].map((definition) => ({
    ...definition,
    tool_names: [...definition.tool_names],
    request_classes: [...definition.request_classes],
  }));
}

export function classifyExternalMutationToolCall(toolName: string, args: Record<string, unknown>): ExternalMutationAction | undefined {
  if (typeof args.command !== "string") {
    return undefined;
  }
  return listExternalMutationPolicyDefinitions().some((definition) => definition.tool_names.includes(toolName))
    ? classifyExternalMutationCommand(args.command)
    : undefined;
}

export function classifyExternalMutationCommand(command: string): ExternalMutationAction | undefined {
  for (const segment of shellCommandSegments(command)) {
    const words = shellWords(segment);
    const action = classifyGitHubCliSegment(words) ?? classifyNpmCliSegment(words);
    if (action) {
      return action;
    }
  }
  return undefined;
}

export function decideExternalMutationPolicy(
  action: ExternalMutationAction,
  requestClass: ExternalMutationRequestClass = "interactive",
): ExternalMutationPolicyResult {
  const policy = matchingExternalMutationPolicy(action, requestClass);
  if (!policy) {
    return {
      status: "allow",
      reason: "external mutation is allowed for this request class",
      request_class: requestClass,
      needs_review: false,
      action,
    };
  }
  return {
    status: policy.decision,
    reason: "unattended external mutation requires explicit interactive approval",
    request_class: requestClass,
    needs_review: true,
    review_surface: policy.review_surface,
    policy_id: policy.id,
    policy_kind: "external_mutation",
    action,
  };
}

function matchingExternalMutationPolicy(
  action: ExternalMutationAction,
  requestClass: ExternalMutationRequestClass,
): ExternalMutationPolicyDefinition | undefined {
  return listExternalMutationPolicyDefinitions().find((definition) => (
    definition.system === action.system
    && definition.surface === action.surface
    && definition.command === action.command
    && definition.kind === action.kind
    && definition.request_classes.includes(requestClass)
  ));
}

function classifyGitHubCliSegment(words: string[]): ExternalMutationAction | undefined {
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
          system: "github",
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
        system: "github",
        surface: "cli",
        command: "gh",
        kind: "mutation",
        area: normalizedArea,
        operation: normalizedAction,
      }
    : undefined;
}

function classifyNpmCliSegment(words: string[]): ExternalMutationAction | undefined {
  const start = executableIndex(words);
  if (start === undefined || commandName(words[start]!) !== "npm") {
    return undefined;
  }
  const action = words[start + 1];
  if (action?.toLowerCase() !== "publish" || npmPublishIsDryRun(words.slice(start + 2))) {
    return undefined;
  }
  return {
    system: "npm",
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
