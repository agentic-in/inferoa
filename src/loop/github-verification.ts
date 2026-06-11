import { readGoalState } from "../goals/state.js";
import type { SessionStore } from "../session/store.js";
import type { JsonObject, WorkspaceIdentity } from "../types.js";
import { randomId } from "../util/hash.js";
import { runSmallCommand } from "../util/fs.js";
import type { GoalLoopVerification, GoalLoopVerificationConfidence, GoalLoopVerificationVerdict } from "./types.js";
import { recordGoalVerification } from "./verification.js";

export interface VerifyGitHubPullRequestChecksOptions {
  session_id: string;
  pr: string;
  repo?: string;
  timeout_ms?: number;
  run_id?: string;
}

export interface VerifyGitHubPullRequestStatusOptions {
  session_id: string;
  pr: string;
  repo?: string;
  timeout_ms?: number;
  run_id?: string;
}

export interface VerifyGitHubReviewRequestStatusOptions {
  session_id: string;
  pr: string;
  repo?: string;
  reviewer?: string;
  timeout_ms?: number;
  run_id?: string;
}

export interface VerifyGitHubIssueStatusOptions {
  session_id: string;
  issue: string;
  repo?: string;
  timeout_ms?: number;
  run_id?: string;
}

export interface VerifyGitHubNotificationStatusOptions {
  session_id: string;
  thread: string;
  timeout_ms?: number;
  run_id?: string;
}

export interface VerifyGitHubActionsRunOptions {
  session_id: string;
  run: string;
  repo?: string;
  attempt?: number;
  timeout_ms?: number;
  run_id?: string;
}

export interface VerifyGitHubWorkflowRunStatusOptions {
  session_id: string;
  workflow: string;
  repo?: string;
  branch?: string;
  event?: string;
  commit?: string;
  timeout_ms?: number;
  run_id?: string;
}

export type GitHubDeploymentExpectedState = "success" | "inactive" | "failure" | "any";

export interface VerifyGitHubDeploymentStatusOptions {
  session_id: string;
  repo: string;
  deployment_id?: string;
  environment?: string;
  ref?: string;
  expect?: GitHubDeploymentExpectedState;
  timeout_ms?: number;
  run_id?: string;
}

export type GitHubReleaseExpectedState = "published" | "draft" | "any";

export interface VerifyGitHubReleaseStatusOptions {
  session_id: string;
  tag: string;
  repo?: string;
  expect?: GitHubReleaseExpectedState;
  timeout_ms?: number;
  run_id?: string;
}

interface GitHubCheck {
  name?: string;
  workflow?: string;
  state?: string;
  bucket?: string;
  event?: string;
  link?: string;
  description?: string;
  started_at?: string;
  completed_at?: string;
}

interface GitHubActionsRun {
  run_id?: number;
  run_number?: number;
  attempt?: number;
  name?: string;
  workflow_name?: string;
  display_title?: string;
  event?: string;
  head_branch?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string;
  created_at?: string;
  started_at?: string;
  updated_at?: string;
  url?: string;
  jobs: GitHubActionsJob[];
}

interface GitHubActionsJob {
  job_id?: number;
  name?: string;
  status?: string;
  conclusion?: string;
  started_at?: string;
  completed_at?: string;
}

interface GitHubReleaseStatus {
  tag_name?: string;
  name?: string;
  url?: string;
  target_commitish?: string;
  is_draft?: boolean;
  is_prerelease?: boolean;
  created_at?: string;
  published_at?: string;
}

interface GitHubDeployment {
  id?: number;
  environment?: string;
  ref?: string;
  sha?: string;
  task?: string;
  description?: string;
  url?: string;
  statuses_url?: string;
  created_at?: string;
  updated_at?: string;
}

interface GitHubDeploymentStatus {
  id?: number;
  state?: string;
  environment_url?: string;
  log_url?: string;
  target_url?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

interface GitHubPullRequestStatus {
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  merged?: boolean;
  is_draft?: boolean;
  review_decision?: string;
  merge_state_status?: string;
  base_ref_name?: string;
  head_ref_name?: string;
  updated_at?: string;
}

interface GitHubReviewRequestStatus {
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  is_draft?: boolean;
  review_decision?: string;
  updated_at?: string;
  review_requests: GitHubReviewRequest[];
}

interface GitHubReviewRequest {
  login?: string;
  name?: string;
  slug?: string;
  type?: string;
}

interface GitHubIssueStatus {
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  closed_at?: string;
  updated_at?: string;
  labels: string[];
  assignees: string[];
}

interface GitHubNotificationThread {
  id?: string;
  reason?: string;
  unread?: boolean;
  updated_at?: string;
  last_read_at?: string;
  url?: string;
  repository_full_name?: string;
  subject_title?: string;
  subject_type?: string;
  subject_url?: string;
  latest_comment_url?: string;
}

const DEFAULT_GITHUB_VERIFIER_TIMEOUT_MS = 30_000;
const GITHUB_PR_CHECK_FIELDS = "bucket,completedAt,description,event,link,name,startedAt,state,workflow";
const GITHUB_PR_STATUS_FIELDS = "baseRefName,headRefName,isDraft,mergeStateStatus,merged,number,reviewDecision,state,title,updatedAt,url";
const GITHUB_REVIEW_REQUEST_FIELDS = "isDraft,number,reviewDecision,reviewRequests,state,title,updatedAt,url";
const GITHUB_ISSUE_STATUS_FIELDS = "assignees,closedAt,labels,number,state,title,updatedAt,url";
const GITHUB_RUN_FIELDS = "attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,jobs,name,number,startedAt,status,updatedAt,url,workflowName";
const GITHUB_RUN_LIST_FIELDS = "attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,name,number,startedAt,status,updatedAt,url,workflowName";
const GITHUB_RELEASE_FIELDS = "createdAt,isDraft,isPrerelease,name,publishedAt,tagName,targetCommitish,url";

export async function verifyGitHubPullRequestChecks(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: VerifyGitHubPullRequestChecksOptions,
): Promise<GoalLoopVerification> {
  const pr = options.pr.trim();
  if (!pr) {
    throw new Error("GitHub PR verifier requires a PR number, URL, or branch.");
  }
  const state = readGoalState(store, options.session_id);
  if (!state || state.goal.status === "dropped") {
    throw new Error(`Session ${options.session_id} has no verifiable goal.`);
  }
  const runId = options.run_id ?? randomId("verify_github_pr");
  store.appendEvent({
    session_id: options.session_id,
    run_id: runId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      provider: "connector",
      connector: "github",
      role: "github-pr-checks",
      pr,
      repo: options.repo,
    },
  });

  const args = ["pr", "checks", pr, "--json", GITHUB_PR_CHECK_FIELDS];
  if (options.repo?.trim()) {
    args.push("--repo", options.repo.trim());
  }
  const result = await runSmallCommand("gh", args, workspace.root, options.timeout_ms ?? DEFAULT_GITHUB_VERIFIER_TIMEOUT_MS);
  if (result.code !== 0 && result.code !== 8) {
    return recordGitHubVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "blocked",
      confidence: "soft",
      pr,
      repo: options.repo,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      summary: `GitHub PR checks could not be read for ${pr}.`,
      failure_reason: result.stderr.trim() || result.stdout.trim() || `gh pr checks exited ${result.code}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "[]") as unknown;
  } catch (error) {
    return recordGitHubVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "unknown",
      confidence: "soft",
      pr,
      repo: options.repo,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      stdout_excerpt: result.stdout.slice(0, 2_000),
      summary: `GitHub PR checks returned invalid JSON for ${pr}.`,
      failure_reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!Array.isArray(parsed)) {
    return recordGitHubVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "unknown",
      confidence: "soft",
      pr,
      repo: options.repo,
      exit_code: result.code,
      summary: `GitHub PR checks returned a non-array payload for ${pr}.`,
      failure_reason: "gh pr checks --json must return a JSON array.",
    });
  }

  const checks = parsed.map(parseGitHubCheck).filter((check): check is GitHubCheck => Boolean(check));
  const counts = githubCheckBucketCounts(checks);
  const classified = classifyGitHubChecks(counts, checks.length);
  return recordGitHubVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
    ...classified,
    pr,
    repo: options.repo,
    exit_code: result.code,
    checks,
    bucket_counts: counts,
    summary: githubChecksSummary(pr, counts, checks.length, classified.verdict),
    failure_reason: classified.verdict === "pass" ? undefined : githubChecksFailureReason(counts, checks.length),
  });
}

export async function verifyGitHubPullRequestStatus(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: VerifyGitHubPullRequestStatusOptions,
): Promise<GoalLoopVerification> {
  const pr = options.pr.trim();
  if (!pr) {
    throw new Error("GitHub PR status verifier requires a PR number, URL, or branch.");
  }
  const state = readGoalState(store, options.session_id);
  if (!state || state.goal.status === "dropped") {
    throw new Error(`Session ${options.session_id} has no verifiable goal.`);
  }
  const runId = options.run_id ?? randomId("verify_github_pr_status");
  store.appendEvent({
    session_id: options.session_id,
    run_id: runId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      provider: "connector",
      connector: "github",
      role: "github-pr-status",
      pr,
      repo: options.repo,
    },
  });

  const args = ["pr", "view", pr, "--json", GITHUB_PR_STATUS_FIELDS];
  if (options.repo?.trim()) {
    args.push("--repo", options.repo.trim());
  }
  const result = await runSmallCommand("gh", args, workspace.root, options.timeout_ms ?? DEFAULT_GITHUB_VERIFIER_TIMEOUT_MS);
  if (result.code !== 0) {
    return recordGitHubPrStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "blocked",
      confidence: "soft",
      pr,
      repo: options.repo,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      summary: `GitHub PR status could not be read for ${pr}.`,
      failure_reason: result.stderr.trim() || result.stdout.trim() || `gh pr view exited ${result.code}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "{}") as unknown;
  } catch (error) {
    return recordGitHubPrStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "unknown",
      confidence: "soft",
      pr,
      repo: options.repo,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      stdout_excerpt: result.stdout.slice(0, 2_000),
      summary: `GitHub PR status returned invalid JSON for ${pr}.`,
      failure_reason: error instanceof Error ? error.message : String(error),
    });
  }
  const prStatus = parseGitHubPullRequestStatus(parsed);
  if (!prStatus) {
    return recordGitHubPrStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "unknown",
      confidence: "soft",
      pr,
      repo: options.repo,
      exit_code: result.code,
      summary: `GitHub PR status returned a non-object payload for ${pr}.`,
      failure_reason: "gh pr view --json must return a JSON object.",
    });
  }

  const classified = classifyGitHubPullRequestStatus(prStatus);
  return recordGitHubPrStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
    ...classified,
    pr,
    repo: options.repo,
    exit_code: result.code,
    pr_status: prStatus,
    summary: githubPrStatusSummary(pr, prStatus, classified.verdict),
    failure_reason: classified.verdict === "pass" ? undefined : githubPrStatusFailureReason(prStatus),
  });
}

