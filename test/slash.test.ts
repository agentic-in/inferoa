import test from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "../src/tui/ansi.js";
import { renderComposerSurface } from "../src/tui/composer.js";
import { bareSlashCommandWithSubcommands, parseSlashCommand, slashCommandWithSubcommands, slashSubcommands } from "../src/tui/slash.js";
import { renderUnknownSlashCommandNotice } from "../src/tui/slash-notice.js";

test("slash parser uses clear as the fresh-session command", () => {
  const parsed = parseSlashCommand("/clear");
  assert.equal(parsed.command?.name, "clear");
  assert.equal(parsed.args, "");
  assert.equal(parsed.error, undefined);
});

test("slash parser supports goal and autoresearch chat commands", () => {
  const goal = parseSlashCommand("/goal ship the feature");
  assert.equal(goal.command?.name, "goal");
  assert.equal(goal.args, "ship the feature");
  assert.equal(goal.error, undefined);

  const plan = parseSlashCommand("/plan add offline retry support");
  assert.equal(plan.command?.name, "plan");
  assert.equal(plan.args, "add offline retry support");
  assert.equal(plan.error, undefined);

  const autoresearch = parseSlashCommand("/autoresearch reduce benchmark latency");
  assert.equal(autoresearch.command?.name, "autoresearch");
  assert.equal(autoresearch.args, "reduce benchmark latency");
  assert.equal(autoresearch.error, undefined);
});

test("slash parser exposes system command and keeps endpoint aliases", () => {
  const system = parseSlashCommand("/system");
  assert.equal(system.command?.name, "system");
  assert.equal(system.error, undefined);

  const endpoint = parseSlashCommand("/endpoint");
  assert.equal(endpoint.command?.name, "system");
  assert.equal(endpoint.error, undefined);

  const endpoints = parseSlashCommand("/endpoints");
  assert.equal(endpoints.command?.name, "system");
  assert.equal(endpoints.error, undefined);
});

test("slash parser exposes tokenmaxxing and keeps old savings aliases", () => {
  const tokenmaxxing = parseSlashCommand("/tokenmaxxing");
  assert.equal(tokenmaxxing.command?.name, "tokenmaxxing");
  assert.equal(tokenmaxxing.error, undefined);

  const activity = parseSlashCommand("/activity");
  assert.equal(activity.command?.name, "tokenmaxxing");
  assert.equal(activity.error, undefined);

  const cache = parseSlashCommand("/cache");
  assert.equal(cache.command?.name, "tokenmaxxing");
  assert.equal(cache.error, undefined);

  const rtk = parseSlashCommand("/rtk");
  assert.equal(rtk.command?.name, "tokenmaxxing");
  assert.equal(rtk.error, undefined);

  const evidenceAlias = parseSlashCommand("/evidence");
  assert.equal(evidenceAlias.command?.name, "tokenmaxxing");
  assert.equal(evidenceAlias.error, undefined);

  const fresh = parseSlashCommand("/new");
  assert.equal(fresh.command, undefined);
  assert.equal(fresh.error, "Unrecognized command '/new'. Type '/' for commands.");

  const resume = parseSlashCommand("/resume s_123");
  assert.equal(resume.command?.name, "resume");
  assert.equal(resume.args, "s_123");
  assert.equal(resume.error, undefined);

  const access = parseSlashCommand("/access full");
  assert.equal(access.command?.name, "access");
  assert.equal(access.args, "full");
  assert.equal(access.error, undefined);

  const sandbox = parseSlashCommand("/sandbox workspace-write");
  assert.equal(sandbox.command?.name, "sandbox");
  assert.equal(sandbox.args, "workspace-write");
  assert.equal(sandbox.error, undefined);
});

test("slash parser leaves dragged absolute paths as chat input", () => {
  const single = parseSlashCommand("/Users/demo/Desktop/screenshot.png");
  assert.equal(single.command, undefined);
  assert.equal(single.error, undefined);
  assert.equal(single.args, "/Users/demo/Desktop/screenshot.png");

  const nested = parseSlashCommand("/Users/demo/local-workbench/work/vllm/vllm-agent/website/static/img/screenshots/inferoa-welcome.png");
  assert.equal(nested.command, undefined);
  assert.equal(nested.error, undefined);
  assert.equal(nested.args, "/Users/demo/local-workbench/work/vllm/vllm-agent/website/static/img/screenshots/inferoa-welcome.png");

  const multiple = parseSlashCommand("/Users/demo/a.png /Users/demo/b.jpg");
  assert.equal(multiple.command, undefined);
  assert.equal(multiple.error, undefined);
  assert.equal(multiple.args, "/Users/demo/a.png /Users/demo/b.jpg");
});

