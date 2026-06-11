import type { SessionStore } from "../session/store.js";
import type { WorkspaceIdentity } from "../types.js";
import type { GoalLoopVerification } from "./types.js";
import { verifyGitClean } from "./git-verification.js";
import {
  verifyGitHubActionsRun,
  verifyGitHubDeploymentStatus,
  verifyGitHubIssueStatus,
  verifyGitHubReleaseStatus,
  verifyGitHubNotificationStatus,
  verifyGitHubPullRequestChecks,
  verifyGitHubPullRequestStatus,
  verifyGitHubReviewRequestStatus,
  verifyGitHubWorkflowRunStatus,
  type GitHubReleaseExpectedState,
  type GitHubDeploymentExpectedState,
} from "./github-verification.js";
import { verifyHttpHealth } from "./http-verification.js";
import { verifyNpmPackageStatus } from "./npm-verification.js";

export type ConnectorVerifierId =
  | "github-pr-checks"
  | "github-pr-status"
  | "github-review-request"
  | "github-issue-status"
  | "github-notification-status"
  | "github-actions-run"
  | "github-workflow-run-status"
  | "github-deployment-status"
  | "github-release-status"
  | "git-clean"
  | "http-health"
  | "npm-package-status";

export interface RunConnectorVerifierOptions {
  session_id: string;
  params?: Record<string, unknown>;
  run_id?: string;
}

export interface ConnectorVerifierDefinition {
  id: ConnectorVerifierId;
  connector: "github" | "git" | "http" | "npm";
  verifier_role: string;
  cli_command: string;
  tui_action: string;
  description: string;
  run: (
    store: SessionStore,
    workspace: WorkspaceIdentity,
    options: RunConnectorVerifierOptions,
  ) => Promise<GoalLoopVerification>;
}

const CONNECTOR_VERIFIER_REGISTRY: Record<ConnectorVerifierId, ConnectorVerifierDefinition> = {
  "github-pr-checks": {
    id: "github-pr-checks",
    connector: "github",
    verifier_role: "github-pr-checks",
    cli_command: "verify-github-pr",
    tui_action: "verify-github-pr",
    description: "Read GitHub PR check status and record connector verification.",
    run: (store, workspace, options) => verifyGitHubPullRequestChecks(store, workspace, {
      session_id: options.session_id,
      pr: requireStringParam(options.params, "pr", "github-pr-checks"),
      repo: optionalStringParam(options.params, "repo"),
      run_id: options.run_id,
    }),
  },
  "github-pr-status": {
    id: "github-pr-status",
    connector: "github",
    verifier_role: "github-pr-status",
    cli_command: "verify-github-pr-status",
    tui_action: "verify-github-pr-status",
    description: "Read GitHub PR state and record connector verification.",
    run: (store, workspace, options) => verifyGitHubPullRequestStatus(store, workspace, {
      session_id: options.session_id,
      pr: requireStringParam(options.params, "pr", "github-pr-status"),
      repo: optionalStringParam(options.params, "repo"),
      run_id: options.run_id,
    }),
  },
  "github-review-request": {
    id: "github-review-request",
    connector: "github",
    verifier_role: "github-review-request",
    cli_command: "verify-github-review-request",
    tui_action: "verify-github-review-request",
    description: "Read GitHub review-request state and record connector verification.",
    run: (store, workspace, options) => verifyGitHubReviewRequestStatus(store, workspace, {
      session_id: options.session_id,
      pr: requireStringParam(options.params, "pr", "github-review-request"),
      repo: optionalStringParam(options.params, "repo"),
      reviewer: optionalStringParam(options.params, "reviewer"),
      run_id: options.run_id,
    }),
  },
  "github-issue-status": {
    id: "github-issue-status",
    connector: "github",
    verifier_role: "github-issue-status",
    cli_command: "verify-github-issue-status",
    tui_action: "verify-github-issue-status",
    description: "Read GitHub issue state and record connector verification.",
    run: (store, workspace, options) => verifyGitHubIssueStatus(store, workspace, {
      session_id: options.session_id,
      issue: requireStringParam(options.params, "issue", "github-issue-status"),
      repo: optionalStringParam(options.params, "repo"),
      run_id: options.run_id,
    }),
  },
  "github-notification-status": {
    id: "github-notification-status",
    connector: "github",
    verifier_role: "github-notification-status",
    cli_command: "verify-github-notification",
    tui_action: "verify-github-notification",
    description: "Read GitHub notification thread state and record connector verification.",
    run: (store, workspace, options) => verifyGitHubNotificationStatus(store, workspace, {
      session_id: options.session_id,
      thread: requireStringParam(options.params, "thread", "github-notification-status"),
      run_id: options.run_id,
    }),
  },
  "github-actions-run": {
    id: "github-actions-run",
    connector: "github",
    verifier_role: "github-actions-run",
    cli_command: "verify-github-run",
    tui_action: "verify-github-run",
    description: "Read GitHub Actions run state and record connector verification.",
    run: (store, workspace, options) => verifyGitHubActionsRun(store, workspace, {
      session_id: options.session_id,
      run: requireStringParam(options.params, "run", "github-actions-run"),
      repo: optionalStringParam(options.params, "repo"),
      attempt: optionalNumberParam(options.params, "attempt"),
      run_id: options.run_id,
    }),
  },
  "github-workflow-run-status": {
    id: "github-workflow-run-status",
    connector: "github",
    verifier_role: "github-workflow-run-status",
    cli_command: "verify-github-workflow",
    tui_action: "verify-github-workflow",
    description: "Read the latest matching GitHub Actions workflow run and record connector verification.",
    run: (store, workspace, options) => verifyGitHubWorkflowRunStatus(store, workspace, {
      session_id: options.session_id,
      workflow: requireStringParam(options.params, "workflow", "github-workflow-run-status"),
      repo: optionalStringParam(options.params, "repo"),
      branch: optionalStringParam(options.params, "branch"),
      event: optionalStringParam(options.params, "event"),
      commit: optionalStringParam(options.params, "commit"),
      run_id: options.run_id,
    }),
  },
  "github-deployment-status": {
    id: "github-deployment-status",
    connector: "github",
    verifier_role: "github-deployment-status",
    cli_command: "verify-github-deployment",
    tui_action: "verify-github-deployment",
    description: "Read GitHub Deployment latest status and record connector verification.",
    run: (store, workspace, options) => verifyGitHubDeploymentStatus(store, workspace, {
      session_id: options.session_id,
      repo: requireStringParam(options.params, "repo", "github-deployment-status"),
      deployment_id: optionalStringParam(options.params, "deployment_id"),
      environment: optionalStringParam(options.params, "environment"),
      ref: optionalStringParam(options.params, "ref"),
      expect: optionalDeploymentExpectedStateParam(options.params, "expect"),
      run_id: options.run_id,
    }),
  },
  "github-release-status": {
    id: "github-release-status",
    connector: "github",
    verifier_role: "github-release-status",
    cli_command: "verify-github-release",
    tui_action: "verify-github-release",
    description: "Read GitHub release draft/published state and record connector verification.",
    run: (store, workspace, options) => verifyGitHubReleaseStatus(store, workspace, {
      session_id: options.session_id,
      tag: requireStringParam(options.params, "tag", "github-release-status"),
      repo: optionalStringParam(options.params, "repo"),
      expect: optionalReleaseExpectedStateParam(options.params, "expect"),
      run_id: options.run_id,
    }),
  },
  "git-clean": {
    id: "git-clean",
    connector: "git",
    verifier_role: "git-clean",
    cli_command: "verify-git-clean",
    tui_action: "verify-git-clean",
    description: "Read local git working tree status and record clean-state verification.",
    run: (store, workspace, options) => verifyGitClean(store, workspace, {
      session_id: options.session_id,
      run_id: options.run_id,
    }),
  },
  "http-health": {
    id: "http-health",
    connector: "http",
    verifier_role: "http-health",
    cli_command: "verify-http",
    tui_action: "verify-http",
    description: "Read an HTTP endpoint and record health verification.",
    run: (store, workspace, options) => verifyHttpHealth(store, workspace, {
      session_id: options.session_id,
      url: requireStringParam(options.params, "url", "http-health"),
      expected_status: optionalNumberParam(options.params, "expected_status"),
      timeout_ms: optionalNumberParam(options.params, "timeout_ms"),
      run_id: options.run_id,
    }),
  },
  "npm-package-status": {
    id: "npm-package-status",
    connector: "npm",
    verifier_role: "npm-package-status",
    cli_command: "verify-npm-package",
    tui_action: "verify-npm-package",
    description: "Read npm registry package metadata and record published version/tag verification.",
    run: (store, workspace, options) => verifyNpmPackageStatus(store, workspace, {
      session_id: options.session_id,
      package_name: requireStringParam(options.params, "package_name", "npm-package-status"),
      version: requireStringParam(options.params, "version", "npm-package-status"),
      tag: optionalStringParam(options.params, "tag"),
      timeout_ms: optionalNumberParam(options.params, "timeout_ms"),
      run_id: options.run_id,
    }),
  },
};

