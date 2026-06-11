import { execFile } from "node:child_process";
import type { SessionStore } from "../session/store.js";
import type { JsonObject, SessionRecord } from "../types.js";
import {
  preflightConnectorAction,
  type ConnectorActionPreflightResult,
  type ConnectorActionRequestClass,
} from "../tools/connector-actions.js";

export type ConnectorActionRunStatus = "dry_run" | "executed" | "denied" | "failed";
export type ConnectorActionExecutable = "gh" | "npm";
export type GitHubPullRequestMergeMethod = "merge" | "squash" | "rebase";
export type GitHubPullRequestReviewEvent = "approve" | "request_changes" | "comment";
export type GitHubDeploymentStatusState = "error" | "failure" | "inactive" | "in_progress" | "queued" | "pending" | "success";
export type NpmPackageAccess = "public" | "restricted";

export interface ConnectorActionRunnerDefinition {
  id: string;
  connector: string;
  surface: "first_class";
  kind: "mutation";
  area: string;
  operation: string;
  cli_command: string;
  tui_action: string;
  default_mode: "dry_run";
  description: string;
}

interface BaseConnectorActionRunInput {
  connector: "github" | "npm";
  request_class: ConnectorActionRequestClass;
  execute: boolean;
  timeout_ms: number;
}

interface GitHubRepoNumberActionRunInput extends BaseConnectorActionRunInput {
  connector: "github";
  repo: string;
  number: number;
}

export interface GitHubPullRequestMergeActionRunInput extends GitHubRepoNumberActionRunInput {
  area: "pull_request";
  operation: "merge";
  method: GitHubPullRequestMergeMethod;
  delete_branch: boolean;
}

export interface GitHubPullRequestReviewActionRunInput extends GitHubRepoNumberActionRunInput {
  area: "pull_request";
  operation: "review";
  review_event: GitHubPullRequestReviewEvent;
  body?: string;
}

export interface GitHubPullRequestCommentActionRunInput extends GitHubRepoNumberActionRunInput {
  area: "pull_request";
  operation: "comment";
  body: string;
}

export interface GitHubPullRequestLabelActionRunInput extends GitHubRepoNumberActionRunInput {
  area: "pull_request";
  operation: "label";
  add_labels: string[];
  remove_labels: string[];
}

export interface GitHubIssueCloseActionRunInput extends GitHubRepoNumberActionRunInput {
  area: "issue";
  operation: "close";
}

export interface GitHubIssueCommentActionRunInput extends GitHubRepoNumberActionRunInput {
  area: "issue";
  operation: "comment";
  body: string;
}

export interface GitHubIssueLabelActionRunInput extends GitHubRepoNumberActionRunInput {
  area: "issue";
  operation: "label";
  add_labels: string[];
  remove_labels: string[];
}

export interface GitHubNotificationMarkReadActionRunInput extends BaseConnectorActionRunInput {
  connector: "github";
  area: "notification";
  operation: "mark_read";
  thread: string;
}

export interface GitHubRunRerunActionRunInput extends BaseConnectorActionRunInput {
  connector: "github";
  area: "run";
  operation: "rerun";
  repo: string;
  target_run_id: string;
}

export interface GitHubWorkflowDispatchActionRunInput extends BaseConnectorActionRunInput {
  connector: "github";
  area: "workflow";
  operation: "dispatch";
  repo: string;
  workflow: string;
  ref?: string;
  fields: Array<{ key: string; value: string }>;
}

export interface GitHubDeploymentCreateStatusActionRunInput extends BaseConnectorActionRunInput {
  connector: "github";
  area: "deployment";
  operation: "create_status";
  repo: string;
  deployment_id: string;
  state: GitHubDeploymentStatusState;
  environment_url?: string;
  log_url?: string;
  description?: string;
}

export interface GitHubReleaseCreateDraftActionRunInput extends BaseConnectorActionRunInput {
  connector: "github";
  area: "release";
  operation: "create_draft";
  repo: string;
  tag: string;
  title?: string;
  notes?: string;
  generate_notes: boolean;
  draft: true;
  verify_tag: true;
}

export interface GitHubReleasePublishDraftActionRunInput extends BaseConnectorActionRunInput {
  connector: "github";
  area: "release";
  operation: "publish_draft";
  repo: string;
  tag: string;
  draft: false;
  verify_tag: true;
}

export interface NpmPackagePublishActionRunInput extends BaseConnectorActionRunInput {
  connector: "npm";
  area: "package";
  operation: "publish";
  dist_tag: string;
  access?: NpmPackageAccess;
  provenance: boolean;
}

export type ConnectorActionRunInput =
  | GitHubPullRequestMergeActionRunInput
  | GitHubPullRequestReviewActionRunInput
  | GitHubPullRequestCommentActionRunInput
  | GitHubPullRequestLabelActionRunInput
  | GitHubIssueCloseActionRunInput
  | GitHubIssueCommentActionRunInput
  | GitHubIssueLabelActionRunInput
  | GitHubNotificationMarkReadActionRunInput
  | GitHubRunRerunActionRunInput
  | GitHubWorkflowDispatchActionRunInput
  | GitHubDeploymentCreateStatusActionRunInput
  | GitHubReleaseCreateDraftActionRunInput
  | GitHubReleasePublishDraftActionRunInput
  | NpmPackagePublishActionRunInput;

export interface ConnectorActionRunResult {
  status: ConnectorActionRunStatus;
  session_id: string;
  recorded: boolean;
  event_id?: number;
  preflight: ConnectorActionPreflightResult;
  action: ConnectorActionRunInput;
  command: {
    executable: ConnectorActionExecutable;
    args: string[];
  };
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  reason?: string;
}

const ACTION_EVENT_TYPE = "connector.action.recorded";
const DEFAULT_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 12_000;

