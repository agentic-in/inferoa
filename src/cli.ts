#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadApp, type AppOptions } from "./app.js";
import { userConfigPath } from "./config/config.js";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import { TuiApp } from "./tui/app.js";
import { EndpointSignals } from "./model/endpoint-signals.js";
import { SkillRegistry } from "./skills/registry.js";
import { ToolRegistry } from "./tools/registry.js";
import { randomId } from "./util/hash.js";
import { ensureDir } from "./util/fs.js";
import { fail } from "./util/limit.js";
import type { JsonObject, ToolCall } from "./types.js";
import {
  createLoopAutomationSchedule,
  enqueueDueAutomationSchedules,
  parseAutomationInterval,
  pauseLoopAutomationSchedule,
  removeLoopAutomationSchedule,
  resumeLoopAutomationSchedule,
  type AutomationIsolation,
  type AutomationReviewPolicy,
} from "./loop/automation.js";
import {
  createGitChangesDiscoverySchedule,
  createGitHubAssignedIssuesDiscoverySchedule,
  createGitHubAssignedPullRequestsDiscoverySchedule,
  createGitHubActionsDiscoverySchedule,
  createGitHubDeploymentsDiscoverySchedule,
  createGitHubDraftReleasesDiscoverySchedule,
  createGitHubIssuesDiscoverySchedule,
  createGitHubNotificationsDiscoverySchedule,
  createGitHubPullRequestsDiscoverySchedule,
  createGitHubReviewRequestsDiscoverySchedule,
  createHttpHealthDiscoverySchedule,
  createLoopDiscoverySchedule,
  createNpmPackageDiscoverySchedule,
  pauseLoopDiscoverySchedule,
  removeLoopDiscoverySchedule,
  resumeLoopDiscoverySchedule,
  runDueDiscoverySchedules,
} from "./loop/discovery.js";
import {
  parseLoopInboxSnoozeUntil,
  promoteLoopInboxItem,
  readLoopInbox,
  readLoopInboxRouting,
  updateLoopInboxAssignment,
  updateLoopInboxItemState,
  updateLoopInboxMute,
  updateLoopInboxRouting,
  type LoopInboxAction,
  type LoopInboxItemKind,
  type LoopInboxPriority,
  type LoopInboxPromotionIsolation,
} from "./loop/inbox.js";
import { readLoopHealth } from "./loop/health.js";
import { readLoopDashboard } from "./loop/dashboard.js";
import { readLoopMetrics } from "./loop/metrics.js";
import { readLoopEvidence } from "./loop/evidence.js";
import { readLoopTrace } from "./loop/trace.js";
import { readLoopRoadmap } from "./loop/roadmap.js";
import { readLoopWorkers } from "./loop/workers.js";
import { readLoopConnectors } from "./loop/connectors.js";
import { readLoopTasks } from "./loop/tasks.js";
import { parseConnectorActionPreflightInput, recordConnectorActionPreflight } from "./loop/action-preflight.js";
import { parseConnectorActionRunInput, runConnectorAction } from "./loop/actions.js";
import { readLoopActions } from "./loop/action-log.js";
import { queueGoalVerificationSuite, runGoalVerificationSuite } from "./loop/verifier-suite.js";
import { runConnectorVerifier } from "./loop/connector-verifiers.js";
import { readLoopPolicy, resolveLoopBackgroundIsolation } from "./loop/policy.js";
import { optLiteAdopt, optLitePropose, optLiteReplay, optLiteReport, optLiteRun, optLiteStatus } from "./opt/opt-lite.js";
import {
  attachDaemonJob,
  cancelDaemonJob,
  daemonStatus,
  detachDaemonJob,
  queueDaemonGoalInWorktree,
  queueDaemonGoal,
  queueDaemonRunInWorktree,
  queueDaemonRun,
  startDaemon,
} from "./daemon/supervisor.js";
import { adoptLoopWorktree, cleanupLoopWorktrees, createLoopWorktree, listLoopWorktrees, readLoopWorktreeHealth, removeLoopWorktree } from "./loop/worktree.js";
import { readGoalState } from "./goals/state.js";
import { buildGoalVerificationPrompt, parseGoalVerifierArgs } from "./goals/verifier.js";
import { runFinalAcceptance } from "./validation/acceptance.js";

interface ParsedCli extends AppOptions {
  json?: boolean;
  help?: boolean;
  print?: boolean;
  noAnimation?: boolean;
  initialView?: "setup";
  prompt?: string;
  debug?: string[];
  selfImprove?: string[];
  loop?: string[];
  inbox?: string[];
  automation?: string[];
  discovery?: string[];
  worktree?: string[];
  verify?: string[];
  verifyGithubPr?: string[];
  verifyGithubPrStatus?: string[];
  verifyGithubReviewRequest?: string[];
  verifyGithubIssueStatus?: string[];
  verifyGithubNotification?: string[];
  verifyGithubRun?: string[];
  verifyGithubWorkflow?: string[];
  verifyGithubDeployment?: string[];
  verifyGithubRelease?: string[];
  verifyNpmPackage?: string[];
  verifyGitClean?: string[];
  verifyHttp?: string[];
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }
  if (parsed.debug) {
    await runDebug(parsed);
    return;
  }
  if (parsed.print) {
    await runPrint(parsed);
    return;
  }
  if (parsed.selfImprove) {
    await runSelfImprove(parsed);
    return;
  }
  if (parsed.loop) {
    await runLoop(parsed);
    return;
  }
  if (parsed.automation) {
    await runAutomation(parsed);
    return;
  }
  if (parsed.discovery) {
    await runDiscovery(parsed);
    return;
  }
  if (parsed.worktree) {
    await runWorktree(parsed);
    return;
  }
  if (parsed.verifyGithubPr) {
    await runVerifyGithubPr(parsed);
    return;
  }
  if (parsed.verifyGithubPrStatus) {
    await runVerifyGithubPrStatus(parsed);
    return;
  }
  if (parsed.verifyGithubReviewRequest) {
    await runVerifyGithubReviewRequest(parsed);
    return;
  }
  if (parsed.verifyGithubIssueStatus) {
    await runVerifyGithubIssueStatus(parsed);
    return;
  }
  if (parsed.verifyGithubNotification) {
    await runVerifyGithubNotification(parsed);
    return;
  }
  if (parsed.verifyGithubRun) {
    await runVerifyGithubRun(parsed);
    return;
  }
  if (parsed.verifyGithubWorkflow) {
    await runVerifyGithubWorkflow(parsed);
    return;
  }
  if (parsed.verifyGithubDeployment) {
    await runVerifyGithubDeployment(parsed);
    return;
  }
  if (parsed.verifyGithubRelease) {
    await runVerifyGithubRelease(parsed);
    return;
  }
  if (parsed.verifyNpmPackage) {
    await runVerifyNpmPackage(parsed);
    return;
  }
  if (parsed.verifyGitClean) {
    await runVerifyGitClean(parsed);
    return;
  }
  if (parsed.verifyHttp) {
    await runVerifyHttp(parsed);
    return;
  }
  if (parsed.verify) {
    await runVerify(parsed);
    return;
  }
  if (parsed.inbox) {
    await runInbox(parsed);
    return;
  }
  const app = await loadApp(parsed);
  try {
    await new TuiApp(app, {
      initialPrompt: parsed.prompt,
      initialView: parsed.initialView,
      stateDir: parsed.stateDir,
      noAnimation: parsed.noAnimation,
    }).run();
  } finally {
    closeApp(app);
  }
}

function closeApp(app: Awaited<ReturnType<typeof loadApp>>): void {
  app.runtime.dispose();
  app.store.close();
}

function parseArgs(argv: string[]): ParsedCli {
  const parsed: ParsedCli = {};
  const prompt: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--config") {
      parsed.config = requiredValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--workspace") {
      parsed.workspace = requiredValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--state-dir") {
      parsed.stateDir = requiredValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--print" || arg === "-p") {
      parsed.print = true;
      continue;
    }
    if (arg === "--no-animation") {
      parsed.noAnimation = true;
      continue;
    }
    if (arg === "debug") {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.debug = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "self-improve" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.selfImprove = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "loop" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.loop = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "inbox" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.inbox = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "automation" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.automation = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "discovery" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.discovery = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "worktree" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.worktree = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "verify" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.verify = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "verify-github-pr" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.verifyGithubPr = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "verify-github-pr-status" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.verifyGithubPrStatus = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "verify-github-review-request" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.verifyGithubReviewRequest = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "verify-github-issue-status" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.verifyGithubIssueStatus = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "verify-github-notification" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.verifyGithubNotification = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "verify-github-run" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.verifyGithubRun = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "verify-github-workflow" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.verifyGithubWorkflow = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "verify-github-deployment" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.verifyGithubDeployment = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "verify-github-release" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.verifyGithubRelease = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "verify-npm-package" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.verifyNpmPackage = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "verify-git-clean" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.verifyGitClean = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "verify-http" && prompt.length === 0) {
      const rest = argv.slice(i + 1);
      parsed.json = parsed.json || rest.includes("--json");
      parsed.verifyHttp = rest.filter((item) => item !== "--json");
      break;
    }
    if (arg === "setup" && prompt.length === 0) {
      parsed.initialView = "setup";
      continue;
    }
    prompt.push(arg, ...argv.slice(i + 1));
    break;
  }
  parsed.prompt = prompt.join(" ").trim() || undefined;
  return parsed;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Inferoa

