import { unknownSlashCommandMessage } from "./slash-notice.js";
import { isPathListInput } from "../util/path-input.js";

export type SlashCommandName =
  | "setup"
  | "model"
  | "system"
  | "access"
  | "sandbox"
  | "skills"
  | "goal"
  | "plan"
  | "autoresearch"
  | "tokenmaxxing"
  | "context"
  | "tools"
  | "sessions"
  | "daemon"
  | "doctor"
  | "help"
  | "clear"
  | "resume"
  | "exit";

export interface SlashCommandSpec {
  name: SlashCommandName;
  description: string;
  inlineHint?: string;
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
  { name: "sandbox", description: "Change OS sandbox mode and network boundary" },
  { name: "skills", description: "List skills or manage enabled skills" },
  { name: "goal", description: "Run /goal to start a long-horizon recursive goal" },
  { name: "plan", description: "Start or manage plan mode" },
  { name: "autoresearch", description: "Start or manage autoresearch experiments" },
  { name: "tokenmaxxing", description: "Show token, cache, RTK, and routing savings" },
  { name: "context", description: "Show context usage and compression state" },
  { name: "tools", description: "Show fixed tool schemas and renderer status" },
  { name: "sessions", description: "Manage chat sessions" },
  { name: "daemon", description: "Manage background daemon runs" },
  { name: "doctor", description: "Check endpoint, tool, and optional Omni health" },
  { name: "help", description: "Show keyboard shortcuts and slash commands" },
  { name: "clear", description: "Start a fresh session" },
  { name: "resume", description: "Resume a previous session" },
  { name: "exit", description: "Exit the TUI" },
];

export const SLASH_SUBCOMMANDS: SlashSubcommandSpec[] = [
  { command: "skills", name: "list", value: "/skills list", description: "Show discovered skills" },
  { command: "skills", name: "manage", value: "/skills manage", description: "Enable or disable skills" },
  { command: "goal", name: "show", value: "/goal show", description: "Show active goal state" },
  { command: "goal", name: "set", value: "/goal set", description: "Set or replace the goal objective" },
  { command: "goal", name: "plan", value: "/goal plan", description: "Update the goal's internal plan" },
  { command: "goal", name: "pause", value: "/goal pause", description: "Pause the current goal" },
  { command: "goal", name: "resume", value: "/goal resume", description: "Resume a paused goal" },
  { command: "goal", name: "budget", value: "/goal budget", description: "Set or clear the goal token budget" },
  { command: "goal", name: "complete", value: "/goal complete", description: "Mark the goal complete" },
  { command: "goal", name: "drop", value: "/goal drop", description: "Drop the current goal" },
  { command: "plan", name: "show", value: "/plan show", description: "Show active plan state" },
  { command: "plan", name: "set", value: "/plan set", description: "Set or replace the plan objective" },
  { command: "plan", name: "pause", value: "/plan pause", description: "Pause the current plan" },
  { command: "plan", name: "resume", value: "/plan resume", description: "Resume a paused plan" },
  { command: "plan", name: "approve", value: "/plan approve", description: "Approve the current plan for execution" },
  { command: "plan", name: "drop", value: "/plan drop", description: "Drop the current plan" },
  { command: "autoresearch", name: "status", value: "/autoresearch status", description: "Show autoresearch state" },
  { command: "autoresearch", name: "off", value: "/autoresearch off", description: "Disable autoresearch mode" },
  { command: "autoresearch", name: "clear", value: "/autoresearch clear", description: "Clear autoresearch state" },
  { command: "access", name: "status", value: "/access status", description: "Show this workspace's access mode" },
  { command: "access", name: "full", value: "/access full", description: "Allow full local file and tool access for this workspace" },
  { command: "access", name: "auto", value: "/access auto", description: "Auto-approve routine tools for this workspace" },
  { command: "access", name: "ask", value: "/access ask", description: "Ask before risky access in this workspace" },
  { command: "access", name: "custom", value: "/access custom", description: "Use custom config rules for this workspace" },
  { command: "sandbox", name: "status", value: "/sandbox status", description: "Show OS sandbox mode" },
  { command: "sandbox", name: "off", value: "/sandbox off", description: "Disable OS sandboxing" },
  { command: "sandbox", name: "read-only", value: "/sandbox read-only", description: "Enable read-only OS sandboxing" },
  { command: "sandbox", name: "workspace-write", value: "/sandbox workspace-write", description: "Allow workspace and tmp writes" },
  { command: "sandbox", name: "network on", value: "/sandbox network on", description: "Allow network inside sandbox" },
  { command: "sandbox", name: "network off", value: "/sandbox network off", description: "Restrict network inside sandbox" },
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
  { command: "doctor", name: "status", value: "/doctor status", description: "Show configuration health" },
  { command: "doctor", name: "run", value: "/doctor run", description: "Probe configured endpoint and optional Omni routes" },
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

export function bareSlashCommandWithSubcommands(input: string): SlashCommandName | undefined {
  const value = input.toLowerCase();
  if (!value.startsWith("/") || /\s/.test(value)) {
    return undefined;
  }
  const rawName = value.slice(1);
  const name = rawName ? COMMAND_ALIASES.get(rawName) ?? (rawName as SlashCommandName) : undefined;
  if (!name || !COMMANDS.has(name)) {
    return undefined;
  }
  return slashSubcommands(name).length ? name : undefined;
}
