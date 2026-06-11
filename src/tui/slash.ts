import { unknownSlashCommandMessage } from "./slash-notice.js";
import { isPathListInput } from "../util/path-input.js";

export type SlashCommandName =
  | "setup"
  | "model"
  | "system"
  | "access"
  | "skills"
  | "loop"
  | "inbox"
  | "self-improve"
  | "plan"
  | "tokenmaxxing"
  | "context"
  | "tools"
  | "sessions"
  | "daemon"
  | "automation"
  | "discovery"
  | "worktree"
  | "doctor"
  | "help"
  | "clear"
  | "resume"
  | "exit";

export interface SlashCommandSpec {
  name: SlashCommandName;
  description: string;
  inlineHint?: string;
  suggested?: boolean;
}

export interface SlashSubcommandSpec {
  command: SlashCommandName;
  name: string;
  value: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandSpec[] = [
  { name: "setup", description: "Open endpoint, provider, and Omni setup" },
  { name: "model", description: "Open model/provider selector" },
  { name: "system", description: "Show model, web search, Omni, and runtime status" },
  { name: "access", description: "Change this workspace's file and tool access" },
  { name: "skills", description: "List skills or manage enabled skills" },
  { name: "loop", description: "Start or manage long-running loops" },
  { name: "inbox", description: "Show loop review, blocker, automation, and self-improve items" },
  { name: "self-improve", description: "Manage loop learning proposals and replay reports" },
  { name: "plan", description: "Start or manage plan mode" },
  { name: "tokenmaxxing", description: "Show token, cache, RTK, and routing savings" },
  { name: "context", description: "Show context usage and compression state" },
  { name: "tools", description: "Show fixed tool schemas and renderer status" },
  { name: "sessions", description: "Manage chat sessions" },
  { name: "daemon", description: "Manage background daemon runs", suggested: false },
  { name: "automation", description: "Manage recurring loop automation", suggested: false },
  { name: "discovery", description: "Manage structured scheduled discovery", suggested: false },
  { name: "worktree", description: "Manage isolated loop worktrees" },
  { name: "doctor", description: "Check endpoint, tool, and optional Omni health" },
  { name: "help", description: "Show keyboard shortcuts and slash commands" },
  { name: "clear", description: "Start a fresh session" },
  { name: "resume", description: "Resume a previous session" },
  { name: "exit", description: "Exit the TUI" },
];

export const SLASH_SUBCOMMANDS: SlashSubcommandSpec[] = [
  { command: "skills", name: "list", value: "/skills list", description: "Show discovered skills" },
  { command: "skills", name: "manage", value: "/skills manage", description: "Enable or disable skills" },
  { command: "loop", name: "status", value: "/loop status", description: "Show active loop state" },
  { command: "loop", name: "health", value: "/loop health", description: "Show workspace loop health" },
  { command: "loop", name: "mode auto", value: "/loop mode auto", description: "Start a default auto loop" },
  { command: "loop", name: "mode research", value: "/loop mode research", description: "Start a research loop" },
  { command: "loop", name: "mode focus", value: "/loop mode focus", description: "Start a focused loop" },
  { command: "loop", name: "mode explore", value: "/loop mode explore", description: "Start an exploratory loop" },
  { command: "loop", name: "mode timebox", value: "/loop mode timebox", description: "Start a timeboxed loop" },
  { command: "loop", name: "review", value: "/loop review", description: "Review a pending loop decision" },
  { command: "loop", name: "verify", value: "/loop verify", description: "Run an independent loop verification pass" },
  { command: "loop", name: "pause", value: "/loop pause", description: "Pause the current loop" },
  { command: "loop", name: "resume", value: "/loop resume", description: "Resume a paused loop" },
  { command: "loop", name: "drop", value: "/loop drop", description: "Drop the current loop" },
  { command: "inbox", name: "show", value: "/inbox", description: "Show loop inbox items" },
  { command: "inbox", name: "all", value: "/inbox all", description: "Include terminal loop inbox items" },
  { command: "inbox", name: "resolve", value: "/inbox resolve", description: "Mark an inbox item resolved" },
  { command: "inbox", name: "dismiss", value: "/inbox dismiss", description: "Hide an inbox item" },
  { command: "inbox", name: "promote", value: "/inbox promote", description: "Queue a runnable inbox item" },
  { command: "self-improve", name: "status", value: "/self-improve status", description: "Show learning evidence, proposals, and replay count" },
  { command: "self-improve", name: "propose", value: "/self-improve propose", description: "Stage a learned workspace skill proposal" },
  { command: "self-improve", name: "run replay", value: "/self-improve run --replay", description: "Run structured replay/gating for a proposal" },
  { command: "self-improve", name: "report", value: "/self-improve report", description: "Show the latest replay report" },
  { command: "self-improve", name: "adopt", value: "/self-improve adopt", description: "Adopt a staged learned workspace skill" },
  { command: "plan", name: "show", value: "/plan show", description: "Show active plan state" },
  { command: "plan", name: "set", value: "/plan set", description: "Set or replace the plan objective" },
  { command: "plan", name: "pause", value: "/plan pause", description: "Pause the current plan" },
  { command: "plan", name: "resume", value: "/plan resume", description: "Resume a paused plan" },
  { command: "plan", name: "approve", value: "/plan approve", description: "Approve the current plan for execution" },
  { command: "plan", name: "drop", value: "/plan drop", description: "Drop the current plan" },
  { command: "tokenmaxxing", name: "signals", value: "/tokenmaxxing signals", description: "Show raw tokenmaxxing evidence and lifecycle signals" },
  { command: "access", name: "status", value: "/access status", description: "Show this workspace's access mode" },
  { command: "access", name: "full", value: "/access full", description: "Allow full local file and tool access for this workspace" },
  { command: "access", name: "auto", value: "/access auto", description: "Auto-approve routine tools for this workspace" },
  { command: "access", name: "ask", value: "/access ask", description: "Ask before risky access in this workspace" },
  { command: "access", name: "custom", value: "/access custom", description: "Use custom config rules for this workspace" },
  { command: "context", name: "status", value: "/context", description: "Show context and code intelligence state" },
  { command: "context", name: "reindex", value: "/context reindex", description: "Rebuild the context index" },
  { command: "tools", name: "list", value: "/tools", description: "Show fixed tool schemas" },
  { command: "tools", name: "expand", value: "/tools expand", description: "Expand the latest tool run" },
  { command: "tools", name: "compact", value: "/tools compact", description: "Fold long successful tool runs" },
  { command: "tools", name: "last", value: "/tools last", description: "Show the latest tool trace" },
  { command: "sessions", name: "resume", value: "/sessions resume", description: "Attach to a previous session" },
  { command: "sessions", name: "new", value: "/sessions new", description: "Start a fresh session" },
  { command: "sessions", name: "all", value: "/sessions all", description: "Show active and archived sessions" },
  { command: "daemon", name: "status", value: "/daemon status", description: "Show daemon and background run state" },
  { command: "daemon", name: "queue", value: "/daemon queue", description: "Queue a supervised run" },
  { command: "daemon", name: "attach", value: "/daemon attach", description: "Attach to a supervised run" },
  { command: "daemon", name: "detach", value: "/daemon detach", description: "Detach a supervised run" },
  { command: "daemon", name: "cancel", value: "/daemon cancel", description: "Cancel a supervised run" },
  { command: "automation", name: "list", value: "/automation", description: "Show recurring schedules" },
  { command: "automation", name: "add", value: "/automation add", description: "Create a recurring schedule" },
  { command: "automation", name: "add review", value: "/automation add --review", description: "Create a review-gated recurring schedule" },
  { command: "automation", name: "run-due", value: "/automation run-due", description: "Enqueue due schedules now" },
  { command: "automation", name: "pause", value: "/automation pause", description: "Pause a schedule" },
  { command: "automation", name: "resume", value: "/automation resume", description: "Resume a schedule" },
  { command: "automation", name: "remove", value: "/automation remove", description: "Remove a schedule" },
  { command: "discovery", name: "list", value: "/discovery", description: "Show discovery schedules and candidates" },
  { command: "discovery", name: "add", value: "/discovery add", description: "Schedule a JSON-producing discovery command" },
  { command: "discovery", name: "add-git", value: "/discovery add-git", description: "Schedule local git changes discovery" },
  { command: "discovery", name: "add-github-issues", value: "/discovery add-github-issues", description: "Schedule GitHub issue discovery" },
  { command: "discovery", name: "add-github-assigned-issues", value: "/discovery add-github-assigned-issues", description: "Schedule assigned GitHub issue discovery" },
  { command: "discovery", name: "add-github-prs", value: "/discovery add-github-prs", description: "Schedule GitHub pull request discovery" },
  { command: "discovery", name: "add-github-assigned-prs", value: "/discovery add-github-assigned-prs", description: "Schedule assigned GitHub pull request discovery" },
  { command: "discovery", name: "add-github-review-requests", value: "/discovery add-github-review-requests", description: "Schedule GitHub review request discovery" },
  { command: "discovery", name: "add-github-notifications", value: "/discovery add-github-notifications", description: "Schedule GitHub notification discovery" },
  { command: "discovery", name: "add-github-ci", value: "/discovery add-github-ci", description: "Schedule failing GitHub Actions run discovery" },
  { command: "discovery", name: "add-github-draft-releases", value: "/discovery add-github-draft-releases", description: "Schedule draft GitHub release discovery" },
  { command: "discovery", name: "add-github-deployments", value: "/discovery add-github-deployments", description: "Schedule GitHub Deployment discovery" },
  { command: "discovery", name: "add-http", value: "/discovery add-http", description: "Schedule HTTP health discovery" },
  { command: "discovery", name: "add-npm-package", value: "/discovery add-npm-package", description: "Schedule npm package version/tag discovery" },
  { command: "discovery", name: "run-due", value: "/discovery run-due", description: "Run due discovery schedules now" },
  { command: "discovery", name: "pause", value: "/discovery pause", description: "Pause a discovery schedule" },
  { command: "discovery", name: "resume", value: "/discovery resume", description: "Resume a discovery schedule" },
  { command: "discovery", name: "remove", value: "/discovery remove", description: "Remove a discovery schedule" },
  { command: "worktree", name: "list", value: "/worktree", description: "Show managed worktrees" },
  { command: "worktree", name: "health", value: "/worktree health", description: "Show managed worktree health" },
  { command: "worktree", name: "adopt", value: "/worktree adopt", description: "Merge a managed worktree into the active checkout" },
  { command: "doctor", name: "status", value: "/doctor status", description: "Show configuration health" },
  { command: "doctor", name: "run", value: "/doctor run", description: "Probe configured endpoint and optional Omni routes" },
  { command: "doctor", name: "tools", value: "/doctor tools", description: "Ask the current agent to regress built-in tools" },
];

const COMMANDS = new Map(SLASH_COMMANDS.map((command) => [command.name, command]));
const COMMAND_ALIASES = new Map<string, SlashCommandName>([
  ["endpoint", "system"],
  ["endpoints", "system"],
  ["activity", "tokenmaxxing"],
  ["cache", "tokenmaxxing"],
  ["rtk", "tokenmaxxing"],
  ["evidence", "tokenmaxxing"],
  ["history", "tokenmaxxing"],
]);
const SUBCOMMANDS = SLASH_SUBCOMMANDS.reduce((map, command) => {
  const bucket = map.get(command.command) ?? [];
  bucket.push(command);
  map.set(command.command, bucket);
  return map;
}, new Map<SlashCommandName, SlashSubcommandSpec[]>());

export function parseSlashCommand(input: string): { command?: SlashCommandSpec; args: string; error?: string } {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { args: trimmed };
  }
  if (isPathListInput(trimmed)) {
    return { args: trimmed };
  }
  const body = trimmed.slice(1);
  const [namePart = "", ...rest] = body.split(/\s+/);
  const rawName = namePart.toLowerCase();
  const name = COMMAND_ALIASES.get(rawName) ?? (rawName as SlashCommandName);
  const command = COMMANDS.get(name);
  if (!command) {
    return { args: rest.join(" "), error: unknownSlashCommandMessage(namePart) };
  }
  return { command, args: rest.join(" ") };
}

export function slashSubcommands(command: SlashCommandName): SlashSubcommandSpec[] {
  return SUBCOMMANDS.get(command) ?? [];
}

export function suggestedSlashCommands(): SlashCommandSpec[] {
  return SLASH_COMMANDS.filter((command) => command.suggested !== false);
}

export function slashCommandWithSubcommands(input: string): SlashCommandName | undefined {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const rawName = trimmed.slice(1).split(/\s+/)[0];
  const name = rawName ? COMMAND_ALIASES.get(rawName) ?? (rawName as SlashCommandName) : undefined;
  if (!name || !COMMANDS.has(name)) {
    return undefined;
  }
  return slashSubcommands(name).length ? name : undefined;
}
