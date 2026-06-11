import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { readLoopActions } from "../src/loop/action-log.js";
import { parseConnectorActionRunInput, runConnectorAction } from "../src/loop/actions.js";
import { readLoopInbox } from "../src/loop/inbox.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("connector action-run records a dry-run without executing external tools", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run connector action");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "pull_request", "merge", "--repo", "owner/repo", "--number", "17", "--method", "squash"]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.equal(result.action.execute, false);
    assert.deepEqual(result.command.args, ["pr", "merge", "17", "--repo", "owner/repo", "--squash"]);
    const events = store.listEvents(session.session_id).filter((event) => event.type === "connector.action.recorded");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.data.status, "dry_run");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.summary.dry_run, 1);
    assert.equal(audit.summary.by_connector.github, 1);
    assert.equal(audit.actions[0]?.status, "dry_run");
    assert.equal(audit.actions[0]?.repo, "owner/repo");
    assert.equal(audit.actions[0]?.number, 17);
    assert.equal(audit.actions[0]?.method, "squash");
    assert.equal(store.getSession(session.session_id)?.status, session.status);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run denies unattended execution and projects inbox review", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-deny-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "denied connector action");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "pull_request", "merge", "--repo", "owner/repo", "--number", "18", "--execute", "--request-class", "background"]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "denied");
    assert.equal(result.preflight.status, "deny");
    assert.equal(result.preflight.policy_id, "first-class-connector-mutation");
    const inbox = await readLoopInbox(store, workspace);
    const actionItems = inbox.items.filter((item) => item.kind === "action_review");
    assert.equal(actionItems.length, 1);
    assert.equal(actionItems[0]?.source_label, "github");
    assert.match(actionItems[0]?.detail ?? "", /operation github\.pull_request\.merge/);
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.summary.denied, 1);
    assert.equal(audit.summary.by_request_class.background, 1);
    assert.equal(audit.actions[0]?.source, "action_run");
    assert.equal(audit.actions[0]?.reason, "unattended connector mutation requires explicit interactive approval");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run supports GitHub PR review dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-pr-review-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run PR review");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput([
        "github",
        "pull_request",
        "review",
        "--repo",
        "owner/repo",
        "--number",
        "17",
        "--event",
        "request-changes",
        "--body",
        "Need tests before merge",
      ]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.deepEqual(result.command.args, ["pr", "review", "17", "--repo", "owner/repo", "--request-changes", "--body", "Need tests before merge"]);
    assert.equal(result.action.operation, "review");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.summary.by_connector.github, 1);
    assert.equal(audit.actions[0]?.area, "pull_request");
    assert.equal(audit.actions[0]?.operation, "review");
    assert.equal(audit.actions[0]?.repo, "owner/repo");
    assert.equal(audit.actions[0]?.number, 17);
    assert.equal(audit.actions[0]?.review_event, "request_changes");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run supports GitHub PR comment dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-pr-comment-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run PR comment");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "pull_request", "comment", "--repo", "owner/repo", "--number", "17", "--body", "I left a triage note"]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.deepEqual(result.command.args, ["pr", "comment", "17", "--repo", "owner/repo", "--body", "I left a triage note"]);
    assert.equal(result.action.operation, "comment");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.actions[0]?.area, "pull_request");
    assert.equal(audit.actions[0]?.operation, "comment");
    assert.equal(audit.actions[0]?.repo, "owner/repo");
    assert.equal(audit.actions[0]?.number, 17);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run supports GitHub PR label dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-pr-label-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run PR label");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput([
        "github",
        "pull_request",
        "label",
        "--repo",
        "owner/repo",
        "--number",
        "17",
        "--add-label",
        "triage",
        "--remove-label",
        "needs-info",
      ]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.deepEqual(result.command.args, ["pr", "edit", "17", "--repo", "owner/repo", "--add-label", "triage", "--remove-label", "needs-info"]);
    assert.equal(result.action.operation, "label");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.actions[0]?.area, "pull_request");
    assert.equal(audit.actions[0]?.operation, "label");
    assert.equal(audit.actions[0]?.repo, "owner/repo");
    assert.equal(audit.actions[0]?.number, 17);
    assert.deepEqual(audit.actions[0]?.add_labels, ["triage"]);
    assert.deepEqual(audit.actions[0]?.remove_labels, ["needs-info"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run supports GitHub issue close dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-issue-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run issue close");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "issue", "close", "--repo", "owner/repo", "--number", "22"]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.deepEqual(result.command.args, ["issue", "close", "22", "--repo", "owner/repo"]);
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.actions[0]?.area, "issue");
    assert.equal(audit.actions[0]?.operation, "close");
    assert.equal(audit.actions[0]?.repo, "owner/repo");
    assert.equal(audit.actions[0]?.number, 22);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run supports GitHub issue comment dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-issue-comment-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run issue comment");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "issue", "comment", "--repo", "owner/repo", "--number", "22", "--body", "Tracking this in the loop inbox"]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.deepEqual(result.command.args, ["issue", "comment", "22", "--repo", "owner/repo", "--body", "Tracking this in the loop inbox"]);
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.actions[0]?.area, "issue");
    assert.equal(audit.actions[0]?.operation, "comment");
    assert.equal(audit.actions[0]?.repo, "owner/repo");
    assert.equal(audit.actions[0]?.number, 22);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run supports GitHub issue label dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-issue-label-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run issue label");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput([
        "github",
        "issue",
        "label",
        "--repo",
        "owner/repo",
        "--number",
        "22",
        "--add-label",
        "accepted",
      ]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.deepEqual(result.command.args, ["issue", "edit", "22", "--repo", "owner/repo", "--add-label", "accepted"]);
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.actions[0]?.area, "issue");
    assert.equal(audit.actions[0]?.operation, "label");
    assert.equal(audit.actions[0]?.repo, "owner/repo");
    assert.equal(audit.actions[0]?.number, 22);
    assert.deepEqual(audit.actions[0]?.add_labels, ["accepted"]);
    assert.equal(audit.actions[0]?.remove_labels, undefined);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run supports GitHub notification mark-read dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-notification-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run notification mark-read");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "notification", "mark-read", "--thread", "notif_123"]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.deepEqual(result.command.args, ["api", "--method", "PATCH", "notifications/threads/notif_123"]);
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.actions[0]?.area, "notification");
    assert.equal(audit.actions[0]?.operation, "mark_read");
    assert.equal(audit.actions[0]?.thread, "notif_123");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run supports GitHub Actions run rerun dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-run-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run Actions run rerun");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "run", "rerun", "--repo", "owner/repo", "--run-id", "987654321"]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.deepEqual(result.command.args, ["run", "rerun", "987654321", "--repo", "owner/repo"]);
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.actions[0]?.area, "run");
    assert.equal(audit.actions[0]?.operation, "rerun");
    assert.equal(audit.actions[0]?.repo, "owner/repo");
    assert.equal(audit.actions[0]?.target_run_id, "987654321");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run supports GitHub workflow dispatch dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-workflow-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run workflow dispatch");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput([
        "github",
        "workflow",
        "dispatch",
        "--repo",
        "owner/repo",
        "--workflow",
        "deploy.yml",
        "--ref",
        "main",
        "--field",
        "env=prod",
        "--field",
        "sha=abc123",
      ]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.deepEqual(result.command.args, ["workflow", "run", "deploy.yml", "--repo", "owner/repo", "--ref", "main", "-f", "env=prod", "-f", "sha=abc123"]);
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.actions[0]?.area, "workflow");
    assert.equal(audit.actions[0]?.operation, "dispatch");
    assert.equal(audit.actions[0]?.repo, "owner/repo");
    assert.equal(audit.actions[0]?.workflow, "deploy.yml");
    assert.equal(audit.actions[0]?.ref, "main");
    assert.deepEqual(audit.actions[0]?.fields, [
      { key: "env", value: "prod" },
      { key: "sha", value: "abc123" },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run supports GitHub deployment status dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-deployment-status-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run deployment status");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput([
        "github",
        "deployment",
        "create-status",
        "--repo",
        "owner/repo",
        "--deployment-id",
        "4242",
        "--state",
        "in-progress",
        "--environment-url",
        "https://prod.example.test",
        "--log-url",
        "https://logs.example.test/deploy/4242",
        "--description",
        "deploying",
      ]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.deepEqual(result.command.args, [
      "api",
      "--method",
      "POST",
      "repos/owner/repo/deployments/4242/statuses",
      "-f",
      "state=in_progress",
      "-f",
      "environment_url=https://prod.example.test/",
      "-f",
      "log_url=https://logs.example.test/deploy/4242",
      "-f",
      "description=deploying",
    ]);
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.actions[0]?.area, "deployment");
    assert.equal(audit.actions[0]?.operation, "create_status");
    assert.equal(audit.actions[0]?.repo, "owner/repo");
    assert.equal(audit.actions[0]?.deployment_id, "4242");
    assert.equal(audit.actions[0]?.state, "in_progress");
    assert.equal(audit.actions[0]?.environment_url, "https://prod.example.test/");
    assert.equal(audit.actions[0]?.log_url, "https://logs.example.test/deploy/4242");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run supports GitHub draft release create dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-release-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run draft release create");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "release", "create-draft", "--repo", "owner/repo", "--tag", "v1.2.3", "--generate-notes"]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.deepEqual(result.command.args, ["release", "create", "v1.2.3", "--repo", "owner/repo", "--draft", "--verify-tag", "--generate-notes"]);
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.actions[0]?.area, "release");
    assert.equal(audit.actions[0]?.operation, "create_draft");
    assert.equal(audit.actions[0]?.repo, "owner/repo");
    assert.equal(audit.actions[0]?.tag, "v1.2.3");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run supports GitHub draft release publish dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-release-publish-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run draft release publish");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "release", "publish-draft", "--repo", "owner/repo", "--tag", "v1.2.5"]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.deepEqual(result.command.args, ["release", "edit", "v1.2.5", "--repo", "owner/repo", "--draft=false", "--verify-tag"]);
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.actions[0]?.area, "release");
    assert.equal(audit.actions[0]?.operation, "publish_draft");
    assert.equal(audit.actions[0]?.repo, "owner/repo");
    assert.equal(audit.actions[0]?.tag, "v1.2.5");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run supports npm package publish dry-run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-npm-publish-dry-run-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "dry-run npm package publish");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["npm", "package", "publish", "--tag", "beta", "--access", "public", "--provenance"]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "dry_run");
    assert.equal(result.preflight.status, "allow");
    assert.equal(result.action.connector, "npm");
    assert.deepEqual(result.command, {
      executable: "npm",
      args: ["publish", "--tag", "beta", "--access", "public", "--provenance"],
    });
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.summary.by_connector.npm, 1);
    assert.equal(audit.actions[0]?.area, "package");
    assert.equal(audit.actions[0]?.operation, "publish");
    assert.equal(audit.actions[0]?.dist_tag, "beta");
    assert.equal(audit.actions[0]?.access, "public");
    assert.equal(audit.actions[0]?.provenance, true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run denies unattended npm package publish execution and projects inbox review", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-npm-publish-deny-"));
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "denied npm package publish");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["npm", "package", "publish", "--execute", "--request-class", "background"]),
      { cwd: workspace.root, env: { PATH: "" } },
    );

    assert.equal(result.status, "denied");
    assert.equal(result.preflight.status, "deny");
    assert.equal(result.preflight.policy_id, "first-class-connector-mutation");
    const inbox = await readLoopInbox(store, workspace);
    const actionItems = inbox.items.filter((item) => item.kind === "action_review");
    assert.equal(actionItems.length, 1);
    assert.equal(actionItems[0]?.source_label, "npm");
    assert.match(actionItems[0]?.detail ?? "", /operation npm\.package\.publish/);
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.denied, 1);
    assert.equal(audit.summary.by_connector.npm, 1);
    assert.equal(audit.actions[0]?.dist_tag, "latest");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run executes npm package publish only with explicit interactive execute", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-npm-publish-execute-"));
  const binDir = path.join(dir, "bin");
  const callsPath = path.join(dir, "npm-calls.txt");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(binDir, { recursive: true });
    const npmPath = path.join(binDir, "npm");
    await writeFile(npmPath, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${callsPath}"\necho published-package\n`, "utf8");
    await chmod(npmPath, 0o755);

    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "execute npm package publish");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["npm", "package", "publish", "--tag", "latest", "--execute"]),
      { cwd: workspace.root, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    assert.equal(result.status, "executed");
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout ?? "", /published-package/);
    assert.equal((await readFile(callsPath, "utf8")).trim(), "publish --tag latest");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.executed, 1);
    assert.equal(audit.summary.by_connector.npm, 1);
    assert.equal(audit.actions[0]?.command, "npm publish --tag latest");
    assert.equal(audit.actions[0]?.dist_tag, "latest");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run rejects npm otp secrets", () => {
  assert.throws(
    () => parseConnectorActionRunInput(["npm", "package", "publish", "--otp", "123456"]),
    /--otp is not supported/,
  );
});