Usage:
  inferoa                         Launch the TUI
  inferoa "prompt"                Launch the TUI and submit an initial prompt
  inferoa setup                   Launch the TUI setup wizard
  inferoa --print "prompt"        Non-interactive print mode
  inferoa loop health             Show loop health summary for this workspace
  inferoa inbox                   Show loop inbox items for this workspace
  inferoa worktree <command>      Manage isolated loop worktrees
  inferoa verify <session> [--role role|--roles role,role] [--background] [--worktree] [rubric]
                                   Run an independent loop verification pass
  inferoa self-improve <command>  Loop self-improvement commands
  inferoa debug <command>         Machine/debug commands

Options:
  --config <path>                    Config YAML path
  --workspace <path>                 Workspace root
  --state-dir <path>                 State directory, defaults to ~/.inferoa
  --json                             JSON output for debug commands
  --no-animation                     Disable TUI intro animation

TUI commands:
  /setup /model /system /skills /tokenmaxxing /context /tools /sessions
  /loop /inbox /self-improve /worktree /doctor /help /clear /exit
  $                                  Open skill catalog

Debug commands:
  init [--force]                    Write ~/.inferoa/config.yaml
  setup
  status
  sessions
  tools list
  tools call <name> [json]
  events <session> [limit]
  archive <session>
  daemon start|status|jobs|run|goal|attach|detach|cancel ...
  acceptance [--daemon]

Self-improve commands:
  status                           Show learning evidence/proposal status
  propose                          Stage a workspace skill proposal from verified loop evidence
  replay [proposal_id]             Replay structured samples and gate a staged proposal
  run --replay [proposal_id]        Run an explicit replay/gating job
  report [replay_id]               Show the latest or selected replay report
  adopt [proposal_id]              Adopt a staged proposal as an enabled workspace skill

Inbox options:
  --all                            Include terminal/done and snoozed items
  resolve <item_id> [note]          Mark an item resolved
  dismiss <item_id> [note]          Hide an item without marking its source complete
  promote [--worktree] <item_id>    Queue runnable item for background work

Worktree commands:
  list [--all]                      Show managed isolated worktrees
  health                            Show managed worktree health
  adopt <worktree_id> [--dry-run]   Merge a managed worktree branch into the active checkout
`);
}

async function runPrint(options: ParsedCli): Promise<void> {
  if (!options.prompt) {
    throw new Error("--print requires a prompt");
  }
  const app = await loadApp(options);
  try {
    const result = await app.runtime.run({
      prompt: options.prompt,
      client_id: randomId("print"),
      onDelta: options.json ? undefined : (text) => process.stdout.write(text),
    });
    if (!options.json) {
      process.stdout.write("\n");
    }
    print(
      {
        session: publicSession(result.session),
        content: result.content,
        tool_rounds: result.tool_rounds,
        tool_calls: result.tool_calls,
        duration_ms: result.duration_ms,
        tokens_used: result.tokens_used,
        rtk: result.rtk,
        goal_report: result.goal_report,
      },
      options.json,
    );
  } finally {
    closeApp(app);
  }
}

async function runSelfImprove(options: ParsedCli): Promise<void> {
  const [command = "status", ...rest] = options.selfImprove ?? [];
  const app = await loadApp(options);
  try {
    switch (command) {
      case "status":
        print(await optLiteStatus(app.store, app.workspace), options.json);
        return;
      case "propose":
        print(await optLitePropose(app.store, app.workspace), options.json);
        return;
      case "replay": {
        const [proposalId] = rest;
        print(await optLiteReplay(app.store, app.workspace, proposalId), options.json);
        return;
      }
      case "run":
        print(await optLiteRun(app.store, app.workspace, parseOptRunArgs(rest)), options.json);
        return;
      case "report": {
        const [replayId] = rest;
        print(await optLiteReport(app.workspace, replayId), options.json);
        return;
      }
      case "adopt":
        {
        const [proposalId] = rest;
        print(await optLiteAdopt(app.store, app.workspace, app.config, proposalId), options.json);
        return;
        }
      default:
        throw new Error(`Unknown self-improve command: ${command}`);
    }
  } finally {
    closeApp(app);
  }
}

function parseOptRunArgs(args: string[]): { replay: boolean; proposal_id?: string } {
  let replay = false;
  let proposalId: string | undefined;
  for (const arg of args) {
    if (arg === "--replay") {
      replay = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown self-improve run option: ${arg}`);
    }
    if (proposalId) {
      throw new Error(`Unexpected self-improve run argument: ${arg}`);
    }
    proposalId = arg;
  }
  return { replay, proposal_id: proposalId };
}

async function runInbox(options: ParsedCli): Promise<void> {
  const args = options.inbox ?? [];
  const parsed = parseInboxArgs(args);
  const [command = "show", ...rest] = parsed.args;
  const app = await loadApp(options);
  try {
    if (command === "show" || command === "list" || command === "status" || command === "all") {
      print(await readLoopInbox(app.store, app.workspace, {
        includeDone: parsed.includeDone,
        includeSnoozed: parsed.includeDone,
        includeMuted: parsed.includeMuted,
        assignee: parsed.assignee,
        onlyUnassigned: parsed.onlyUnassigned,
      }), options.json);
      return;
    }
    if (command === "resolve" || command === "dismiss" || command === "reopen") {
      const itemId = requiredArg(rest, 0, "item_id");
      print(
        await updateLoopInboxItemState(app.store, app.workspace, {
          action: command as LoopInboxAction,
          item_id: itemId,
          note: rest.slice(1).join(" "),
        }),
        options.json,
      );
      return;
    }
    if (command === "promote") {
      const promote = parseInboxPromoteFlags(rest);
      print(
        await promoteLoopInboxItem(app.store, app.workspace, promote.item_id, {
          config_path: app.configFiles[0],
          isolation: resolveLoopBackgroundIsolation(promote.isolation, app.config),
        }),
        options.json,
      );
      return;
    }
    if (command === "assign") {
      const itemId = requiredArg(rest, 0, "item_id");
      const assignee = requiredArg(rest, 1, "owner");
      print(
        await updateLoopInboxAssignment(app.store, app.workspace, {
          item_id: itemId,
          assignee,
          note: rest.slice(2).join(" "),
        }),
        options.json,
      );
      return;
    }
    if (command === "unassign") {
      const itemId = requiredArg(rest, 0, "item_id");
      print(
        await updateLoopInboxAssignment(app.store, app.workspace, {
          item_id: itemId,
        }),
        options.json,
      );
      return;
    }
    if (command === "routes") {
      print(await readLoopInboxRouting(app.workspace), options.json);
      return;
    }
    if (command === "route") {
      const subcommand = requiredArg(rest, 0, "add|remove");
      if (subcommand === "list" || subcommand === "show") {
        print(await readLoopInboxRouting(app.workspace), options.json);
        return;
      }
      if (subcommand === "add") {
        const route = parseInboxRouteAddFlags(rest.slice(1));
        print(await updateLoopInboxRouting(app.workspace, { action: "add", ...route }), options.json);
        return;
      }
      if (subcommand === "remove" || subcommand === "delete") {
        print(await updateLoopInboxRouting(app.workspace, { action: "remove", route_id: requiredArg(rest, 1, "route_id") }), options.json);
        return;
      }
      throw new Error("Usage: inferoa inbox route list|add|remove ...");
    }
    if (command === "mute") {
      const itemId = requiredArg(rest, 0, "item_id");
      print(
        await updateLoopInboxMute(app.store, app.workspace, {
          action: "mute",
          item_id: itemId,
          note: rest.slice(1).join(" "),
        }),
        options.json,
      );
      return;
    }
    if (command === "unmute") {
      const itemId = requiredArg(rest, 0, "item_id_or_mute_key");
      print(
        await updateLoopInboxMute(app.store, app.workspace, {
          action: "unmute",
          item_id: itemId,
        }),
        options.json,
      );
      return;
    }
    if (command === "snooze") {
      const itemId = requiredArg(rest, 0, "item_id");
      const until = parseLoopInboxSnoozeUntil(requiredArg(rest, 1, "duration"));
      print(
        await updateLoopInboxItemState(app.store, app.workspace, {
          action: "snooze",
          item_id: itemId,
          snoozed_until: until,
          note: rest.slice(2).join(" "),
        }),
        options.json,
      );
      return;
    }
    throw new Error("Usage: inferoa inbox [--all|--muted]|resolve|dismiss|snooze|assign|unassign|routes|route|mute|unmute|reopen|promote [--worktree] ...");
  } finally {
    closeApp(app);
  }
}