export async function verifyGitHubReviewRequestStatus(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: VerifyGitHubReviewRequestStatusOptions,
): Promise<GoalLoopVerification> {
  const pr = options.pr.trim();
  if (!pr) {
    throw new Error("GitHub review request verifier requires a PR number, URL, or branch.");
  }
  const state = readGoalState(store, options.session_id);
  if (!state || state.goal.status === "dropped") {
    throw new Error(`Session ${options.session_id} has no verifiable goal.`);
  }
  const runId = options.run_id ?? randomId("verify_github_review_request");
  const reviewer = normalizeReviewer(options.reviewer);
  store.appendEvent({
    session_id: options.session_id,
    run_id: runId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      provider: "connector",
      connector: "github",
      role: "github-review-request",
      pr,
      repo: options.repo,
      reviewer,
    },
  });

  const args = ["pr", "view", pr, "--json", GITHUB_REVIEW_REQUEST_FIELDS];
  if (options.repo?.trim()) {
    args.push("--repo", options.repo.trim());
  }
  const result = await runSmallCommand("gh", args, workspace.root, options.timeout_ms ?? DEFAULT_GITHUB_VERIFIER_TIMEOUT_MS);
  if (result.code !== 0) {
    return recordGitHubReviewRequestVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "blocked",
      confidence: "soft",
      pr,
      repo: options.repo,
      reviewer,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      summary: `GitHub review request status could not be read for ${pr}.`,
      failure_reason: result.stderr.trim() || result.stdout.trim() || `gh pr view exited ${result.code}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "{}") as unknown;
  } catch (error) {
    return recordGitHubReviewRequestVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "unknown",
      confidence: "soft",
      pr,
      repo: options.repo,
      reviewer,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      stdout_excerpt: result.stdout.slice(0, 2_000),
      summary: `GitHub review request status returned invalid JSON for ${pr}.`,
      failure_reason: error instanceof Error ? error.message : String(error),
    });
  }
  const reviewStatus = parseGitHubReviewRequestStatus(parsed);
  if (!reviewStatus) {
    return recordGitHubReviewRequestVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "unknown",
      confidence: "soft",
      pr,
      repo: options.repo,
      reviewer,
      exit_code: result.code,
      summary: `GitHub review request status returned a non-object payload for ${pr}.`,
      failure_reason: "gh pr view --json must return a JSON object.",
    });
  }

  const loginResolution = reviewer || !reviewStatus.review_requests.length
    ? undefined
    : await readGitHubCurrentLogin(workspace, options.timeout_ms ?? DEFAULT_GITHUB_VERIFIER_TIMEOUT_MS);
  const targetReviewer = reviewer ?? loginResolution?.login;
  const classified = classifyGitHubReviewRequestStatus(reviewStatus, targetReviewer);
  return recordGitHubReviewRequestVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
    ...classified,
    pr,
    repo: options.repo,
    reviewer: targetReviewer,
    current_login: loginResolution?.login,
    current_login_error: loginResolution?.error,
    exit_code: result.code,
    review_status: reviewStatus,
    summary: githubReviewRequestSummary(pr, reviewStatus, classified.verdict, targetReviewer),
    failure_reason: classified.verdict === "pass" ? undefined : githubReviewRequestFailureReason(reviewStatus, targetReviewer, loginResolution?.error),
  });
}

export async function verifyGitHubIssueStatus(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: VerifyGitHubIssueStatusOptions,
): Promise<GoalLoopVerification> {
  const issue = options.issue.trim();
  if (!issue) {
    throw new Error("GitHub issue status verifier requires an issue number or URL.");
  }
  const state = readGoalState(store, options.session_id);
  if (!state || state.goal.status === "dropped") {
    throw new Error(`Session ${options.session_id} has no verifiable goal.`);
  }
  const runId = options.run_id ?? randomId("verify_github_issue_status");
  store.appendEvent({
    session_id: options.session_id,
    run_id: runId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      provider: "connector",
      connector: "github",
      role: "github-issue-status",
      issue,
      repo: options.repo,
    },
  });

  const args = ["issue", "view", issue, "--json", GITHUB_ISSUE_STATUS_FIELDS];
  if (options.repo?.trim()) {
    args.push("--repo", options.repo.trim());
  }
  const result = await runSmallCommand("gh", args, workspace.root, options.timeout_ms ?? DEFAULT_GITHUB_VERIFIER_TIMEOUT_MS);
  if (result.code !== 0) {
    return recordGitHubIssueStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "blocked",
      confidence: "soft",
      issue,
      repo: options.repo,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      summary: `GitHub issue status could not be read for ${issue}.`,
      failure_reason: result.stderr.trim() || result.stdout.trim() || `gh issue view exited ${result.code}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "{}") as unknown;
  } catch (error) {
    return recordGitHubIssueStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "unknown",
      confidence: "soft",
      issue,
      repo: options.repo,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      stdout_excerpt: result.stdout.slice(0, 2_000),
      summary: `GitHub issue status returned invalid JSON for ${issue}.`,
      failure_reason: error instanceof Error ? error.message : String(error),
    });
  }
  const issueStatus = parseGitHubIssueStatus(parsed);
  if (!issueStatus) {
    return recordGitHubIssueStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "unknown",
      confidence: "soft",
      issue,
      repo: options.repo,
      exit_code: result.code,
      summary: `GitHub issue status returned a non-object payload for ${issue}.`,
      failure_reason: "gh issue view --json must return a JSON object.",
    });
  }

  const classified = classifyGitHubIssueStatus(issueStatus);
  return recordGitHubIssueStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
    ...classified,
    issue,
    repo: options.repo,
    exit_code: result.code,
    issue_status: issueStatus,
    summary: githubIssueStatusSummary(issue, issueStatus, classified.verdict),
    failure_reason: classified.verdict === "pass" ? undefined : githubIssueStatusFailureReason(issueStatus),
  });
}

export async function verifyGitHubNotificationStatus(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: VerifyGitHubNotificationStatusOptions,
): Promise<GoalLoopVerification> {
  const thread = options.thread.trim();
  if (!thread) {
    throw new Error("GitHub notification verifier requires a notification thread id.");
  }
  const state = readGoalState(store, options.session_id);
  if (!state || state.goal.status === "dropped") {
    throw new Error(`Session ${options.session_id} has no verifiable goal.`);
  }
  const runId = options.run_id ?? randomId("verify_github_notification");
  store.appendEvent({
    session_id: options.session_id,
    run_id: runId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      provider: "connector",
      connector: "github",
      role: "github-notification-status",
      thread,
    },
  });

  const result = await runSmallCommand("gh", ["api", "--method", "GET", `notifications/threads/${thread}`], workspace.root, options.timeout_ms ?? DEFAULT_GITHUB_VERIFIER_TIMEOUT_MS);
  if (result.code !== 0) {
    return recordGitHubNotificationStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "blocked",
      confidence: "soft",
      thread,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      summary: `GitHub notification thread ${thread} could not be read.`,
      failure_reason: result.stderr.trim() || result.stdout.trim() || `gh api notifications/threads/${thread} exited ${result.code}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "{}") as unknown;
  } catch (error) {
    return recordGitHubNotificationStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "unknown",
      confidence: "soft",
      thread,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      stdout_excerpt: result.stdout.slice(0, 2_000),
      summary: `GitHub notification thread ${thread} returned invalid JSON.`,
      failure_reason: error instanceof Error ? error.message : String(error),
    });
  }
  const notification = parseGitHubNotificationThread(parsed);
  if (!notification) {
    return recordGitHubNotificationStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
      verdict: "unknown",
      confidence: "soft",
      thread,
      exit_code: result.code,
      summary: `GitHub notification thread ${thread} returned a non-object payload.`,
      failure_reason: "gh api notifications/threads/<thread> must return a JSON object.",
    });
  }

  const classified = classifyGitHubNotificationStatus(notification);
  return recordGitHubNotificationStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, runId, {
    ...classified,
    thread,
    exit_code: result.code,
    notification,
    summary: githubNotificationStatusSummary(thread, notification, classified.verdict),
    failure_reason: classified.verdict === "pass" ? undefined : githubNotificationStatusFailureReason(notification),
  });
}

export async function verifyGitHubActionsRun(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: VerifyGitHubActionsRunOptions,
): Promise<GoalLoopVerification> {
  const run = options.run.trim();
  if (!run) {
    throw new Error("GitHub Actions run verifier requires a run id.");
  }
  const state = readGoalState(store, options.session_id);
  if (!state || state.goal.status === "dropped") {
    throw new Error(`Session ${options.session_id} has no verifiable goal.`);
  }
  const verificationRunId = options.run_id ?? randomId("verify_github_run");
  store.appendEvent({
    session_id: options.session_id,
    run_id: verificationRunId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      provider: "connector",
      connector: "github",
      role: "github-actions-run",
      github_run_id: run,
      repo: options.repo,
      attempt: options.attempt,
    },
  });

  const args = ["run", "view", run, "--json", GITHUB_RUN_FIELDS];
  if (options.repo?.trim()) {
    args.push("--repo", options.repo.trim());
  }
  if (options.attempt !== undefined) {
    args.push("--attempt", String(options.attempt));
  }
  const result = await runSmallCommand("gh", args, workspace.root, options.timeout_ms ?? DEFAULT_GITHUB_VERIFIER_TIMEOUT_MS);
  if (result.code !== 0) {
    return recordGitHubRunVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
      verdict: "blocked",
      confidence: "soft",
      run,
      repo: options.repo,
      attempt: options.attempt,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      summary: `GitHub Actions run ${run} could not be read.`,
      failure_reason: result.stderr.trim() || result.stdout.trim() || `gh run view exited ${result.code}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "{}") as unknown;
  } catch (error) {
    return recordGitHubRunVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
      verdict: "unknown",
      confidence: "soft",
      run,
      repo: options.repo,
      attempt: options.attempt,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      stdout_excerpt: result.stdout.slice(0, 2_000),
      summary: `GitHub Actions run ${run} returned invalid JSON.`,
      failure_reason: error instanceof Error ? error.message : String(error),
    });
  }
  const actionsRun = parseGitHubActionsRun(parsed);
  if (!actionsRun) {
    return recordGitHubRunVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
      verdict: "unknown",
      confidence: "soft",
      run,
      repo: options.repo,
      attempt: options.attempt,
      exit_code: result.code,
      summary: `GitHub Actions run ${run} returned a non-object payload.`,
      failure_reason: "gh run view --json must return a JSON object.",
    });
  }

  const counts = githubActionsJobCounts(actionsRun.jobs);
  const classified = classifyGitHubActionsRun(actionsRun, counts);
  return recordGitHubRunVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
    ...classified,
    run,
    repo: options.repo,
    attempt: options.attempt,
    exit_code: result.code,
    actions_run: actionsRun,
    job_counts: counts,
    summary: githubRunSummary(run, actionsRun, counts, classified.verdict),
    failure_reason: classified.verdict === "pass" ? undefined : githubRunFailureReason(actionsRun, counts),
  });
}