export function listConnectorActionRunnerDefinitions(): ConnectorActionRunnerDefinition[] {
  return [
    {
      id: "github-pr-merge",
      connector: "github",
      surface: "first_class",
      kind: "mutation",
      area: "pull_request",
      operation: "merge",
      cli_command: "inferoa loop action-run <session> github pull_request merge --repo owner/repo --number 17 [--method merge|squash|rebase] [--execute]",
      tui_action: "/loop action-run [session] github pull_request merge --repo owner/repo --number 17 [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly execute a GitHub pull request merge through the connector action policy gate.",
    },
    {
      id: "github-pr-review",
      connector: "github",
      surface: "first_class",
      kind: "mutation",
      area: "pull_request",
      operation: "review",
      cli_command: "inferoa loop action-run <session> github pull_request review --repo owner/repo --number 17 --event approve|request-changes|comment [--body TEXT] [--execute]",
      tui_action: "/loop action-run [session] github pull_request review --repo owner/repo --number 17 --event approve [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly submit a GitHub pull request review through the connector action policy gate.",
    },
    {
      id: "github-pr-comment",
      connector: "github",
      surface: "first_class",
      kind: "mutation",
      area: "pull_request",
      operation: "comment",
      cli_command: "inferoa loop action-run <session> github pull_request comment --repo owner/repo --number 17 --body TEXT [--execute]",
      tui_action: "/loop action-run [session] github pull_request comment --repo owner/repo --number 17 --body TEXT [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly comment on a GitHub pull request through the connector action policy gate.",
    },
    {
      id: "github-pr-label",
      connector: "github",
      surface: "first_class",
      kind: "mutation",
      area: "pull_request",
      operation: "label",
      cli_command: "inferoa loop action-run <session> github pull_request label --repo owner/repo --number 17 [--add-label LABEL ...] [--remove-label LABEL ...] [--execute]",
      tui_action: "/loop action-run [session] github pull_request label --repo owner/repo --number 17 --add-label triage [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly add/remove labels on a GitHub pull request through the connector action policy gate.",
    },
    {
      id: "github-issue-close",
      connector: "github",
      surface: "first_class",
      kind: "mutation",
      area: "issue",
      operation: "close",
      cli_command: "inferoa loop action-run <session> github issue close --repo owner/repo --number 42 [--execute]",
      tui_action: "/loop action-run [session] github issue close --repo owner/repo --number 42 [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly execute a GitHub issue close through the connector action policy gate.",
    },
    {
      id: "github-issue-comment",
      connector: "github",
      surface: "first_class",
      kind: "mutation",
      area: "issue",
      operation: "comment",
      cli_command: "inferoa loop action-run <session> github issue comment --repo owner/repo --number 42 --body TEXT [--execute]",
      tui_action: "/loop action-run [session] github issue comment --repo owner/repo --number 42 --body TEXT [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly comment on a GitHub issue through the connector action policy gate.",
    },
    {
      id: "github-issue-label",
      connector: "github",
      surface: "first_class",
      kind: "mutation",
      area: "issue",
      operation: "label",
      cli_command: "inferoa loop action-run <session> github issue label --repo owner/repo --number 42 [--add-label LABEL ...] [--remove-label LABEL ...] [--execute]",
      tui_action: "/loop action-run [session] github issue label --repo owner/repo --number 42 --add-label triage [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly add/remove labels on a GitHub issue through the connector action policy gate.",
    },
    {
      id: "github-notification-mark-read",
      connector: "github",
      surface: "first_class",
      kind: "mutation",
      area: "notification",
      operation: "mark_read",
      cli_command: "inferoa loop action-run <session> github notification mark-read --thread THREAD [--execute]",
      tui_action: "/loop action-run [session] github notification mark-read --thread THREAD [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly mark a GitHub notification thread as read through the connector action policy gate.",
    },
    {
      id: "github-run-rerun",
      connector: "github",
      surface: "first_class",
      kind: "mutation",
      area: "run",
      operation: "rerun",
      cli_command: "inferoa loop action-run <session> github run rerun --repo owner/repo --run-id RUN_ID [--execute]",
      tui_action: "/loop action-run [session] github run rerun --repo owner/repo --run-id RUN_ID [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly rerun a GitHub Actions run through the connector action policy gate.",
    },
    {
      id: "github-workflow-dispatch",
      connector: "github",
      surface: "first_class",
      kind: "mutation",
      area: "workflow",
      operation: "dispatch",
      cli_command: "inferoa loop action-run <session> github workflow dispatch --repo owner/repo --workflow deploy.yml [--ref main] [--field key=value ...] [--execute]",
      tui_action: "/loop action-run [session] github workflow dispatch --repo owner/repo --workflow deploy.yml [--ref main] [--field key=value ...] [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly dispatch a GitHub Actions workflow through the connector action policy gate.",
    },
    {
      id: "github-deployment-create-status",
      connector: "github",
      surface: "first_class",
      kind: "mutation",
      area: "deployment",
      operation: "create_status",
      cli_command: "inferoa loop action-run <session> github deployment create-status --repo owner/repo --deployment-id ID --state success|failure|inactive|in_progress|queued|pending|error [--environment-url URL] [--log-url URL] [--description TEXT] [--execute]",
      tui_action: "/loop action-run [session] github deployment create-status --repo owner/repo --deployment-id ID --state success [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly create a GitHub Deployment status through the connector action policy gate.",
    },
    {
      id: "github-release-create-draft",
      connector: "github",
      surface: "first_class",
      kind: "mutation",
      area: "release",
      operation: "create_draft",
      cli_command: "inferoa loop action-run <session> github release create-draft --repo owner/repo --tag v1.2.3 (--notes TEXT|--generate-notes) [--title TITLE] [--execute]",
      tui_action: "/loop action-run [session] github release create-draft --repo owner/repo --tag v1.2.3 --generate-notes [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly create a draft GitHub release without publishing it.",
    },
    {
      id: "github-release-publish-draft",
      connector: "github",
      surface: "first_class",
      kind: "mutation",
      area: "release",
      operation: "publish_draft",
      cli_command: "inferoa loop action-run <session> github release publish-draft --repo owner/repo --tag v1.2.3 [--execute]",
      tui_action: "/loop action-run [session] github release publish-draft --repo owner/repo --tag v1.2.3 [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly publish an existing draft GitHub release through the connector action policy gate.",
    },
    {
      id: "npm-package-publish",
      connector: "npm",
      surface: "first_class",
      kind: "mutation",
      area: "package",
      operation: "publish",
      cli_command: "inferoa loop action-run <session> npm package publish [--tag latest] [--access public|restricted] [--provenance] [--execute]",
      tui_action: "/loop action-run [session] npm package publish [--tag latest] [--access public|restricted] [--provenance] [--execute]",
      default_mode: "dry_run",
      description: "Dry-run or explicitly publish the current workspace package through the connector action policy gate.",
    },
  ];
}

