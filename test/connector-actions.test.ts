import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyConnectorCommandAction,
  classifyConnectorToolAction,
  listConnectorActionPolicyDefinitions,
  preflightConnectorAction,
} from "../src/tools/connector-actions.js";

test("connector action policy registry exposes unattended mutation gates", () => {
  const definitions = listConnectorActionPolicyDefinitions();
  assert.deepEqual(definitions, [
    {
      id: "github-cli-mutation",
      connector: "github",
      surface: "cli",
      command: "gh",
      tool_names: ["run_command"],
      kind: "mutation",
      request_classes: ["background", "verification"],
      decision: "deny",
      review_surface: "loop inbox action_review",
      description: "Deny known mutating GitHub CLI operations in unattended request classes.",
    },
    {
      id: "npm-cli-package-publish",
      connector: "npm",
      surface: "cli",
      command: "npm",
      tool_names: ["run_command"],
      kind: "mutation",
      request_classes: ["background", "verification"],
      decision: "deny",
      review_surface: "loop inbox action_review",
      description: "Deny npm package publish commands in unattended request classes.",
    },
    {
      id: "first-class-connector-mutation",
      connector: "*",
      surface: "first_class",
      tool_names: [],
      kind: "mutation",
      request_classes: ["background", "verification"],
      decision: "deny",
      review_surface: "loop inbox action_review",
      description: "Deny first-class connector mutations in unattended request classes before execution.",
    },
  ]);

  definitions[0]!.tool_names.push("mutated");
  assert.deepEqual(listConnectorActionPolicyDefinitions()[0]?.tool_names, ["run_command"]);
});

test("connector action classifier identifies GitHub CLI mutations structurally", () => {
  assert.deepEqual(classifyConnectorCommandAction("gh issue close 42 --repo owner/repo"), {
    connector: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "issue",
    operation: "close",
  });
  assert.deepEqual(classifyConnectorCommandAction("GH_TOKEN=x sudo gh api repos/owner/repo/issues/42 --method PATCH -f title=updated"), {
    connector: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "api",
    operation: "patch",
  });
  assert.equal(classifyConnectorCommandAction("gh api notifications -F per_page=25 --method GET"), undefined);
  assert.equal(classifyConnectorCommandAction("gh api --method GET repos/owner/repo/notifications -F participating=true"), undefined);
  assert.deepEqual(classifyConnectorCommandAction("gh api repos/owner/repo/issues/42 -F title=updated"), {
    connector: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "api",
    operation: "post",
  });
  assert.deepEqual(classifyConnectorCommandAction("gh api repos/owner/repo/issues/42 -F title=updated -XPATCH"), {
    connector: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "api",
    operation: "patch",
  });
  assert.deepEqual(classifyConnectorCommandAction("gh workflow run deploy.yml --repo owner/repo -f env=prod"), {
    connector: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "workflow",
    operation: "run",
  });
  assert.deepEqual(classifyConnectorCommandAction("gh api --method POST repos/owner/repo/deployments/4242/statuses -f state=success"), {
    connector: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "api",
    operation: "post",
  });
  assert.equal(classifyConnectorCommandAction("gh issue view 42 --repo owner/repo"), undefined);
  assert.equal(classifyConnectorCommandAction("gh pr checks 17 --repo owner/repo && gh run view 9001 --log"), undefined);
});

test("connector action classifier identifies npm package publish structurally", () => {
  assert.deepEqual(classifyConnectorCommandAction("npm publish --tag latest"), {
    connector: "npm",
    surface: "cli",
    command: "npm",
    kind: "mutation",
    area: "package",
    operation: "publish",
  });
  assert.deepEqual(classifyConnectorCommandAction("NPM_TOKEN=x command npm publish --provenance"), {
    connector: "npm",
    surface: "cli",
    command: "npm",
    kind: "mutation",
    area: "package",
    operation: "publish",
  });
  assert.equal(classifyConnectorCommandAction("npm publish --dry-run"), undefined);
  assert.equal(classifyConnectorCommandAction("npm publish --dry-run=true"), undefined);
  assert.equal(classifyConnectorCommandAction("npm view inferoa version"), undefined);
});