export async function verifyGitHubWorkflowRunStatus(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: VerifyGitHubWorkflowRunStatusOptions,
): Promise<GoalLoopVerification> {
  const workflow = normalizeRequiredGitHubFilter(options.workflow, "workflow");
  const repo = normalizeOptionalGitHubFilter(options.repo, "repo");
  const branch = normalizeOptionalGitHubFilter(options.branch, "branch");
  const event = normalizeOptionalGitHubFilter(options.event, "event");
  const commit = normalizeOptionalGitHubFilter(options.commit, "commit");
  const state = readGoalState(store, options.session_id);
  if (!state || state.goal.status === "dropped") {
    throw new Error(`Session ${options.session_id} has no verifiable goal.`);
  }
  const verificationRunId = options.run_id ?? randomId("verify_github_workflow");
  store.appendEvent({
    session_id: options.session_id,
    run_id: verificationRunId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      provider: "connector",
      connector: "github",
      role: "github-workflow-run-status",
      workflow,
      repo,
      branch,
      event,
      commit,
    },
  });

  const args = ["run", "list", "--workflow", workflow, "--limit", "1", "--json", GITHUB_RUN_LIST_FIELDS];
  if (repo) {
    args.push("--repo", repo);
  }
  if (branch) {
    args.push("--branch", branch);
  }
  if (event) {
    args.push("--event", event);
  }
  if (commit) {
    args.push("--commit", commit);
  }
  const result = await runSmallCommand("gh", args, workspace.root, options.timeout_ms ?? DEFAULT_GITHUB_VERIFIER_TIMEOUT_MS);
  if (result.code !== 0) {
    return recordGitHubWorkflowRunStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
      verdict: "blocked",
      confidence: "soft",
      workflow,
      repo,
      branch,
      event,
      commit,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      summary: `GitHub workflow ${workflow} latest run could not be read.`,
      failure_reason: result.stderr.trim() || result.stdout.trim() || `gh run list exited ${result.code}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "[]") as unknown;
  } catch (error) {
    return recordGitHubWorkflowRunStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
      verdict: "unknown",
      confidence: "soft",
      workflow,
      repo,
      branch,
      event,
      commit,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      stdout_excerpt: result.stdout.slice(0, 2_000),
      summary: `GitHub workflow ${workflow} latest run returned invalid JSON.`,
      failure_reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!Array.isArray(parsed)) {
    return recordGitHubWorkflowRunStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
      verdict: "unknown",
      confidence: "soft",
      workflow,
      repo,
      branch,
      event,
      commit,
      exit_code: result.code,
      summary: `GitHub workflow ${workflow} latest run returned a non-array payload.`,
      failure_reason: "gh run list --json must return a JSON array.",
    });
  }

  const actionsRun = parsed.map(parseGitHubActionsRun).find((run): run is GitHubActionsRun => Boolean(run));
  if (!actionsRun) {
    return recordGitHubWorkflowRunStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
      verdict: "fail",
      confidence: "hard",
      workflow,
      repo,
      branch,
      event,
      commit,
      exit_code: result.code,
      summary: `GitHub workflow ${workflow} has no matching run.`,
      failure_reason: "No GitHub Actions run matched the workflow and filters.",
    });
  }

  const counts = githubActionsJobCounts(actionsRun.jobs);
  const classified = classifyGitHubActionsRun(actionsRun, counts);
  return recordGitHubWorkflowRunStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
    ...classified,
    workflow,
    repo,
    branch,
    event,
    commit,
    exit_code: result.code,
    actions_run: actionsRun,
    job_counts: counts,
    summary: githubWorkflowRunStatusSummary(workflow, actionsRun, counts, classified.verdict),
    failure_reason: classified.verdict === "pass" ? undefined : githubWorkflowRunStatusFailureReason(actionsRun, counts),
  });
}

export async function verifyGitHubDeploymentStatus(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: VerifyGitHubDeploymentStatusOptions,
): Promise<GoalLoopVerification> {
  const repo = normalizeRequiredGitHubFilter(options.repo, "repo");
  const deploymentId = normalizeOptionalGitHubFilter(options.deployment_id, "deployment_id");
  const environment = normalizeOptionalGitHubFilter(options.environment, "environment");
  const ref = normalizeOptionalGitHubFilter(options.ref, "ref");
  const expected = normalizeGitHubDeploymentExpectedState(options.expect);
  if (!deploymentId && !environment) {
    throw new Error("GitHub deployment verifier requires --deployment-id or --environment.");
  }
  const state = readGoalState(store, options.session_id);
  if (!state || state.goal.status === "dropped") {
    throw new Error(`Session ${options.session_id} has no verifiable goal.`);
  }
  const verificationRunId = options.run_id ?? randomId("verify_github_deployment");
  store.appendEvent({
    session_id: options.session_id,
    run_id: verificationRunId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      provider: "connector",
      connector: "github",
      role: "github-deployment-status",
      repo,
      deployment_id: deploymentId,
      environment,
      ref,
      expected_state: expected,
    },
  });

  const deploymentResult = await readGitHubDeployment(workspace, {
    repo,
    deployment_id: deploymentId,
    environment,
    ref,
    timeout_ms: options.timeout_ms ?? DEFAULT_GITHUB_VERIFIER_TIMEOUT_MS,
  });
  if (deploymentResult.status !== "ok") {
    return recordGitHubDeploymentStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
      verdict: deploymentResult.status === "not_found" ? "fail" : deploymentResult.status,
      confidence: deploymentResult.status === "not_found" ? "hard" : "soft",
      repo,
      deployment_id: deploymentId,
      environment,
      ref,
      expected_state: expected,
      exit_code: deploymentResult.exit_code,
      stderr: deploymentResult.stderr,
      stdout_excerpt: deploymentResult.stdout_excerpt,
      summary: deploymentResult.summary,
      failure_reason: deploymentResult.failure_reason,
    });
  }

  const deploymentIdNumber = deploymentResult.deployment.id;
  if (deploymentIdNumber === undefined) {
    return recordGitHubDeploymentStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
      verdict: "unknown",
      confidence: "soft",
      repo,
      deployment_id: deploymentId,
      environment,
      ref,
      expected_state: expected,
      deployment: deploymentResult.deployment,
      exit_code: deploymentResult.exit_code,
      summary: `GitHub deployment for ${repo} did not include an id.`,
      failure_reason: "GitHub deployment payload must include id.",
    });
  }

  const statusResult = await readGitHubDeploymentLatestStatus(workspace, repo, deploymentIdNumber, options.timeout_ms ?? DEFAULT_GITHUB_VERIFIER_TIMEOUT_MS);
  if (statusResult.status !== "ok") {
    return recordGitHubDeploymentStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
      verdict: statusResult.status === "not_found" ? "unknown" : statusResult.status,
      confidence: "soft",
      repo,
      deployment_id: deploymentId,
      environment,
      ref,
      expected_state: expected,
      deployment: deploymentResult.deployment,
      exit_code: statusResult.exit_code,
      stderr: statusResult.stderr,
      stdout_excerpt: statusResult.stdout_excerpt,
      summary: statusResult.summary,
      failure_reason: statusResult.failure_reason,
    });
  }

  const classified = classifyGitHubDeploymentStatus(statusResult.deployment_status, expected);
  return recordGitHubDeploymentStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
    ...classified,
    repo,
    deployment_id: deploymentId,
    environment,
    ref,
    expected_state: expected,
    deployment: deploymentResult.deployment,
    deployment_status: statusResult.deployment_status,
    exit_code: statusResult.exit_code,
    summary: githubDeploymentStatusSummary(repo, deploymentResult.deployment, statusResult.deployment_status, classified.verdict, expected),
    failure_reason: classified.verdict === "pass" ? undefined : githubDeploymentStatusFailureReason(statusResult.deployment_status, expected),
  });
}

export async function verifyGitHubReleaseStatus(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: VerifyGitHubReleaseStatusOptions,
): Promise<GoalLoopVerification> {
  const tag = options.tag.trim();
  if (!tag) {
    throw new Error("GitHub release verifier requires a release tag.");
  }
  const expected = normalizeGitHubReleaseExpectedState(options.expect);
  const state = readGoalState(store, options.session_id);
  if (!state || state.goal.status === "dropped") {
    throw new Error(`Session ${options.session_id} has no verifiable goal.`);
  }
  const verificationRunId = options.run_id ?? randomId("verify_github_release");
  store.appendEvent({
    session_id: options.session_id,
    run_id: verificationRunId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      provider: "connector",
      connector: "github",
      role: "github-release-status",
      tag,
      repo: options.repo,
      expected_state: expected,
    },
  });

  const args = ["release", "view", tag, "--json", GITHUB_RELEASE_FIELDS];
  if (options.repo?.trim()) {
    args.push("--repo", options.repo.trim());
  }
  const result = await runSmallCommand("gh", args, workspace.root, options.timeout_ms ?? DEFAULT_GITHUB_VERIFIER_TIMEOUT_MS);
  if (result.code !== 0) {
    return recordGitHubReleaseStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
      verdict: "blocked",
      confidence: "soft",
      tag,
      repo: options.repo,
      expected_state: expected,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      summary: `GitHub release ${tag} could not be read.`,
      failure_reason: result.stderr.trim() || result.stdout.trim() || `gh release view exited ${result.code}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "{}") as unknown;
  } catch (error) {
    return recordGitHubReleaseStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
      verdict: "unknown",
      confidence: "soft",
      tag,
      repo: options.repo,
      expected_state: expected,
      exit_code: result.code,
      stderr: result.stderr.trim(),
      stdout_excerpt: result.stdout.slice(0, 2_000),
      summary: `GitHub release ${tag} returned invalid JSON.`,
      failure_reason: error instanceof Error ? error.message : String(error),
    });
  }
  const release = parseGitHubReleaseStatus(parsed);
  if (!release) {
    return recordGitHubReleaseStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
      verdict: "unknown",
      confidence: "soft",
      tag,
      repo: options.repo,
      expected_state: expected,
      exit_code: result.code,
      summary: `GitHub release ${tag} returned a non-object payload.`,
      failure_reason: "gh release view --json must return a JSON object.",
    });
  }

  const classified = classifyGitHubReleaseStatus(release, tag, expected);
  return recordGitHubReleaseStatusVerification(store, options.session_id, state.goal.id, state.goal.horizon_generation, verificationRunId, {
    ...classified,
    tag,
    repo: options.repo,
    expected_state: expected,
    exit_code: result.code,
    release,
    summary: githubReleaseStatusSummary(tag, release, classified.verdict, expected),
    failure_reason: classified.verdict === "pass" ? undefined : githubReleaseStatusFailureReason(release, tag, expected),
  });
}

