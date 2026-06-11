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
import { createGoalState, writeGoalState } from "../src/goals/state.js";
import { verifyGitHubActionsRun, verifyGitHubDeploymentStatus, verifyGitHubIssueStatus, verifyGitHubNotificationStatus, verifyGitHubPullRequestChecks, verifyGitHubPullRequestStatus, verifyGitHubReleaseStatus, verifyGitHubReviewRequestStatus, verifyGitHubWorkflowRunStatus } from "../src/loop/github-verification.js";
import { readLoopMetrics } from "../src/loop/metrics.js";
import { readGoalVerificationRecords } from "../src/loop/verification.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("GitHub PR checks verifier records connector verification from gh JSON", async () => {
  const fixture = await createFixture("inferoa-loop-github-verification-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '[{\"name\":\"unit\",\"workflow\":\"CI\",\"bucket\":\"pass\",\"state\":\"SUCCESS\",\"link\":\"https://example.test/unit\"},{\"name\":\"lint\",\"workflow\":\"CI\",\"bucket\":\"pass\",\"state\":\"SUCCESS\"}]'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubPullRequestChecks(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      pr: "17",
      repo: "owner/repo",
      run_id: "verify_github_pr_pass",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-pr-checks");
    assert.equal(verification.verdict, "pass");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.evidence?.connector, "github");
    assert.equal(verification.evidence?.verifier, "github-pr-checks");
    assert.equal(verification.metrics?.check_count, 2);
    assert.equal(verification.metrics?.pass, 2);

    const records = readGoalVerificationRecords(fixture.store, fixture.session.session_id);
    assert.equal(records[0]?.provider, "connector");
    assert.equal(records[0]?.verifier_role, "github-pr-checks");
    const metrics = readLoopMetrics(fixture.store, fixture.workspace);
    assert.equal(metrics.verification.by_provider.some((group) => group.key === "connector" && group.verification.pass === 1), true);
    assert.equal(metrics.by_connector.some((group) => group.key === "github" && group.verification.pass === 1), true);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub PR checks verifier treats gh pending exit code as partial evidence", async () => {
  const fixture = await createFixture("inferoa-loop-github-verification-pending-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '[{\"name\":\"unit\",\"workflow\":\"CI\",\"bucket\":\"pending\",\"state\":\"PENDING\"}]'",
      "exit 8",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubPullRequestChecks(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      pr: "17",
      repo: "owner/repo",
      run_id: "verify_github_pr_pending",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verdict, "partial");
    assert.equal(verification.confidence, "mixed");
    assert.equal(verification.metrics?.pending, 1);
    assert.match(verification.failure_reason ?? "", /pending/i);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("verify-github-pr command records GitHub connector verification", async () => {
  const fixture = await createFixture("inferoa-loop-github-verification-cli-");
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(fixture.workspace.root, ".inferoa", "config.yaml"), YAML.stringify(DEFAULT_CONFIG), "utf8");
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '[{\"name\":\"unit\",\"workflow\":\"CI\",\"bucket\":\"pass\",\"state\":\"SUCCESS\"}]'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      fixture.workspace.root,
      "--config",
      path.join(fixture.workspace.root, ".inferoa", "config.yaml"),
      "--state-dir",
      fixture.stateDir,
      "--json",
      "verify-github-pr",
      fixture.session.session_id,
      "17",
      "--repo",
      "owner/repo",
    ], { maxBuffer: 1024 * 1024 })).stdout) as { verification: { provider?: string; verdict?: string; verifier_role?: string } };

    assert.equal(result.verification.provider, "connector");
    assert.equal(result.verification.verdict, "pass");
    assert.equal(result.verification.verifier_role, "github-pr-checks");
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub PR status verifier records merged PR as hard pass", async () => {
  const fixture = await createFixture("inferoa-loop-github-pr-status-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"number\":17,\"title\":\"Fix loop\",\"url\":\"https://example.test/pull/17\",\"state\":\"MERGED\",\"merged\":true,\"isDraft\":false,\"reviewDecision\":\"APPROVED\",\"mergeStateStatus\":\"CLEAN\",\"baseRefName\":\"main\",\"headRefName\":\"loop-fix\"}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubPullRequestStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      pr: "17",
      repo: "owner/repo",
      run_id: "verify_github_pr_status_pass",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-pr-status");
    assert.equal(verification.verdict, "pass");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.evidence?.connector, "github");
    assert.equal(verification.evidence?.verifier, "github-pr-status");
    assert.equal(verification.evidence?.merged, true);
    assert.equal(verification.metrics?.merged, 1);
    assert.equal(verification.metrics?.approved, 1);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub PR status verifier treats open approved PR as partial evidence", async () => {
  const fixture = await createFixture("inferoa-loop-github-pr-status-partial-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"number\":17,\"state\":\"OPEN\",\"merged\":false,\"isDraft\":false,\"reviewDecision\":\"APPROVED\",\"mergeStateStatus\":\"CLEAN\"}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubPullRequestStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      pr: "17",
      repo: "owner/repo",
      run_id: "verify_github_pr_status_partial",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-pr-status");
    assert.equal(verification.verdict, "partial");
    assert.equal(verification.confidence, "mixed");
    assert.match(verification.failure_reason ?? "", /not merged/i);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub PR status verifier treats blocked PR as hard failure", async () => {
  const fixture = await createFixture("inferoa-loop-github-pr-status-fail-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"number\":17,\"state\":\"OPEN\",\"merged\":false,\"isDraft\":false,\"reviewDecision\":\"CHANGES_REQUESTED\",\"mergeStateStatus\":\"DIRTY\"}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubPullRequestStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      pr: "17",
      repo: "owner/repo",
      run_id: "verify_github_pr_status_fail",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-pr-status");
    assert.equal(verification.verdict, "fail");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.metrics?.changes_requested, 1);
    assert.equal(verification.metrics?.merge_blocked, 1);
    assert.match(verification.failure_reason ?? "", /requested changes/i);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("verify-github-pr-status command records GitHub connector verification", async () => {
  const fixture = await createFixture("inferoa-loop-github-pr-status-cli-");
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(fixture.workspace.root, ".inferoa", "config.yaml"), YAML.stringify(DEFAULT_CONFIG), "utf8");
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"number\":17,\"state\":\"MERGED\",\"merged\":true,\"isDraft\":false,\"reviewDecision\":\"APPROVED\",\"mergeStateStatus\":\"CLEAN\"}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      fixture.workspace.root,
      "--config",
      path.join(fixture.workspace.root, ".inferoa", "config.yaml"),
      "--state-dir",
      fixture.stateDir,
      "--json",
      "verify-github-pr-status",
      fixture.session.session_id,
      "17",
      "--repo",
      "owner/repo",
    ], { maxBuffer: 1024 * 1024 })).stdout) as { verification: { provider?: string; verdict?: string; verifier_role?: string; evidence?: { merged?: boolean } } };

    assert.equal(result.verification.provider, "connector");
    assert.equal(result.verification.verdict, "pass");
    assert.equal(result.verification.verifier_role, "github-pr-status");
    assert.equal(result.verification.evidence?.merged, true);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub review request verifier records hard pass when current reviewer is no longer requested", async () => {
  const fixture = await createFixture("inferoa-loop-github-review-request-pass-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"view\" ]; then",
      "  printf '%s\\n' '{\"number\":17,\"title\":\"Review loop\",\"url\":\"https://example.test/pull/17\",\"state\":\"OPEN\",\"isDraft\":false,\"reviewDecision\":\"REVIEW_REQUIRED\",\"reviewRequests\":[{\"requestedReviewer\":{\"login\":\"other\"}}]}'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"api\" ] && [ \"$2\" = \"user\" ]; then",
      "  printf '%s\\n' 'alice'",
      "  exit 0",
      "fi",
      "exit 64",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubReviewRequestStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      pr: "17",
      repo: "owner/repo",
      run_id: "verify_github_review_request_pass",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-review-request");
    assert.equal(verification.verdict, "pass");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.evidence?.connector, "github");
    assert.equal(verification.evidence?.verifier, "github-review-request");
    assert.equal(verification.evidence?.reviewer, "alice");
    assert.equal(verification.evidence?.target_pending, false);
    assert.equal(verification.metrics?.pending_review_requests, 1);
    assert.equal(verification.metrics?.target_pending, 0);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub review request verifier treats pending target reviewer as partial evidence", async () => {
  const fixture = await createFixture("inferoa-loop-github-review-request-partial-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"number\":17,\"state\":\"OPEN\",\"isDraft\":false,\"reviewRequests\":[{\"requestedReviewer\":{\"login\":\"alice\",\"__typename\":\"User\"}}]}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubReviewRequestStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      pr: "17",
      repo: "owner/repo",
      reviewer: "alice",
      run_id: "verify_github_review_request_partial",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-review-request");
    assert.equal(verification.verdict, "partial");
    assert.equal(verification.confidence, "mixed");
    assert.equal(verification.evidence?.reviewer, "alice");
    assert.equal(verification.evidence?.target_pending, true);
    assert.equal(verification.metrics?.pending_review_requests, 1);
    assert.equal(verification.metrics?.target_pending, 1);
    assert.match(verification.failure_reason ?? "", /still requests review from alice/i);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("verify-github-review-request command records GitHub connector verification", async () => {
  const fixture = await createFixture("inferoa-loop-github-review-request-cli-");
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(fixture.workspace.root, ".inferoa", "config.yaml"), YAML.stringify(DEFAULT_CONFIG), "utf8");
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"number\":17,\"state\":\"OPEN\",\"isDraft\":false,\"reviewRequests\":[]}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      fixture.workspace.root,
      "--config",
      path.join(fixture.workspace.root, ".inferoa", "config.yaml"),
      "--state-dir",
      fixture.stateDir,
      "--json",
      "verify-github-review-request",
      fixture.session.session_id,
      "17",
      "--repo",
      "owner/repo",
    ], { maxBuffer: 1024 * 1024 })).stdout) as { verification: { provider?: string; verdict?: string; verifier_role?: string; evidence?: { target_pending?: boolean } } };

    assert.equal(result.verification.provider, "connector");
    assert.equal(result.verification.verdict, "pass");
    assert.equal(result.verification.verifier_role, "github-review-request");
    assert.equal(result.verification.evidence?.target_pending, false);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub issue status verifier records closed issue as hard pass", async () => {
  const fixture = await createFixture("inferoa-loop-github-issue-status-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"number\":31,\"title\":\"Fix issue\",\"url\":\"https://example.test/issues/31\",\"state\":\"CLOSED\",\"closedAt\":\"2026-06-11T00:00:00Z\",\"updatedAt\":\"2026-06-11T00:00:00Z\",\"labels\":[{\"name\":\"bug\"}],\"assignees\":[{\"login\":\"alice\"}]}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubIssueStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      issue: "31",
      repo: "owner/repo",
      run_id: "verify_github_issue_status_pass",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-issue-status");
    assert.equal(verification.verdict, "pass");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.evidence?.connector, "github");
    assert.equal(verification.evidence?.verifier, "github-issue-status");
    assert.equal(verification.evidence?.state, "CLOSED");
    assert.equal(verification.metrics?.closed, 1);
    assert.equal(verification.metrics?.label_count, 1);
    assert.equal(verification.metrics?.assignee_count, 1);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub issue status verifier treats open issue as partial evidence", async () => {
  const fixture = await createFixture("inferoa-loop-github-issue-status-open-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"number\":31,\"state\":\"OPEN\",\"labels\":[],\"assignees\":[]}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubIssueStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      issue: "31",
      repo: "owner/repo",
      run_id: "verify_github_issue_status_partial",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-issue-status");
    assert.equal(verification.verdict, "partial");
    assert.equal(verification.confidence, "mixed");
    assert.equal(verification.metrics?.open, 1);
    assert.match(verification.failure_reason ?? "", /still open/i);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("verify-github-issue-status command records GitHub connector verification", async () => {
  const fixture = await createFixture("inferoa-loop-github-issue-status-cli-");
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(fixture.workspace.root, ".inferoa", "config.yaml"), YAML.stringify(DEFAULT_CONFIG), "utf8");
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"number\":31,\"state\":\"CLOSED\",\"closedAt\":\"2026-06-11T00:00:00Z\",\"labels\":[],\"assignees\":[]}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      fixture.workspace.root,
      "--config",
      path.join(fixture.workspace.root, ".inferoa", "config.yaml"),
      "--state-dir",
      fixture.stateDir,
      "--json",
      "verify-github-issue-status",
      fixture.session.session_id,
      "31",
      "--repo",
      "owner/repo",
    ], { maxBuffer: 1024 * 1024 })).stdout) as { verification: { provider?: string; verdict?: string; verifier_role?: string; evidence?: { state?: string } } };

    assert.equal(result.verification.provider, "connector");
    assert.equal(result.verification.verdict, "pass");
    assert.equal(result.verification.verifier_role, "github-issue-status");
    assert.equal(result.verification.evidence?.state, "CLOSED");
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub notification verifier records read thread as hard pass", async () => {
  const fixture = await createFixture("inferoa-loop-github-notification-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "if [ \"$1\" = \"api\" ] && [ \"$2\" = \"--method\" ] && [ \"$3\" = \"GET\" ] && [ \"$4\" = \"notifications/threads/123\" ]; then",
      "  printf '%s\\n' '{\"id\":\"123\",\"repository\":{\"full_name\":\"owner/repo\"},\"subject\":{\"title\":\"Review loop\",\"type\":\"PullRequest\",\"url\":\"https://api.github.com/repos/owner/repo/pulls/17\",\"latest_comment_url\":\"https://api.github.com/repos/owner/repo/issues/comments/9\"},\"reason\":\"review_requested\",\"unread\":false,\"updated_at\":\"2026-06-11T00:00:00Z\",\"last_read_at\":\"2026-06-11T00:01:00Z\",\"url\":\"https://api.github.com/notifications/threads/123\"}'",
      "  exit 0",
      "fi",
      "exit 64",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubNotificationStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      thread: "123",
      run_id: "verify_github_notification_read",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-notification-status");
    assert.equal(verification.verdict, "pass");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.evidence?.connector, "github");
    assert.equal(verification.evidence?.verifier, "github-notification-status");
    assert.equal(verification.evidence?.thread, "123");
    assert.equal(verification.evidence?.unread, false);
    assert.equal(verification.evidence?.repository_full_name, "owner/repo");
    assert.equal(verification.evidence?.subject_type, "PullRequest");
    assert.equal(verification.metrics?.read, 1);
    assert.equal(verification.metrics?.unread, 0);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub notification verifier treats unread thread as partial evidence", async () => {
  const fixture = await createFixture("inferoa-loop-github-notification-unread-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"id\":\"123\",\"repository\":{\"full_name\":\"owner/repo\"},\"subject\":{\"title\":\"Review loop\",\"type\":\"PullRequest\"},\"reason\":\"mention\",\"unread\":true}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubNotificationStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      thread: "123",
      run_id: "verify_github_notification_unread",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-notification-status");
    assert.equal(verification.verdict, "partial");
    assert.equal(verification.confidence, "mixed");
    assert.equal(verification.metrics?.unread, 1);
    assert.match(verification.failure_reason ?? "", /still unread/i);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("verify-github-notification command records GitHub connector verification", async () => {
  const fixture = await createFixture("inferoa-loop-github-notification-cli-");
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(fixture.workspace.root, ".inferoa", "config.yaml"), YAML.stringify(DEFAULT_CONFIG), "utf8");
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "if [ \"$1\" = \"api\" ] && [ \"$2\" = \"--method\" ] && [ \"$3\" = \"GET\" ] && [ \"$4\" = \"notifications/threads/123\" ]; then",
      "  printf '%s\\n' '{\"id\":\"123\",\"repository\":{\"full_name\":\"owner/repo\"},\"subject\":{\"title\":\"Review loop\",\"type\":\"PullRequest\"},\"reason\":\"review_requested\",\"unread\":false}'",
      "  exit 0",
      "fi",
      "exit 64",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      fixture.workspace.root,
      "--config",
      path.join(fixture.workspace.root, ".inferoa", "config.yaml"),
      "--state-dir",
      fixture.stateDir,
      "--json",
      "verify-github-notification",
      fixture.session.session_id,
      "123",
    ], { maxBuffer: 1024 * 1024 })).stdout) as { verification: { provider?: string; verdict?: string; verifier_role?: string; evidence?: { unread?: boolean } } };

    assert.equal(result.verification.provider, "connector");
    assert.equal(result.verification.verdict, "pass");
    assert.equal(result.verification.verifier_role, "github-notification-status");
    assert.equal(result.verification.evidence?.unread, false);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub Actions run verifier records successful run evidence", async () => {
  const fixture = await createFixture("inferoa-loop-github-run-verification-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"databaseId\":9001,\"number\":44,\"attempt\":2,\"workflowName\":\"CI\",\"displayTitle\":\"Fix verifier policy\",\"status\":\"completed\",\"conclusion\":\"success\",\"headBranch\":\"loop-ci\",\"headSha\":\"1234567890abcdef\",\"url\":\"https://example.test/actions/runs/9001\",\"jobs\":[{\"databaseId\":1,\"name\":\"unit\",\"status\":\"completed\",\"conclusion\":\"success\"},{\"databaseId\":2,\"name\":\"lint\",\"status\":\"completed\",\"conclusion\":\"success\"}]}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubActionsRun(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      run: "9001",
      repo: "owner/repo",
      attempt: 2,
      run_id: "verify_github_run_pass",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-actions-run");
    assert.equal(verification.verdict, "pass");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.evidence?.connector, "github");
    assert.equal(verification.evidence?.verifier, "github-actions-run");
    assert.equal(verification.evidence?.github_run_id, "9001");
    assert.equal(verification.evidence?.attempt, 2);
    assert.equal(verification.metrics?.job_count, 2);
    assert.equal(verification.metrics?.pass, 2);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub Actions run verifier records failed run evidence", async () => {
  const fixture = await createFixture("inferoa-loop-github-run-verification-fail-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"databaseId\":9002,\"workflowName\":\"CI\",\"status\":\"completed\",\"conclusion\":\"failure\",\"jobs\":[{\"databaseId\":1,\"name\":\"unit\",\"status\":\"completed\",\"conclusion\":\"failure\"}]}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubActionsRun(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      run: "9002",
      repo: "owner/repo",
      run_id: "verify_github_run_fail",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verdict, "fail");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.metrics?.fail, 1);
    assert.match(verification.failure_reason ?? "", /failing/i);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("verify-github-run command records GitHub connector verification", async () => {
  const fixture = await createFixture("inferoa-loop-github-run-verification-cli-");
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(fixture.workspace.root, ".inferoa", "config.yaml"), YAML.stringify(DEFAULT_CONFIG), "utf8");
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"databaseId\":9001,\"workflowName\":\"CI\",\"status\":\"completed\",\"conclusion\":\"success\",\"jobs\":[{\"databaseId\":1,\"name\":\"unit\",\"status\":\"completed\",\"conclusion\":\"success\"}]}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      fixture.workspace.root,
      "--config",
      path.join(fixture.workspace.root, ".inferoa", "config.yaml"),
      "--state-dir",
      fixture.stateDir,
      "--json",
      "verify-github-run",
      fixture.session.session_id,
      "9001",
      "--repo",
      "owner/repo",
      "--attempt",
      "2",
    ], { maxBuffer: 1024 * 1024 })).stdout) as { verification: { provider?: string; verdict?: string; verifier_role?: string; evidence?: { attempt?: number } } };

    assert.equal(result.verification.provider, "connector");
    assert.equal(result.verification.verdict, "pass");
    assert.equal(result.verification.verifier_role, "github-actions-run");
    assert.equal(result.verification.evidence?.attempt, 2);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub workflow verifier records latest matching run evidence", async () => {
  const fixture = await createFixture("inferoa-loop-github-workflow-verification-");
  const originalPath = process.env.PATH;
  const callsPath = path.join(fixture.dir, "gh-calls.txt");
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" > "${callsPath}"`,
      "printf '%s\\n' '[{\"databaseId\":9101,\"number\":12,\"attempt\":1,\"workflowName\":\"Deploy\",\"displayTitle\":\"deploy main\",\"event\":\"workflow_dispatch\",\"headBranch\":\"main\",\"headSha\":\"abcdef1234567890\",\"status\":\"completed\",\"conclusion\":\"success\",\"url\":\"https://example.test/actions/runs/9101\"}]'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubWorkflowRunStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      workflow: "deploy.yml",
      repo: "owner/repo",
      branch: "main",
      event: "workflow_dispatch",
      commit: "abcdef1234567890",
      run_id: "verify_github_workflow_pass",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-workflow-run-status");
    assert.equal(verification.verdict, "pass");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.evidence?.connector, "github");
    assert.equal(verification.evidence?.verifier, "github-workflow-run-status");
    assert.equal(verification.evidence?.workflow, "deploy.yml");
    assert.equal(verification.evidence?.github_run_id, "9101");
    assert.equal(verification.evidence?.head_branch, "main");
    assert.equal(verification.metrics?.run_found, 1);
    assert.equal(verification.metrics?.pass, 1);
    const call = await readFile(callsPath, "utf8");
    assert.match(call, /run list --workflow deploy\.yml --limit 1 --json /);
    assert.match(call, /--repo owner\/repo/);
    assert.match(call, /--branch main/);
    assert.match(call, /--event workflow_dispatch/);
    assert.match(call, /--commit abcdef1234567890/);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub workflow verifier fails hard when no matching run exists", async () => {
  const fixture = await createFixture("inferoa-loop-github-workflow-verification-empty-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '[]'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubWorkflowRunStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      workflow: "deploy.yml",
      repo: "owner/repo",
      run_id: "verify_github_workflow_empty",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verdict, "fail");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.metrics?.run_found, 0);
    assert.match(verification.failure_reason ?? "", /No GitHub Actions run matched/);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("verify-github-workflow command records GitHub connector verification", async () => {
  const fixture = await createFixture("inferoa-loop-github-workflow-verification-cli-");
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(fixture.workspace.root, ".inferoa", "config.yaml"), YAML.stringify(DEFAULT_CONFIG), "utf8");
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '[{\"databaseId\":9102,\"workflowName\":\"Deploy\",\"event\":\"workflow_dispatch\",\"headBranch\":\"main\",\"status\":\"completed\",\"conclusion\":\"success\"}]'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      fixture.workspace.root,
      "--config",
      path.join(fixture.workspace.root, ".inferoa", "config.yaml"),
      "--state-dir",
      fixture.stateDir,
      "--json",
      "verify-github-workflow",
      fixture.session.session_id,
      "--workflow",
      "deploy.yml",
      "--repo",
      "owner/repo",
      "--branch",
      "main",
      "--event",
      "workflow_dispatch",
    ], { maxBuffer: 1024 * 1024 })).stdout) as { verification: { provider?: string; verdict?: string; verifier_role?: string; evidence?: { workflow?: string; github_run_id?: string } } };

    assert.equal(result.verification.provider, "connector");
    assert.equal(result.verification.verdict, "pass");
    assert.equal(result.verification.verifier_role, "github-workflow-run-status");
    assert.equal(result.verification.evidence?.workflow, "deploy.yml");
    assert.equal(result.verification.evidence?.github_run_id, "9102");
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub deployment verifier records successful latest environment deployment", async () => {
  const fixture = await createFixture("inferoa-loop-github-deployment-verification-");
  const originalPath = process.env.PATH;
  const callsPath = path.join(fixture.dir, "gh-calls.txt");
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${callsPath}"`,
      "if [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/owner/repo/deployments?environment=production&ref=main&per_page=1\" ]; then",
      "  printf '%s\\n' '[{\"id\":42,\"environment\":\"production\",\"ref\":\"main\",\"sha\":\"abcdef1234567890\",\"task\":\"deploy\",\"url\":\"https://api.example.test/deployments/42\",\"statuses_url\":\"https://api.example.test/deployments/42/statuses\"}]'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/owner/repo/deployments/42/statuses?per_page=1\" ]; then",
      "  printf '%s\\n' '[{\"id\":7,\"state\":\"success\",\"environment_url\":\"https://prod.example.test\",\"log_url\":\"https://example.test/logs\",\"description\":\"deployed\",\"created_at\":\"2026-06-11T00:00:00Z\"}]'",
      "  exit 0",
      "fi",
      "exit 64",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubDeploymentStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      repo: "owner/repo",
      environment: "production",
      ref: "main",
      run_id: "verify_github_deployment_pass",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-deployment-status");
    assert.equal(verification.verdict, "pass");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.evidence?.connector, "github");
    assert.equal(verification.evidence?.verifier, "github-deployment-status");
    assert.equal(verification.evidence?.deployment_id, "42");
    assert.equal(verification.evidence?.environment, "production");
    assert.equal(verification.evidence?.state, "success");
    assert.equal(verification.evidence?.environment_url, "https://prod.example.test");
    assert.equal(verification.metrics?.deployment_found, 1);
    assert.equal(verification.metrics?.status_found, 1);
    assert.equal(verification.metrics?.success, 1);
    const calls = await readFile(callsPath, "utf8");
    assert.match(calls, /api repos\/owner\/repo\/deployments\?environment=production&ref=main&per_page=1/);
    assert.match(calls, /api repos\/owner\/repo\/deployments\/42\/statuses\?per_page=1/);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub deployment verifier records hard failure for failed deployment status", async () => {
  const fixture = await createFixture("inferoa-loop-github-deployment-verification-fail-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "if [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/owner/repo/deployments/43\" ]; then",
      "  printf '%s\\n' '{\"id\":43,\"environment\":\"production\",\"ref\":\"main\",\"sha\":\"abcdef1234567890\"}'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/owner/repo/deployments/43/statuses?per_page=1\" ]; then",
      "  printf '%s\\n' '[{\"id\":8,\"state\":\"failure\",\"description\":\"rollback required\"}]'",
      "  exit 0",
      "fi",
      "exit 64",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubDeploymentStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      repo: "owner/repo",
      deployment_id: "43",
      run_id: "verify_github_deployment_fail",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verdict, "fail");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.metrics?.failure, 1);
    assert.match(verification.failure_reason ?? "", /not success/i);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("verify-github-deployment command records GitHub connector verification", async () => {
  const fixture = await createFixture("inferoa-loop-github-deployment-verification-cli-");
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(fixture.workspace.root, ".inferoa", "config.yaml"), YAML.stringify(DEFAULT_CONFIG), "utf8");
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "if [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/owner/repo/deployments?environment=staging&per_page=1\" ]; then",
      "  printf '%s\\n' '[{\"id\":44,\"environment\":\"staging\",\"ref\":\"main\",\"sha\":\"abcdef1234567890\"}]'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/owner/repo/deployments/44/statuses?per_page=1\" ]; then",
      "  printf '%s\\n' '[{\"id\":9,\"state\":\"success\",\"environment_url\":\"https://staging.example.test\"}]'",
      "  exit 0",
      "fi",
      "exit 64",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      fixture.workspace.root,
      "--config",
      path.join(fixture.workspace.root, ".inferoa", "config.yaml"),
      "--state-dir",
      fixture.stateDir,
      "--json",
      "verify-github-deployment",
      fixture.session.session_id,
      "--repo",
      "owner/repo",
      "--environment",
      "staging",
    ], { maxBuffer: 1024 * 1024 })).stdout) as { verification: { provider?: string; verdict?: string; verifier_role?: string; evidence?: { environment?: string; deployment_id?: string } } };

    assert.equal(result.verification.provider, "connector");
    assert.equal(result.verification.verdict, "pass");
    assert.equal(result.verification.verifier_role, "github-deployment-status");
    assert.equal(result.verification.evidence?.environment, "staging");
    assert.equal(result.verification.evidence?.deployment_id, "44");
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub release verifier records published release as hard pass", async () => {
  const fixture = await createFixture("inferoa-loop-github-release-status-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"tagName\":\"v1.2.3\",\"name\":\"v1.2.3\",\"url\":\"https://example.test/releases/v1.2.3\",\"isDraft\":false,\"isPrerelease\":false,\"publishedAt\":\"2026-06-11T00:00:00Z\",\"targetCommitish\":\"main\"}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubReleaseStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      tag: "v1.2.3",
      repo: "owner/repo",
      run_id: "verify_github_release_pass",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-release-status");
    assert.equal(verification.verdict, "pass");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.evidence?.connector, "github");
    assert.equal(verification.evidence?.verifier, "github-release-status");
    assert.equal(verification.evidence?.tag_name, "v1.2.3");
    assert.equal(verification.evidence?.is_draft, false);
    assert.equal(verification.metrics?.published, 1);
    assert.equal(verification.metrics?.tag_match, 1);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("GitHub release verifier treats draft release as partial when published is expected", async () => {
  const fixture = await createFixture("inferoa-loop-github-release-draft-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"tagName\":\"v1.2.3\",\"name\":\"v1.2.3\",\"isDraft\":true,\"isPrerelease\":false,\"targetCommitish\":\"main\"}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyGitHubReleaseStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      tag: "v1.2.3",
      repo: "owner/repo",
      run_id: "verify_github_release_partial",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "github-release-status");
    assert.equal(verification.verdict, "partial");
    assert.equal(verification.confidence, "mixed");
    assert.equal(verification.metrics?.draft, 1);
    assert.match(verification.failure_reason ?? "", /still a draft/i);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("verify-github-release command records GitHub release connector verification", async () => {
  const fixture = await createFixture("inferoa-loop-github-release-cli-");
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(fixture.workspace.root, ".inferoa", "config.yaml"), YAML.stringify(DEFAULT_CONFIG), "utf8");
    await writeFakeGh(fixture.ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"tagName\":\"v1.2.4\",\"name\":\"v1.2.4\",\"isDraft\":true,\"isPrerelease\":false,\"targetCommitish\":\"main\"}'",
    ]);
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = JSON.parse((await execFileAsync(process.execPath, [
      cliPath,
      "--workspace",
      fixture.workspace.root,
      "--config",
      path.join(fixture.workspace.root, ".inferoa", "config.yaml"),
      "--state-dir",
      fixture.stateDir,
      "--json",
      "verify-github-release",
      fixture.session.session_id,
      "v1.2.4",
      "--repo",
      "owner/repo",
      "--expect",
      "draft",
    ], { maxBuffer: 1024 * 1024 })).stdout) as { verification: { provider?: string; verdict?: string; verifier_role?: string; evidence?: { expected_state?: string; is_draft?: boolean } } };

    assert.equal(result.verification.provider, "connector");
    assert.equal(result.verification.verdict, "pass");
    assert.equal(result.verification.verifier_role, "github-release-status");
    assert.equal(result.verification.evidence?.expected_state, "draft");
    assert.equal(result.verification.evidence?.is_draft, true);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

async function createFixture(prefix: string): Promise<{
  dir: string;
  stateDir: string;
  binDir: string;
  ghPath: string;
  workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  store: SessionStore;
  session: ReturnType<SessionStore["createSession"]>;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  const binDir = path.join(dir, "bin");
  await mkdir(path.join(workspaceRoot, ".inferoa"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  const store = await SessionStore.open(stateDir);
  const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
  const session = store.createSession(workspace, "GitHub verifier");
  writeGoalState(store, session.session_id, createGoalState({ objective: "Verify GitHub PR checks" }), "seed");
  return {
    dir,
    stateDir,
    binDir,
    ghPath: path.join(binDir, "gh"),
    workspace,
    store,
    session,
    cleanup: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function writeFakeGh(ghPath: string, lines: string[]): Promise<void> {
  await writeFile(ghPath, lines.join("\n"), "utf8");
  await chmod(ghPath, 0o755);
}