function parseInboxArgs(args: string[]): { args: string[]; includeDone: boolean; includeMuted: boolean; assignee?: string; onlyUnassigned?: boolean } {
  const output: string[] = [];
  let includeDone = false;
  let includeMuted = false;
  let assignee: string | undefined;
  let onlyUnassigned = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all" || arg === "all") {
      includeDone = true;
      includeMuted = true;
      continue;
    }
    if (arg === "--muted" || arg === "muted") {
      includeMuted = true;
      continue;
    }
    if (arg === "--unassigned") {
      onlyUnassigned = true;
      continue;
    }
    if (arg === "--assignee") {
      assignee = requiredArg(args, index + 1, "owner");
      index += 1;
      continue;
    }
    if (arg?.startsWith("--assignee=")) {
      assignee = arg.slice("--assignee=".length);
      continue;
    }
    if (arg) {
      output.push(arg);
    }
  }
  if (assignee) {
    onlyUnassigned = false;
  }
  return { args: output, includeDone, includeMuted, assignee, onlyUnassigned };
}

function parseInboxRouteAddFlags(args: string[]): {
  route_id?: string;
  assignee: string;
  note?: string;
  kind?: LoopInboxItemKind;
  source?: string;
  priority?: LoopInboxPriority;
} {
  const owner = requiredArg(args, 0, "owner");
  let rest = args.slice(1);
  const id = consumeFlagValue(rest, "--id");
  rest = id.rest;
  const kind = consumeFlagValue(rest, "--kind");
  rest = kind.rest;
  const source = consumeFlagValue(rest, "--source");
  rest = source.rest;
  const priority = consumeFlagValue(rest, "--priority");
  rest = priority.rest;
  const unknown = rest.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown inbox route option: ${unknown}`);
  }
  return {
    route_id: id.value,
    assignee: owner,
    note: rest.join(" "),
    kind: parseInboxKindFlag(kind.value),
    source: source.value,
    priority: parseInboxPriorityFlag(priority.value),
  };
}

function parseInboxKindFlag(value: string | undefined): LoopInboxItemKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === "goal_review"
    || value === "goal_blocker"
    || value === "goal_paused"
    || value === "verification_failure"
    || value === "stale_work"
    || value === "automation_review"
    || value === "action_review"
    || value === "discovery_candidate"
    || value === "daemon_job"
    || value === "skill_proposal"
    || value === "self_improve_replay"
  ) {
    return value;
  }
  throw new Error(`Unknown inbox item kind: ${value}`);
}

function parseInboxPriorityFlag(value: string | undefined): LoopInboxPriority | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  throw new Error(`Unknown inbox priority: ${value}`);
}

async function runLoop(options: ParsedCli): Promise<void> {
  const [command = "health", ...rest] = options.loop ?? [];
  const app = await loadApp(options);
  try {
    if (command === "health" || command === "status" || command === "show") {
      print(await readLoopHealth(app.store, app.workspace), options.json);
      return;
    }
    if (command === "dashboard" || command === "overview") {
      print(await readLoopDashboard(app.store, app.workspace), options.json);
      return;
    }
    if (command === "metrics") {
      print(readLoopMetrics(app.store, app.workspace), options.json);
      return;
    }
    if (command === "tasks" || command === "task") {
      print(readLoopTasks(app.store, app.workspace), options.json);
      return;
    }
    if (command === "policy") {
      print(await readLoopPolicy(app.config, app.workspace), options.json);
      return;
    }
    if (command === "action-preflight" || command === "action") {
      const sessionPrefix = requiredArg(rest, 0, "session");
      const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
      if (!session) {
        throw new Error(`No session matches ${sessionPrefix}`);
      }
      const input = parseConnectorActionPreflightInput(rest.slice(1));
      print(recordConnectorActionPreflight(app.store, session, input), options.json);
      return;
    }
    if (command === "action-run" || command === "action-execute") {
      const sessionPrefix = requiredArg(rest, 0, "session");
      const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
      if (!session) {
        throw new Error(`No session matches ${sessionPrefix}`);
      }
      const input = parseConnectorActionRunInput(rest.slice(1));
      print(await runConnectorAction(app.store, session, input, {
        cwd: app.workspace.root,
        env: process.env,
      }), options.json);
      return;
    }
    if (command === "actions" || command === "action-log") {
      print(readLoopActions(app.store, app.workspace), options.json);
      return;
    }
    if (command === "roadmap" || command === "coverage") {
      print(readLoopRoadmap(), options.json);
      return;
    }
    if (command === "evidence") {
      const sessionPrefix = requiredArg(rest, 0, "session");
      const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
      if (!session) {
        throw new Error(`No session matches ${sessionPrefix}`);
      }
      print(readLoopEvidence(app.store, session), options.json);
      return;
    }
    if (command === "trace") {
      const sessionPrefix = requiredArg(rest, 0, "session");
      const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
      if (!session) {
        throw new Error(`No session matches ${sessionPrefix}`);
      }
      print(readLoopTrace(app.store, session), options.json);
      return;
    }
    if (command === "workers" || command === "worker") {
      print(readLoopWorkers(app.store, app.workspace), options.json);
      return;
    }
    if (command === "connectors" || command === "connector") {
      print(readLoopConnectors(app.store, app.workspace), options.json);
      return;
    }
    throw new Error("Usage: inferoa loop health");
  } finally {
    closeApp(app);
  }
}

async function runAutomation(options: ParsedCli): Promise<void> {
  const [command = "list", ...rest] = options.automation ?? [];
  const app = await loadApp(options);
  try {
    switch (command) {
      case "list":
      case "status":
        print({ schedules: app.store.listAutomationSchedules({ workspaceId: app.workspace.id }) }, options.json);
        return;
      case "add": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        const flags = parseAutomationFlags(rest.slice(1));
        const prompt = flags.args.join(" ").trim();
        if (!prompt) {
          throw new Error("Usage: inferoa automation add <15m|2h|1d> [--worktree|--active-checkout] [--review] <prompt>");
        }
        print(
          createLoopAutomationSchedule(app.store, app.workspace, {
            interval_ms: interval,
            prompt,
            config_path: app.configFiles[0],
            isolation: resolveLoopBackgroundIsolation(flags.isolation, app.config),
            review_policy: flags.review_policy,
          }),
          options.json,
        );
        return;
      }
      case "run-due":
        print(await enqueueDueAutomationSchedules(app.store), options.json);
        return;
      case "pause":
        print(pauseLoopAutomationSchedule(app.store, requiredArg(rest, 0, "schedule")), options.json);
        return;
      case "resume":
        print(resumeLoopAutomationSchedule(app.store, requiredArg(rest, 0, "schedule")), options.json);
        return;
      case "remove":
        print(removeLoopAutomationSchedule(app.store, requiredArg(rest, 0, "schedule")), options.json);
        return;
      default:
        throw new Error("Usage: inferoa automation list|add|run-due|pause|resume|remove ...");
    }
  } finally {
    closeApp(app);
  }
}

async function runDiscovery(options: ParsedCli): Promise<void> {
  const [command = "list", ...rest] = options.discovery ?? [];
  const app = await loadApp(options);
  try {
    switch (command) {
      case "list":
      case "status":
        print({
          schedules: app.store.listDiscoverySchedules({ workspaceId: app.workspace.id }),
          candidates: app.store.listDiscoveryCandidates({ workspaceId: app.workspace.id }),
        }, options.json);
        return;
      case "add": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        const discoveryCommand = rest.slice(1).join(" ").trim();
        if (!discoveryCommand) {
          throw new Error("Usage: inferoa discovery add <15m|2h|1d> <json-command>");
        }
        print(
          createLoopDiscoverySchedule(app.store, app.workspace, {
            interval_ms: interval,
            command: discoveryCommand,
          }),
          options.json,
        );
        return;
      }
      case "add-git": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        print(
          createGitChangesDiscoverySchedule(app.store, app.workspace, {
            interval_ms: interval,
          }),
          options.json,
        );
        return;
      }
      case "add-github-issues": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        const flags = parseDiscoveryConnectorFlags(rest.slice(1));
        print(
          createGitHubIssuesDiscoverySchedule(app.store, app.workspace, {
            interval_ms: interval,
            repo: flags.repo,
            labels: flags.labels,
            limit: flags.limit,
          }),
          options.json,
        );
        return;
      }
      case "add-github-assigned-issues": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        const flags = parseDiscoveryAssignedConnectorFlags(rest.slice(1));
        print(
          createGitHubAssignedIssuesDiscoverySchedule(app.store, app.workspace, {
            interval_ms: interval,
            repo: flags.repo,
            assignee: flags.assignee,
            labels: flags.labels,
            limit: flags.limit,
          }),
          options.json,
        );
        return;
      }
      case "add-github-assigned-prs": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        const flags = parseDiscoveryAssignedConnectorFlags(rest.slice(1));
        print(
          createGitHubAssignedPullRequestsDiscoverySchedule(app.store, app.workspace, {
            interval_ms: interval,
            repo: flags.repo,
            assignee: flags.assignee,
            labels: flags.labels,
            limit: flags.limit,
          }),
          options.json,
        );
        return;
      }
      case "add-github-prs": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        const flags = parseDiscoveryConnectorFlags(rest.slice(1));
        print(
          createGitHubPullRequestsDiscoverySchedule(app.store, app.workspace, {
            interval_ms: interval,
            repo: flags.repo,
            labels: flags.labels,
            limit: flags.limit,
          }),
          options.json,
        );
        return;
      }
      case "add-github-review-requests": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        const flags = parseDiscoveryConnectorFlags(rest.slice(1));
        print(
          createGitHubReviewRequestsDiscoverySchedule(app.store, app.workspace, {
            interval_ms: interval,
            repo: flags.repo,
            limit: flags.limit,
          }),
          options.json,
        );
        return;
      }
      case "add-github-notifications": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        const flags = parseDiscoveryNotificationFlags(rest.slice(1));
        print(
          createGitHubNotificationsDiscoverySchedule(app.store, app.workspace, {
            interval_ms: interval,
            repo: flags.repo,
            participating: flags.participating,
            limit: flags.limit,
          }),
          options.json,
        );
        return;
      }
      case "add-github-ci": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        const flags = parseDiscoveryConnectorFlags(rest.slice(1));
        print(
          createGitHubActionsDiscoverySchedule(app.store, app.workspace, {
            interval_ms: interval,
            repo: flags.repo,
            limit: flags.limit,
          }),
          options.json,
        );
        return;
      }
      case "add-github-draft-releases": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        const flags = parseDiscoveryConnectorFlags(rest.slice(1));
        print(
          createGitHubDraftReleasesDiscoverySchedule(app.store, app.workspace, {
            interval_ms: interval,
            repo: flags.repo,
            limit: flags.limit,
          }),
          options.json,
        );
        return;
      }
      case "add-github-deployments": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        const flags = parseDiscoveryDeploymentFlags(rest.slice(1));
        print(
          createGitHubDeploymentsDiscoverySchedule(app.store, app.workspace, {
            interval_ms: interval,
            repo: flags.repo,
            environment: flags.environment,
            ref: flags.ref,
            limit: flags.limit,
          }),
          options.json,
        );
        return;
      }
      case "add-http": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        const flags = parseDiscoveryHttpFlags(rest.slice(1));
        print(
          createHttpHealthDiscoverySchedule(app.store, app.workspace, {
            interval_ms: interval,
            url: flags.url,
            expected_status: flags.status,
            timeout_ms: flags.timeout_ms,
          }),
          options.json,
        );
        return;
      }
      case "add-npm-package": {
        const interval = parseAutomationInterval(requiredArg(rest, 0, "interval"));
        const flags = parseDiscoveryNpmPackageFlags(rest.slice(1));
        print(
          createNpmPackageDiscoverySchedule(app.store, app.workspace, {
            interval_ms: interval,
            package_name: flags.package_name,
            version: flags.version,
            tag: flags.tag,
          }),
          options.json,
        );
        return;
      }
      case "run-due":
        print(await runDueDiscoverySchedules(app.store), options.json);
        return;
      case "pause":
        print(pauseLoopDiscoverySchedule(app.store, requiredArg(rest, 0, "schedule")), options.json);
        return;
      case "resume":
        print(resumeLoopDiscoverySchedule(app.store, requiredArg(rest, 0, "schedule")), options.json);
        return;
      case "remove":
        print(removeLoopDiscoverySchedule(app.store, requiredArg(rest, 0, "schedule")), options.json);
        return;
      default:
        throw new Error("Usage: inferoa discovery list|add|add-git|add-github-issues|add-github-assigned-issues|add-github-prs|add-github-assigned-prs|add-github-review-requests|add-github-notifications|add-github-ci|add-github-draft-releases|add-github-deployments|add-http|add-npm-package|run-due|pause|resume|remove ...");
    }
  } finally {
    closeApp(app);
  }
}

async function runWorktree(options: ParsedCli): Promise<void> {
  const [command = "list", ...rest] = options.worktree ?? [];
  const app = await loadApp(options);
  try {
    switch (command) {
      case "list":
      case "status":
        print({ worktrees: listLoopWorktrees(app.store, app.workspace, { includeRemoved: rest.includes("--all") || rest.includes("all") }) }, options.json);
        return;
      case "health":
        print(readLoopWorktreeHealth(app.store, app.workspace), options.json);
        return;
      case "create": {
        const parsed = parseWorktreeFlags(rest);
        print(
          await createLoopWorktree(app.store, app.workspace, {
            base_ref: parsed.baseRef,
            branch: parsed.branch,
            path: parsed.path,
          }),
          options.json,
        );
        return;
      }
      case "remove": {
        const parsed = parseWorktreeFlags(rest);
        print(await removeLoopWorktree(app.store, app.workspace, requiredArg(parsed.args, 0, "worktree_id"), { force: parsed.force }), options.json);
        return;
      }
      case "adopt": {
        const parsed = parseWorktreeFlags(rest);
        print(
          await adoptLoopWorktree(app.store, app.workspace, requiredArg(parsed.args, 0, "worktree_id"), {
            dry_run: parsed.dryRun,
            message: parsed.message,
          }),
          options.json,
        );
        return;
      }
      case "cleanup": {
        const parsed = parseWorktreeFlags(rest);
        print(
          await cleanupLoopWorktrees(app.store, app.workspace, {
            dry_run: parsed.dryRun,
            force: parsed.force,
            older_than_ms: parsed.all ? 0 : parsed.olderThanMs,
          }),
          options.json,
        );
        return;
      }
      case "run": {
        const parsed = parseWorktreeFlags(rest);
        const prompt = parsed.args.join(" ").trim();
        if (!prompt) {
          throw new Error("Usage: inferoa worktree run [--base ref] [--branch name] [--path path] <prompt>");
        }
        const result = await queueDaemonRunInWorktree({
          stateDir: options.stateDir,
          workspaceRoot: app.workspace.root,
          prompt,
          title: `worktree:${prompt.slice(0, 40)}`,
          configPath: app.configFiles[0],
          baseRef: parsed.baseRef,
          branch: parsed.branch,
          path: parsed.path,
        });
        const status = await startDaemon({ stateDir: options.stateDir });
        print({ ...result, daemon: status }, options.json);
        return;
      }
      case "goal": {
        const parsed = parseWorktreeFlags(rest);
        const sessionId = requiredArg(parsed.args, 0, "session");
        const result = await queueDaemonGoalInWorktree({
          stateDir: options.stateDir,
          workspaceRoot: app.workspace.root,
          sessionId,
          maxIterations: parsed.maxIterations,
          configPath: app.configFiles[0],
          baseRef: parsed.baseRef,
          branch: parsed.branch,
          path: parsed.path,
        });
        const status = await startDaemon({ stateDir: options.stateDir });
        print({ ...result, daemon: status }, options.json);
        return;
      }
      default:
        throw new Error("Usage: inferoa worktree list|create|run|goal|adopt|cleanup|remove ...");
    }
  } finally {
    closeApp(app);
  }
}

async function runVerify(options: ParsedCli): Promise<void> {
  const [sessionPrefix, ...rubricParts] = options.verify ?? [];
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa verify <session> [--role completion|implementation|tests|security|docs|research] [rubric]");
  }
  const parsed = parseGoalVerifierArgs(rubricParts);
  const app = await loadApp(options);
  try {
    const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    const state = readGoalState(app.store, session.session_id);
    if (!state || state.goal.status === "dropped") {
      throw new Error(`Session ${session.session_id} has no verifiable goal.`);
    }
    if (parsed.background) {
      const queued = await queueGoalVerificationSuite({
        store: app.store,
        workspace: app.workspace,
        session_id: session.session_id,
        goal_state: state,
        roles: parsed.roles,
        rubric: parsed.rubric,
        source: "cli",
        isolation: parsed.isolation,
        config_path: app.configFiles[0],
      });
      print({
        session: publicSession(session),
        suite_id: queued.suite_id,
        verifier_roles: queued.roles,
        isolation: queued.isolation,
        jobs: queued.jobs,
      }, options.json);
      return;
    }
    if (parsed.roles.length > 1) {
      const suite = await runGoalVerificationSuite({
        store: app.store,
        runtime: app.runtime,
        session_id: session.session_id,
        goal: state.goal,
        roles: parsed.roles,
        rubric: parsed.rubric,
        source: "cli",
      });
      print({
        session: publicSession(session),
        suite_id: suite.suite_id,
        verifier_roles: suite.roles,
        results: suite.results.map((result) => ({
          role: result.role,
          run_id: result.run_id,
          tool_rounds: result.tool_rounds,
          tool_calls: result.tool_calls,
          tokens_used: result.tokens_used,
          verification: result.verification,
          content: result.content,
        })),
      }, options.json);
      return;
    }
    const runId = randomId("verify");
    app.store.appendEvent({
      session_id: session.session_id,
      run_id: runId,
      type: "goal.verification.requested",
      data: {
        goal_id: state.goal.id,
        horizon_generation: state.goal.horizon_generation,
        role: parsed.role,
        source: "cli",
      },
    });
    const result = await app.runtime.run({
      prompt: buildGoalVerificationPrompt(state.goal, parsed),
      session_id: session.session_id,
      run_id: runId,
      client_id: randomId("verify"),
      request_class: "verification",
      visibility: "internal",
    });
    print({
      session: publicSession(result.session),
      run_id: result.run_id,
      content: result.content,
      verifier_role: parsed.role,
      tool_rounds: result.tool_rounds,
      tool_calls: result.tool_calls,
      tokens_used: result.tokens_used,
    }, options.json);
  } finally {
    closeApp(app);
  }
}

async function runVerifyGithubPr(options: ParsedCli): Promise<void> {
  const [sessionPrefix, ...rest] = options.verifyGithubPr ?? [];
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa verify-github-pr <session> <pr> [--repo owner/name]");
  }
  const parsed = parseGitHubPrVerifierFlags(rest);
  const app = await loadApp(options);
  try {
    const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    const verification = await runConnectorVerifier(app.store, app.workspace, "github-pr-checks", {
      session_id: session.session_id,
      params: { pr: parsed.pr, repo: parsed.repo },
    });
    print({
      session: publicSession(session),
      verification,
    }, options.json);
  } finally {
    closeApp(app);
  }
}

async function runVerifyGithubPrStatus(options: ParsedCli): Promise<void> {
  const [sessionPrefix, ...rest] = options.verifyGithubPrStatus ?? [];
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa verify-github-pr-status <session> <pr> [--repo owner/name]");
  }
  const parsed = parseGitHubPrVerifierFlags(rest);
  const app = await loadApp(options);
  try {
    const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    const verification = await runConnectorVerifier(app.store, app.workspace, "github-pr-status", {
      session_id: session.session_id,
      params: { pr: parsed.pr, repo: parsed.repo },
    });
    print({
      session: publicSession(session),
      verification,
    }, options.json);
  } finally {
    closeApp(app);
  }
}

async function runVerifyGithubReviewRequest(options: ParsedCli): Promise<void> {
  const [sessionPrefix, ...rest] = options.verifyGithubReviewRequest ?? [];
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa verify-github-review-request <session> <pr> [--repo owner/name] [--reviewer login]");
  }
  const parsed = parseGitHubReviewRequestVerifierFlags(rest);
  const app = await loadApp(options);
  try {
    const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    const verification = await runConnectorVerifier(app.store, app.workspace, "github-review-request", {
      session_id: session.session_id,
      params: { pr: parsed.pr, repo: parsed.repo, reviewer: parsed.reviewer },
    });
    print({
      session: publicSession(session),
      verification,
    }, options.json);
  } finally {
    closeApp(app);
  }
}

async function runVerifyGithubIssueStatus(options: ParsedCli): Promise<void> {
  const [sessionPrefix, ...rest] = options.verifyGithubIssueStatus ?? [];
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa verify-github-issue-status <session> <issue> [--repo owner/name]");
  }
  const parsed = parseGitHubIssueVerifierFlags(rest);
  const app = await loadApp(options);
  try {
    const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    const verification = await runConnectorVerifier(app.store, app.workspace, "github-issue-status", {
      session_id: session.session_id,
      params: { issue: parsed.issue, repo: parsed.repo },
    });
    print({
      session: publicSession(session),
      verification,
    }, options.json);
  } finally {
    closeApp(app);
  }
}

async function runVerifyGithubNotification(options: ParsedCli): Promise<void> {
  const [sessionPrefix, ...rest] = options.verifyGithubNotification ?? [];
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa verify-github-notification <session> <thread_id>");
  }
  const parsed = parseGitHubNotificationVerifierFlags(rest);
  const app = await loadApp(options);
  try {
    const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    const verification = await runConnectorVerifier(app.store, app.workspace, "github-notification-status", {
      session_id: session.session_id,
      params: { thread: parsed.thread },
    });
    print({
      session: publicSession(session),
      verification,
    }, options.json);
  } finally {
    closeApp(app);
  }
}

async function runVerifyGithubRun(options: ParsedCli): Promise<void> {
  const [sessionPrefix, ...rest] = options.verifyGithubRun ?? [];
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa verify-github-run <session> <run_id> [--repo owner/name] [--attempt N]");
  }
  const parsed = parseGitHubRunVerifierFlags(rest);
  const app = await loadApp(options);
  try {
    const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    const verification = await runConnectorVerifier(app.store, app.workspace, "github-actions-run", {
      session_id: session.session_id,
      params: { run: parsed.run, repo: parsed.repo, attempt: parsed.attempt },
    });
    print({
      session: publicSession(session),
      verification,
    }, options.json);
  } finally {
    closeApp(app);
  }
}

async function runVerifyGithubWorkflow(options: ParsedCli): Promise<void> {
  const [sessionPrefix, ...rest] = options.verifyGithubWorkflow ?? [];
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa verify-github-workflow <session> --workflow WORKFLOW [--repo owner/name] [--branch BRANCH] [--event EVENT] [--commit SHA]");
  }
  const parsed = parseGitHubWorkflowVerifierFlags(rest);
  const app = await loadApp(options);
  try {
    const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    const verification = await runConnectorVerifier(app.store, app.workspace, "github-workflow-run-status", {
      session_id: session.session_id,
      params: {
        workflow: parsed.workflow,
        repo: parsed.repo,
        branch: parsed.branch,
        event: parsed.event,
        commit: parsed.commit,
      },
    });
    print({
      session: publicSession(session),
      verification,
    }, options.json);
  } finally {
    closeApp(app);
  }
}

async function runVerifyGithubDeployment(options: ParsedCli): Promise<void> {
  const [sessionPrefix, ...rest] = options.verifyGithubDeployment ?? [];
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa verify-github-deployment <session> --repo owner/name (--deployment-id ID|--environment ENV) [--ref REF] [--expect success|inactive|failure|any]");
  }
  const parsed = parseGitHubDeploymentVerifierFlags(rest);
  const app = await loadApp(options);
  try {
    const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    const verification = await runConnectorVerifier(app.store, app.workspace, "github-deployment-status", {
      session_id: session.session_id,
      params: {
        repo: parsed.repo,
        deployment_id: parsed.deployment_id,
        environment: parsed.environment,
        ref: parsed.ref,
        expect: parsed.expect,
      },
    });
    print({
      session: publicSession(session),
      verification,
    }, options.json);
  } finally {
    closeApp(app);
  }
}

async function runVerifyGithubRelease(options: ParsedCli): Promise<void> {
  const [sessionPrefix, ...rest] = options.verifyGithubRelease ?? [];
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa verify-github-release <session> <tag> [--repo owner/name] [--expect published|draft|any]");
  }
  const parsed = parseGitHubReleaseVerifierFlags(rest);
  const app = await loadApp(options);
  try {
    const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    const verification = await runConnectorVerifier(app.store, app.workspace, "github-release-status", {
      session_id: session.session_id,
      params: { tag: parsed.tag, repo: parsed.repo, expect: parsed.expect },
    });
    print({
      session: publicSession(session),
      verification,
    }, options.json);
  } finally {
    closeApp(app);
  }
}

async function runVerifyNpmPackage(options: ParsedCli): Promise<void> {
  const [sessionPrefix, ...rest] = options.verifyNpmPackage ?? [];
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa verify-npm-package <session> <package> --version X [--tag latest] [--timeout-ms N]");
  }
  const parsed = parseNpmPackageVerifierFlags(rest);
  const app = await loadApp(options);
  try {
    const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    const verification = await runConnectorVerifier(app.store, app.workspace, "npm-package-status", {
      session_id: session.session_id,
      params: {
        package_name: parsed.package_name,
        version: parsed.version,
        tag: parsed.tag,
        timeout_ms: parsed.timeout_ms,
      },
    });
    print({
      session: publicSession(session),
      verification,
    }, options.json);
  } finally {
    closeApp(app);
  }
}

async function runVerifyGitClean(options: ParsedCli): Promise<void> {
  const [sessionPrefix] = options.verifyGitClean ?? [];
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa verify-git-clean <session>");
  }
  const app = await loadApp(options);
  try {
    const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    const verification = await runConnectorVerifier(app.store, app.workspace, "git-clean", {
      session_id: session.session_id,
    });
    print({
      session: publicSession(session),
      verification,
    }, options.json);
  } finally {
    closeApp(app);
  }
}

async function runVerifyHttp(options: ParsedCli): Promise<void> {
  const [sessionPrefix, ...rest] = options.verifyHttp ?? [];
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa verify-http <session> <url> [--status N] [--timeout-ms N]");
  }
  const parsed = parseHttpVerifierFlags(rest);
  const app = await loadApp(options);
  try {
    const session = app.store.getSession(sessionPrefix) ?? app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    const verification = await runConnectorVerifier(app.store, app.workspace, "http-health", {
      session_id: session.session_id,
      params: { url: parsed.url, expected_status: parsed.status, timeout_ms: parsed.timeout_ms },
    });
    print({
      session: publicSession(session),
      verification,
    }, options.json);
  } finally {
    closeApp(app);
  }
}

async function runDebug(options: ParsedCli): Promise<void> {
  const [command, ...rest] = options.debug ?? [];
  if (!command) {
    printHelp();
    return;
  }
  switch (command) {
    case "init":
      await debugInit(options, rest.includes("--force"));
      return;
    case "setup":
      await debugSetup(options);
      return;
    case "status":
      await debugStatus(options);
      return;
    case "sessions":
      await debugSessions(options);
      return;
    case "tools":
      await debugTools(options, rest);
      return;
    case "events":
      await debugEvents(options, rest);
      return;
    case "archive":
      await debugArchive(options, rest);
      return;
    case "daemon":
      await debugDaemon(options, rest);
      return;
    case "acceptance":
      await debugAcceptance(options, rest);
      return;
    default:
      throw new Error(`Unknown debug command: ${command}`);
  }
}

async function debugInit(options: ParsedCli, force: boolean): Promise<void> {
  if (options.stateDir) {
    process.env.INFEROA_STATE_DIR = options.stateDir;
  }
  const target = userConfigPath();
  await ensureDir(path.dirname(target));
  try {
    await fs.access(target);
    if (!force) {
      throw new Error(`Config already exists: ${target}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
      throw error;
    }
  }
  await fs.writeFile(target, YAML.stringify(DEFAULT_CONFIG), "utf8");
  console.log(`Wrote ${target}`);
}