function recordGitHubVerification(
  store: SessionStore,
  sessionId: string,
  goalId: string,
  horizonGeneration: number,
  runId: string,
  input: {
    verdict: GoalLoopVerificationVerdict;
    confidence: GoalLoopVerificationConfidence;
    pr: string;
    repo?: string;
    exit_code?: number | null;
    stderr?: string;
    stdout_excerpt?: string;
    checks?: GitHubCheck[];
    bucket_counts?: Record<string, number>;
    summary: string;
    failure_reason?: string;
  },
): GoalLoopVerification {
  return recordGoalVerification(store, sessionId, {
    provider: "connector",
    verifier_role: "github-pr-checks",
    verdict: input.verdict,
    confidence: input.confidence,
    goal_id: goalId,
    horizon_generation: horizonGeneration,
    run_id: runId,
    evidence: {
      connector: "github",
      verifier: "github-pr-checks",
      pr: input.pr,
      repo: input.repo,
      exit_code: input.exit_code,
      stderr: input.stderr,
      stdout_excerpt: input.stdout_excerpt,
      bucket_counts: input.bucket_counts,
      checks: input.checks ? checksToJson(input.checks.slice(0, 100)) : undefined,
    },
    metrics: {
      check_count: input.checks?.length ?? 0,
      pass: input.bucket_counts?.pass ?? 0,
      fail: input.bucket_counts?.fail ?? 0,
      pending: input.bucket_counts?.pending ?? 0,
      skipping: input.bucket_counts?.skipping ?? 0,
      cancel: input.bucket_counts?.cancel ?? 0,
    },
    summary: input.summary,
    failure_reason: input.failure_reason,
  }, runId);
}

function recordGitHubRunVerification(
  store: SessionStore,
  sessionId: string,
  goalId: string,
  horizonGeneration: number,
  verificationRunId: string,
  input: {
    verdict: GoalLoopVerificationVerdict;
    confidence: GoalLoopVerificationConfidence;
    run: string;
    repo?: string;
    attempt?: number;
    exit_code?: number | null;
    stderr?: string;
    stdout_excerpt?: string;
    actions_run?: GitHubActionsRun;
    job_counts?: Record<string, number>;
    summary: string;
    failure_reason?: string;
  },
): GoalLoopVerification {
  return recordGoalVerification(store, sessionId, {
    provider: "connector",
    verifier_role: "github-actions-run",
    verdict: input.verdict,
    confidence: input.confidence,
    goal_id: goalId,
    horizon_generation: horizonGeneration,
    run_id: verificationRunId,
    evidence: {
      connector: "github",
      verifier: "github-actions-run",
      github_run_id: input.run,
      repo: input.repo,
      attempt: input.attempt,
      exit_code: input.exit_code,
      stderr: input.stderr,
      stdout_excerpt: input.stdout_excerpt,
      status: input.actions_run?.status,
      conclusion: input.actions_run?.conclusion,
      url: input.actions_run?.url,
      head_branch: input.actions_run?.head_branch,
      head_sha: input.actions_run?.head_sha,
      workflow_name: input.actions_run?.workflow_name,
      display_title: input.actions_run?.display_title,
      job_counts: input.job_counts,
      jobs: input.actions_run ? jobsToJson(input.actions_run.jobs.slice(0, 100)) : undefined,
    },
    metrics: {
      job_count: input.actions_run?.jobs.length ?? 0,
      pass: input.job_counts?.pass ?? 0,
      fail: input.job_counts?.fail ?? 0,
      pending: input.job_counts?.pending ?? 0,
      skipping: input.job_counts?.skipping ?? 0,
      cancel: input.job_counts?.cancel ?? 0,
    },
    summary: input.summary,
    failure_reason: input.failure_reason,
  }, verificationRunId);
}

function recordGitHubWorkflowRunStatusVerification(
  store: SessionStore,
  sessionId: string,
  goalId: string,
  horizonGeneration: number,
  runId: string,
  input: {
    verdict: GoalLoopVerificationVerdict;
    confidence: GoalLoopVerificationConfidence;
    workflow: string;
    repo?: string;
    branch?: string;
    event?: string;
    commit?: string;
    exit_code?: number | null;
    stderr?: string;
    stdout_excerpt?: string;
    actions_run?: GitHubActionsRun;
    job_counts?: Record<string, number>;
    summary: string;
    failure_reason?: string;
  },
): GoalLoopVerification {
  const runBucket = normalizeBucket(input.actions_run?.conclusion ?? input.actions_run?.status);
  return recordGoalVerification(store, sessionId, {
    provider: "connector",
    verifier_role: "github-workflow-run-status",
    verdict: input.verdict,
    confidence: input.confidence,
    goal_id: goalId,
    horizon_generation: horizonGeneration,
    run_id: runId,
    evidence: {
      connector: "github",
      verifier: "github-workflow-run-status",
      workflow: input.workflow,
      repo: input.repo,
      branch: input.branch,
      event: input.event,
      commit: input.commit,
      exit_code: input.exit_code,
      stderr: input.stderr,
      stdout_excerpt: input.stdout_excerpt,
      github_run_id: input.actions_run?.run_id !== undefined ? String(input.actions_run.run_id) : undefined,
      run_number: input.actions_run?.run_number,
      attempt: input.actions_run?.attempt,
      status: input.actions_run?.status,
      conclusion: input.actions_run?.conclusion,
      url: input.actions_run?.url,
      head_branch: input.actions_run?.head_branch,
      head_sha: input.actions_run?.head_sha,
      workflow_name: input.actions_run?.workflow_name,
      display_title: input.actions_run?.display_title,
      job_counts: input.job_counts,
      jobs: input.actions_run?.jobs.length ? jobsToJson(input.actions_run.jobs.slice(0, 100)) : undefined,
    },
    metrics: {
      run_found: input.actions_run ? 1 : 0,
      job_count: input.actions_run?.jobs.length ?? 0,
      pass: runBucket === "pass" ? 1 : (input.job_counts?.pass ?? 0),
      fail: runBucket === "fail" ? 1 : (input.job_counts?.fail ?? 0),
      pending: runBucket === "pending" ? 1 : (input.job_counts?.pending ?? 0),
      cancel: runBucket === "cancel" ? 1 : (input.job_counts?.cancel ?? 0),
      skipping: input.job_counts?.skipping ?? 0,
    },
    summary: input.summary,
    failure_reason: input.failure_reason,
  }, runId);
}

function recordGitHubDeploymentStatusVerification(
  store: SessionStore,
  sessionId: string,
  goalId: string,
  horizonGeneration: number,
  runId: string,
  input: {
    verdict: GoalLoopVerificationVerdict;
    confidence: GoalLoopVerificationConfidence;
    repo: string;
    deployment_id?: string;
    environment?: string;
    ref?: string;
    expected_state: GitHubDeploymentExpectedState;
    exit_code?: number | null;
    stderr?: string;
    stdout_excerpt?: string;
    deployment?: GitHubDeployment;
    deployment_status?: GitHubDeploymentStatus;
    summary: string;
    failure_reason?: string;
  },
): GoalLoopVerification {
  const statusBucket = normalizeDeploymentStatus(input.deployment_status?.state);
  return recordGoalVerification(store, sessionId, {
    provider: "connector",
    verifier_role: "github-deployment-status",
    verdict: input.verdict,
    confidence: input.confidence,
    goal_id: goalId,
    horizon_generation: horizonGeneration,
    run_id: runId,
    evidence: {
      connector: "github",
      verifier: "github-deployment-status",
      repo: input.repo,
      requested_deployment_id: input.deployment_id,
      deployment_id: input.deployment?.id !== undefined ? String(input.deployment.id) : undefined,
      environment: input.environment ?? input.deployment?.environment,
      ref: input.ref ?? input.deployment?.ref,
      expected_state: input.expected_state,
      exit_code: input.exit_code,
      stderr: input.stderr,
      stdout_excerpt: input.stdout_excerpt,
      sha: input.deployment?.sha,
      task: input.deployment?.task,
      deployment_url: input.deployment?.url,
      statuses_url: input.deployment?.statuses_url,
      deployment_created_at: input.deployment?.created_at,
      deployment_updated_at: input.deployment?.updated_at,
      status_id: input.deployment_status?.id !== undefined ? String(input.deployment_status.id) : undefined,
      state: input.deployment_status?.state,
      environment_url: input.deployment_status?.environment_url,
      log_url: input.deployment_status?.log_url,
      target_url: input.deployment_status?.target_url,
      status_description: input.deployment_status?.description,
      status_created_at: input.deployment_status?.created_at,
      status_updated_at: input.deployment_status?.updated_at,
    },
    metrics: {
      deployment_found: input.deployment ? 1 : 0,
      status_found: input.deployment_status ? 1 : 0,
      success: statusBucket === "success" ? 1 : 0,
      inactive: statusBucket === "inactive" ? 1 : 0,
      failure: statusBucket === "failure" ? 1 : 0,
      pending: statusBucket === "pending" ? 1 : 0,
    },
    summary: input.summary,
    failure_reason: input.failure_reason,
  }, runId);
}

