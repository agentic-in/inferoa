import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createGitChangesDiscoverySchedule, createGitHubActionsDiscoverySchedule, createGitHubAssignedIssuesDiscoverySchedule, createGitHubAssignedPullRequestsDiscoverySchedule, createGitHubDeploymentsDiscoverySchedule, createGitHubDraftReleasesDiscoverySchedule, createGitHubIssuesDiscoverySchedule, createGitHubNotificationsDiscoverySchedule, createGitHubPullRequestsDiscoverySchedule, createGitHubReviewRequestsDiscoverySchedule, createHttpHealthDiscoverySchedule, createLoopDiscoverySchedule, createNpmPackageDiscoverySchedule, parseDiscoveryOutput, runDueDiscoverySchedules } from "../src/loop/discovery.js";
import { promoteLoopInboxItem, readLoopInbox } from "../src/loop/inbox.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("discovery output parser accepts explicit JSON candidates only", () => {
  const parsed = parseDiscoveryOutput(JSON.stringify({
    items: [
      {
        title: "Fix failing CI",
        prompt: "Investigate CI failure",
        detail: "main branch red",
        priority: "high",
        dedupe_key: "ci:red",
      },
      { description: "ignored without title" },
    ],
  }), { schedule_id: "disc_test" });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.title, "Fix failing CI");
  assert.equal(parsed[0]?.prompt, "Investigate CI failure");
  assert.equal(parsed[0]?.priority, "high");
  assert.throws(() => parseDiscoveryOutput("plain text", { schedule_id: "disc_test" }));
});