async function debugSetup(options: ParsedCli): Promise<void> {
  const app = await loadApp(options);
  try {
    const signals = new EndpointSignals(app.config);
    const skills = new SkillRegistry(app.workspace, app.config);
    print(
      {
        workspace: { root: app.workspace.root, alias: app.workspace.alias },
        config_files: app.configFiles,
        model_setup: redactSecretFields(app.config.model_setup as unknown as JsonObject),
        endpoint_signals: await signals.snapshot(),
        skills: await skills.discover(),
      },
      options.json,
    );
  } finally {
    closeApp(app);
  }
}

async function debugStatus(options: ParsedCli): Promise<void> {
  const app = await loadApp(options);
  try {
    print({ ...(await app.runtime.status()), sessions: app.store.listSessions(app.workspace.id).map(publicSession) }, options.json);
  } finally {
    closeApp(app);
  }
}

async function debugSessions(options: ParsedCli): Promise<void> {
  const app = await loadApp(options);
  try {
    print(
      {
        workspace: { root: app.workspace.root, alias: app.workspace.alias },
        sessions: app.store.listSessions(app.workspace.id).map(publicSession),
      },
      options.json,
    );
  } finally {
    closeApp(app);
  }
}

async function debugTools(options: ParsedCli, rest: string[]): Promise<void> {
  const [subcommand, name, json] = rest;
  const app = await loadApp(options);
  try {
    const registry = new ToolRegistry(app.config, app.workspace, app.store);
    if (subcommand === "list" || !subcommand) {
      print({ tools: registry.list() }, options.json);
      return;
    }
    if (subcommand !== "call" || !name) {
      throw new Error("Usage: inferoa debug tools call <name> [json]");
    }
    const session = app.store.createSession(app.workspace, `tool:${name}`);
    const args = json ? (JSON.parse(json) as JsonObject) : {};
    const result = await registry.call({ id: randomId("tc"), name, arguments: args } satisfies ToolCall, {
      session_id: session.session_id,
      run_id: randomId("run"),
    });
    print({ session: publicSession(session), result }, options.json);
  } finally {
    closeApp(app);
  }
}