function recordGitHubReleaseStatusVerification(
  store: SessionStore,
  sessionId: string,
  goalId: string,
  horizonGeneration: number,
  runId: string,
  input: {
    verdict: GoalLoopVerificationVerdict;
    confidence: GoalLoopVerificationConfidence;
    tag: string;
    repo?: string;
    expected_state: GitHubReleaseExpectedState;
    exit_code?: number | null;
    stderr?: string;
    stdout_excerpt?: string;
    release?: GitHubReleaseStatus;
    summary: string;
    failure_reason?: string;
  },
): GoalLoopVerification {
  return recordGoalVerification(store, sessionId, {
    provider: "connector",
    verifier_role: "github-release-status",
    verdict: input.verdict,
    confidence: input.confidence,
    goal_id: goalId,
    horizon_generation: horizonGeneration,
    run_id: runId,
    evidence: {
      connector: "github",
      verifier: "github-release-status",
      tag: input.tag,
      repo: input.repo,
      expected_state: input.expected_state,
      exit_code: input.exit_code,
      stderr: input.stderr,
      stdout_excerpt: input.stdout_excerpt,
      tag_name: input.release?.tag_name,
      name: input.release?.name,
      url: input.release?.url,
      target_commitish: input.release?.target_commitish,
      is_draft: input.release?.is_draft,
      is_prerelease: input.release?.is_prerelease,
      created_at: input.release?.created_at,
      published_at: input.release?.published_at,
    },
    metrics: {
      exists: input.release ? 1 : 0,
      tag_match: releaseTagMatches(input.release, input.tag) ? 1 : 0,
      draft: input.release?.is_draft ? 1 : 0,
      published: input.release && input.release.is_draft === false ? 1 : 0,
      prerelease: input.release?.is_prerelease ? 1 : 0,
    },
    summary: input.summary,
    failure_reason: input.failure_reason,
  }, runId);
}

function recordGitHubPrStatusVerification(
  store: SessionStore,
  sessionId: string,
  goalId: string,
  horizonGeneration: number,
  runId: string,
  input: {
    verdict: GoalLoopVerificationVerdict;
    confidence: GoalLoopVerificationConfidence;
    pr: string;
    repo?: string;
    exit_code?: number | null;
    stderr?: string;
    stdout_excerpt?: string;
    pr_status?: GitHubPullRequestStatus;
    summary: string;
    failure_reason?: string;
  },
): GoalLoopVerification {
  return recordGoalVerification(store, sessionId, {
    provider: "connector",
    verifier_role: "github-pr-status",
    verdict: input.verdict,
    confidence: input.confidence,
    goal_id: goalId,
    horizon_generation: horizonGeneration,
    run_id: runId,
    evidence: {
      connector: "github",
      verifier: "github-pr-status",
      pr: input.pr,
      repo: input.repo,
      exit_code: input.exit_code,
      stderr: input.stderr,
      stdout_excerpt: input.stdout_excerpt,
      number: input.pr_status?.number,
      title: input.pr_status?.title,
      url: input.pr_status?.url,
      state: input.pr_status?.state,
      merged: input.pr_status?.merged,
      is_draft: input.pr_status?.is_draft,
      review_decision: input.pr_status?.review_decision,
      merge_state_status: input.pr_status?.merge_state_status,
      base_ref_name: input.pr_status?.base_ref_name,
      head_ref_name: input.pr_status?.head_ref_name,
      updated_at: input.pr_status?.updated_at,
    },
    metrics: {
      merged: input.pr_status?.merged ? 1 : 0,
      draft: input.pr_status?.is_draft ? 1 : 0,
      approved: normalizeGitHubStatus(input.pr_status?.review_decision) === "approved" ? 1 : 0,
      changes_requested: normalizeGitHubStatus(input.pr_status?.review_decision) === "changes_requested" ? 1 : 0,
      merge_blocked: isBlockingMergeState(input.pr_status?.merge_state_status) ? 1 : 0,
    },
    summary: input.summary,
    failure_reason: input.failure_reason,
  }, runId);
}

function recordGitHubReviewRequestVerification(
  store: SessionStore,
  sessionId: string,
  goalId: string,
  horizonGeneration: number,
  runId: string,
  input: {
    verdict: GoalLoopVerificationVerdict;
    confidence: GoalLoopVerificationConfidence;
    pr: string;
    repo?: string;
    reviewer?: string;
    current_login?: string;
    current_login_error?: string;
    target_pending?: boolean;
    exit_code?: number | null;
    stderr?: string;
    stdout_excerpt?: string;
    review_status?: GitHubReviewRequestStatus;
    summary: string;
    failure_reason?: string;
  },
): GoalLoopVerification {
  return recordGoalVerification(store, sessionId, {
    provider: "connector",
    verifier_role: "github-review-request",
    verdict: input.verdict,
    confidence: input.confidence,
    goal_id: goalId,
    horizon_generation: horizonGeneration,
    run_id: runId,
    evidence: {
      connector: "github",
      verifier: "github-review-request",
      pr: input.pr,
      repo: input.repo,
      reviewer: input.reviewer,
      current_login: input.current_login,
      current_login_error: input.current_login_error,
      target_pending: input.target_pending,
      exit_code: input.exit_code,
      stderr: input.stderr,
      stdout_excerpt: input.stdout_excerpt,
      number: input.review_status?.number,
      title: input.review_status?.title,
      url: input.review_status?.url,
      state: input.review_status?.state,
      is_draft: input.review_status?.is_draft,
      review_decision: input.review_status?.review_decision,
      updated_at: input.review_status?.updated_at,
      review_requests: input.review_status ? reviewRequestsToJson(input.review_status.review_requests.slice(0, 100)) : undefined,
    },
    metrics: {
      pending_review_requests: input.review_status?.review_requests.length ?? 0,
      target_pending: input.target_pending ? 1 : 0,
      open: normalizeGitHubStatus(input.review_status?.state) === "open" ? 1 : 0,
      draft: input.review_status?.is_draft ? 1 : 0,
    },
    summary: input.summary,
    failure_reason: input.failure_reason,
  }, runId);
}

function recordGitHubIssueStatusVerification(
  store: SessionStore,
  sessionId: string,
  goalId: string,
  horizonGeneration: number,
  runId: string,
  input: {
    verdict: GoalLoopVerificationVerdict;
    confidence: GoalLoopVerificationConfidence;
    issue: string;
    repo?: string;
    exit_code?: number | null;
    stderr?: string;
    stdout_excerpt?: string;
    issue_status?: GitHubIssueStatus;
    summary: string;
    failure_reason?: string;
  },
): GoalLoopVerification {
  return recordGoalVerification(store, sessionId, {
    provider: "connector",
    verifier_role: "github-issue-status",
    verdict: input.verdict,
    confidence: input.confidence,
    goal_id: goalId,
    horizon_generation: horizonGeneration,
    run_id: runId,
    evidence: {
      connector: "github",
      verifier: "github-issue-status",
      issue: input.issue,
      repo: input.repo,
      exit_code: input.exit_code,
      stderr: input.stderr,
      stdout_excerpt: input.stdout_excerpt,
      number: input.issue_status?.number,
      title: input.issue_status?.title,
      url: input.issue_status?.url,
      state: input.issue_status?.state,
      closed_at: input.issue_status?.closed_at,
      updated_at: input.issue_status?.updated_at,
      labels: input.issue_status?.labels.slice(0, 50),
      assignees: input.issue_status?.assignees.slice(0, 50),
    },
    metrics: {
      closed: normalizeGitHubStatus(input.issue_status?.state) === "closed" ? 1 : 0,
      open: normalizeGitHubStatus(input.issue_status?.state) === "open" ? 1 : 0,
      label_count: input.issue_status?.labels.length ?? 0,
      assignee_count: input.issue_status?.assignees.length ?? 0,
    },
    summary: input.summary,
    failure_reason: input.failure_reason,
  }, runId);
}

function recordGitHubNotificationStatusVerification(
  store: SessionStore,
  sessionId: string,
  goalId: string,
  horizonGeneration: number,
  runId: string,
  input: {
    verdict: GoalLoopVerificationVerdict;
    confidence: GoalLoopVerificationConfidence;
    thread: string;
    exit_code?: number | null;
    stderr?: string;
    stdout_excerpt?: string;
    notification?: GitHubNotificationThread;
    summary: string;
    failure_reason?: string;
  },
): GoalLoopVerification {
  return recordGoalVerification(store, sessionId, {
    provider: "connector",
    verifier_role: "github-notification-status",
    verdict: input.verdict,
    confidence: input.confidence,
    goal_id: goalId,
    horizon_generation: horizonGeneration,
    run_id: runId,
    evidence: {
      connector: "github",
      verifier: "github-notification-status",
      thread: input.thread,
      exit_code: input.exit_code,
      stderr: input.stderr,
      stdout_excerpt: input.stdout_excerpt,
      id: input.notification?.id,
      unread: input.notification?.unread,
      reason: input.notification?.reason,
      repository_full_name: input.notification?.repository_full_name,
      subject_title: input.notification?.subject_title,
      subject_type: input.notification?.subject_type,
      subject_url: input.notification?.subject_url,
      latest_comment_url: input.notification?.latest_comment_url,
      updated_at: input.notification?.updated_at,
      last_read_at: input.notification?.last_read_at,
      url: input.notification?.url,
    },
    metrics: {
      unread: input.notification?.unread ? 1 : 0,
      read: input.notification?.unread === false ? 1 : 0,
    },
    summary: input.summary,
    failure_reason: input.failure_reason,
  }, runId);
}

function checksToJson(checks: GitHubCheck[]): JsonObject[] {
  return checks.map((check) => compactJsonObject({
    name: check.name,
    workflow: check.workflow,
    state: check.state,
    bucket: check.bucket,
    event: check.event,
    link: check.link,
    description: check.description,
    started_at: check.started_at,
    completed_at: check.completed_at,
  }));
}

function compactJsonObject(input: Record<string, string | undefined>): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function jobsToJson(jobs: GitHubActionsJob[]): JsonObject[] {
  return jobs.map((job) => {
    const output: JsonObject = {};
    if (job.job_id !== undefined) {
      output.job_id = job.job_id;
    }
    for (const [key, value] of Object.entries({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      started_at: job.started_at,
      completed_at: job.completed_at,
    })) {
      if (value !== undefined) {
        output[key] = value;
      }
    }
    return output;
  });
}

function reviewRequestsToJson(requests: GitHubReviewRequest[]): JsonObject[] {
  return requests.map((request) => {
    const output: JsonObject = {};
    if (request.login) {
      output.login = request.login;
    }
    if (request.name) {
      output.name = request.name;
    }
    if (request.slug) {
      output.slug = request.slug;
    }
    if (request.type) {
      output.type = request.type;
    }
    return output;
  });
}

type GitHubDeploymentReadResult =
  | { status: "ok"; deployment: GitHubDeployment; exit_code: number }
  | { status: "blocked" | "unknown" | "not_found"; exit_code?: number | null; stderr?: string; stdout_excerpt?: string; summary: string; failure_reason: string };