test("scheduled discovery runs JSON command, projects inbox candidate, and promotes it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const commandPath = path.join(workspaceRoot, "discover.js");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(commandPath, `console.log(JSON.stringify({items:[{title:"Review stale docs",prompt:"Update stale docs",priority:"medium",dedupe_key:"docs"}]}));\n`, "utf8");
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T00:00:00.000Z");
    const schedule = createLoopDiscoverySchedule(store, workspace, {
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(commandPath)}`,
      interval_ms: 60_000,
      next_run_at: new Date(now.getTime() - 1000).toISOString(),
    });

    const result = await runDueDiscoverySchedules(store, { now });
    assert.equal(result.ran.length, 1);
    assert.equal(result.failed.length, 0);
    assert.equal(result.ran[0]?.candidates.length, 1);
    assert.equal(result.ran[0]?.candidates[0]?.title, "Review stale docs");
    assert.equal(store.getDiscoverySchedule(schedule.schedule_id)?.last_error, undefined);

    const inbox = await readLoopInbox(store, workspace);
    const candidate = inbox.items.find((item) => item.kind === "discovery_candidate");
    assert.ok(candidate);
    assert.equal(candidate.priority, "medium");
    assert.equal(candidate.action, "/inbox promote");

    const promoted = await promoteLoopInboxItem(store, workspace, candidate.id);
    assert.equal(promoted.job.prompt, "Update stale docs");
    assert.equal(promoted.job.metadata.discovery_candidate_id, candidate.candidate_id);
    assert.equal(store.getDiscoveryCandidate(candidate.candidate_id!)?.status, "promoted");
    assert.equal((await readLoopInbox(store, workspace)).items.some((item) => item.id === candidate.id), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("git changes discovery projects local workspace changes and clears when clean", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-git-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: workspaceRoot });
    await writeFile(path.join(workspaceRoot, "feature.txt"), "draft\n", "utf8");
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T00:00:00.000Z");
    const schedule = createGitChangesDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: new Date(now.getTime() - 1000).toISOString(),
    });

    const result = await runDueDiscoverySchedules(store, { now });
    assert.equal(result.failed.length, 0);
    assert.equal(result.ran.length, 1);
    const candidate = result.ran[0]?.candidates[0];
    assert.ok(candidate);
    assert.match(candidate.title, /local git changes/i);
    assert.equal(candidate.source.kind, "git-changes");
    assert.deepEqual(candidate.source.sample_paths, ["feature.txt"]);
    assert.deepEqual(candidate.source.suggested_verifier, {
      id: "git-clean",
      params: {},
    });

    const inbox = await readLoopInbox(store, workspace);
    const item = inbox.items.find((entry) => entry.kind === "discovery_candidate");
    assert.ok(item);
    assert.match(item.prompt ?? "", /git status --short/);
    assert.equal(item.verification_hint?.verifier_id, "git-clean");
    assert.equal("command" in (item.verification_hint ?? {}), false);
    assert.match(item.detail ?? "", /goal\.verify evidence/);

    await execFileAsync("git", ["add", "feature.txt"], { cwd: workspaceRoot });
    await execFileAsync("git", ["-c", "user.name=Inferoa Test", "-c", "user.email=inferoa@example.test", "commit", "-m", "Add feature"], { cwd: workspaceRoot });
    await runDueDiscoverySchedules(store, { now: new Date(now.getTime() + 61_000) });
    assert.equal(store.getDiscoveryCandidate(candidate.candidate_id)?.status, "dismissed");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("github issues discovery uses gh CLI output as discovery candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-github-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  const ghPath = path.join(binDir, "gh");
  const store = await SessionStore.open(stateDir);
  const originalPath = process.env.PATH;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      ghPath,
      [
        "#!/bin/sh",
        "[ \"$1\" = \"issue\" ] || exit 64",
        "[ \"$2\" = \"list\" ] || exit 65",
        "case \" $* \" in *\" --label bug \"*) ;; *) exit 66 ;; esac",
        "case \" $* \" in *\" --label triage \"*) ;; *) exit 67 ;; esac",
        "printf '%s\\n' '[{\"number\":42,\"title\":\"Fix scheduler drift\",\"url\":\"https://example.test/issue/42\",\"updatedAt\":\"2026-06-11T00:00:00Z\",\"labels\":[{\"name\":\"bug\"}],\"assignees\":[{\"login\":\"dev\"}]}]'",
      ].join("\n"),
      "utf8",
    );
    await chmod(ghPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T00:00:00.000Z");
    const schedule = createGitHubIssuesDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: new Date(now.getTime() - 1000).toISOString(),
      repo: "owner/repo",
      labels: ["bug", "triage"],
      limit: 5,
    });

    const result = await runDueDiscoverySchedules(store, { now });
    assert.equal(result.failed.length, 0);
    assert.equal(result.ran.length, 1);
    const candidate = result.ran[0]?.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.title, "GitHub issue #42: Fix scheduler drift");
    assert.equal(candidate.priority, "medium");
    assert.equal(candidate.dedupe_key, "github-issue:owner/repo:42");
    assert.equal(candidate.source.kind, "github-issues");
    assert.equal(candidate.source.repo, "owner/repo");
    assert.deepEqual(candidate.source.labels, ["bug"]);
    assert.deepEqual(candidate.source.label_filter, ["bug", "triage"]);
    assert.deepEqual(candidate.source.suggested_verifier, {
      id: "github-issue-status",
      params: { issue: "42", repo: "owner/repo" },
    });
    assert.match(candidate.prompt, /gh issue view 42 --repo owner\/repo/);
    assert.deepEqual(store.getDiscoverySchedule(schedule.schedule_id)?.metadata.label_filter, ["bug", "triage"]);
    assert.equal(store.getDiscoverySchedule(schedule.schedule_id)?.last_error, undefined);
  } finally {
    process.env.PATH = originalPath;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("github assigned issues discovery uses gh CLI output as assigned discovery candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-github-assigned-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  const ghPath = path.join(binDir, "gh");
  const store = await SessionStore.open(stateDir);
  const originalPath = process.env.PATH;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      ghPath,
      [
        "#!/bin/sh",
        "[ \"$1\" = \"issue\" ] || exit 64",
        "[ \"$2\" = \"list\" ] || exit 65",
        "case \" $* \" in *\" --assignee dev \"*) ;; *) exit 66 ;; esac",
        "case \" $* \" in *\" --repo owner/repo \"*) ;; *) exit 67 ;; esac",
        "case \" $* \" in *\" --label owned \"*) ;; *) exit 68 ;; esac",
        "printf '%s\\n' '[{\"number\":43,\"title\":\"Triage owned scheduler bug\",\"url\":\"https://example.test/issue/43\",\"updatedAt\":\"2026-06-11T00:30:00Z\",\"labels\":[{\"name\":\"owned\"}],\"assignees\":[{\"login\":\"dev\"}]}]'",
      ].join("\n"),
      "utf8",
    );
    await chmod(ghPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T00:30:00.000Z");
    const schedule = createGitHubAssignedIssuesDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: new Date(now.getTime() - 1000).toISOString(),
      repo: "owner/repo",
      assignee: "dev",
      labels: ["owned"],
      limit: 5,
    });

    const result = await runDueDiscoverySchedules(store, { now });
    assert.equal(result.failed.length, 0);
    assert.equal(result.ran.length, 1);
    const candidate = result.ran[0]?.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.title, "GitHub assigned issue #43: Triage owned scheduler bug");
    assert.equal(candidate.priority, "medium");
    assert.equal(candidate.dedupe_key, "github-assigned-issue:owner/repo:43");
    assert.equal(candidate.source.kind, "github-assigned-issues");
    assert.equal(candidate.source.repo, "owner/repo");
    assert.equal(candidate.source.assignee_filter, "dev");
    assert.deepEqual(candidate.source.labels, ["owned"]);
    assert.deepEqual(candidate.source.label_filter, ["owned"]);
    assert.match(candidate.prompt, /Inspect assigned GitHub issue #43 in owner\/repo/);
    assert.match(candidate.prompt, /gh issue view 43 --repo owner\/repo/);
    assert.equal(store.getDiscoverySchedule(schedule.schedule_id)?.last_error, undefined);
  } finally {
    process.env.PATH = originalPath;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("github pull request discovery uses gh CLI output as discovery candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-github-pr-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  const ghPath = path.join(binDir, "gh");
  const store = await SessionStore.open(stateDir);
  const originalPath = process.env.PATH;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      ghPath,
      [
        "#!/bin/sh",
        "[ \"$1\" = \"pr\" ] || exit 64",
        "[ \"$2\" = \"list\" ] || exit 65",
        "case \" $* \" in *\" --label loop \"*) ;; *) exit 66 ;; esac",
        "printf '%s\\n' '[{\"number\":17,\"title\":\"Tighten verifier gate\",\"url\":\"https://example.test/pull/17\",\"baseRefName\":\"main\",\"headRefName\":\"verify-gate\",\"isDraft\":false,\"reviewDecision\":\"REVIEW_REQUIRED\",\"mergeStateStatus\":\"CLEAN\",\"updatedAt\":\"2026-06-11T01:00:00Z\",\"labels\":[{\"name\":\"loop\"}],\"assignees\":[{\"login\":\"dev\"}],\"author\":{\"login\":\"author\"}}]'",
      ].join("\n"),
      "utf8",
    );
    await chmod(ghPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T01:00:00.000Z");
    const schedule = createGitHubPullRequestsDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: new Date(now.getTime() - 1000).toISOString(),
      repo: "owner/repo",
      labels: ["loop"],
      limit: 5,
    });

    const result = await runDueDiscoverySchedules(store, { now });
    assert.equal(result.failed.length, 0);
    assert.equal(result.ran.length, 1);
    const candidate = result.ran[0]?.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.title, "GitHub PR #17: Tighten verifier gate");
    assert.equal(candidate.priority, "medium");
    assert.equal(candidate.dedupe_key, "github-pr:owner/repo:17");
    assert.equal(candidate.source.kind, "github-prs");
    assert.equal(candidate.source.repo, "owner/repo");
    assert.equal(candidate.source.base_ref, "main");
    assert.equal(candidate.source.head_ref, "verify-gate");
    assert.equal(candidate.source.review_decision, "REVIEW_REQUIRED");
    assert.equal(candidate.source.merge_state, "CLEAN");
    assert.deepEqual(candidate.source.labels, ["loop"]);
    assert.deepEqual(candidate.source.label_filter, ["loop"]);
    assert.equal(candidate.source.author, "author");
    assert.deepEqual(candidate.source.suggested_verifier, {
      id: "github-pr-status",
      params: { pr: "17", repo: "owner/repo" },
    });
    assert.match(candidate.prompt, /gh pr view 17 --repo owner\/repo/);
    assert.equal(store.getDiscoverySchedule(schedule.schedule_id)?.last_error, undefined);
  } finally {
    process.env.PATH = originalPath;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("github assigned pull request discovery uses gh CLI output as assigned discovery candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-github-assigned-pr-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  const ghPath = path.join(binDir, "gh");
  const store = await SessionStore.open(stateDir);
  const originalPath = process.env.PATH;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      ghPath,
      [
        "#!/bin/sh",
        "[ \"$1\" = \"pr\" ] || exit 64",
        "[ \"$2\" = \"list\" ] || exit 65",
        "case \" $* \" in *\" --assignee dev \"*) ;; *) exit 66 ;; esac",
        "case \" $* \" in *\" --repo owner/repo \"*) ;; *) exit 67 ;; esac",
        "case \" $* \" in *\" --label owned-pr \"*) ;; *) exit 68 ;; esac",
        "printf '%s\\n' '[{\"number\":18,\"title\":\"Own rollout follow-up\",\"url\":\"https://example.test/pull/18\",\"baseRefName\":\"main\",\"headRefName\":\"rollout-follow-up\",\"isDraft\":false,\"reviewDecision\":\"APPROVED\",\"mergeStateStatus\":\"CLEAN\",\"updatedAt\":\"2026-06-11T01:30:00Z\",\"labels\":[{\"name\":\"owned-pr\"}],\"assignees\":[{\"login\":\"dev\"}],\"author\":{\"login\":\"author\"}}]'",
      ].join("\n"),
      "utf8",
    );
    await chmod(ghPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T01:30:00.000Z");
    const schedule = createGitHubAssignedPullRequestsDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: new Date(now.getTime() - 1000).toISOString(),
      repo: "owner/repo",
      assignee: "dev",
      labels: ["owned-pr"],
      limit: 5,
    });

    const result = await runDueDiscoverySchedules(store, { now });
    assert.equal(result.failed.length, 0);
    assert.equal(result.ran.length, 1);
    const candidate = result.ran[0]?.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.title, "GitHub assigned PR #18: Own rollout follow-up");
    assert.equal(candidate.priority, "medium");
    assert.equal(candidate.dedupe_key, "github-assigned-pr:owner/repo:18");
    assert.equal(candidate.source.kind, "github-assigned-prs");
    assert.equal(candidate.source.repo, "owner/repo");
    assert.equal(candidate.source.assignee_filter, "dev");
    assert.equal(candidate.source.base_ref, "main");
    assert.equal(candidate.source.head_ref, "rollout-follow-up");
    assert.deepEqual(candidate.source.labels, ["owned-pr"]);
    assert.deepEqual(candidate.source.label_filter, ["owned-pr"]);
    assert.match(candidate.prompt, /Inspect assigned GitHub pull request #18 in owner\/repo/);
    assert.match(candidate.prompt, /gh pr view 18 --repo owner\/repo/);
    assert.equal(store.getDiscoverySchedule(schedule.schedule_id)?.last_error, undefined);
  } finally {
    process.env.PATH = originalPath;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("github review request discovery uses gh search output as discovery candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-github-review-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  const ghPath = path.join(binDir, "gh");
  const store = await SessionStore.open(stateDir);
  const originalPath = process.env.PATH;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      ghPath,
      [
        "#!/bin/sh",
        "[ \"$1\" = \"search\" ] || exit 64",
        "[ \"$2\" = \"prs\" ] || exit 65",
        "printf '%s\\n' '[{\"number\":23,\"title\":\"Review loop inbox routing\",\"url\":\"https://example.test/pull/23\",\"isDraft\":false,\"updatedAt\":\"2026-06-11T04:00:00Z\",\"labels\":[{\"name\":\"review\"}],\"assignees\":[{\"login\":\"dev\"}],\"author\":{\"login\":\"author\"},\"repository\":{\"nameWithOwner\":\"owner/repo\"}}]'",
      ].join("\n"),
      "utf8",
    );
    await chmod(ghPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T04:00:00.000Z");
    const schedule = createGitHubReviewRequestsDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: new Date(now.getTime() - 1000).toISOString(),
      limit: 5,
    });

    const result = await runDueDiscoverySchedules(store, { now });
    assert.equal(result.failed.length, 0);
    assert.equal(result.ran.length, 1);
    const candidate = result.ran[0]?.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.title, "GitHub review request owner/repo#23: Review loop inbox routing");
    assert.equal(candidate.priority, "medium");
    assert.equal(candidate.dedupe_key, "github-review-request:owner/repo:23");
    assert.equal(candidate.source.kind, "github-review-requests");
    assert.equal(candidate.source.repo, "owner/repo");
    assert.equal(candidate.source.provider, "github");
    assert.equal(candidate.source.number, 23);
    assert.deepEqual(candidate.source.labels, ["review"]);
    assert.equal(candidate.source.author, "author");
    assert.deepEqual(candidate.source.suggested_verifier, {
      id: "github-review-request",
      params: { pr: "23", repo: "owner/repo" },
    });
    assert.match(candidate.prompt, /gh pr view 23 --repo owner\/repo/);
    assert.match(candidate.prompt, /Do not submit a review/);
    assert.equal(store.getDiscoverySchedule(schedule.schedule_id)?.last_error, undefined);
  } finally {
    process.env.PATH = originalPath;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("github notifications discovery uses gh API output as discovery candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-github-notifications-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  const ghPath = path.join(binDir, "gh");
  const store = await SessionStore.open(stateDir);
  const originalPath = process.env.PATH;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      ghPath,
      [
        "#!/bin/sh",
        "[ \"$1\" = \"api\" ] || exit 64",
        "case \" $* \" in *\" --method GET repos/owner/repo/notifications \"*) ;; *) exit 65 ;; esac",
        "case \" $* \" in *\" per_page=5 \"*) ;; *) exit 66 ;; esac",
        "case \" $* \" in *\" participating=true \"*) ;; *) exit 67 ;; esac",
        "printf '%s\\n' '[{\"id\":\"notif_1\",\"unread\":true,\"reason\":\"review_requested\",\"updated_at\":\"2026-06-11T04:30:00Z\",\"repository\":{\"full_name\":\"owner/repo\"},\"subject\":{\"title\":\"Review loop policy\",\"type\":\"PullRequest\",\"url\":\"https://api.github.com/repos/owner/repo/pulls/44\",\"latest_comment_url\":\"https://api.github.com/repos/owner/repo/issues/comments/100\"}}]'",
      ].join("\n"),
      "utf8",
    );
    await chmod(ghPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T04:30:00.000Z");
    const schedule = createGitHubNotificationsDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: new Date(now.getTime() - 1000).toISOString(),
      repo: "owner/repo",
      participating: true,
      limit: 5,
    });

    const result = await runDueDiscoverySchedules(store, { now });
    assert.equal(result.failed.length, 0);
    assert.equal(result.ran.length, 1);
    const candidate = result.ran[0]?.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.title, "GitHub notification owner/repo: Review loop policy");
    assert.equal(candidate.priority, "medium");
    assert.equal(candidate.dedupe_key, "github-notification:notif_1");
    assert.equal(candidate.source.kind, "github-notifications");
    assert.equal(candidate.source.repo, "owner/repo");
    assert.equal(candidate.source.reason, "review_requested");
    assert.equal(candidate.source.unread, true);
    assert.equal(candidate.source.participating, true);
    assert.equal(candidate.source.subject_type, "PullRequest");
    assert.equal(candidate.source.target_kind, "pull_request");
    assert.equal(candidate.source.target_number, 44);
    assert.deepEqual(candidate.source.suggested_verifier, {
      id: "github-notification-status",
      params: { thread: "notif_1" },
    });
    assert.match(candidate.prompt, /gh pr view 44 --repo owner\/repo/);
    assert.match(candidate.prompt, /gh api notifications\/threads\/notif_1/);
    assert.match(candidate.prompt, /Do not mark notifications as read/);
    assert.equal(store.getDiscoverySchedule(schedule.schedule_id)?.last_error, undefined);
  } finally {
    process.env.PATH = originalPath;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("github actions discovery uses gh CLI output as CI candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-github-ci-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  const ghPath = path.join(binDir, "gh");
  const store = await SessionStore.open(stateDir);
  const originalPath = process.env.PATH;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      ghPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' '[{\"databaseId\":9001,\"number\":44,\"name\":\"test\",\"workflowName\":\"CI\",\"displayTitle\":\"Fix verifier policy\",\"event\":\"pull_request\",\"headBranch\":\"loop-ci\",\"headSha\":\"1234567890abcdef\",\"attempt\":2,\"status\":\"completed\",\"conclusion\":\"failure\",\"startedAt\":\"2026-06-11T02:00:00Z\",\"updatedAt\":\"2026-06-11T02:05:00Z\",\"url\":\"https://example.test/actions/runs/9001\"}]'",
      ].join("\n"),
      "utf8",
    );
    await chmod(ghPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T02:00:00.000Z");
    const schedule = createGitHubActionsDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: new Date(now.getTime() - 1000).toISOString(),
      repo: "owner/repo",
      limit: 5,
    });

    const result = await runDueDiscoverySchedules(store, { now });
    assert.equal(result.failed.length, 0);
    assert.equal(result.ran.length, 1);
    const candidate = result.ran[0]?.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.title, "GitHub Actions failure 9001: Fix verifier policy");
    assert.equal(candidate.priority, "high");
    assert.equal(candidate.dedupe_key, "github-actions-run:owner/repo:9001");
    assert.equal(candidate.source.kind, "github-actions");
    assert.equal(candidate.source.repo, "owner/repo");
    assert.equal(candidate.source.run_id, 9001);
    assert.equal(candidate.source.workflow_name, "CI");
    assert.equal(candidate.source.head_branch, "loop-ci");
    assert.equal(candidate.source.conclusion, "failure");
    assert.deepEqual(candidate.source.suggested_verifier, {
      id: "github-actions-run",
      params: { run: "9001", repo: "owner/repo", attempt: 2 },
    });
    assert.match(candidate.prompt, /gh run view 9001 --repo owner\/repo --log/);
    assert.equal(store.getDiscoverySchedule(schedule.schedule_id)?.last_error, undefined);
  } finally {
    process.env.PATH = originalPath;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("github draft release discovery uses gh CLI output as release candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-github-release-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  const ghPath = path.join(binDir, "gh");
  const store = await SessionStore.open(stateDir);
  const originalPath = process.env.PATH;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      ghPath,
      [
        "#!/bin/sh",
        "[ \"$1\" = \"release\" ] || exit 64",
        "[ \"$2\" = \"list\" ] || exit 65",
        "case \" $* \" in *\" --repo owner/repo \"*) ;; *) exit 66 ;; esac",
        "case \" $* \" in *\" --limit 5 \"*) ;; *) exit 67 ;; esac",
        "printf '%s\\n' '[{\"tagName\":\"v1.2.3\",\"name\":\"v1.2.3\",\"isDraft\":true,\"isPrerelease\":false,\"isLatest\":false,\"createdAt\":\"2026-06-11T05:00:00Z\",\"publishedAt\":null},{\"tagName\":\"v1.2.2\",\"name\":\"v1.2.2\",\"isDraft\":false,\"isPrerelease\":false,\"isLatest\":true,\"createdAt\":\"2026-06-10T05:00:00Z\",\"publishedAt\":\"2026-06-10T05:30:00Z\"}]'",
      ].join("\n"),
      "utf8",
    );
    await chmod(ghPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T05:00:00.000Z");
    const schedule = createGitHubDraftReleasesDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: new Date(now.getTime() - 1000).toISOString(),
      repo: "owner/repo",
      limit: 5,
    });

    const result = await runDueDiscoverySchedules(store, { now });
    assert.equal(result.failed.length, 0);
    assert.equal(result.ran.length, 1);
    assert.equal(result.ran[0]?.candidates.length, 1);
    const candidate = result.ran[0]?.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.title, "GitHub draft release v1.2.3");
    assert.equal(candidate.priority, "medium");
    assert.equal(candidate.dedupe_key, "github-draft-release:owner/repo:v1.2.3");
    assert.equal(candidate.source.kind, "github-draft-releases");
    assert.equal(candidate.source.provider, "github");
    assert.equal(candidate.source.repo, "owner/repo");
    assert.equal(candidate.source.tag, "v1.2.3");
    assert.equal(candidate.source.draft, true);
    assert.deepEqual(candidate.source.suggested_verifier, {
      id: "github-release-status",
      params: { tag: "v1.2.3", repo: "owner/repo", expect: "published" },
    });
    assert.match(candidate.prompt, /gh release view v1\.2\.3 --repo owner\/repo/);
    assert.equal(store.getDiscoverySchedule(schedule.schedule_id)?.last_error, undefined);

    const inbox = await readLoopInbox(store, workspace);
    const item = inbox.items.find((entry) => entry.kind === "discovery_candidate");
    assert.ok(item);
    assert.equal(item.source, "github-draft-releases");
    assert.equal(item.verification_hint?.verifier_id, "github-release-status");
    assert.equal("command" in (item.verification_hint ?? {}), false);
    assert.match(item.detail ?? "", /goal\.verify evidence/);
  } finally {
    process.env.PATH = originalPath;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("github deployments discovery uses gh API output as deployment candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-github-deployment-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  const ghPath = path.join(binDir, "gh");
  const store = await SessionStore.open(stateDir);
  const originalPath = process.env.PATH;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      ghPath,
      [
        "#!/bin/sh",
        "[ \"$1\" = \"api\" ] || exit 64",
        "case \" $* \" in *\" --method GET repos/owner/repo/deployments \"*) ;; *) exit 65 ;; esac",
        "case \" $* \" in *\" per_page=5 \"*) ;; *) exit 66 ;; esac",
        "case \" $* \" in *\" environment=prod \"*) ;; *) exit 67 ;; esac",
        "case \" $* \" in *\" ref=main \"*) ;; *) exit 68 ;; esac",
        "printf '%s\\n' '[{\"id\":4242,\"environment\":\"prod\",\"ref\":\"main\",\"sha\":\"abcdef1234567890\",\"task\":\"deploy\",\"description\":\"production rollout\",\"creator\":{\"login\":\"deployer\"},\"url\":\"https://api.github.com/repos/owner/repo/deployments/4242\",\"statuses_url\":\"https://api.github.com/repos/owner/repo/deployments/4242/statuses\",\"created_at\":\"2026-06-11T06:00:00Z\",\"updated_at\":\"2026-06-11T06:05:00Z\"}]'",
      ].join("\n"),
      "utf8",
    );
    await chmod(ghPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T06:00:00.000Z");
    const schedule = createGitHubDeploymentsDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: new Date(now.getTime() - 1000).toISOString(),
      repo: "owner/repo",
      environment: "prod",
      ref: "main",
      limit: 5,
    });

    const result = await runDueDiscoverySchedules(store, { now });
    assert.equal(result.failed.length, 0);
    assert.equal(result.ran.length, 1);
    const candidate = result.ran[0]?.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.title, "GitHub Deployment 4242 (prod)");
    assert.equal(candidate.priority, "medium");
    assert.equal(candidate.dedupe_key, "github-deployment:owner/repo:4242");
    assert.equal(candidate.source.kind, "github-deployments");
    assert.equal(candidate.source.provider, "github");
    assert.equal(candidate.source.repo, "owner/repo");
    assert.equal(candidate.source.deployment_id, 4242);
    assert.equal(candidate.source.environment, "prod");
    assert.equal(candidate.source.ref, "main");
    assert.equal(candidate.source.sha, "abcdef1234567890");
    assert.equal(candidate.source.task, "deploy");
    assert.equal(candidate.source.creator, "deployer");
    assert.deepEqual(candidate.source.suggested_verifier, {
      id: "github-deployment-status",
      params: { repo: "owner/repo", deployment_id: "4242" },
    });
    assert.match(candidate.prompt, /read-only gh CLI\/API/i);
    assert.match(candidate.prompt, /goal\.verify evidence/);
    assert.match(candidate.prompt, /Do not create deployment statuses/);
    assert.equal(store.getDiscoverySchedule(schedule.schedule_id)?.last_error, undefined);

    const inbox = await readLoopInbox(store, workspace);
    const item = inbox.items.find((entry) => entry.kind === "discovery_candidate");
    assert.ok(item);
    assert.equal(item.source, "github-deployments");
    assert.equal(item.verification_hint?.verifier_id, "github-deployment-status");
    assert.equal("command" in (item.verification_hint ?? {}), false);
    assert.match(item.detail ?? "", /goal\.verify evidence/);
  } finally {
    process.env.PATH = originalPath;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP health discovery creates and clears typed health candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-http-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const store = await SessionStore.open(stateDir);
  const routes: Record<string, number> = { "/health": 503 };
  const server = await startDiscoveryServer(routes);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T03:00:00.000Z");
    const schedule = createHttpHealthDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: new Date(now.getTime() - 1000).toISOString(),
      url: server.url("/health"),
      expected_status: 200,
      timeout_ms: 1_000,
    });

    const result = await runDueDiscoverySchedules(store, { now });
    assert.equal(result.failed.length, 0);
    assert.equal(result.ran.length, 1);
    const candidate = result.ran[0]?.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.title, `HTTP health status 503: ${server.url("/health")}`);
    assert.equal(candidate.priority, "high");
    assert.equal(candidate.dedupe_key, `http-health:${server.url("/health")}:200`);
    assert.equal(candidate.source.kind, "http-health");
    assert.equal(candidate.source.provider, "http");
    assert.equal(candidate.source.status, 503);
    assert.equal(candidate.source.expected_status, 200);
    assert.deepEqual(candidate.source.suggested_verifier, {
      id: "http-health",
      params: { url: server.url("/health"), expected_status: 200 },
    });
    assert.match(candidate.prompt, /read-only HTTP checks/);
    assert.match(candidate.prompt, /goal\.verify evidence/);

    const inbox = await readLoopInbox(store, workspace);
    const item = inbox.items.find((entry) => entry.kind === "discovery_candidate");
    assert.ok(item);
    assert.equal(item.source, "http-health");
    assert.equal(item.verification_hint?.verifier_id, "http-health");
    assert.equal("command" in (item.verification_hint ?? {}), false);
    assert.match(item.prompt ?? "", /HTTP health check failure/);
    assert.match(item.detail ?? "", /goal\.verify evidence/);

    routes["/health"] = 200;
    const next = new Date("2026-06-11T03:01:00.000Z");
    store.updateDiscoverySchedule(schedule.schedule_id, { next_run_at: new Date(next.getTime() - 1000).toISOString() });
    const clearResult = await runDueDiscoverySchedules(store, { now: next });
    assert.equal(clearResult.failed.length, 0);
    assert.equal(clearResult.ran.length, 1);
    assert.equal(clearResult.ran[0]?.candidates.length, 0);
    const cleared = store.getDiscoveryCandidate(candidate.candidate_id);
    assert.equal(cleared?.status, "dismissed");
    assert.equal(cleared?.source.dismissed_by_source, "http-health");
  } finally {
    await server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("npm package discovery creates and clears typed package status candidates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-npm-"));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  const npmPath = path.join(binDir, "npm");
  const store = await SessionStore.open(stateDir);
  const originalPath = process.env.PATH;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFakeNpmView(npmPath, {
      versions: ["1.2.2", "1.2.3"],
      "dist-tags": { latest: "1.2.2" },
    });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
    const now = new Date("2026-06-11T07:00:00.000Z");
    const schedule = createNpmPackageDiscoverySchedule(store, workspace, {
      interval_ms: 60_000,
      next_run_at: new Date(now.getTime() - 1000).toISOString(),
      package_name: "@scope/pkg",
      version: "1.2.3",
      tag: "latest",
    });

    const result = await runDueDiscoverySchedules(store, { now });
    assert.equal(result.failed.length, 0);
    assert.equal(result.ran.length, 1);
    const candidate = result.ran[0]?.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.title, "npm dist-tag mismatch: @scope/pkg latest");
    assert.equal(candidate.priority, "high");
    assert.equal(candidate.dedupe_key, "npm-package-status:@scope/pkg:1.2.3:latest");
    assert.equal(candidate.source.kind, "npm-package-status");
    assert.equal(candidate.source.provider, "npm");
    assert.equal(candidate.source.package_name, "@scope/pkg");
    assert.equal(candidate.source.version, "1.2.3");
    assert.equal(candidate.source.tag, "latest");
    assert.equal(candidate.source.version_present, true);
    assert.equal(candidate.source.tag_version, "1.2.2");
    assert.equal(candidate.source.tag_match, false);
    assert.deepEqual(candidate.source.suggested_verifier, {
      id: "npm-package-status",
      params: { package_name: "@scope/pkg", version: "1.2.3", tag: "latest" },
    });
    assert.match(candidate.prompt, /read-only npm CLI/);
    assert.match(candidate.prompt, /goal\.verify evidence/);

    const inbox = await readLoopInbox(store, workspace);
    const item = inbox.items.find((entry) => entry.kind === "discovery_candidate");
    assert.ok(item);
    assert.equal(item.source, "npm-package-status");
    assert.equal(item.verification_hint?.verifier_id, "npm-package-status");
    assert.equal("command" in (item.verification_hint ?? {}), false);
    assert.match(item.detail ?? "", /goal\.verify evidence/);

    await writeFakeNpmView(npmPath, {
      versions: ["1.2.2", "1.2.3"],
      "dist-tags": { latest: "1.2.3" },
    });
    const next = new Date("2026-06-11T07:01:00.000Z");
    store.updateDiscoverySchedule(schedule.schedule_id, { next_run_at: new Date(next.getTime() - 1000).toISOString() });
    const clearResult = await runDueDiscoverySchedules(store, { now: next });
    assert.equal(clearResult.failed.length, 0);
    assert.equal(clearResult.ran.length, 1);
    assert.equal(clearResult.ran[0]?.candidates.length, 0);
    const cleared = store.getDiscoveryCandidate(candidate.candidate_id);
    assert.equal(cleared?.status, "dismissed");
    assert.equal(cleared?.source.dismissed_by_source, "npm-package-status");
  } finally {
    process.env.PATH = originalPath;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovery command can add and list schedules", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-loop-discovery-cli-"));
  const workspaceRoot = path.join(dir, "workspace");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  try {
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const baseArgs = [
      cliPath,
      "--workspace",
      workspaceRoot,
      "--config",
      configPath,
      "--state-dir",
      stateDir,
      "--json",
      "discovery",
    ];
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log(JSON.stringify([]))")}`;
    const added = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add", "1h", command], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      command: string;
    };
    assert.ok(added.schedule_id.startsWith("disc_"));
    assert.equal(added.interval_ms, 3_600_000);
    assert.equal(added.command, command);

    const gitAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add-git", "2h"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      command: string;
      metadata: { source?: string };
    };
    assert.ok(gitAdded.schedule_id.startsWith("disc_"));
    assert.equal(gitAdded.interval_ms, 7_200_000);
    assert.equal(gitAdded.command, "git-changes");
    assert.equal(gitAdded.metadata.source, "git-changes");

    const githubAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add-github-issues", "30m", "--repo", "owner/repo", "--label", "bug", "--label", "triage", "--limit", "10"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      command: string;
      metadata: { source?: string; repo?: string; label_filter?: string[]; limit?: number };
    };
    assert.ok(githubAdded.schedule_id.startsWith("disc_"));
    assert.equal(githubAdded.interval_ms, 1_800_000);
    assert.equal(githubAdded.command, "github-issues");
    assert.equal(githubAdded.metadata.source, "github-issues");
    assert.equal(githubAdded.metadata.repo, "owner/repo");
    assert.deepEqual(githubAdded.metadata.label_filter, ["bug", "triage"]);
    assert.equal(githubAdded.metadata.limit, 10);

    const githubAssignedAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add-github-assigned-issues", "25m", "--repo", "owner/repo", "--assignee", "dev", "--label", "owned", "--limit", "9"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      command: string;
      metadata: { source?: string; repo?: string; assignee?: string; label_filter?: string[]; limit?: number };
    };
    assert.ok(githubAssignedAdded.schedule_id.startsWith("disc_"));
    assert.equal(githubAssignedAdded.interval_ms, 1_500_000);
    assert.equal(githubAssignedAdded.command, "github-assigned-issues");
    assert.equal(githubAssignedAdded.metadata.source, "github-assigned-issues");
    assert.equal(githubAssignedAdded.metadata.repo, "owner/repo");
    assert.equal(githubAssignedAdded.metadata.assignee, "dev");
    assert.deepEqual(githubAssignedAdded.metadata.label_filter, ["owned"]);
    assert.equal(githubAssignedAdded.metadata.limit, 9);

    const githubPrAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add-github-prs", "45m", "--repo", "owner/repo", "--label", "loop", "--limit", "8"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      command: string;
      metadata: { source?: string; repo?: string; label_filter?: string[]; limit?: number };
    };
    assert.ok(githubPrAdded.schedule_id.startsWith("disc_"));
    assert.equal(githubPrAdded.interval_ms, 2_700_000);
    assert.equal(githubPrAdded.command, "github-prs");
    assert.equal(githubPrAdded.metadata.source, "github-prs");
    assert.equal(githubPrAdded.metadata.repo, "owner/repo");
    assert.deepEqual(githubPrAdded.metadata.label_filter, ["loop"]);
    assert.equal(githubPrAdded.metadata.limit, 8);

    const githubAssignedPrAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add-github-assigned-prs", "35m", "--repo", "owner/repo", "--assignee", "dev", "--label", "owned-pr", "--limit", "4"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      command: string;
      metadata: { source?: string; repo?: string; assignee?: string; label_filter?: string[]; limit?: number };
    };
    assert.ok(githubAssignedPrAdded.schedule_id.startsWith("disc_"));
    assert.equal(githubAssignedPrAdded.interval_ms, 2_100_000);
    assert.equal(githubAssignedPrAdded.command, "github-assigned-prs");
    assert.equal(githubAssignedPrAdded.metadata.source, "github-assigned-prs");
    assert.equal(githubAssignedPrAdded.metadata.repo, "owner/repo");
    assert.equal(githubAssignedPrAdded.metadata.assignee, "dev");
    assert.deepEqual(githubAssignedPrAdded.metadata.label_filter, ["owned-pr"]);
    assert.equal(githubAssignedPrAdded.metadata.limit, 4);

    const githubReviewAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add-github-review-requests", "20m", "--repo", "owner/repo", "--limit", "7"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      command: string;
      metadata: { source?: string; repo?: string; limit?: number };
    };
    assert.ok(githubReviewAdded.schedule_id.startsWith("disc_"));
    assert.equal(githubReviewAdded.interval_ms, 1_200_000);
    assert.equal(githubReviewAdded.command, "github-review-requests");
    assert.equal(githubReviewAdded.metadata.source, "github-review-requests");
    assert.equal(githubReviewAdded.metadata.repo, "owner/repo");
    assert.equal(githubReviewAdded.metadata.limit, 7);

    const githubNotificationsAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add-github-notifications", "10m", "--repo", "owner/repo", "--participating", "--limit", "3"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      command: string;
      metadata: { source?: string; repo?: string; participating?: boolean; limit?: number };
    };
    assert.ok(githubNotificationsAdded.schedule_id.startsWith("disc_"));
    assert.equal(githubNotificationsAdded.interval_ms, 600_000);
    assert.equal(githubNotificationsAdded.command, "github-notifications");
    assert.equal(githubNotificationsAdded.metadata.source, "github-notifications");
    assert.equal(githubNotificationsAdded.metadata.repo, "owner/repo");
    assert.equal(githubNotificationsAdded.metadata.participating, true);
    assert.equal(githubNotificationsAdded.metadata.limit, 3);

    const githubCiAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add-github-ci", "15m", "--repo", "owner/repo", "--limit", "6"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      command: string;
      metadata: { source?: string; repo?: string; limit?: number };
    };
    assert.ok(githubCiAdded.schedule_id.startsWith("disc_"));
    assert.equal(githubCiAdded.interval_ms, 900_000);
    assert.equal(githubCiAdded.command, "github-actions");
    assert.equal(githubCiAdded.metadata.source, "github-actions");
    assert.equal(githubCiAdded.metadata.repo, "owner/repo");
    assert.equal(githubCiAdded.metadata.limit, 6);

    const githubDraftReleaseAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add-github-draft-releases", "12m", "--repo", "owner/repo", "--limit", "4"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      command: string;
      metadata: { source?: string; repo?: string; limit?: number };
    };
    assert.ok(githubDraftReleaseAdded.schedule_id.startsWith("disc_"));
    assert.equal(githubDraftReleaseAdded.interval_ms, 720_000);
    assert.equal(githubDraftReleaseAdded.command, "github-draft-releases");
    assert.equal(githubDraftReleaseAdded.metadata.source, "github-draft-releases");
    assert.equal(githubDraftReleaseAdded.metadata.repo, "owner/repo");
    assert.equal(githubDraftReleaseAdded.metadata.limit, 4);

    const githubDeploymentAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add-github-deployments", "18m", "--repo", "owner/repo", "--environment", "prod", "--ref", "main", "--limit", "5"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      command: string;
      metadata: { source?: string; repo?: string; environment?: string; ref?: string; limit?: number };
    };
    assert.ok(githubDeploymentAdded.schedule_id.startsWith("disc_"));
    assert.equal(githubDeploymentAdded.interval_ms, 1_080_000);
    assert.equal(githubDeploymentAdded.command, "github-deployments");
    assert.equal(githubDeploymentAdded.metadata.source, "github-deployments");
    assert.equal(githubDeploymentAdded.metadata.repo, "owner/repo");
    assert.equal(githubDeploymentAdded.metadata.environment, "prod");
    assert.equal(githubDeploymentAdded.metadata.ref, "main");
    assert.equal(githubDeploymentAdded.metadata.limit, 5);

    const httpAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add-http", "15m", "http://127.0.0.1:65535/health", "--status", "204", "--timeout-ms", "1500"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      timeout_ms: number;
      command: string;
      metadata: { source?: string; url?: string; expected_status?: number };
    };
    assert.ok(httpAdded.schedule_id.startsWith("disc_"));
    assert.equal(httpAdded.interval_ms, 900_000);
    assert.equal(httpAdded.timeout_ms, 1_500);
    assert.equal(httpAdded.command, "http-health");
    assert.equal(httpAdded.metadata.source, "http-health");
    assert.equal(httpAdded.metadata.url, "http://127.0.0.1:65535/health");
    assert.equal(httpAdded.metadata.expected_status, 204);

    const npmAdded = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "add-npm-package", "22m", "@scope/pkg", "--version", "1.2.3", "--tag", "latest"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedule_id: string;
      interval_ms: number;
      command: string;
      metadata: { source?: string; package_name?: string; version?: string; tag?: string };
    };
    assert.ok(npmAdded.schedule_id.startsWith("disc_"));
    assert.equal(npmAdded.interval_ms, 1_320_000);
    assert.equal(npmAdded.command, "npm-package-status");
    assert.equal(npmAdded.metadata.source, "npm-package-status");
    assert.equal(npmAdded.metadata.package_name, "@scope/pkg");
    assert.equal(npmAdded.metadata.version, "1.2.3");
    assert.equal(npmAdded.metadata.tag, "latest");

    const listed = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "list"], { maxBuffer: 1024 * 1024 })).stdout) as {
      schedules: { schedule_id: string }[];
      candidates: unknown[];
    };
    assert.equal(listed.schedules.length, 13);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === added.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === gitAdded.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === githubAdded.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === githubAssignedAdded.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === githubPrAdded.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === githubAssignedPrAdded.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === githubReviewAdded.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === githubNotificationsAdded.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === githubCiAdded.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === githubDraftReleaseAdded.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === githubDeploymentAdded.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === httpAdded.schedule_id), true);
    assert.equal(listed.schedules.some((schedule) => schedule.schedule_id === npmAdded.schedule_id), true);
    assert.equal(listed.candidates.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function startDiscoveryServer(routes: Record<string, number>): Promise<{
  server: Server;
  url: (pathname: string) => string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    const status = routes[request.url ?? ""] ?? 404;
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(String(status));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: (pathname: string) => `http://127.0.0.1:${address.port}${pathname}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function writeFakeNpmView(npmPath: string, payload: unknown): Promise<void> {
  const json = JSON.stringify(payload).replace(/'/g, "'\\''");
  await writeFile(npmPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"view\" ] && [ \"$3\" = \"versions\" ] && [ \"$4\" = \"dist-tags\" ] && [ \"$5\" = \"--json\" ]; then",
    `  printf '%s\\n' '${json}'`,
    "  exit 0",
    "fi",
    "exit 64",
    "",
  ].join("\n"), "utf8");
  await chmod(npmPath, 0o755);
}