export function parseConnectorActionRunInput(args: string[]): ConnectorActionRunInput {
  const parsed = parseConnectorActionRunFlags(args);
  if (!parsed.connector) {
    parsed.connector = parsed.args[0];
    parsed.area = parsed.args[1];
    parsed.operation = parsed.args[2];
  }
  const connector = normalizeConnector(parsed.connector);
  const area = normalizeActionArea(parsed.area);
  const operation = normalizeActionOperation(parsed.operation);
  if (connector === "npm") {
    const base = {
      connector: "npm" as const,
      request_class: parsed.request_class ?? "interactive",
      execute: parsed.execute ?? false,
      timeout_ms: parsed.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    };
    if (area === "package" && operation === "publish") {
      rejectNpmPackagePublishUnsupportedFlags(parsed);
      return {
        ...base,
        area,
        operation,
        dist_tag: parseNpmDistTag(parsed.tag ?? "latest"),
        access: parsed.access,
        provenance: parsed.provenance ?? false,
      };
    }
    throw new Error(actionRunUsage());
  }
  if (connector !== "github") {
    throw new Error("Only github and npm connector action-run are supported.");
  }
  const base = {
    connector: "github" as const,
    request_class: parsed.request_class ?? "interactive",
    execute: parsed.execute ?? false,
    timeout_ms: parsed.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  };
  if (area === "pull_request" && operation === "merge") {
    rejectWorkflowDispatchOnlyFlags(parsed, "github pull_request merge");
    rejectDeploymentCreateStatusOnlyFlags(parsed, "github pull_request merge");
    rejectPullRequestReviewOnlyFlags(parsed, "github pull_request merge");
    rejectGitHubLabelOnlyFlags(parsed, "github pull_request merge");
    const repo = parseRepo(parsed.repo);
    const number = parsePositiveInt(parsed.number, "--number");
    return {
      ...base,
      area,
      operation,
      repo,
      number,
      method: parsed.method ?? "merge",
      delete_branch: parsed.delete_branch ?? false,
    };
  }
  if (area === "pull_request" && operation === "review") {
    rejectWorkflowDispatchOnlyFlags(parsed, "github pull_request review");
    rejectDeploymentCreateStatusOnlyFlags(parsed, "github pull_request review");
    rejectGitHubLabelOnlyFlags(parsed, "github pull_request review");
    const repo = parseRepo(parsed.repo);
    const number = parsePositiveInt(parsed.number, "--number");
    const reviewEvent = parsePullRequestReviewEvent(parsed.review_event);
    if (parsed.thread) {
      throw new Error("--thread is only supported for github notification mark-read action-run.");
    }
    if (parsed.run_id) {
      throw new Error("--run-id is only supported for github run rerun action-run.");
    }
    if (parsed.tag) {
      throw new Error("--tag is only supported for github release actions and npm package publish action-run.");
    }
    if (parsed.title || parsed.notes || parsed.generate_notes) {
      throw new Error("--title, --notes, and --generate-notes are only supported for github release create-draft action-run.");
    }
    if (parsed.method) {
      throw new Error("--method is only supported for github pull_request merge action-run.");
    }
    if (parsed.delete_branch) {
      throw new Error("--delete-branch is only supported for github pull_request merge action-run.");
    }
    if (parsed.access || parsed.provenance) {
      throw new Error("--access and --provenance are only supported for npm package publish action-run.");
    }
    return {
      ...base,
      area,
      operation,
      repo,
      number,
      review_event: reviewEvent,
      body: parsePullRequestReviewBody(parsed.body, reviewEvent),
    };
  }
  if (area === "pull_request" && operation === "comment") {
    rejectWorkflowDispatchOnlyFlags(parsed, "github pull_request comment");
    rejectDeploymentCreateStatusOnlyFlags(parsed, "github pull_request comment");
    rejectPullRequestReviewEventOnlyFlags(parsed, "github pull_request comment");
    rejectGitHubLabelOnlyFlags(parsed, "github pull_request comment");
    rejectGitHubBodyActionUnsupportedFlags(parsed);
    return {
      ...base,
      area,
      operation,
      repo: parseRepo(parsed.repo),
      number: parsePositiveInt(parsed.number, "--number"),
      body: parseRequiredText(parsed.body, "--body"),
    };
  }
  if (area === "pull_request" && operation === "label") {
    rejectWorkflowDispatchOnlyFlags(parsed, "github pull_request label");
    rejectDeploymentCreateStatusOnlyFlags(parsed, "github pull_request label");
    rejectGitHubLabelActionUnsupportedFlags(parsed);
    const labels = parseGitHubLabelMutation(parsed);
    return {
      ...base,
      area,
      operation,
      repo: parseRepo(parsed.repo),
      number: parsePositiveInt(parsed.number, "--number"),
      ...labels,
    };
  }
  if (area === "issue" && operation === "close") {
    rejectWorkflowDispatchOnlyFlags(parsed, "github issue close");
    rejectDeploymentCreateStatusOnlyFlags(parsed, "github issue close");
    rejectPullRequestReviewOnlyFlags(parsed, "github issue close");
    rejectGitHubLabelOnlyFlags(parsed, "github issue close");
    const repo = parseRepo(parsed.repo);
    const number = parsePositiveInt(parsed.number, "--number");
    if (parsed.method) {
      throw new Error("--method is only supported for github pull_request merge action-run.");
    }
    if (parsed.delete_branch) {
      throw new Error("--delete-branch is only supported for github pull_request merge action-run.");
    }
    return {
      ...base,
      area,
      operation,
      repo,
      number,
    };
  }
  if (area === "issue" && operation === "comment") {
    rejectWorkflowDispatchOnlyFlags(parsed, "github issue comment");
    rejectDeploymentCreateStatusOnlyFlags(parsed, "github issue comment");
    rejectPullRequestReviewEventOnlyFlags(parsed, "github issue comment");
    rejectGitHubLabelOnlyFlags(parsed, "github issue comment");
    rejectGitHubBodyActionUnsupportedFlags(parsed);
    return {
      ...base,
      area,
      operation,
      repo: parseRepo(parsed.repo),
      number: parsePositiveInt(parsed.number, "--number"),
      body: parseRequiredText(parsed.body, "--body"),
    };
  }
  if (area === "issue" && operation === "label") {
    rejectWorkflowDispatchOnlyFlags(parsed, "github issue label");
    rejectDeploymentCreateStatusOnlyFlags(parsed, "github issue label");
    rejectGitHubLabelActionUnsupportedFlags(parsed);
    const labels = parseGitHubLabelMutation(parsed);
    return {
      ...base,
      area,
      operation,
      repo: parseRepo(parsed.repo),
      number: parsePositiveInt(parsed.number, "--number"),
      ...labels,
    };
  }
  if (area === "notification" && operation === "mark_read") {
    rejectWorkflowDispatchOnlyFlags(parsed, "github notification mark-read");
    rejectDeploymentCreateStatusOnlyFlags(parsed, "github notification mark-read");
    rejectPullRequestReviewOnlyFlags(parsed, "github notification mark-read");
    rejectGitHubLabelOnlyFlags(parsed, "github notification mark-read");
    if (parsed.repo) {
      throw new Error("--repo is not supported for github notification mark-read action-run.");
    }
    if (parsed.number) {
      throw new Error("--number is not supported for github notification mark-read action-run.");
    }
    if (parsed.method) {
      throw new Error("--method is only supported for github pull_request merge action-run.");
    }
    if (parsed.delete_branch) {
      throw new Error("--delete-branch is only supported for github pull_request merge action-run.");
    }
    return {
      ...base,
      area,
      operation,
      thread: parseThread(parsed.thread),
    };
  }
  if (area === "run" && operation === "rerun") {
    rejectWorkflowDispatchOnlyFlags(parsed, "github run rerun");
    rejectDeploymentCreateStatusOnlyFlags(parsed, "github run rerun");
    rejectPullRequestReviewOnlyFlags(parsed, "github run rerun");
    rejectGitHubLabelOnlyFlags(parsed, "github run rerun");
    const repo = parseRepo(parsed.repo);
    if (parsed.number) {
      throw new Error("--number is only supported for github pull_request merge/review/comment/label and github issue close/comment/label action-run.");
    }
    if (parsed.thread) {
      throw new Error("--thread is only supported for github notification mark-read action-run.");
    }
    if (parsed.method) {
      throw new Error("--method is only supported for github pull_request merge action-run.");
    }
    if (parsed.delete_branch) {
      throw new Error("--delete-branch is only supported for github pull_request merge action-run.");
    }
    return {
      ...base,
      area,
      operation,
      repo,
      target_run_id: parseTargetRunId(parsed.run_id),
    };
  }
  if (area === "workflow" && operation === "dispatch") {
    rejectWorkflowDispatchUnsupportedFlags(parsed);
    return {
      ...base,
      area,
      operation,
      repo: parseRepo(parsed.repo),
      workflow: parseWorkflow(parsed.workflow),
      ref: parseWorkflowRef(parsed.ref),
      fields: parsed.fields ?? [],
    };
  }
  if (area === "deployment" && operation === "create_status") {
    rejectDeploymentCreateStatusUnsupportedFlags(parsed);
    return {
      ...base,
      area,
      operation,
      repo: parseRepo(parsed.repo),
      deployment_id: parseDeploymentId(parsed.deployment_id),
      state: parseDeploymentStatusState(parsed.state),
      environment_url: parseOptionalUrl(parsed.environment_url, "--environment-url"),
      log_url: parseOptionalUrl(parsed.log_url, "--log-url"),
      description: parseOptionalText(parsed.description, "--description"),
    };
  }
  if (area === "release" && operation === "create_draft") {
    rejectWorkflowDispatchOnlyFlags(parsed, "github release create-draft");
    const repo = parseRepo(parsed.repo);
    rejectDeploymentCreateStatusOnlyFlags(parsed, "github release create-draft");
    rejectPullRequestReviewOnlyFlags(parsed, "github release create-draft");
    rejectGitHubLabelOnlyFlags(parsed, "github release create-draft");
    if (parsed.number) {
      throw new Error("--number is only supported for github pull_request merge/review/comment/label and github issue close/comment/label action-run.");
    }
    if (parsed.thread) {
      throw new Error("--thread is only supported for github notification mark-read action-run.");
    }
    if (parsed.run_id) {
      throw new Error("--run-id is only supported for github run rerun action-run.");
    }
    if (parsed.method) {
      throw new Error("--method is only supported for github pull_request merge action-run.");
    }
    if (parsed.delete_branch) {
      throw new Error("--delete-branch is only supported for github pull_request merge action-run.");
    }
    if (parsed.notes && parsed.generate_notes) {
      throw new Error("Use either --notes or --generate-notes for github release create-draft action-run, not both.");
    }
    if (!parsed.notes && !parsed.generate_notes) {
      throw new Error("github release create-draft action-run requires --notes TEXT or --generate-notes.");
    }
    return {
      ...base,
      area,
      operation,
      repo,
      tag: parseReleaseTag(parsed.tag),
      title: parseOptionalText(parsed.title, "--title"),
      notes: parsed.generate_notes ? undefined : parseRequiredText(parsed.notes, "--notes"),
      generate_notes: parsed.generate_notes ?? false,
      draft: true,
      verify_tag: true,
    };
  }
  if (area === "release" && operation === "publish_draft") {
    rejectWorkflowDispatchOnlyFlags(parsed, "github release publish-draft");
    const repo = parseRepo(parsed.repo);
    rejectDeploymentCreateStatusOnlyFlags(parsed, "github release publish-draft");
    rejectPullRequestReviewOnlyFlags(parsed, "github release publish-draft");
    rejectGitHubLabelOnlyFlags(parsed, "github release publish-draft");
    if (parsed.number) {
      throw new Error("--number is only supported for github pull_request merge/review/comment/label and github issue close/comment/label action-run.");
    }
    if (parsed.thread) {
      throw new Error("--thread is only supported for github notification mark-read action-run.");
    }
    if (parsed.run_id) {
      throw new Error("--run-id is only supported for github run rerun action-run.");
    }
    if (parsed.method) {
      throw new Error("--method is only supported for github pull_request merge action-run.");
    }
    if (parsed.delete_branch) {
      throw new Error("--delete-branch is only supported for github pull_request merge action-run.");
    }
    if (parsed.title || parsed.notes || parsed.generate_notes) {
      throw new Error("--title, --notes, and --generate-notes are only supported for github release create-draft action-run.");
    }
    return {
      ...base,
      area,
      operation,
      repo,
      tag: parseReleaseTag(parsed.tag),
      draft: false,
      verify_tag: true,
    };
  }
  throw new Error(actionRunUsage());
}