test("connector action-run validates GitHub workflow dispatch fields", () => {
  assert.throws(
    () => parseConnectorActionRunInput(["github", "workflow", "dispatch", "--repo", "owner/repo", "--workflow", "deploy.yml", "--field", "env"]),
    /--field must be key=value/,
  );
  assert.throws(
    () => parseConnectorActionRunInput(["github", "issue", "close", "--repo", "owner/repo", "--number", "22", "--workflow", "deploy.yml"]),
    /--workflow, --ref, and --field are only supported/,
  );
});

test("connector action-run validates GitHub deployment status fields", () => {
  assert.throws(
    () => parseConnectorActionRunInput(["github", "deployment", "create-status", "--repo", "owner/repo", "--deployment-id", "0", "--state", "success"]),
    /--deployment-id must be a positive/,
  );
  assert.throws(
    () => parseConnectorActionRunInput(["github", "deployment", "create-status", "--repo", "owner/repo", "--deployment-id", "42", "--state", "done"]),
    /--state must be/,
  );
  assert.throws(
    () => parseConnectorActionRunInput(["github", "workflow", "dispatch", "--repo", "owner/repo", "--workflow", "deploy.yml", "--deployment-id", "42"]),
    /--deployment-id, --state, --environment-url, --log-url, and --description are only supported/,
  );
});