async function debugEvents(options: ParsedCli, rest: string[]): Promise<void> {
  const [sessionPrefix, limit = "50"] = rest;
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa debug events <session> [limit]");
  }
  const app = await loadApp(options);
  try {
    const session = app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    print({ session: publicSession(session), events: app.store.listEvents(session.session_id, Number(limit)) }, options.json);
  } finally {
    closeApp(app);
  }
}

async function debugArchive(options: ParsedCli, rest: string[]): Promise<void> {
  const [sessionPrefix] = rest;
  if (!sessionPrefix) {
    throw new Error("Usage: inferoa debug archive <session>");
  }
  const app = await loadApp(options);
  try {
    const session = app.store.findSessionByPrefix(app.workspace.id, sessionPrefix);
    if (!session) {
      throw new Error(`No session matches ${sessionPrefix}`);
    }
    app.store.appendEvent({ session_id: session.session_id, type: "session.archived", data: { reason: "debug archive" } });
    app.store.updateSession(session.session_id, { status: "archived" });
    const archived = app.store.getSession(session.session_id);
    print({ session: archived ? publicSession(archived) : undefined }, options.json);
  } finally {
    closeApp(app);
  }
}

async function debugDaemon(options: ParsedCli, rest: string[]): Promise<void> {
  const [subcommand, ...args] = rest;
  switch (subcommand) {
    case "start":
      print(await startDaemon({ stateDir: options.stateDir, foreground: args.includes("--foreground") }), options.json);
      return;
    case "status":
      print(await daemonStatus(options.stateDir), options.json);
      return;
    case "jobs": {
      const status = await daemonStatus(options.stateDir);
      print({ jobs: status.jobs }, options.json);
      return;
    }
    case "run": {
      const prompt = args.join(" ");
      const app = await loadApp(options);
      try {
        const isolation = resolveLoopBackgroundIsolation(undefined, app.config);
        const queued = isolation === "worktree"
          ? await queueDaemonRunInWorktree({
            stateDir: options.stateDir,
            workspaceRoot: app.workspace.root,
            prompt,
            configPath: app.configFiles[0],
          })
          : { job: await queueDaemonRun({
            stateDir: options.stateDir,
            workspaceRoot: app.workspace.root,
            prompt,
            configPath: app.configFiles[0],
          }) };
        const status = await startDaemon({ stateDir: options.stateDir });
        print({ ...queued, daemon: status }, options.json);
      } finally {
        closeApp(app);
      }
      return;
    }
    case "goal": {
      const sessionId = requiredArg(args, 0, "session");
      const maxIterations = optionalPositiveIntFlag(args, "--max-iterations");
      const app = await loadApp(options);
      try {
        const isolation = resolveLoopBackgroundIsolation(undefined, app.config);
        const queued = isolation === "worktree"
          ? await queueDaemonGoalInWorktree({
            stateDir: options.stateDir,
            workspaceRoot: app.workspace.root,
            sessionId,
            maxIterations,
            configPath: app.configFiles[0],
          })
          : { job: await queueDaemonGoal({
            stateDir: options.stateDir,
            workspaceRoot: app.workspace.root,
            sessionId,
            maxIterations,
            configPath: app.configFiles[0],
          }) };
        const status = await startDaemon({ stateDir: options.stateDir });
        print({ ...queued, daemon: status }, options.json);
      } finally {
        closeApp(app);
      }
      return;
    }
    case "attach":
      print(await attachDaemonJob(options.stateDir, requiredArg(args, 0, "job"), { follow: args.includes("--follow") }), options.json);
      return;
    case "detach":
      print(await detachDaemonJob(options.stateDir, requiredArg(args, 0, "job")), options.json);
      return;
    case "cancel":
      print(await cancelDaemonJob(options.stateDir, requiredArg(args, 0, "job")), options.json);
      return;
    default:
      throw new Error("Usage: inferoa debug daemon start|status|jobs|run|goal|attach|detach|cancel ...");
  }
}