export async function runConnectorAction(
  store: SessionStore,
  session: SessionRecord,
  input: ConnectorActionRunInput,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ConnectorActionRunResult> {
  const command = connectorActionCommand(input);
  const preflight = preflightConnectorAction({
    connector: input.connector,
    surface: "first_class",
    kind: "mutation",
    area: input.area,
    operation: input.operation,
    request_class: input.request_class,
  });
  if (preflight.status !== "allow") {
    const eventId = appendPermissionDenied(store, session, input, preflight);
    return {
      status: "denied",
      session_id: session.session_id,
      recorded: true,
      event_id: eventId,
      preflight,
      action: input,
      command,
      reason: preflight.reason,
    };
  }
  if (input.execute && input.request_class !== "interactive") {
    const denied = {
      ...preflight,
      status: "deny" as const,
      reason: "connector action execution requires an interactive request class",
      needs_review: true,
      review_surface: "loop inbox action_review",
      policy_id: "first-class-connector-interactive-execution",
      policy_kind: "connector_mutation" as const,
    };
    const eventId = appendPermissionDenied(store, session, input, denied);
    return {
      status: "denied",
      session_id: session.session_id,
      recorded: true,
      event_id: eventId,
      preflight: denied,
      action: input,
      command,
      reason: denied.reason,
    };
  }
  if (!input.execute) {
    const eventId = appendConnectorActionEvent(store, session, {
      status: "dry_run",
      request_class: input.request_class,
      action: actionEventInput(input),
      command,
      preflight: preflightEventData(preflight),
    });
    return {
      status: "dry_run",
      session_id: session.session_id,
      recorded: true,
      event_id: eventId,
      preflight,
      action: input,
      command,
      reason: "dry run recorded; pass --execute from an interactive request to run the connector action",
    };
  }

  const executed = await execConnectorCommand(command, {
    cwd: options.cwd,
    env: options.env,
    timeout_ms: input.timeout_ms,
  });
  const status: ConnectorActionRunStatus = executed.exit_code === 0 ? "executed" : "failed";
  const eventId = appendConnectorActionEvent(store, session, {
    status,
    request_class: input.request_class,
    action: actionEventInput(input),
    command,
    preflight: preflightEventData(preflight),
    result: {
      exit_code: executed.exit_code,
      stdout: truncateOutput(executed.stdout),
      stderr: truncateOutput(executed.stderr),
    },
  });
  return {
    status,
    session_id: session.session_id,
    recorded: true,
    event_id: eventId,
    preflight,
    action: input,
    command,
    exit_code: executed.exit_code,
    stdout: truncateOutput(executed.stdout),
    stderr: truncateOutput(executed.stderr),
    reason: executed.exit_code === 0 ? "connector action executed" : "connector action command failed",
  };
}

interface ParsedConnectorActionRunFlags {
  args: string[];
  connector?: string;
  area?: string;
  operation?: string;
  request_class?: ConnectorActionRequestClass;
  execute?: boolean;
  repo?: string;
  number?: string;
  thread?: string;
  run_id?: string;
  workflow?: string;
  ref?: string;
  fields?: Array<{ key: string; value: string }>;
  deployment_id?: string;
  state?: string;
  environment_url?: string;
  log_url?: string;
  description?: string;
  tag?: string;
  title?: string;
  notes?: string;
  generate_notes?: boolean;
  review_event?: GitHubPullRequestReviewEvent;
  body?: string;
  add_labels?: string[];
  remove_labels?: string[];
  method?: GitHubPullRequestMergeMethod;
  delete_branch?: boolean;
  access?: NpmPackageAccess;
  provenance?: boolean;
  timeout_ms?: number;
}

function parseConnectorActionRunFlags(args: string[]): ParsedConnectorActionRunFlags {
  const parsed: ParsedConnectorActionRunFlags = { args: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const inline = parseInlineFlag(arg);
    const flag = inline?.flag ?? arg;
    const inlineValue = inline?.value;
    if (flag === "--connector") {
      parsed.connector = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--area") {
      parsed.area = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--operation") {
      parsed.operation = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--request-class") {
      parsed.request_class = parseRequestClass(inlineValue ?? requiredFlagValue(args, ++index, flag));
    } else if (flag === "--repo") {
      parsed.repo = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--number") {
      parsed.number = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--thread" || flag === "--thread-id") {
      parsed.thread = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--run-id" || flag === "--run") {
      parsed.run_id = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--workflow") {
      parsed.workflow = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--ref") {
      parsed.ref = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--field" || flag === "-f") {
      parsed.fields ??= [];
      parsed.fields.push(parseWorkflowField(inlineValue ?? requiredFlagValue(args, ++index, flag)));
    } else if (flag === "--deployment-id" || flag === "--deployment") {
      parsed.deployment_id = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--state") {
      parsed.state = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--environment-url") {
      parsed.environment_url = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--log-url") {
      parsed.log_url = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--description") {
      parsed.description = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--tag") {
      parsed.tag = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--title") {
      parsed.title = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--notes") {
      parsed.notes = inlineValue ?? requiredFlagValue(args, ++index, flag);
    } else if (flag === "--event") {
      parsed.review_event = parsePullRequestReviewEvent(inlineValue ?? requiredFlagValue(args, ++index, flag));
    } else if (flag === "--body") {
      parsed.body = parseRequiredText(inlineValue ?? requiredFlagValue(args, ++index, flag), flag);
    } else if (flag === "--add-label") {
      parsed.add_labels ??= [];
      parsed.add_labels.push(parseGitHubLabel(inlineValue ?? requiredFlagValue(args, ++index, flag), flag));
    } else if (flag === "--remove-label") {
      parsed.remove_labels ??= [];
      parsed.remove_labels.push(parseGitHubLabel(inlineValue ?? requiredFlagValue(args, ++index, flag), flag));
    } else if (flag === "--method") {
      parsed.method = parseMergeMethod(inlineValue ?? requiredFlagValue(args, ++index, flag));
    } else if (flag === "--access") {
      parsed.access = parseNpmAccess(inlineValue ?? requiredFlagValue(args, ++index, flag));
    } else if (flag === "--timeout-ms") {
      parsed.timeout_ms = parsePositiveInt(inlineValue ?? requiredFlagValue(args, ++index, flag), flag);
    } else if (flag === "--otp") {
      throw new Error("--otp is not supported for connector action-run because secrets are recorded in action audit metadata.");
    } else if (flag === "--execute") {
      parsed.execute = true;
    } else if (flag === "--dry-run") {
      parsed.execute = false;
    } else if (flag === "--delete-branch") {
      parsed.delete_branch = true;
    } else if (flag === "--generate-notes") {
      parsed.generate_notes = true;
    } else if (flag === "--provenance") {
      parsed.provenance = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown action-run option: ${arg}`);
    } else {
      parsed.args.push(arg);
    }
  }
  return parsed;
}

function connectorActionCommand(input: ConnectorActionRunInput): { executable: ConnectorActionExecutable; args: string[] } {
  return input.connector === "npm" ? npmActionCommand(input) : githubActionCommand(input);
}

function githubActionCommand(input: Exclude<ConnectorActionRunInput, NpmPackagePublishActionRunInput>): { executable: "gh"; args: string[] } {
  if (input.area === "notification" && input.operation === "mark_read") {
    return { executable: "gh", args: ["api", "--method", "PATCH", `notifications/threads/${input.thread}`] };
  }
  if (input.area === "run" && input.operation === "rerun") {
    return { executable: "gh", args: ["run", "rerun", input.target_run_id, "--repo", input.repo] };
  }
  if (input.area === "workflow" && input.operation === "dispatch") {
    const args = ["workflow", "run", input.workflow, "--repo", input.repo];
    if (input.ref) {
      args.push("--ref", input.ref);
    }
    for (const field of input.fields) {
      args.push("-f", `${field.key}=${field.value}`);
    }
    return { executable: "gh", args };
  }
  if (input.area === "deployment" && input.operation === "create_status") {
    const args = [
      "api",
      "--method",
      "POST",
      `repos/${input.repo}/deployments/${input.deployment_id}/statuses`,
      "-f",
      `state=${input.state}`,
    ];
    if (input.environment_url) {
      args.push("-f", `environment_url=${input.environment_url}`);
    }
    if (input.log_url) {
      args.push("-f", `log_url=${input.log_url}`);
    }
    if (input.description) {
      args.push("-f", `description=${input.description}`);
    }
    return { executable: "gh", args };
  }
  if (input.area === "release" && input.operation === "create_draft") {
    const args = ["release", "create", input.tag, "--repo", input.repo, "--draft", "--verify-tag"];
    if (input.title) {
      args.push("--title", input.title);
    }
    if (input.generate_notes) {
      args.push("--generate-notes");
    } else if (input.notes) {
      args.push("--notes", input.notes);
    }
    return { executable: "gh", args };
  }
  if (input.area === "release" && input.operation === "publish_draft") {
    return { executable: "gh", args: ["release", "edit", input.tag, "--repo", input.repo, "--draft=false", "--verify-tag"] };
  }
  if (input.area === "issue" && input.operation === "close") {
    return { executable: "gh", args: ["issue", "close", String(input.number), "--repo", input.repo] };
  }
  if (input.area === "issue" && input.operation === "comment") {
    return { executable: "gh", args: ["issue", "comment", String(input.number), "--repo", input.repo, "--body", input.body] };
  }
  if (input.area === "issue" && input.operation === "label") {
    return { executable: "gh", args: githubLabelCommandArgs("issue", input) };
  }
  if (input.area === "pull_request" && input.operation === "review") {
    const args = ["pr", "review", String(input.number), "--repo", input.repo, reviewEventFlag(input.review_event)];
    if (input.body) {
      args.push("--body", input.body);
    }
    return { executable: "gh", args };
  }
  if (input.area === "pull_request" && input.operation === "comment") {
    return { executable: "gh", args: ["pr", "comment", String(input.number), "--repo", input.repo, "--body", input.body] };
  }
  if (input.area === "pull_request" && input.operation === "label") {
    return { executable: "gh", args: githubLabelCommandArgs("pr", input) };
  }
  const args = ["pr", "merge", String(input.number), "--repo", input.repo, `--${input.method}`];
  if (input.delete_branch) {
    args.push("--delete-branch");
  }
  return { executable: "gh", args };
}

function npmActionCommand(input: NpmPackagePublishActionRunInput): { executable: "npm"; args: string[] } {
  const args = ["publish", "--tag", input.dist_tag];
  if (input.access) {
    args.push("--access", input.access);
  }
  if (input.provenance) {
    args.push("--provenance");
  }
  return { executable: "npm", args };
}

function githubLabelCommandArgs(
  subject: "issue" | "pr",
  input: GitHubIssueLabelActionRunInput | GitHubPullRequestLabelActionRunInput,
): string[] {
  const args = [subject, "edit", String(input.number), "--repo", input.repo];
  for (const label of input.add_labels) {
    args.push("--add-label", label);
  }
  for (const label of input.remove_labels) {
    args.push("--remove-label", label);
  }
  return args;
}

function appendConnectorActionEvent(store: SessionStore, session: SessionRecord, data: JsonObject): number {
  const previousStatus = session.status;
  const eventId = store.appendEvent({
    session_id: session.session_id,
    type: ACTION_EVENT_TYPE,
    data,
  });
  restoreSessionStatus(store, session.session_id, previousStatus);
  return eventId;
}

function appendPermissionDenied(
  store: SessionStore,
  session: SessionRecord,
  input: ConnectorActionRunInput,
  preflight: ConnectorActionPreflightResult,
): number {
  const previousStatus = session.status;
  const eventId = store.appendEvent({
    session_id: session.session_id,
    type: "permission.denied",
    data: {
      preflight: false,
      action_run: true,
      request_class: preflight.request_class,
      decision: {
        status: "deny",
        reason: preflight.reason,
        policy_id: preflight.policy_id,
        policy_kind: preflight.policy_kind,
        review_surface: preflight.review_surface,
        connector: input.connector,
        connector_surface: "first_class",
        connector_action: "mutation",
        connector_area: input.area,
        connector_operation: input.operation,
      },
      arguments: actionEventInput(input),
    } as JsonObject,
  });
  restoreSessionStatus(store, session.session_id, previousStatus);
  return eventId;
}

function restoreSessionStatus(store: SessionStore, sessionId: string, previousStatus: string): void {
  const current = store.getSession(sessionId);
  if (current && current.status !== previousStatus) {
    store.updateSession(sessionId, { status: previousStatus });
  }
}

async function execConnectorCommand(
  command: { executable: ConnectorActionExecutable; args: string[] },
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout_ms: number },
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command.executable, command.args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout_ms,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ exit_code: 0, stdout, stderr });
        return;
      }
      const maybeCode = (error as { code?: unknown }).code;
      resolve({
        exit_code: typeof maybeCode === "number" ? maybeCode : 1,
        stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
        stderr: typeof stderr === "string" ? stderr : String(stderr ?? error.message),
      });
    });
  });
}

function actionEventInput(input: ConnectorActionRunInput): JsonObject {
  const event: JsonObject = {
    connector: input.connector,
    surface: "first_class",
    kind: "mutation",
    area: input.area,
    operation: input.operation,
    execute: input.execute,
    timeout_ms: input.timeout_ms,
  };
  if (input.connector === "npm") {
    event.dist_tag = input.dist_tag;
    event.access = input.access;
    event.provenance = input.provenance;
    return event;
  }
  if (input.area === "notification") {
    event.thread = input.thread;
  } else if (input.area === "run") {
    event.repo = input.repo;
    event.target_run_id = input.target_run_id;
  } else if (input.area === "workflow") {
    event.repo = input.repo;
    event.workflow = input.workflow;
    event.ref = input.ref;
    event.fields = input.fields;
  } else if (input.area === "deployment") {
    event.repo = input.repo;
    event.deployment_id = input.deployment_id;
    event.state = input.state;
    event.environment_url = input.environment_url;
    event.log_url = input.log_url;
    event.description = input.description;
  } else if (input.area === "release") {
    event.repo = input.repo;
    event.tag = input.tag;
    event.draft = input.draft;
    event.verify_tag = input.verify_tag;
    if (input.operation === "create_draft") {
      event.title = input.title;
      event.generate_notes = input.generate_notes;
      event.notes = input.notes;
    }
  } else {
    event.repo = input.repo;
    event.number = input.number;
  }
  if (input.area === "pull_request" && input.operation === "merge") {
    event.method = input.method;
    event.delete_branch = input.delete_branch;
  } else if (input.area === "pull_request" && input.operation === "review") {
    event.review_event = input.review_event;
    event.body = input.body;
  } else if ((input.area === "pull_request" || input.area === "issue") && input.operation === "comment") {
    event.body = input.body;
  } else if ((input.area === "pull_request" || input.area === "issue") && input.operation === "label") {
    event.add_labels = input.add_labels;
    event.remove_labels = input.remove_labels;
  }
  return event;
}

function preflightEventData(preflight: ConnectorActionPreflightResult): JsonObject {
  return {
    status: preflight.status,
    reason: preflight.reason,
    needs_review: preflight.needs_review,
    review_surface: preflight.review_surface,
    policy_id: preflight.policy_id,
    policy_kind: preflight.policy_kind,
  };
}

function parseInlineFlag(arg: string): { flag: string; value: string } | undefined {
  const index = arg.indexOf("=");
  if (!arg.startsWith("--") || index < 0) {
    return undefined;
  }
  return { flag: arg.slice(0, index), value: arg.slice(index + 1) };
}

function requiredFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseRequestClass(value: string): ConnectorActionRequestClass {
  if (
    value === "interactive"
    || value === "tool"
    || value === "verification"
    || value === "compaction"
    || value === "background"
    || value === "reflection"
  ) {
    return value;
  }
  throw new Error(`Unknown request class: ${value}`);
}

function parseMergeMethod(value: string): GitHubPullRequestMergeMethod {
  if (value === "merge" || value === "squash" || value === "rebase") {
    return value;
  }
  throw new Error(`Unknown merge method: ${value}`);
}

function parsePullRequestReviewEvent(value: string | undefined): GitHubPullRequestReviewEvent {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "approve" || normalized === "request_changes" || normalized === "comment") {
    return normalized;
  }
  throw new Error("--event must be approve, request-changes, or comment");
}

function parsePullRequestReviewBody(value: string | undefined, event: GitHubPullRequestReviewEvent): string | undefined {
  if (event === "request_changes" || event === "comment") {
    return parseRequiredText(value, "--body");
  }
  return parseOptionalText(value, "--body");
}

function parseGitHubLabel(value: string, flag: string): string {
  const label = value.trim();
  if (!label || /[\r\n]/.test(label)) {
    throw new Error(`${flag} requires a non-empty single-line label`);
  }
  return label;
}

function parseGitHubLabelMutation(parsed: ParsedConnectorActionRunFlags): { add_labels: string[]; remove_labels: string[] } {
  const addLabels = parsed.add_labels ?? [];
  const removeLabels = parsed.remove_labels ?? [];
  if (!addLabels.length && !removeLabels.length) {
    throw new Error("github label action-run requires --add-label LABEL or --remove-label LABEL.");
  }
  const removeSet = new Set(removeLabels.map((label) => label.toLowerCase()));
  const overlap = addLabels.find((label) => removeSet.has(label.toLowerCase()));
  if (overlap) {
    throw new Error(`Cannot add and remove the same label in one action-run: ${overlap}`);
  }
  return { add_labels: addLabels, remove_labels: removeLabels };
}

function reviewEventFlag(event: GitHubPullRequestReviewEvent): string {
  if (event === "request_changes") {
    return "--request-changes";
  }
  return event === "approve" ? "--approve" : "--comment";
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseRepo(value: string | undefined): string {
  const repo = value?.trim();
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("--repo must be owner/name");
  }
  return repo;
}

function parseThread(value: string | undefined): string {
  const thread = value?.trim();
  if (!thread || !/^[A-Za-z0-9_.:-]+$/.test(thread)) {
    throw new Error("--thread must be a GitHub notification thread id");
  }
  return thread;
}

function parseTargetRunId(value: string | undefined): string {
  const runId = value?.trim();
  if (!runId || !/^[1-9][0-9]*$/.test(runId)) {
    throw new Error("--run-id must be a positive GitHub Actions run id");
  }
  return runId;
}

function parseDeploymentId(value: string | undefined): string {
  const deploymentId = value?.trim();
  if (!deploymentId || !/^[1-9][0-9]*$/.test(deploymentId)) {
    throw new Error("--deployment-id must be a positive GitHub Deployment id");
  }
  return deploymentId;
}

function parseDeploymentStatusState(value: string | undefined): GitHubDeploymentStatusState {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_");
  if (
    normalized === "error"
    || normalized === "failure"
    || normalized === "inactive"
    || normalized === "in_progress"
    || normalized === "queued"
    || normalized === "pending"
    || normalized === "success"
  ) {
    return normalized;
  }
  throw new Error("--state must be success, failure, inactive, in_progress, queued, pending, or error");
}

function parseWorkflow(value: string | undefined): string {
  const workflow = value?.trim();
  if (!workflow || workflow.startsWith("-") || !/^[A-Za-z0-9_.@/+:-]+(?:\.ya?ml)?$/.test(workflow)) {
    throw new Error("--workflow must be a workflow file name or workflow id");
  }
  return workflow;
}

function parseWorkflowRef(value: string | undefined): string | undefined {
  const ref = value?.trim();
  if (ref === undefined || ref === "") {
    return undefined;
  }
  if (ref.startsWith("-") || !/^[A-Za-z0-9._/@:+-]+$/.test(ref)) {
    throw new Error("--ref must be a branch, tag, or commit-ish ref");
  }
  return ref;
}

function parseWorkflowField(value: string): { key: string; value: string } {
  const index = value.indexOf("=");
  if (index <= 0) {
    throw new Error("--field must be key=value");
  }
  const key = value.slice(0, index).trim();
  const fieldValue = value.slice(index + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
    throw new Error("--field key must start with a letter or underscore and contain only letters, numbers, underscores, or dashes");
  }
  return { key, value: fieldValue };
}

function parseReleaseTag(value: string | undefined): string {
  const tag = value?.trim();
  if (!tag || tag.startsWith("-") || !/^[A-Za-z0-9._/+:-]+$/.test(tag)) {
    throw new Error("--tag must be a release tag such as v1.2.3");
  }
  return tag;
}

function parseNpmDistTag(value: string | undefined): string {
  const tag = value?.trim();
  if (!tag || tag.startsWith("-") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    throw new Error("--tag must be an npm dist-tag such as latest or beta");
  }
  return tag;
}

function parseNpmAccess(value: string): NpmPackageAccess {
  if (value === "public" || value === "restricted") {
    return value;
  }
  throw new Error("--access must be public or restricted");
}

function rejectNpmPackagePublishUnsupportedFlags(parsed: ParsedConnectorActionRunFlags): void {
  if (parsed.repo) {
    throw new Error("--repo is not supported for npm package publish action-run.");
  }
  if (parsed.number) {
    throw new Error("--number is not supported for npm package publish action-run.");
  }
  if (parsed.thread) {
    throw new Error("--thread is not supported for npm package publish action-run.");
  }
  if (parsed.run_id) {
    throw new Error("--run-id is not supported for npm package publish action-run.");
  }
  rejectWorkflowDispatchOnlyFlags(parsed, "npm package publish");
  rejectDeploymentCreateStatusOnlyFlags(parsed, "npm package publish");
  rejectPullRequestReviewOnlyFlags(parsed, "npm package publish");
  rejectGitHubLabelOnlyFlags(parsed, "npm package publish");
  if (parsed.title || parsed.notes || parsed.generate_notes) {
    throw new Error("--title, --notes, and --generate-notes are not supported for npm package publish action-run.");
  }
  if (parsed.method) {
    throw new Error("--method is not supported for npm package publish action-run.");
  }
  if (parsed.delete_branch) {
    throw new Error("--delete-branch is not supported for npm package publish action-run.");
  }
}

function rejectWorkflowDispatchOnlyFlags(parsed: ParsedConnectorActionRunFlags, action: string): void {
  if (parsed.workflow || parsed.ref || parsed.fields?.length) {
    throw new Error(`--workflow, --ref, and --field are only supported for github workflow dispatch action-run, not ${action}.`);
  }
}

function rejectDeploymentCreateStatusOnlyFlags(parsed: ParsedConnectorActionRunFlags, action: string): void {
  if (parsed.deployment_id || parsed.state || parsed.environment_url || parsed.log_url || parsed.description) {
    throw new Error(`--deployment-id, --state, --environment-url, --log-url, and --description are only supported for github deployment create-status action-run, not ${action}.`);
  }
}

function rejectPullRequestReviewOnlyFlags(parsed: ParsedConnectorActionRunFlags, action: string): void {
  if (parsed.review_event || parsed.body) {
    throw new Error(`--event and --body are only supported for github pull_request review action-run, not ${action}.`);
  }
}

function rejectPullRequestReviewEventOnlyFlags(parsed: ParsedConnectorActionRunFlags, action: string): void {
  if (parsed.review_event) {
    throw new Error(`--event is only supported for github pull_request review action-run, not ${action}.`);
  }
}

function rejectGitHubLabelOnlyFlags(parsed: ParsedConnectorActionRunFlags, action: string): void {
  if (parsed.add_labels?.length || parsed.remove_labels?.length) {
    throw new Error(`--add-label and --remove-label are only supported for github issue label and github pull_request label action-run, not ${action}.`);
  }
}

function rejectGitHubLabelActionUnsupportedFlags(parsed: ParsedConnectorActionRunFlags): void {
  rejectPullRequestReviewOnlyFlags(parsed, "github label");
  if (parsed.thread) {
    throw new Error("--thread is only supported for github notification mark-read action-run.");
  }
  if (parsed.run_id) {
    throw new Error("--run-id is only supported for github run rerun action-run.");
  }
  if (parsed.tag) {
    throw new Error("--tag is only supported for github release actions and npm package publish action-run.");
  }
  if (parsed.title || parsed.notes || parsed.generate_notes) {
    throw new Error("--title, --notes, and --generate-notes are only supported for github release create-draft action-run.");
  }
  if (parsed.method) {
    throw new Error("--method is only supported for github pull_request merge action-run.");
  }
  if (parsed.delete_branch) {
    throw new Error("--delete-branch is only supported for github pull_request merge action-run.");
  }
  if (parsed.access || parsed.provenance) {
    throw new Error("--access and --provenance are only supported for npm package publish action-run.");
  }
}

function rejectGitHubBodyActionUnsupportedFlags(parsed: ParsedConnectorActionRunFlags): void {
  if (parsed.thread) {
    throw new Error("--thread is only supported for github notification mark-read action-run.");
  }
  if (parsed.run_id) {
    throw new Error("--run-id is only supported for github run rerun action-run.");
  }
  if (parsed.tag) {
    throw new Error("--tag is only supported for github release actions and npm package publish action-run.");
  }
  if (parsed.title || parsed.notes || parsed.generate_notes) {
    throw new Error("--title, --notes, and --generate-notes are only supported for github release create-draft action-run.");
  }
  if (parsed.method) {
    throw new Error("--method is only supported for github pull_request merge action-run.");
  }
  if (parsed.delete_branch) {
    throw new Error("--delete-branch is only supported for github pull_request merge action-run.");
  }
  if (parsed.access || parsed.provenance) {
    throw new Error("--access and --provenance are only supported for npm package publish action-run.");
  }
}

function rejectDeploymentCreateStatusUnsupportedFlags(parsed: ParsedConnectorActionRunFlags): void {
  rejectWorkflowDispatchOnlyFlags(parsed, "github deployment create-status");
  rejectPullRequestReviewOnlyFlags(parsed, "github deployment create-status");
  rejectGitHubLabelOnlyFlags(parsed, "github deployment create-status");
  if (parsed.number) {
    throw new Error("--number is only supported for github pull_request merge/review/comment/label and github issue close/comment/label action-run.");
  }
  if (parsed.thread) {
    throw new Error("--thread is only supported for github notification mark-read action-run.");
  }
  if (parsed.run_id) {
    throw new Error("--run-id is only supported for github run rerun action-run.");
  }
  if (parsed.tag) {
    throw new Error("--tag is only supported for github release actions and npm package publish action-run.");
  }
  if (parsed.title || parsed.notes || parsed.generate_notes) {
    throw new Error("--title, --notes, and --generate-notes are only supported for github release create-draft action-run.");
  }
  if (parsed.method) {
    throw new Error("--method is only supported for github pull_request merge action-run.");
  }
  if (parsed.delete_branch) {
    throw new Error("--delete-branch is only supported for github pull_request merge action-run.");
  }
  if (parsed.access || parsed.provenance) {
    throw new Error("--access and --provenance are only supported for npm package publish action-run.");
  }
}

function rejectWorkflowDispatchUnsupportedFlags(parsed: ParsedConnectorActionRunFlags): void {
  if (parsed.number) {
    throw new Error("--number is only supported for github pull_request merge/review/comment/label and github issue close/comment/label action-run.");
  }
  if (parsed.thread) {
    throw new Error("--thread is only supported for github notification mark-read action-run.");
  }
  if (parsed.run_id) {
    throw new Error("--run-id is only supported for github run rerun action-run.");
  }
  if (parsed.tag) {
    throw new Error("--tag is only supported for github release actions and npm package publish action-run.");
  }
  rejectDeploymentCreateStatusOnlyFlags(parsed, "github workflow dispatch");
  rejectPullRequestReviewOnlyFlags(parsed, "github workflow dispatch");
  rejectGitHubLabelOnlyFlags(parsed, "github workflow dispatch");
  if (parsed.title || parsed.notes || parsed.generate_notes) {
    throw new Error("--title, --notes, and --generate-notes are only supported for github release create-draft action-run.");
  }
  if (parsed.method) {
    throw new Error("--method is only supported for github pull_request merge action-run.");
  }
  if (parsed.delete_branch) {
    throw new Error("--delete-branch is only supported for github pull_request merge action-run.");
  }
  if (parsed.access || parsed.provenance) {
    throw new Error("--access and --provenance are only supported for npm package publish action-run.");
  }
}

function parseRequiredText(value: string | undefined, flag: string): string {
  const text = value?.trim();
  if (!text) {
    throw new Error(`${flag} requires non-empty text`);
  }
  return text;
}

function parseOptionalText(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseRequiredText(value, flag);
}

function parseOptionalUrl(value: string | undefined, flag: string): string | undefined {
  const text = value?.trim();
  if (text === undefined || text === "") {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${flag} must be an HTTP or HTTPS URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${flag} must be an HTTP or HTTPS URL`);
  }
  return parsed.toString();
}

function normalizeConnector(value: string | undefined): string | undefined {
  return normalizeIdentifier(value);
}

function normalizeActionArea(value: string | undefined): "pull_request" | "issue" | "notification" | "run" | "workflow" | "deployment" | "release" | "package" | undefined {
  const normalized = normalizeIdentifier(value);
  if (normalized === "pull-request" || normalized === "pull_request" || normalized === "pr") {
    return "pull_request";
  }
  if (normalized === "issue" || normalized === "issues") {
    return "issue";
  }
  if (normalized === "notification" || normalized === "notifications") {
    return "notification";
  }
  if (normalized === "run" || normalized === "runs" || normalized === "actions-run" || normalized === "workflow-run") {
    return "run";
  }
  if (normalized === "workflow" || normalized === "workflows" || normalized === "workflow-dispatch") {
    return "workflow";
  }
  if (normalized === "deployment" || normalized === "deployments") {
    return "deployment";
  }
  if (normalized === "release" || normalized === "releases") {
    return "release";
  }
  if (normalized === "package" || normalized === "packages" || normalized === "npm-package") {
    return "package";
  }
  return undefined;
}

function normalizeActionOperation(value: string | undefined): string | undefined {
  const normalized = normalizeIdentifier(value);
  if (normalized === "create-draft") {
    return "create_draft";
  }
  if (normalized === "publish-draft") {
    return "publish_draft";
  }
  if (normalized === "create-status") {
    return "create_status";
  }
  if (normalized === "workflow-dispatch") {
    return "dispatch";
  }
  if (normalized === "labels" || normalized === "edit-labels") {
    return "label";
  }
  return normalized === "mark-read" ? "mark_read" : normalized;
}

function normalizeIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return normalized || undefined;
}