test("connector action-run validates GitHub PR review fields", () => {
  assert.throws(
    () => parseConnectorActionRunInput(["github", "pull_request", "review", "--repo", "owner/repo", "--number", "17"]),
    /--event must be approve, request-changes, or comment/,
  );
  assert.throws(
    () => parseConnectorActionRunInput(["github", "pull_request", "review", "--repo", "owner/repo", "--number", "17", "--event", "comment"]),
    /--body requires non-empty text/,
  );
  assert.throws(
    () => parseConnectorActionRunInput(["github", "pull_request", "merge", "--repo", "owner/repo", "--number", "17", "--event", "approve"]),
    /--event and --body are only supported/,
  );
  const input = parseConnectorActionRunInput(["github", "pull_request", "review", "--repo", "owner/repo", "--number", "17", "--event", "approve"]);
  if (input.operation !== "review") {
    assert.fail(`expected review action, got ${input.operation}`);
  }
  assert.equal(input.review_event, "approve");
});

test("connector action-run validates GitHub comment fields", () => {
  assert.throws(
    () => parseConnectorActionRunInput(["github", "issue", "comment", "--repo", "owner/repo", "--number", "17"]),
    /--body requires non-empty text/,
  );
  assert.throws(
    () => parseConnectorActionRunInput(["github", "pull_request", "comment", "--repo", "owner/repo", "--number", "17", "--event", "approve", "--body", "Looks good"]),
    /--event is only supported/,
  );
  const issueComment = parseConnectorActionRunInput(["github", "issue", "comment", "--repo", "owner/repo", "--number", "17", "--body", "Thanks"]);
  if (issueComment.operation !== "comment") {
    assert.fail(`expected comment action, got ${issueComment.operation}`);
  }
  assert.equal(issueComment.body, "Thanks");
});