async function debugAcceptance(options: ParsedCli, rest: string[]): Promise<void> {
  const result = await runFinalAcceptance({
    workspaceRoot: path.resolve(options.workspace ?? process.cwd()),
    stateDir: options.stateDir,
    configPath: options.config,
    daemon: rest.includes("--daemon"),
  });
  print(result, options.json);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function requiredArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function parseAutomationFlags(args: string[]): { isolation?: AutomationIsolation; review_policy?: AutomationReviewPolicy; args: string[] } {
  let isolation: AutomationIsolation | undefined;
  let reviewPolicy: AutomationReviewPolicy | undefined;
  const output: string[] = [];
  for (const arg of args) {
    if (arg === "--worktree") {
      isolation = "worktree";
    } else if (arg === "--active-checkout") {
      isolation = "active_checkout";
    } else if (arg === "--review") {
      reviewPolicy = "review";
    } else if (arg === "--auto") {
      reviewPolicy = "auto";
    } else {
      output.push(arg);
    }
  }
  return { isolation, review_policy: reviewPolicy, args: output };
}

function parseInboxPromoteFlags(args: string[]): { isolation?: LoopInboxPromotionIsolation; item_id: string } {
  let isolation: LoopInboxPromotionIsolation | undefined;
  const output: string[] = [];
  for (const arg of args) {
    if (arg === "--worktree") {
      isolation = "worktree";
    } else if (arg === "--active-checkout") {
      isolation = "active_checkout";
    } else {
      output.push(arg);
    }
  }
  return {
    isolation,
    item_id: requiredArg(output, 0, "item_id"),
  };
}

function parseGitHubPrVerifierFlags(args: string[]): { pr: string; repo?: string } {
  const output: string[] = [];
  let repo: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      repo = requiredArg(args, index + 1, "repo");
      index += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg) {
      output.push(arg);
    }
  }
  const pr = requiredArg(output, 0, "pr");
  if (!pr.trim()) {
    throw new Error("Usage: inferoa verify-github-pr <session> <pr> [--repo owner/name]");
  }
  return { pr, repo };
}