type GitHubDeploymentStatusReadResult =
  | { status: "ok"; deployment_status: GitHubDeploymentStatus; exit_code: number }
  | { status: "blocked" | "unknown" | "not_found"; exit_code?: number | null; stderr?: string; stdout_excerpt?: string; summary: string; failure_reason: string };

async function readGitHubDeployment(
  workspace: WorkspaceIdentity,
  options: {
    repo: string;
    deployment_id?: string;
    environment?: string;
    ref?: string;
    timeout_ms: number;
  },
): Promise<GitHubDeploymentReadResult> {
  const path = options.deployment_id
    ? `repos/${options.repo}/deployments/${options.deployment_id}`
    : githubApiPathWithQuery(`repos/${options.repo}/deployments`, [
        ["environment", options.environment],
        ["ref", options.ref],
        ["per_page", "1"],
      ]);
  const result = await runSmallCommand("gh", ["api", path], workspace.root, options.timeout_ms);
  if (result.code !== 0) {
    return {
      status: "blocked",
      exit_code: result.code,
      stderr: result.stderr.trim(),
      summary: `GitHub deployment could not be read for ${options.repo}.`,
      failure_reason: result.stderr.trim() || result.stdout.trim() || `gh api ${path} exited ${result.code}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || (options.deployment_id ? "{}" : "[]")) as unknown;
  } catch (error) {
    return {
      status: "unknown",
      exit_code: result.code,
      stderr: result.stderr.trim(),
      stdout_excerpt: result.stdout.slice(0, 2_000),
      summary: `GitHub deployment returned invalid JSON for ${options.repo}.`,
      failure_reason: error instanceof Error ? error.message : String(error),
    };
  }

  const deployment = Array.isArray(parsed)
    ? parsed.map(parseGitHubDeployment).find((item): item is GitHubDeployment => Boolean(item))
    : parseGitHubDeployment(parsed);
  if (!deployment) {
    return {
      status: "not_found",
      exit_code: result.code,
      summary: `GitHub deployment was not found for ${options.repo}.`,
      failure_reason: "No GitHub deployment matched the explicit filters.",
    };
  }
  if (deployment.id === undefined) {
    return {
      status: "unknown",
      exit_code: result.code,
      summary: `GitHub deployment for ${options.repo} did not include an id.`,
      failure_reason: "GitHub deployment payload must include id.",
    };
  }
  return { status: "ok", deployment, exit_code: result.code };
}

async function readGitHubDeploymentLatestStatus(
  workspace: WorkspaceIdentity,
  repo: string,
  deploymentId: number,
  timeoutMs: number,
): Promise<GitHubDeploymentStatusReadResult> {
  const path = githubApiPathWithQuery(`repos/${repo}/deployments/${deploymentId}/statuses`, [["per_page", "1"]]);
  const result = await runSmallCommand("gh", ["api", path], workspace.root, timeoutMs);
  if (result.code !== 0) {
    return {
      status: "blocked",
      exit_code: result.code,
      stderr: result.stderr.trim(),
      summary: `GitHub deployment ${deploymentId} status could not be read.`,
      failure_reason: result.stderr.trim() || result.stdout.trim() || `gh api ${path} exited ${result.code}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "[]") as unknown;
  } catch (error) {
    return {
      status: "unknown",
      exit_code: result.code,
      stderr: result.stderr.trim(),
      stdout_excerpt: result.stdout.slice(0, 2_000),
      summary: `GitHub deployment ${deploymentId} status returned invalid JSON.`,
      failure_reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      status: "unknown",
      exit_code: result.code,
      summary: `GitHub deployment ${deploymentId} status returned a non-array payload.`,
      failure_reason: "GitHub deployment statuses endpoint must return a JSON array.",
    };
  }
  const deploymentStatus = parsed.map(parseGitHubDeploymentStatus).find((item): item is GitHubDeploymentStatus => Boolean(item));
  if (!deploymentStatus) {
    return {
      status: "not_found",
      exit_code: result.code,
      summary: `GitHub deployment ${deploymentId} has no status.`,
      failure_reason: "No GitHub deployment status was reported.",
    };
  }
  return { status: "ok", deployment_status: deploymentStatus, exit_code: result.code };
}

function githubApiPathWithQuery(path: string, params: Array<[string, string | undefined]>): string {
  const query = params
    .filter((item): item is [string, string] => item[1] !== undefined && item[1] !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return query ? `${path}?${query}` : path;
}

function parseGitHubCheck(value: unknown): GitHubCheck | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  return {
    name: stringValue(data.name),
    workflow: stringValue(data.workflow),
    state: stringValue(data.state),
    bucket: stringValue(data.bucket),
    event: stringValue(data.event),
    link: stringValue(data.link),
    description: stringValue(data.description),
    started_at: stringValue(data.startedAt),
    completed_at: stringValue(data.completedAt),
  };
}

function parseGitHubActionsRun(value: unknown): GitHubActionsRun | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  return {
    run_id: numberValue(data.databaseId),
    run_number: numberValue(data.number),
    attempt: numberValue(data.attempt),
    name: stringValue(data.name),
    workflow_name: stringValue(data.workflowName),
    display_title: stringValue(data.displayTitle),
    event: stringValue(data.event),
    head_branch: stringValue(data.headBranch),
    head_sha: stringValue(data.headSha),
    status: stringValue(data.status),
    conclusion: stringValue(data.conclusion),
    created_at: stringValue(data.createdAt),
    started_at: stringValue(data.startedAt),
    updated_at: stringValue(data.updatedAt),
    url: stringValue(data.url),
    jobs: Array.isArray(data.jobs) ? data.jobs.map(parseGitHubActionsJob).filter((job): job is GitHubActionsJob => Boolean(job)) : [],
  };
}

function parseGitHubReleaseStatus(value: unknown): GitHubReleaseStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  return {
    tag_name: stringValue(data.tagName),
    name: stringValue(data.name),
    url: stringValue(data.url),
    target_commitish: stringValue(data.targetCommitish),
    is_draft: booleanValue(data.isDraft),
    is_prerelease: booleanValue(data.isPrerelease),
    created_at: stringValue(data.createdAt),
    published_at: stringValue(data.publishedAt),
  };
}

function parseGitHubDeployment(value: unknown): GitHubDeployment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  return {
    id: numberValue(data.id) ?? numberValue(data.databaseId),
    environment: stringValue(data.environment),
    ref: stringValue(data.ref),
    sha: stringValue(data.sha),
    task: stringValue(data.task),
    description: stringValue(data.description),
    url: stringValue(data.url),
    statuses_url: stringValue(data.statuses_url) ?? stringValue(data.statusesUrl),
    created_at: stringValue(data.created_at) ?? stringValue(data.createdAt),
    updated_at: stringValue(data.updated_at) ?? stringValue(data.updatedAt),
  };
}

function parseGitHubDeploymentStatus(value: unknown): GitHubDeploymentStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  return {
    id: numberValue(data.id) ?? numberValue(data.databaseId),
    state: stringValue(data.state),
    environment_url: stringValue(data.environment_url) ?? stringValue(data.environmentUrl),
    log_url: stringValue(data.log_url) ?? stringValue(data.logUrl),
    target_url: stringValue(data.target_url) ?? stringValue(data.targetUrl),
    description: stringValue(data.description),
    created_at: stringValue(data.created_at) ?? stringValue(data.createdAt),
    updated_at: stringValue(data.updated_at) ?? stringValue(data.updatedAt),
  };
}

function parseGitHubPullRequestStatus(value: unknown): GitHubPullRequestStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  return {
    number: numberValue(data.number),
    title: stringValue(data.title),
    url: stringValue(data.url),
    state: stringValue(data.state),
    merged: booleanValue(data.merged),
    is_draft: booleanValue(data.isDraft),
    review_decision: stringValue(data.reviewDecision),
    merge_state_status: stringValue(data.mergeStateStatus),
    base_ref_name: stringValue(data.baseRefName),
    head_ref_name: stringValue(data.headRefName),
    updated_at: stringValue(data.updatedAt),
  };
}

function parseGitHubReviewRequestStatus(value: unknown): GitHubReviewRequestStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  return {
    number: numberValue(data.number),
    title: stringValue(data.title),
    url: stringValue(data.url),
    state: stringValue(data.state),
    is_draft: booleanValue(data.isDraft),
    review_decision: stringValue(data.reviewDecision),
    updated_at: stringValue(data.updatedAt),
    review_requests: Array.isArray(data.reviewRequests)
      ? data.reviewRequests.map(parseGitHubReviewRequest).filter((request): request is GitHubReviewRequest => Boolean(request))
      : [],
  };
}

function parseGitHubIssueStatus(value: unknown): GitHubIssueStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  return {
    number: numberValue(data.number),
    title: stringValue(data.title),
    url: stringValue(data.url),
    state: stringValue(data.state),
    closed_at: stringValue(data.closedAt),
    updated_at: stringValue(data.updatedAt),
    labels: githubNameList(data.labels),
    assignees: githubLoginList(data.assignees),
  };
}

function parseGitHubNotificationThread(value: unknown): GitHubNotificationThread | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const repository = firstObject(data.repository);
  const subject = firstObject(data.subject);
  return {
    id: stringValue(data.id),
    reason: stringValue(data.reason),
    unread: booleanValue(data.unread),
    updated_at: stringValue(data.updated_at) ?? stringValue(data.updatedAt),
    last_read_at: stringValue(data.last_read_at) ?? stringValue(data.lastReadAt),
    url: stringValue(data.url),
    repository_full_name: stringValue(repository?.full_name) ?? stringValue(repository?.fullName),
    subject_title: stringValue(subject?.title),
    subject_type: stringValue(subject?.type),
    subject_url: stringValue(subject?.url),
    latest_comment_url: stringValue(subject?.latest_comment_url) ?? stringValue(subject?.latestCommentUrl),
  };
}