export function listConnectorVerifierDefinitions(): ConnectorVerifierDefinition[] {
  return Object.values(CONNECTOR_VERIFIER_REGISTRY);
}

export function getConnectorVerifierDefinition(id: string): ConnectorVerifierDefinition | undefined {
  return CONNECTOR_VERIFIER_REGISTRY[id as ConnectorVerifierId];
}

export async function runConnectorVerifier(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  id: ConnectorVerifierId,
  options: RunConnectorVerifierOptions,
): Promise<GoalLoopVerification> {
  const definition = CONNECTOR_VERIFIER_REGISTRY[id];
  if (!definition) {
    throw new Error(`Unknown connector verifier: ${id}`);
  }
  return definition.run(store, workspace, options);
}

function requireStringParam(params: Record<string, unknown> | undefined, key: string, verifier: string): string {
  const value = optionalStringParam(params, key);
  if (!value) {
    throw new Error(`Connector verifier ${verifier} requires parameter ${key}.`);
  }
  return value;
}

function optionalStringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalNumberParam(params: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = params?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalReleaseExpectedStateParam(params: Record<string, unknown> | undefined, key: string): GitHubReleaseExpectedState | undefined {
  const value = optionalStringParam(params, key);
  if (!value) {
    return undefined;
  }
  if (value === "published" || value === "draft" || value === "any") {
    return value;
  }
  throw new Error(`Connector verifier github-release-status parameter ${key} must be published, draft, or any.`);
}

function optionalDeploymentExpectedStateParam(params: Record<string, unknown> | undefined, key: string): GitHubDeploymentExpectedState | undefined {
  const value = optionalStringParam(params, key);
  if (!value) {
    return undefined;
  }
  if (value === "success" || value === "inactive" || value === "failure" || value === "any") {
    return value;
  }
  throw new Error(`Connector verifier github-deployment-status parameter ${key} must be success, inactive, failure, or any.`);
}