test("unknown slash command notice is short and neutral", () => {
  const rendered = renderUnknownSlashCommandNotice("sdsdsdsd");
  const plain = stripAnsi(rendered);

  assert.equal(plain, "• Unrecognized command '/sdsdsdsd'. Type '/' for commands.");
  assert.match(rendered, /\x1b\[38;5;244m/);
  assert.doesNotMatch(rendered, /\x1b\[38;5;203m/);
});

test("slash registry exposes chat subcommands for completion", () => {
  assert.equal(slashCommandWithSubcommands("/tools"), "tools");
  assert.equal(slashCommandWithSubcommands("/daemon"), "daemon");
  assert.equal(slashCommandWithSubcommands("/doctor"), "doctor");
  assert.equal(slashCommandWithSubcommands("/goal"), "goal");
  assert.equal(slashCommandWithSubcommands("/plan"), "plan");
  assert.equal(slashCommandWithSubcommands("/autoresearch"), "autoresearch");
  assert.equal(slashCommandWithSubcommands("/sandbox"), "sandbox");
  assert.equal(slashCommandWithSubcommands("/sessions"), "sessions");
  assert.equal(slashCommandWithSubcommands("/clear"), undefined);
  assert.equal(parseSlashCommand("/jobs").error, "Unrecognized command '/jobs'. Type '/' for commands.");
  assert.equal(parseSlashCommand("/todo").error, "Unrecognized command '/todo'. Type '/' for commands.");
  assert.equal(parseSlashCommand("/acceptance").error, "Unrecognized command '/acceptance'. Type '/' for commands.");
  assert.deepEqual(
    slashSubcommands("tools").map((item) => item.value),
    ["/tools", "/tools expand", "/tools compact", "/tools last"],
  );
  assert.deepEqual(
    slashSubcommands("daemon").map((item) => item.value),
    ["/daemon status", "/daemon queue", "/daemon attach", "/daemon detach", "/daemon cancel"],
  );
  assert.deepEqual(
    slashSubcommands("doctor").map((item) => item.value),
    ["/doctor status", "/doctor run"],
  );
  assert.deepEqual(
    slashSubcommands("goal").map((item) => item.value),
    ["/goal show", "/goal set", "/goal plan", "/goal pause", "/goal resume", "/goal budget", "/goal complete", "/goal drop"],
  );
  assert.deepEqual(
    slashSubcommands("plan").map((item) => item.value),
    ["/plan show", "/plan set", "/plan pause", "/plan resume", "/plan approve", "/plan drop"],
  );
  assert.deepEqual(
    slashSubcommands("autoresearch").map((item) => item.value),
    ["/autoresearch status", "/autoresearch off", "/autoresearch clear"],
  );
  assert.deepEqual(
    slashSubcommands("access").map((item) => item.value),
    ["/access status", "/access full", "/access auto", "/access ask", "/access custom"],
  );
  assert.deepEqual(
    slashSubcommands("sandbox").map((item) => item.value),
    ["/sandbox status", "/sandbox off", "/sandbox read-only", "/sandbox workspace-write", "/sandbox network on", "/sandbox network off"],
  );
  assert.deepEqual(
    slashSubcommands("sessions").map((item) => item.value),
    ["/sessions resume", "/sessions new", "/sessions all"],
  );
});

test("bare slash subcommand expansion does not consume trailing-space subcommand completion", () => {
  assert.equal(bareSlashCommandWithSubcommands("/sandbox"), "sandbox");
  assert.equal(bareSlashCommandWithSubcommands("/sandbox "), undefined);
  assert.equal(bareSlashCommandWithSubcommands("/sandbox network"), undefined);
});

test("composer renders sandbox network subcommands distinctly", () => {
  const items = slashSubcommands("sandbox")
    .filter((item) => item.value.startsWith("/sandbox network"))
    .map((item) => ({ label: item.value, description: item.description, kind: "command" as const }));
  const rendered = stripAnsi(renderComposerSurface({ buffer: "/sandbox ", cursor: "/sandbox ".length, items, selected: 0, width: 90 }).lines.join("\n"));

  assert.match(rendered, /\/sandbox network on\s+Allow network inside sandbox/);
  assert.match(rendered, /\/sandbox network off\s+Restrict network inside sandbox/);
});