function parseGitHubReviewRequest(value: unknown): GitHubReviewRequest | undefined {
  if (typeof value === "string") {
    return { login: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const nested = firstObject(data.requestedReviewer, data.reviewer, data.user, data.team);
  const source = nested ?? data;
  return {
    login: stringValue(source.login),
    name: stringValue(source.name),
    slug: stringValue(source.slug),
    type: stringValue(source.__typename) ?? stringValue(source.type),
  };
}

function parseGitHubActionsJob(value: unknown): GitHubActionsJob | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  return {
    job_id: numberValue(data.databaseId),
    name: stringValue(data.name),
    status: stringValue(data.status),
    conclusion: stringValue(data.conclusion),
    started_at: stringValue(data.startedAt),
    completed_at: stringValue(data.completedAt),
  };
}

function classifyGitHubPullRequestStatus(
  status: GitHubPullRequestStatus,
): { verdict: GoalLoopVerificationVerdict; confidence: GoalLoopVerificationConfidence } {
  const state = normalizeGitHubStatus(status.state);
  if (status.merged === true || state === "merged") {
    return { verdict: "pass", confidence: "hard" };
  }
  if (state === "closed") {
    return { verdict: "fail", confidence: "hard" };
  }
  if (normalizeGitHubStatus(status.review_decision) === "changes_requested") {
    return { verdict: "fail", confidence: "hard" };
  }
  if (isBlockingMergeState(status.merge_state_status)) {
    return { verdict: "fail", confidence: "hard" };
  }
  if (state === "open" || status.is_draft !== undefined || status.review_decision || status.merge_state_status) {
    return { verdict: "partial", confidence: "mixed" };
  }
  return { verdict: "unknown", confidence: "soft" };
}

function classifyGitHubReviewRequestStatus(
  status: GitHubReviewRequestStatus,
  reviewer: string | undefined,
): { verdict: GoalLoopVerificationVerdict; confidence: GoalLoopVerificationConfidence; target_pending: boolean } {
  const state = normalizeGitHubStatus(status.state);
  if (state === "merged" || state === "closed") {
    return { verdict: "pass", confidence: "hard", target_pending: false };
  }
  const targetPending = reviewer ? status.review_requests.some((request) => reviewRequestMatches(request, reviewer)) : false;
  if (targetPending) {
    return { verdict: "partial", confidence: "mixed", target_pending: true };
  }
  if (reviewer) {
    return { verdict: "pass", confidence: "hard", target_pending: false };
  }
  if (!status.review_requests.length) {
    return { verdict: "pass", confidence: "hard", target_pending: false };
  }
  return { verdict: "partial", confidence: "mixed", target_pending: false };
}

function githubPrStatusSummary(
  pr: string,
  status: GitHubPullRequestStatus,
  verdict: GoalLoopVerificationVerdict,
): string {
  return [
    `GitHub PR status for ${pr}: ${verdict}`,
    status.number !== undefined ? `number ${status.number}` : undefined,
    status.state ? `state ${status.state}` : undefined,
    status.merged !== undefined ? `merged ${status.merged}` : undefined,
    status.is_draft !== undefined ? `draft ${status.is_draft}` : undefined,
    status.review_decision ? `review ${status.review_decision}` : undefined,
    status.merge_state_status ? `merge ${status.merge_state_status}` : undefined,
  ].filter((part): part is string => Boolean(part)).join("; ");
}

function githubReviewRequestSummary(
  pr: string,
  status: GitHubReviewRequestStatus,
  verdict: GoalLoopVerificationVerdict,
  reviewer: string | undefined,
): string {
  return [
    `GitHub review request status for ${pr}: ${verdict}`,
    status.number !== undefined ? `number ${status.number}` : undefined,
    status.state ? `state ${status.state}` : undefined,
    status.is_draft !== undefined ? `draft ${status.is_draft}` : undefined,
    reviewer ? `reviewer ${reviewer}` : undefined,
    `pending requests ${status.review_requests.length}`,
    status.review_decision ? `review ${status.review_decision}` : undefined,
  ].filter((part): part is string => Boolean(part)).join("; ");
}

function githubReviewRequestFailureReason(
  status: GitHubReviewRequestStatus,
  reviewer: string | undefined,
  currentLoginError: string | undefined,
): string | undefined {
  const state = normalizeGitHubStatus(status.state);
  if (state === "open" && reviewer && status.review_requests.some((request) => reviewRequestMatches(request, reviewer))) {
    return `GitHub PR still requests review from ${reviewer}.`;
  }
  if (state === "open" && status.review_requests.length > 0) {
    return currentLoginError
      ? `GitHub PR still has pending review requests, and current reviewer could not be resolved: ${currentLoginError}`
      : "GitHub PR still has pending review requests.";
  }
  return "GitHub review request status is unknown.";
}

function githubPrStatusFailureReason(status: GitHubPullRequestStatus): string | undefined {
  const state = normalizeGitHubStatus(status.state);
  if (state === "closed") {
    return "GitHub PR is closed without merged=true.";
  }
  if (normalizeGitHubStatus(status.review_decision) === "changes_requested") {
    return "GitHub PR has requested changes.";
  }
  if (isBlockingMergeState(status.merge_state_status)) {
    return "GitHub PR merge state is blocked, dirty, or unknown.";
  }
  if (status.is_draft) {
    return "GitHub PR is still a draft.";
  }
  if (state === "open") {
    return "GitHub PR is open and not merged yet.";
  }
  return "GitHub PR status is unknown.";
}

function classifyGitHubIssueStatus(
  status: GitHubIssueStatus,
): { verdict: GoalLoopVerificationVerdict; confidence: GoalLoopVerificationConfidence } {
  const state = normalizeGitHubStatus(status.state);
  if (state === "closed") {
    return { verdict: "pass", confidence: "hard" };
  }
  if (state === "open") {
    return { verdict: "partial", confidence: "mixed" };
  }
  return { verdict: "unknown", confidence: "soft" };
}

function githubIssueStatusSummary(
  issue: string,
  status: GitHubIssueStatus,
  verdict: GoalLoopVerificationVerdict,
): string {
  return [
    `GitHub issue status for ${issue}: ${verdict}`,
    status.number !== undefined ? `number ${status.number}` : undefined,
    status.state ? `state ${status.state}` : undefined,
    status.closed_at ? `closed ${status.closed_at}` : undefined,
    `${status.labels.length} labels`,
    `${status.assignees.length} assignees`,
  ].filter((part): part is string => Boolean(part)).join("; ");
}

function githubIssueStatusFailureReason(status: GitHubIssueStatus): string | undefined {
  const state = normalizeGitHubStatus(status.state);
  if (state === "open") {
    return "GitHub issue is still open.";
  }
  return "GitHub issue status is unknown.";
}

function classifyGitHubNotificationStatus(
  notification: GitHubNotificationThread,
): { verdict: GoalLoopVerificationVerdict; confidence: GoalLoopVerificationConfidence } {
  if (notification.unread === false) {
    return { verdict: "pass", confidence: "hard" };
  }
  if (notification.unread === true) {
    return { verdict: "partial", confidence: "mixed" };
  }
  return { verdict: "unknown", confidence: "soft" };
}

function githubNotificationStatusSummary(
  thread: string,
  notification: GitHubNotificationThread,
  verdict: GoalLoopVerificationVerdict,
): string {
  return [
    `GitHub notification thread ${thread}: ${verdict}`,
    notification.unread !== undefined ? `unread ${notification.unread}` : undefined,
    notification.repository_full_name ? `repo ${notification.repository_full_name}` : undefined,
    notification.subject_type ? `type ${notification.subject_type}` : undefined,
    notification.reason ? `reason ${notification.reason}` : undefined,
  ].filter((part): part is string => Boolean(part)).join("; ");
}

function githubNotificationStatusFailureReason(notification: GitHubNotificationThread): string | undefined {
  if (notification.unread === true) {
    return "GitHub notification thread is still unread.";
  }
  return "GitHub notification read state is unknown.";
}

function githubCheckBucketCounts(checks: GitHubCheck[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const check of checks) {
    const bucket = normalizeBucket(check.bucket ?? check.state);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

function classifyGitHubChecks(
  counts: Record<string, number>,
  total: number,
): { verdict: GoalLoopVerificationVerdict; confidence: GoalLoopVerificationConfidence } {
  if (total === 0) {
    return { verdict: "unknown", confidence: "soft" };
  }
  if ((counts.fail ?? 0) > 0 || (counts.cancel ?? 0) > 0) {
    return { verdict: "fail", confidence: "hard" };
  }
  if ((counts.pending ?? 0) > 0) {
    return { verdict: "partial", confidence: "mixed" };
  }
  return { verdict: "pass", confidence: "hard" };
}

function githubActionsJobCounts(jobs: GitHubActionsJob[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const job of jobs) {
    const bucket = normalizeBucket(job.conclusion ?? job.status);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

function classifyGitHubActionsRun(
  run: GitHubActionsRun,
  jobCounts: Record<string, number>,
): { verdict: GoalLoopVerificationVerdict; confidence: GoalLoopVerificationConfidence } {
  const runBucket = normalizeBucket(run.conclusion ?? run.status);
  if (runBucket === "pass") {
    return { verdict: "pass", confidence: "hard" };
  }
  if (runBucket === "fail" || runBucket === "cancel") {
    return { verdict: "fail", confidence: "hard" };
  }
  if ((jobCounts.fail ?? 0) > 0 || (jobCounts.cancel ?? 0) > 0) {
    return { verdict: "fail", confidence: "hard" };
  }
  if (runBucket === "pending" || (jobCounts.pending ?? 0) > 0) {
    return { verdict: "partial", confidence: "mixed" };
  }
  return { verdict: "unknown", confidence: "soft" };
}

function githubRunSummary(
  runId: string,
  run: GitHubActionsRun,
  counts: Record<string, number>,
  verdict: GoalLoopVerificationVerdict,
): string {
  return [
    `GitHub Actions run ${runId}: ${verdict}`,
    run.workflow_name ? `workflow ${run.workflow_name}` : undefined,
    run.status ? `status ${run.status}` : undefined,
    run.conclusion ? `conclusion ${run.conclusion}` : undefined,
    `${run.jobs.length} jobs`,
    countPart("pass", counts.pass),
    countPart("fail", counts.fail),
    countPart("pending", counts.pending),
    countPart("skipping", counts.skipping),
    countPart("cancel", counts.cancel),
  ].filter((part): part is string => Boolean(part)).join("; ");
}

function githubRunFailureReason(run: GitHubActionsRun, counts: Record<string, number>): string | undefined {
  const runBucket = normalizeBucket(run.conclusion ?? run.status);
  if (runBucket === "fail" || runBucket === "cancel" || (counts.fail ?? 0) > 0 || (counts.cancel ?? 0) > 0) {
    return "GitHub Actions reported a failing or cancelled run.";
  }
  if (runBucket === "pending" || (counts.pending ?? 0) > 0) {
    return "GitHub Actions run is still pending.";
  }
  return "GitHub Actions run status is unknown.";
}

function githubWorkflowRunStatusSummary(
  workflow: string,
  run: GitHubActionsRun,
  counts: Record<string, number>,
  verdict: GoalLoopVerificationVerdict,
): string {
  return [
    `GitHub workflow ${workflow} latest run: ${verdict}`,
    run.run_id !== undefined ? `run ${run.run_id}` : undefined,
    run.run_number !== undefined ? `#${run.run_number}` : undefined,
    run.workflow_name ? `workflow ${run.workflow_name}` : undefined,
    run.status ? `status ${run.status}` : undefined,
    run.conclusion ? `conclusion ${run.conclusion}` : undefined,
    run.head_branch ? `branch ${run.head_branch}` : undefined,
    run.head_sha ? `sha ${run.head_sha.slice(0, 12)}` : undefined,
    run.jobs.length ? `${run.jobs.length} jobs` : undefined,
    countPart("pass", counts.pass),
    countPart("fail", counts.fail),
    countPart("pending", counts.pending),
    countPart("skipping", counts.skipping),
    countPart("cancel", counts.cancel),
  ].filter((part): part is string => Boolean(part)).join("; ");
}

function githubWorkflowRunStatusFailureReason(run: GitHubActionsRun, counts: Record<string, number>): string | undefined {
  return githubRunFailureReason(run, counts);
}

function classifyGitHubDeploymentStatus(
  status: GitHubDeploymentStatus,
  expectedState: GitHubDeploymentExpectedState,
): { verdict: GoalLoopVerificationVerdict; confidence: GoalLoopVerificationConfidence } {
  const bucket = normalizeDeploymentStatus(status.state);
  if (expectedState === "any" && bucket !== "unknown") {
    return { verdict: "pass", confidence: "hard" };
  }
  if (bucket === "pending") {
    return { verdict: "partial", confidence: "mixed" };
  }
  if (bucket === "unknown") {
    return { verdict: "unknown", confidence: "soft" };
  }
  if (bucket === expectedState) {
    return { verdict: "pass", confidence: "hard" };
  }
  return { verdict: "fail", confidence: "hard" };
}

function githubDeploymentStatusSummary(
  repo: string,
  deployment: GitHubDeployment,
  status: GitHubDeploymentStatus,
  verdict: GoalLoopVerificationVerdict,
  expectedState: GitHubDeploymentExpectedState,
): string {
  return [
    `GitHub deployment ${deployment.id ?? "unknown"} in ${repo}: ${verdict}`,
    `expect ${expectedState}`,
    deployment.environment ? `environment ${deployment.environment}` : undefined,
    deployment.ref ? `ref ${deployment.ref}` : undefined,
    deployment.sha ? `sha ${deployment.sha.slice(0, 12)}` : undefined,
    status.state ? `state ${status.state}` : undefined,
    status.environment_url ? `environment_url ${status.environment_url}` : undefined,
  ].filter((part): part is string => Boolean(part)).join("; ");
}

function githubDeploymentStatusFailureReason(status: GitHubDeploymentStatus, expectedState: GitHubDeploymentExpectedState): string | undefined {
  const bucket = normalizeDeploymentStatus(status.state);
  if (bucket === "pending") {
    return "GitHub deployment status is still pending.";
  }
  if (bucket === "unknown") {
    return "GitHub deployment status is unknown.";
  }
  return `GitHub deployment status is ${status.state ?? bucket}, not ${expectedState}.`;
}

function classifyGitHubReleaseStatus(
  release: GitHubReleaseStatus,
  expectedTag: string,
  expectedState: GitHubReleaseExpectedState,
): { verdict: GoalLoopVerificationVerdict; confidence: GoalLoopVerificationConfidence } {
  if (!releaseTagMatches(release, expectedTag)) {
    return { verdict: "fail", confidence: "hard" };
  }
  if (expectedState === "any") {
    return { verdict: "pass", confidence: "hard" };
  }
  if (expectedState === "draft") {
    if (release.is_draft === true) {
      return { verdict: "pass", confidence: "hard" };
    }
    if (release.is_draft === false) {
      return { verdict: "fail", confidence: "hard" };
    }
    return { verdict: "unknown", confidence: "soft" };
  }
  if (release.is_draft === false) {
    return { verdict: "pass", confidence: "hard" };
  }
  if (release.is_draft === true) {
    return { verdict: "partial", confidence: "mixed" };
  }
  return { verdict: "unknown", confidence: "soft" };
}

function githubReleaseStatusSummary(
  tag: string,
  release: GitHubReleaseStatus,
  verdict: GoalLoopVerificationVerdict,
  expectedState: GitHubReleaseExpectedState,
): string {
  return [
    `GitHub release ${tag}: ${verdict}`,
    `expect ${expectedState}`,
    release.tag_name ? `tag ${release.tag_name}` : undefined,
    release.name ? `name ${release.name}` : undefined,
    release.is_draft !== undefined ? `draft ${release.is_draft}` : undefined,
    release.is_prerelease !== undefined ? `prerelease ${release.is_prerelease}` : undefined,
    release.published_at ? `published ${release.published_at}` : undefined,
  ].filter((part): part is string => Boolean(part)).join("; ");
}

function githubReleaseStatusFailureReason(
  release: GitHubReleaseStatus,
  expectedTag: string,
  expectedState: GitHubReleaseExpectedState,
): string | undefined {
  if (!releaseTagMatches(release, expectedTag)) {
    return `GitHub release tag mismatch: expected ${expectedTag}, got ${release.tag_name ?? "unknown"}.`;
  }
  if (expectedState === "draft" && release.is_draft === false) {
    return "GitHub release is published, not draft.";
  }
  if (expectedState === "published" && release.is_draft === true) {
    return "GitHub release is still a draft.";
  }
  return "GitHub release state is unknown.";
}

function releaseTagMatches(release: GitHubReleaseStatus | undefined, expectedTag: string): boolean {
  if (!release?.tag_name) {
    return false;
  }
  return release.tag_name.trim() === expectedTag.trim();
}

function normalizeGitHubReleaseExpectedState(value: GitHubReleaseExpectedState | undefined): GitHubReleaseExpectedState {
  if (value === "draft" || value === "any" || value === "published") {
    return value;
  }
  return "published";
}

function githubChecksSummary(
  pr: string,
  counts: Record<string, number>,
  total: number,
  verdict: GoalLoopVerificationVerdict,
): string {
  return [
    `GitHub PR checks for ${pr}: ${verdict}`,
    `${total} checks`,
    countPart("pass", counts.pass),
    countPart("fail", counts.fail),
    countPart("pending", counts.pending),
    countPart("skipping", counts.skipping),
    countPart("cancel", counts.cancel),
  ].filter((part): part is string => Boolean(part)).join("; ");
}

function githubChecksFailureReason(counts: Record<string, number>, total: number): string | undefined {
  if (total === 0) {
    return "No GitHub checks were reported.";
  }
  if ((counts.fail ?? 0) > 0 || (counts.cancel ?? 0) > 0) {
    return "GitHub reported failing or cancelled checks.";
  }
  if ((counts.pending ?? 0) > 0) {
    return "GitHub checks are still pending.";
  }
  return undefined;
}

function normalizeBucket(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "pass" || normalized === "fail" || normalized === "pending" || normalized === "skipping" || normalized === "cancel") {
    return normalized;
  }
  if (normalized === "success" || normalized === "completed") {
    return "pass";
  }
  if (normalized === "failure" || normalized === "error" || normalized === "timed_out" || normalized === "action_required") {
    return "fail";
  }
  if (normalized === "cancelled" || normalized === "canceled") {
    return "cancel";
  }
  if (normalized === "queued" || normalized === "in_progress" || normalized === "waiting" || normalized === "requested") {
    return "pending";
  }
  if (normalized === "skipped" || normalized === "neutral") {
    return "skipping";
  }
  return "unknown";
}

function normalizeDeploymentStatus(value: string | undefined): GitHubDeploymentExpectedState | "pending" | "unknown" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "success") {
    return "success";
  }
  if (normalized === "inactive") {
    return "inactive";
  }
  if (normalized === "failure" || normalized === "error") {
    return "failure";
  }
  if (normalized === "queued" || normalized === "pending" || normalized === "in_progress" || normalized === "waiting") {
    return "pending";
  }
  return "unknown";
}

function normalizeGitHubStatus(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function normalizeGitHubDeploymentExpectedState(value: GitHubDeploymentExpectedState | undefined): GitHubDeploymentExpectedState {
  if (value === "inactive" || value === "failure" || value === "any" || value === "success") {
    return value;
  }
  return "success";
}

function normalizeRequiredGitHubFilter(value: string | undefined, field: string): string {
  const normalized = normalizeOptionalGitHubFilter(value, field);
  if (!normalized) {
    throw new Error(`GitHub verifier requires ${field}.`);
  }
  return normalized;
}

function normalizeOptionalGitHubFilter(value: string | undefined, field: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("-")) {
    throw new Error(`GitHub verifier ${field} must not start with '-'.`);
  }
  return normalized;
}

function isBlockingMergeState(value: string | undefined): boolean {
  const normalized = normalizeGitHubStatus(value);
  return normalized === "blocked" || normalized === "dirty" || normalized === "draft";
}

function githubNameList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return undefined;
      }
      const data = item as Record<string, unknown>;
      return stringValue(data.name)?.trim();
    })
    .filter((item): item is string => Boolean(item));
}