test("connector action classifier routes supported tool calls through the policy registry", () => {
  assert.deepEqual(classifyConnectorToolAction("run_command", { command: "gh pr merge 17 --repo owner/repo" }), {
    connector: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "pr",
    operation: "merge",
  });
  assert.deepEqual(classifyConnectorToolAction("run_command", { command: "gh pr review 17 --repo owner/repo --approve" }), {
    connector: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "pr",
    operation: "review",
  });
  assert.deepEqual(classifyConnectorToolAction("run_command", { command: "gh issue comment 17 --repo owner/repo --body hi" }), {
    connector: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "issue",
    operation: "comment",
  });
  assert.deepEqual(classifyConnectorToolAction("run_command", { command: "gh pr comment 17 --repo owner/repo --body hi" }), {
    connector: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "pr",
    operation: "comment",
  });
  assert.deepEqual(classifyConnectorToolAction("run_command", { command: "gh issue edit 17 --repo owner/repo --add-label triage" }), {
    connector: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "issue",
    operation: "edit",
  });
  assert.deepEqual(classifyConnectorToolAction("run_command", { command: "gh pr edit 17 --repo owner/repo --remove-label draft" }), {
    connector: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "pr",
    operation: "edit",
  });
  assert.deepEqual(classifyConnectorToolAction("run_command", { command: "npm publish --tag beta" }), {
    connector: "npm",
    surface: "cli",
    command: "npm",
    kind: "mutation",
    area: "package",
    operation: "publish",
  });
  assert.equal(classifyConnectorToolAction("run_command", { command: "gh pr view 17 --repo owner/repo" }), undefined);
  assert.equal(classifyConnectorToolAction("skill_read", { command: "gh pr merge 17" }), undefined);
});

test("connector action preflight denies unattended first-class mutations without execution", () => {
  const result = preflightConnectorAction({
    connector: "github",
    surface: "first_class",
    kind: "mutation",
    area: "pull_request",
    operation: "merge",
    request_class: "background",
  });
  assert.equal(result.status, "deny");
  assert.equal(result.needs_review, true);
  assert.equal(result.policy_id, "first-class-connector-mutation");
  assert.equal(result.action.connector, "github");
  assert.equal(result.action.surface, "first_class");
  assert.equal(result.action.area, "pull-request");
  assert.equal(result.action.operation, "merge");
  assert.equal(result.review_surface, "loop inbox action_review");
});

test("connector action preflight allows reads and interactive mutations", () => {
  assert.equal(preflightConnectorAction({
    connector: "github",
    surface: "first_class",
    kind: "read",
    area: "pull_request",
    operation: "view",
    request_class: "background",
  }).status, "allow");

  assert.equal(preflightConnectorAction({
    connector: "github",
    surface: "first_class",
    kind: "mutation",
    area: "pull_request",
    operation: "merge",
    request_class: "interactive",
  }).status, "allow");
});

test("connector action preflight reuses command mutation classification", () => {
  const result = preflightConnectorAction({
    command: "gh issue close 42 --repo owner/repo",
    request_class: "verification",
  });
  assert.equal(result.status, "deny");
  assert.equal(result.policy_id, "github-cli-mutation");
  assert.equal(result.action.connector, "github");
  assert.equal(result.action.surface, "cli");
  assert.equal(result.action.area, "issue");
  assert.equal(result.action.operation, "close");
});

test("connector action preflight denies unattended npm publish commands", () => {
  const result = preflightConnectorAction({
    command: "npm publish --tag latest",
    request_class: "verification",
  });
  assert.equal(result.status, "deny");
  assert.equal(result.policy_id, "npm-cli-package-publish");
  assert.equal(result.action.connector, "npm");
  assert.equal(result.action.surface, "cli");
  assert.equal(result.action.area, "package");
  assert.equal(result.action.operation, "publish");
});

test("connector action preflight treats unclassified connector commands as read preflights", () => {
  const result = preflightConnectorAction({
    command: "gh issue view 42 --repo owner/repo",
    request_class: "background",
  });
  assert.equal(result.status, "allow");
  assert.equal(result.needs_review, false);
  assert.equal(result.action.connector, "github");
  assert.equal(result.action.surface, "cli");
  assert.equal(result.action.command, "gh");
  assert.equal(result.action.kind, "read");
});