test("connector action-run validates GitHub label fields", () => {
  assert.throws(
    () => parseConnectorActionRunInput(["github", "issue", "label", "--repo", "owner/repo", "--number", "17"]),
    /requires --add-label/,
  );
  assert.throws(
    () => parseConnectorActionRunInput(["github", "pull_request", "label", "--repo", "owner/repo", "--number", "17", "--add-label", "triage", "--remove-label", "TRIAGE"]),
    /Cannot add and remove the same label/,
  );
  assert.throws(
    () => parseConnectorActionRunInput(["github", "pull_request", "merge", "--repo", "owner/repo", "--number", "17", "--add-label", "triage"]),
    /--add-label and --remove-label are only supported/,
  );
  assert.throws(
    () => parseConnectorActionRunInput(["github", "issue", "label", "--repo", "owner/repo", "--number", "17", "--add-label", "\n"]),
    /non-empty single-line label/,
  );
});

test("connector action-run executes GitHub PR merge only with explicit interactive execute", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-execute-"));
  const binDir = path.join(dir, "bin");
  const callsPath = path.join(dir, "gh-calls.txt");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(binDir, { recursive: true });
    const ghPath = path.join(binDir, "gh");
    await writeFile(ghPath, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${callsPath}"\necho merged\n`, "utf8");
    await chmod(ghPath, 0o755);

    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "execute connector action");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "pull_request", "merge", "--repo", "owner/repo", "--number", "19", "--method", "rebase", "--delete-branch", "--execute"]),
      { cwd: workspace.root, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    assert.equal(result.status, "executed");
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout ?? "", /merged/);
    assert.equal((await readFile(callsPath, "utf8")).trim(), "pr merge 19 --repo owner/repo --rebase --delete-branch");
    const events = store.listEvents(session.session_id).filter((event) => event.type === "connector.action.recorded");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.data.status, "executed");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.summary.executed, 1);
    assert.equal(audit.actions[0]?.exit_code, 0);
    assert.equal(audit.actions[0]?.command, "gh pr merge 19 --repo owner/repo --rebase --delete-branch");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run executes GitHub PR review only with explicit interactive execute", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-pr-review-execute-"));
  const binDir = path.join(dir, "bin");
  const callsPath = path.join(dir, "gh-calls.txt");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(binDir, { recursive: true });
    const ghPath = path.join(binDir, "gh");
    await writeFile(ghPath, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${callsPath}"\necho reviewed\n`, "utf8");
    await chmod(ghPath, 0o755);

    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "execute PR review");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "pull_request", "review", "--repo", "owner/repo", "--number", "19", "--event", "approve", "--body", "Looks good", "--execute"]),
      { cwd: workspace.root, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    assert.equal(result.status, "executed");
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout ?? "", /reviewed/);
    assert.equal((await readFile(callsPath, "utf8")).trim(), "pr review 19 --repo owner/repo --approve --body Looks good");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.total, 1);
    assert.equal(audit.summary.executed, 1);
    assert.equal(audit.actions[0]?.command, "gh pr review 19 --repo owner/repo --approve --body Looks good");
    assert.equal(audit.actions[0]?.review_event, "approve");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run executes GitHub PR label only with explicit interactive execute", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-pr-label-execute-"));
  const binDir = path.join(dir, "bin");
  const callsPath = path.join(dir, "gh-calls.txt");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(binDir, { recursive: true });
    const ghPath = path.join(binDir, "gh");
    await writeFile(ghPath, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${callsPath}"\necho labeled\n`, "utf8");
    await chmod(ghPath, 0o755);

    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "execute PR label");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "pull_request", "label", "--repo", "owner/repo", "--number", "19", "--add-label", "ready", "--remove-label", "draft", "--execute"]),
      { cwd: workspace.root, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    assert.equal(result.status, "executed");
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout ?? "", /labeled/);
    assert.equal((await readFile(callsPath, "utf8")).trim(), "pr edit 19 --repo owner/repo --add-label ready --remove-label draft");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.executed, 1);
    assert.equal(audit.actions[0]?.command, "gh pr edit 19 --repo owner/repo --add-label ready --remove-label draft");
    assert.deepEqual(audit.actions[0]?.add_labels, ["ready"]);
    assert.deepEqual(audit.actions[0]?.remove_labels, ["draft"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run executes GitHub issue close only with explicit interactive execute", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-issue-execute-"));
  const binDir = path.join(dir, "bin");
  const callsPath = path.join(dir, "gh-calls.txt");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(binDir, { recursive: true });
    const ghPath = path.join(binDir, "gh");
    await writeFile(ghPath, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${callsPath}"\necho closed\n`, "utf8");
    await chmod(ghPath, 0o755);

    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "execute issue close");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "issue", "close", "--repo", "owner/repo", "--number", "23", "--execute"]),
      { cwd: workspace.root, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    assert.equal(result.status, "executed");
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout ?? "", /closed/);
    assert.equal((await readFile(callsPath, "utf8")).trim(), "issue close 23 --repo owner/repo");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.executed, 1);
    assert.equal(audit.actions[0]?.command, "gh issue close 23 --repo owner/repo");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run executes GitHub issue comment only with explicit interactive execute", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-issue-comment-execute-"));
  const binDir = path.join(dir, "bin");
  const callsPath = path.join(dir, "gh-calls.txt");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(binDir, { recursive: true });
    const ghPath = path.join(binDir, "gh");
    await writeFile(ghPath, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${callsPath}"\necho commented\n`, "utf8");
    await chmod(ghPath, 0o755);

    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "execute issue comment");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "issue", "comment", "--repo", "owner/repo", "--number", "23", "--body", "Leaving a loop triage note", "--execute"]),
      { cwd: workspace.root, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    assert.equal(result.status, "executed");
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout ?? "", /commented/);
    assert.equal((await readFile(callsPath, "utf8")).trim(), "issue comment 23 --repo owner/repo --body Leaving a loop triage note");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.executed, 1);
    assert.equal(audit.actions[0]?.command, "gh issue comment 23 --repo owner/repo --body Leaving a loop triage note");
    assert.equal(audit.actions[0]?.operation, "comment");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run executes GitHub notification mark-read only with explicit interactive execute", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-notification-execute-"));
  const binDir = path.join(dir, "bin");
  const callsPath = path.join(dir, "gh-calls.txt");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(binDir, { recursive: true });
    const ghPath = path.join(binDir, "gh");
    await writeFile(ghPath, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${callsPath}"\necho marked\n`, "utf8");
    await chmod(ghPath, 0o755);

    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "execute notification mark-read");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "notification", "mark-read", "--thread", "notif_456", "--execute"]),
      { cwd: workspace.root, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    assert.equal(result.status, "executed");
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout ?? "", /marked/);
    assert.equal((await readFile(callsPath, "utf8")).trim(), "api --method PATCH notifications/threads/notif_456");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.executed, 1);
    assert.equal(audit.actions[0]?.command, "gh api --method PATCH notifications/threads/notif_456");
    assert.equal(audit.actions[0]?.thread, "notif_456");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run executes GitHub Actions run rerun only with explicit interactive execute", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-run-execute-"));
  const binDir = path.join(dir, "bin");
  const callsPath = path.join(dir, "gh-calls.txt");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(binDir, { recursive: true });
    const ghPath = path.join(binDir, "gh");
    await writeFile(ghPath, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${callsPath}"\necho reran\n`, "utf8");
    await chmod(ghPath, 0o755);

    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "execute Actions run rerun");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "run", "rerun", "--repo", "owner/repo", "--run-id", "987654322", "--execute"]),
      { cwd: workspace.root, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    assert.equal(result.status, "executed");
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout ?? "", /reran/);
    assert.equal((await readFile(callsPath, "utf8")).trim(), "run rerun 987654322 --repo owner/repo");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.executed, 1);
    assert.equal(audit.actions[0]?.command, "gh run rerun 987654322 --repo owner/repo");
    assert.equal(audit.actions[0]?.target_run_id, "987654322");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run executes GitHub workflow dispatch only with explicit interactive execute", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-workflow-execute-"));
  const binDir = path.join(dir, "bin");
  const callsPath = path.join(dir, "gh-calls.txt");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(binDir, { recursive: true });
    const ghPath = path.join(binDir, "gh");
    await writeFile(ghPath, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${callsPath}"\necho dispatched\n`, "utf8");
    await chmod(ghPath, 0o755);

    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "execute workflow dispatch");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "workflow", "dispatch", "--repo", "owner/repo", "--workflow", "deploy.yml", "--ref", "main", "--field", "env=prod", "--execute"]),
      { cwd: workspace.root, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    assert.equal(result.status, "executed");
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout ?? "", /dispatched/);
    assert.equal((await readFile(callsPath, "utf8")).trim(), "workflow run deploy.yml --repo owner/repo --ref main -f env=prod");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.executed, 1);
    assert.equal(audit.actions[0]?.command, "gh workflow run deploy.yml --repo owner/repo --ref main -f env=prod");
    assert.equal(audit.actions[0]?.workflow, "deploy.yml");
    assert.equal(audit.actions[0]?.ref, "main");
    assert.deepEqual(audit.actions[0]?.fields, [{ key: "env", value: "prod" }]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run executes GitHub deployment status only with explicit interactive execute", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-deployment-status-execute-"));
  const binDir = path.join(dir, "bin");
  const callsPath = path.join(dir, "gh-calls.txt");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(binDir, { recursive: true });
    const ghPath = path.join(binDir, "gh");
    await writeFile(ghPath, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${callsPath}"\necho deployment-status\n`, "utf8");
    await chmod(ghPath, 0o755);

    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "execute deployment status");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput([
        "github",
        "deployment",
        "create-status",
        "--repo",
        "owner/repo",
        "--deployment-id",
        "4243",
        "--state",
        "success",
        "--description",
        "deployed",
        "--execute",
      ]),
      { cwd: workspace.root, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    assert.equal(result.status, "executed");
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout ?? "", /deployment-status/);
    assert.equal((await readFile(callsPath, "utf8")).trim(), "api --method POST repos/owner/repo/deployments/4243/statuses -f state=success -f description=deployed");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.executed, 1);
    assert.equal(audit.actions[0]?.command, "gh api --method POST repos/owner/repo/deployments/4243/statuses -f state=success -f description=deployed");
    assert.equal(audit.actions[0]?.deployment_id, "4243");
    assert.equal(audit.actions[0]?.state, "success");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run executes GitHub draft release create only with explicit interactive execute", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-release-execute-"));
  const binDir = path.join(dir, "bin");
  const callsPath = path.join(dir, "gh-calls.txt");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(binDir, { recursive: true });
    const ghPath = path.join(binDir, "gh");
    await writeFile(ghPath, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${callsPath}"\necho draft-release\n`, "utf8");
    await chmod(ghPath, 0o755);

    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "execute draft release create");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "release", "create-draft", "--repo", "owner/repo", "--tag", "v1.2.4", "--title", "v1.2.4", "--notes", "ready", "--execute"]),
      { cwd: workspace.root, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    assert.equal(result.status, "executed");
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout ?? "", /draft-release/);
    assert.equal((await readFile(callsPath, "utf8")).trim(), "release create v1.2.4 --repo owner/repo --draft --verify-tag --title v1.2.4 --notes ready");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.executed, 1);
    assert.equal(audit.actions[0]?.command, "gh release create v1.2.4 --repo owner/repo --draft --verify-tag --title v1.2.4 --notes ready");
    assert.equal(audit.actions[0]?.tag, "v1.2.4");
    assert.equal(audit.actions[0]?.title, "v1.2.4");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector action-run executes GitHub draft release publish only with explicit interactive execute", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-release-publish-execute-"));
  const binDir = path.join(dir, "bin");
  const callsPath = path.join(dir, "gh-calls.txt");
  const store = await SessionStore.open(path.join(dir, "state"));
  try {
    await mkdir(binDir, { recursive: true });
    const ghPath = path.join(binDir, "gh");
    await writeFile(ghPath, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${callsPath}"\necho published-release\n`, "utf8");
    await chmod(ghPath, 0o755);

    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), dir);
    const session = store.createSession(workspace, "execute draft release publish");
    const result = await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "release", "publish-draft", "--repo", "owner/repo", "--tag", "v1.2.6", "--execute"]),
      { cwd: workspace.root, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } },
    );

    assert.equal(result.status, "executed");
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout ?? "", /published-release/);
    assert.equal((await readFile(callsPath, "utf8")).trim(), "release edit v1.2.6 --repo owner/repo --draft=false --verify-tag");
    const audit = readLoopActions(store, workspace);
    assert.equal(audit.summary.executed, 1);
    assert.equal(audit.actions[0]?.command, "gh release edit v1.2.6 --repo owner/repo --draft=false --verify-tag");
    assert.equal(audit.actions[0]?.tag, "v1.2.6");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop action-run command returns dry-run result as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  let sessionId = "";
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    sessionId = store.createSession(workspace, "cli connector action").session_id;
  } finally {
    store.close();
  }

  try {
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const output = await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "loop",
      "action-run",
      sessionId,
      "github",
      "pull_request",
      "merge",
      "--repo",
      "owner/repo",
      "--number",
      "20",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as { status?: string; preflight?: { status?: string }; action?: { repo?: string; number?: number } };
    assert.equal(parsed.status, "dry_run");
    assert.equal(parsed.preflight?.status, "allow");
    assert.equal(parsed.action?.repo, "owner/repo");
    assert.equal(parsed.action?.number, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop action-run command returns GitHub PR review dry-run result as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-pr-review-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  let sessionId = "";
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    sessionId = store.createSession(workspace, "cli PR review connector action").session_id;
  } finally {
    store.close();
  }

  try {
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const output = await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "loop",
      "action-run",
      sessionId,
      "github",
      "pull_request",
      "review",
      "--repo",
      "owner/repo",
      "--number",
      "20",
      "--event",
      "comment",
      "--body",
      "Leaving a review comment",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as {
      status?: string;
      command?: { executable?: string; args?: string[] };
      action?: { repo?: string; number?: number; operation?: string; review_event?: string; body?: string };
    };
    assert.equal(parsed.status, "dry_run");
    assert.equal(parsed.command?.executable, "gh");
    assert.deepEqual(parsed.command?.args, ["pr", "review", "20", "--repo", "owner/repo", "--comment", "--body", "Leaving a review comment"]);
    assert.equal(parsed.action?.repo, "owner/repo");
    assert.equal(parsed.action?.number, 20);
    assert.equal(parsed.action?.operation, "review");
    assert.equal(parsed.action?.review_event, "comment");
    assert.equal(parsed.action?.body, "Leaving a review comment");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop action-run command returns GitHub workflow dispatch dry-run result as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-workflow-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  let sessionId = "";
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    sessionId = store.createSession(workspace, "cli workflow connector action").session_id;
  } finally {
    store.close();
  }

  try {
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const output = await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "loop",
      "action-run",
      sessionId,
      "github",
      "workflow",
      "dispatch",
      "--repo",
      "owner/repo",
      "--workflow",
      "deploy.yml",
      "--ref",
      "main",
      "--field",
      "env=prod",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as {
      status?: string;
      command?: { executable?: string; args?: string[] };
      action?: { repo?: string; workflow?: string; ref?: string; fields?: Array<{ key?: string; value?: string }> };
    };
    assert.equal(parsed.status, "dry_run");
    assert.equal(parsed.command?.executable, "gh");
    assert.deepEqual(parsed.command?.args, ["workflow", "run", "deploy.yml", "--repo", "owner/repo", "--ref", "main", "-f", "env=prod"]);
    assert.equal(parsed.action?.repo, "owner/repo");
    assert.equal(parsed.action?.workflow, "deploy.yml");
    assert.equal(parsed.action?.ref, "main");
    assert.deepEqual(parsed.action?.fields, [{ key: "env", value: "prod" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop action-run command returns GitHub deployment status dry-run result as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-deployment-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  let sessionId = "";
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    sessionId = store.createSession(workspace, "cli deployment connector action").session_id;
  } finally {
    store.close();
  }

  try {
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const output = await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "loop",
      "action-run",
      sessionId,
      "github",
      "deployment",
      "create-status",
      "--repo",
      "owner/repo",
      "--deployment-id",
      "4244",
      "--state",
      "success",
      "--environment-url",
      "https://prod.example.test",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as {
      status?: string;
      command?: { executable?: string; args?: string[] };
      action?: { repo?: string; deployment_id?: string; state?: string; environment_url?: string };
    };
    assert.equal(parsed.status, "dry_run");
    assert.equal(parsed.command?.executable, "gh");
    assert.deepEqual(parsed.command?.args, [
      "api",
      "--method",
      "POST",
      "repos/owner/repo/deployments/4244/statuses",
      "-f",
      "state=success",
      "-f",
      "environment_url=https://prod.example.test/",
    ]);
    assert.equal(parsed.action?.repo, "owner/repo");
    assert.equal(parsed.action?.deployment_id, "4244");
    assert.equal(parsed.action?.state, "success");
    assert.equal(parsed.action?.environment_url, "https://prod.example.test/");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop action-run command returns npm package publish dry-run result as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-action-npm-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  let sessionId = "";
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    sessionId = store.createSession(workspace, "cli npm connector action").session_id;
  } finally {
    store.close();
  }

  try {
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const output = await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "loop",
      "action-run",
      sessionId,
      "npm",
      "package",
      "publish",
      "--tag",
      "beta",
      "--access",
      "public",
      "--provenance",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as {
      status?: string;
      command?: { executable?: string; args?: string[] };
      action?: { connector?: string; area?: string; operation?: string; dist_tag?: string; access?: string; provenance?: boolean };
    };
    assert.equal(parsed.status, "dry_run");
    assert.equal(parsed.command?.executable, "npm");
    assert.deepEqual(parsed.command?.args, ["publish", "--tag", "beta", "--access", "public", "--provenance"]);
    assert.equal(parsed.action?.connector, "npm");
    assert.equal(parsed.action?.area, "package");
    assert.equal(parsed.action?.operation, "publish");
    assert.equal(parsed.action?.dist_tag, "beta");
    assert.equal(parsed.action?.access, "public");
    assert.equal(parsed.action?.provenance, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loop actions command returns connector action audit as json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-actions-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  const store = await SessionStore.open(stateDir);
  let sessionId = "";
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const session = store.createSession(workspace, "cli connector action audit");
    sessionId = session.session_id;
    await runConnectorAction(
      store,
      session,
      parseConnectorActionRunInput(["github", "pull_request", "merge", "--repo", "owner/repo", "--number", "21"]),
      { cwd: workspace.root, env: { PATH: "" } },
    );
  } finally {
    store.close();
  }

  try {
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const output = await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "loop",
      "actions",
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as {
      summary?: { total?: number; dry_run?: number; by_connector?: Record<string, number> };
      actions?: Array<{ status?: string; session_id?: string; repo?: string; number?: number }>;
    };
    assert.equal(parsed.summary?.total, 1);
    assert.equal(parsed.summary?.dry_run, 1);
    assert.equal(parsed.summary?.by_connector?.github, 1);
    assert.equal(parsed.actions?.[0]?.status, "dry_run");
    assert.equal(parsed.actions?.[0]?.session_id, sessionId);
    assert.equal(parsed.actions?.[0]?.repo, "owner/repo");
    assert.equal(parsed.actions?.[0]?.number, 21);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