function githubLoginList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return undefined;
      }
      const data = item as Record<string, unknown>;
      return stringValue(data.login)?.trim() ?? stringValue(data.name)?.trim();
    })
    .filter((item): item is string => Boolean(item));
}

async function readGitHubCurrentLogin(
  workspace: WorkspaceIdentity,
  timeoutMs: number,
): Promise<{ login?: string; error?: string }> {
  const result = await runSmallCommand("gh", ["api", "user", "--jq", ".login"], workspace.root, timeoutMs);
  if (result.code !== 0) {
    return { error: result.stderr.trim() || result.stdout.trim() || `gh api user exited ${result.code}` };
  }
  const login = result.stdout.trim();
  return login ? { login } : { error: "gh api user returned an empty login." };
}

function reviewRequestMatches(request: GitHubReviewRequest, reviewer: string): boolean {
  const target = normalizeReviewer(reviewer);
  if (!target) {
    return false;
  }
  const targetTail = target.includes("/") ? target.split("/").at(-1) : undefined;
  const candidates = [request.login, request.name, request.slug]
    .map(normalizeReviewer)
    .filter((item): item is string => Boolean(item));
  return candidates.includes(target) || (targetTail ? candidates.includes(targetTail) : false);
}

function normalizeReviewer(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^@+/, "").toLowerCase();
  return normalized || undefined;
}

function firstObject(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function countPart(name: string, value: number | undefined): string | undefined {
  return value ? `${name} ${value}` : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