function truncateOutput(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.length <= OUTPUT_LIMIT) {
    return value;
  }
  return `${value.slice(0, OUTPUT_LIMIT)}\n[truncated ${value.length - OUTPUT_LIMIT} chars]`;
}

function actionRunUsage(): string {
  return "Usage: action-run github pull_request merge --repo owner/repo --number N [--method merge|squash|rebase] [--execute] OR action-run github pull_request review --repo owner/repo --number N --event approve|request-changes|comment [--body TEXT] [--execute] OR action-run github pull_request comment --repo owner/repo --number N --body TEXT [--execute] OR action-run github pull_request label --repo owner/repo --number N [--add-label LABEL ...] [--remove-label LABEL ...] [--execute] OR action-run github issue close --repo owner/repo --number N [--execute] OR action-run github issue comment --repo owner/repo --number N --body TEXT [--execute] OR action-run github issue label --repo owner/repo --number N [--add-label LABEL ...] [--remove-label LABEL ...] [--execute] OR action-run github notification mark-read --thread THREAD [--execute] OR action-run github run rerun --repo owner/repo --run-id RUN_ID [--execute] OR action-run github workflow dispatch --repo owner/repo --workflow deploy.yml [--ref main] [--field key=value ...] [--execute] OR action-run github deployment create-status --repo owner/repo --deployment-id ID --state success|failure|inactive|in_progress|queued|pending|error [--environment-url URL] [--log-url URL] [--description TEXT] [--execute] OR action-run github release create-draft --repo owner/repo --tag TAG (--notes TEXT|--generate-notes) [--title TITLE] [--execute] OR action-run github release publish-draft --repo owner/repo --tag TAG [--execute] OR action-run npm package publish [--tag latest] [--access public|restricted] [--provenance] [--execute]";
}