function parseGitHubReviewRequestVerifierFlags(args: string[]): { pr: string; repo?: string; reviewer?: string } {
  const output: string[] = [];
  let repo: string | undefined;
  let reviewer: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      repo = requiredArg(args, index + 1, "repo");
      index += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--reviewer") {
      reviewer = requiredArg(args, index + 1, "reviewer");
      index += 1;
    } else if (arg?.startsWith("--reviewer=")) {
      reviewer = arg.slice("--reviewer=".length);
    } else if (arg) {
      output.push(arg);
    }
  }
  const pr = requiredArg(output, 0, "pr");
  if (!pr.trim()) {
    throw new Error("Usage: inferoa verify-github-review-request <session> <pr> [--repo owner/name] [--reviewer login]");
  }
  return { pr, repo, reviewer };
}

function parseGitHubIssueVerifierFlags(args: string[]): { issue: string; repo?: string } {
  const output: string[] = [];
  let repo: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      repo = requiredArg(args, index + 1, "repo");
      index += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg) {
      output.push(arg);
    }
  }
  const issue = requiredArg(output, 0, "issue");
  if (!issue.trim()) {
    throw new Error("Usage: inferoa verify-github-issue-status <session> <issue> [--repo owner/name]");
  }
  return { issue, repo };
}

function parseGitHubNotificationVerifierFlags(args: string[]): { thread: string } {
  const unknown = args.find((arg) => arg.startsWith("--"));
  if (unknown) {
    throw new Error(`Unknown GitHub notification verifier option: ${unknown}`);
  }
  const thread = requiredArg(args, 0, "thread_id");
  if (!thread.trim()) {
    throw new Error("Usage: inferoa verify-github-notification <session> <thread_id>");
  }
  return { thread };
}

function parseGitHubRunVerifierFlags(args: string[]): { run: string; repo?: string; attempt?: number } {
  const output: string[] = [];
  let repo: string | undefined;
  let attempt: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      repo = requiredArg(args, index + 1, "repo");
      index += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--attempt") {
      attempt = parsePositiveInteger(requiredArg(args, index + 1, "attempt"), "--attempt");
      index += 1;
    } else if (arg?.startsWith("--attempt=")) {
      attempt = parsePositiveInteger(arg.slice("--attempt=".length), "--attempt");
    } else if (arg) {
      output.push(arg);
    }
  }
  const run = requiredArg(output, 0, "run_id");
  if (!run.trim()) {
    throw new Error("Usage: inferoa verify-github-run <session> <run_id> [--repo owner/name] [--attempt N]");
  }
  return { run, repo, attempt };
}

function parseGitHubWorkflowVerifierFlags(args: string[]): { workflow: string; repo?: string; branch?: string; event?: string; commit?: string } {
  const output: string[] = [];
  let workflow: string | undefined;
  let repo: string | undefined;
  let branch: string | undefined;
  let event: string | undefined;
  let commit: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workflow") {
      workflow = requiredArg(args, index + 1, "workflow");
      index += 1;
    } else if (arg?.startsWith("--workflow=")) {
      workflow = arg.slice("--workflow=".length);
    } else if (arg === "--repo") {
      repo = requiredArg(args, index + 1, "repo");
      index += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--branch") {
      branch = requiredArg(args, index + 1, "branch");
      index += 1;
    } else if (arg?.startsWith("--branch=")) {
      branch = arg.slice("--branch=".length);
    } else if (arg === "--event") {
      event = requiredArg(args, index + 1, "event");
      index += 1;
    } else if (arg?.startsWith("--event=")) {
      event = arg.slice("--event=".length);
    } else if (arg === "--commit") {
      commit = requiredArg(args, index + 1, "commit");
      index += 1;
    } else if (arg?.startsWith("--commit=")) {
      commit = arg.slice("--commit=".length);
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown GitHub workflow verifier option: ${arg}`);
    } else if (arg) {
      output.push(arg);
    }
  }
  workflow ??= output[0];
  if (!workflow?.trim()) {
    throw new Error("Usage: inferoa verify-github-workflow <session> --workflow WORKFLOW [--repo owner/name] [--branch BRANCH] [--event EVENT] [--commit SHA]");
  }
  return { workflow, repo, branch, event, commit };
}

function parseGitHubDeploymentVerifierFlags(args: string[]): { repo: string; deployment_id?: string; environment?: string; ref?: string; expect?: string } {
  let repo: string | undefined;
  let deploymentId: string | undefined;
  let environment: string | undefined;
  let ref: string | undefined;
  let expect: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      repo = requiredArg(args, index + 1, "repo");
      index += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--deployment-id") {
      deploymentId = requiredArg(args, index + 1, "deployment-id");
      index += 1;
    } else if (arg?.startsWith("--deployment-id=")) {
      deploymentId = arg.slice("--deployment-id=".length);
    } else if (arg === "--environment") {
      environment = requiredArg(args, index + 1, "environment");
      index += 1;
    } else if (arg?.startsWith("--environment=")) {
      environment = arg.slice("--environment=".length);
    } else if (arg === "--ref") {
      ref = requiredArg(args, index + 1, "ref");
      index += 1;
    } else if (arg?.startsWith("--ref=")) {
      ref = arg.slice("--ref=".length);
    } else if (arg === "--expect") {
      expect = parseGitHubDeploymentExpectedFlag(requiredArg(args, index + 1, "expect"));
      index += 1;
    } else if (arg?.startsWith("--expect=")) {
      expect = parseGitHubDeploymentExpectedFlag(arg.slice("--expect=".length));
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown GitHub deployment verifier option: ${arg}`);
    } else if (arg) {
      throw new Error(`Unexpected GitHub deployment verifier argument: ${arg}`);
    }
  }
  if (!repo?.trim() || (!deploymentId?.trim() && !environment?.trim())) {
    throw new Error("Usage: inferoa verify-github-deployment <session> --repo owner/name (--deployment-id ID|--environment ENV) [--ref REF] [--expect success|inactive|failure|any]");
  }
  return { repo, deployment_id: deploymentId, environment, ref, expect };
}

function parseGitHubReleaseVerifierFlags(args: string[]): { tag: string; repo?: string; expect?: string } {
  const output: string[] = [];
  let repo: string | undefined;
  let expect: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      repo = requiredArg(args, index + 1, "repo");
      index += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--expect") {
      expect = parseGitHubReleaseExpectedFlag(requiredArg(args, index + 1, "expect"));
      index += 1;
    } else if (arg?.startsWith("--expect=")) {
      expect = parseGitHubReleaseExpectedFlag(arg.slice("--expect=".length));
    } else if (arg) {
      output.push(arg);
    }
  }
  const tag = requiredArg(output, 0, "tag");
  if (!tag.trim()) {
    throw new Error("Usage: inferoa verify-github-release <session> <tag> [--repo owner/name] [--expect published|draft|any]");
  }
  return { tag, repo, expect };
}

function parseGitHubReleaseExpectedFlag(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "published" || normalized === "draft" || normalized === "any") {
    return normalized;
  }
  throw new Error("--expect must be published, draft, or any");
}

function parseGitHubDeploymentExpectedFlag(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "success" || normalized === "inactive" || normalized === "failure" || normalized === "any") {
    return normalized;
  }
  throw new Error("--expect must be success, inactive, failure, or any");
}

function parseNpmPackageVerifierFlags(args: string[]): { package_name: string; version: string; tag?: string; timeout_ms?: number } {
  const output: string[] = [];
  let version: string | undefined;
  let tag: string | undefined;
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--version") {
      version = requiredArg(args, index + 1, "version");
      index += 1;
    } else if (arg?.startsWith("--version=")) {
      version = arg.slice("--version=".length);
    } else if (arg === "--tag") {
      tag = requiredArg(args, index + 1, "tag");
      index += 1;
    } else if (arg?.startsWith("--tag=")) {
      tag = arg.slice("--tag=".length);
    } else if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(requiredArg(args, index + 1, "timeout_ms"), "--timeout-ms");
      index += 1;
    } else if (arg?.startsWith("--timeout-ms=")) {
      timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
    } else if (arg) {
      output.push(arg);
    }
  }
  const packageName = requiredArg(output, 0, "package");
  if (!packageName.trim() || !version?.trim()) {
    throw new Error("Usage: inferoa verify-npm-package <session> <package> --version X [--tag latest] [--timeout-ms N]");
  }
  return { package_name: packageName, version, tag, timeout_ms: timeoutMs };
}

function parseHttpVerifierFlags(args: string[]): { url: string; status?: number; timeout_ms?: number } {
  const output: string[] = [];
  let status: number | undefined;
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--status") {
      status = parseHttpStatus(requiredArg(args, index + 1, "status"));
      index += 1;
    } else if (arg?.startsWith("--status=")) {
      status = parseHttpStatus(arg.slice("--status=".length));
    } else if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(requiredArg(args, index + 1, "timeout_ms"), "--timeout-ms");
      index += 1;
    } else if (arg?.startsWith("--timeout-ms=")) {
      timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
    } else if (arg) {
      output.push(arg);
    }
  }
  const url = requiredArg(output, 0, "url");
  if (!url.trim()) {
    throw new Error("Usage: inferoa verify-http <session> <url> [--status N] [--timeout-ms N]");
  }
  return { url, status, timeout_ms: timeoutMs };
}

function parseHttpStatus(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
    throw new Error("--status requires an integer from 100 to 599");
  }
  return parsed;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function parseDiscoveryConnectorFlags(args: string[]): { repo?: string; labels?: string[]; limit?: number } {
  const output: { repo?: string; labels?: string[]; limit?: number } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      output.repo = requiredArg(args, index + 1, "repo");
      index += 1;
    } else if (arg === "--label") {
      output.labels ??= [];
      output.labels.push(parseDiscoveryGitHubLabel(requiredArg(args, index + 1, "label")));
      index += 1;
    } else if (arg === "--limit") {
      const value = Number.parseInt(requiredArg(args, index + 1, "limit"), 10);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--limit requires a positive integer");
      }
      output.limit = value;
      index += 1;
    } else if (arg) {
      throw new Error(`Unknown discovery option: ${arg}`);
    }
  }
  output.labels = dedupeDiscoveryLabels(output.labels);
  return output;
}

function parseDiscoveryAssignedConnectorFlags(args: string[]): { repo?: string; assignee?: string; labels?: string[]; limit?: number } {
  const output: { repo?: string; assignee?: string; labels?: string[]; limit?: number } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      output.repo = requiredArg(args, index + 1, "repo");
      index += 1;
    } else if (arg === "--assignee") {
      output.assignee = requiredArg(args, index + 1, "assignee");
      index += 1;
    } else if (arg === "--label") {
      output.labels ??= [];
      output.labels.push(parseDiscoveryGitHubLabel(requiredArg(args, index + 1, "label")));
      index += 1;
    } else if (arg === "--limit") {
      const value = Number.parseInt(requiredArg(args, index + 1, "limit"), 10);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--limit requires a positive integer");
      }
      output.limit = value;
      index += 1;
    } else if (arg) {
      throw new Error(`Unknown discovery option: ${arg}`);
    }
  }
  output.labels = dedupeDiscoveryLabels(output.labels);
  return output;
}

function parseDiscoveryGitHubLabel(value: string): string {
  const label = value.trim();
  if (!label || /[\r\n]/.test(label)) {
    throw new Error("--label requires a non-empty single-line label");
  }
  return label;
}

function dedupeDiscoveryLabels(labels: string[] | undefined): string[] | undefined {
  if (!labels?.length) {
    return undefined;
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const key = label.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      output.push(label);
    }
  }
  return output;
}

function parseDiscoveryDeploymentFlags(args: string[]): { repo: string; environment?: string; ref?: string; limit?: number } {
  const output: { repo?: string; environment?: string; ref?: string; limit?: number } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      output.repo = requiredArg(args, index + 1, "repo");
      index += 1;
    } else if (arg === "--environment") {
      output.environment = requiredArg(args, index + 1, "environment");
      index += 1;
    } else if (arg === "--ref") {
      output.ref = requiredArg(args, index + 1, "ref");
      index += 1;
    } else if (arg === "--limit") {
      const value = Number.parseInt(requiredArg(args, index + 1, "limit"), 10);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--limit requires a positive integer");
      }
      output.limit = value;
      index += 1;
    } else if (arg) {
      throw new Error(`Unknown discovery option: ${arg}`);
    }
  }
  if (!output.repo) {
    throw new Error("Usage: inferoa discovery add-github-deployments <15m|2h|1d> --repo owner/name [--environment ENV] [--ref REF] [--limit N]");
  }
  return {
    repo: output.repo,
    environment: output.environment,
    ref: output.ref,
    limit: output.limit,
  };
}

function parseDiscoveryNotificationFlags(args: string[]): { repo?: string; participating?: boolean; limit?: number } {
  const output: { repo?: string; participating?: boolean; limit?: number } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      output.repo = requiredArg(args, index + 1, "repo");
      index += 1;
    } else if (arg === "--participating") {
      output.participating = true;
    } else if (arg === "--limit") {
      const value = Number.parseInt(requiredArg(args, index + 1, "limit"), 10);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--limit requires a positive integer");
      }
      output.limit = value;
      index += 1;
    } else if (arg) {
      throw new Error(`Unknown discovery option: ${arg}`);
    }
  }
  return output;
}

function parseDiscoveryHttpFlags(args: string[]): { url: string; status?: number; timeout_ms?: number } {
  const output: string[] = [];
  let status: number | undefined;
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--status") {
      status = parseHttpStatus(requiredArg(args, index + 1, "status"));
      index += 1;
    } else if (arg?.startsWith("--status=")) {
      status = parseHttpStatus(arg.slice("--status=".length));
    } else if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(requiredArg(args, index + 1, "timeout_ms"), "--timeout-ms");
      index += 1;
    } else if (arg?.startsWith("--timeout-ms=")) {
      timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown discovery option: ${arg}`);
    } else if (arg) {
      output.push(arg);
    }
  }
  return {
    url: requiredArg(output, 0, "url"),
    status,
    timeout_ms: timeoutMs,
  };
}

function parseDiscoveryNpmPackageFlags(args: string[]): { package_name: string; version: string; tag?: string } {
  const output: string[] = [];
  let version: string | undefined;
  let tag: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--version") {
      version = requiredArg(args, index + 1, "version");
      index += 1;
    } else if (arg?.startsWith("--version=")) {
      version = arg.slice("--version=".length);
    } else if (arg === "--tag") {
      tag = requiredArg(args, index + 1, "tag");
      index += 1;
    } else if (arg?.startsWith("--tag=")) {
      tag = arg.slice("--tag=".length);
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown discovery option: ${arg}`);
    } else if (arg) {
      output.push(arg);
    }
  }
  const packageName = requiredArg(output, 0, "package");
  if (output.length > 1) {
    throw new Error(`Unexpected discovery argument: ${output[1]}`);
  }
  if (!version?.trim()) {
    throw new Error("Usage: inferoa discovery add-npm-package <15m|2h|1d> <package> --version X [--tag latest]");
  }
  return { package_name: packageName, version, tag };
}

function optionalPositiveIntFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const raw = args[index + 1];
  const value = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return value;
}

function parseWorktreeFlags(args: string[]): {
  args: string[];
  baseRef?: string;
  branch?: string;
  path?: string;
  maxIterations?: number;
  force?: boolean;
  dryRun?: boolean;
  message?: string;
  olderThanMs?: number;
  all?: boolean;
} {
  let rest = [...args];
  const base = consumeFlagValue(rest, "--base");
  rest = base.rest;
  const branch = consumeFlagValue(rest, "--branch");
  rest = branch.rest;
  const worktreePath = consumeFlagValue(rest, "--path");
  rest = worktreePath.rest;
  const maxIterations = consumeFlagValue(rest, "--max-iterations");
  rest = maxIterations.rest;
  const message = consumeFlagValue(rest, "--message");
  rest = message.rest;
  const olderThan = consumeFlagValue(rest, "--older-than");
  rest = olderThan.rest;
  const force = rest.includes("--force");
  const dryRun = rest.includes("--dry-run");
  const all = rest.includes("--all") || rest.includes("all");
  rest = rest.filter((arg) => arg !== "--force" && arg !== "--dry-run" && arg !== "--all" && arg !== "all");
  let parsedMax: number | undefined;
  if (maxIterations.value) {
    parsedMax = Number.parseInt(maxIterations.value, 10);
    if (!Number.isInteger(parsedMax) || parsedMax <= 0) {
      throw new Error("--max-iterations requires a positive integer");
    }
  }
  return {
    args: rest,
    baseRef: base.value,
    branch: branch.value,
    path: worktreePath.value,
    maxIterations: parsedMax,
    force,
    dryRun,
    message: message.value,
    olderThanMs: olderThan.value ? parseAutomationInterval(olderThan.value) : undefined,
    all,
  };
}

function consumeFlagValue(args: string[], flag: string): { value?: string; rest: string[] } {
  const index = args.indexOf(flag);
  if (index < 0) {
    return { rest: args };
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  const rest = [...args.slice(0, index), ...args.slice(index + 2)];
  return { value, rest };
}

function print(value: unknown, json = false): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(YAML.stringify(value));
}

function publicSession(session: { session_id: string; title: string; status: string; created_at: string; updated_at: string }): Record<string, unknown> {
  return {
    session_id: session.session_id,
    title: session.title,
    status: session.status,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

function redactSecretFields(value: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = key.includes("api_key") && typeof item === "string" ? "<redacted>" : item;
  }
  return output;
}

main().catch((error) => {
  const result = fail("cli_error", error instanceof Error ? error.message : String(error));
  console.error(result.summary);
  process.exitCode = 1;
});
