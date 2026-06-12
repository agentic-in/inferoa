import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyExternalMutationCommand,
  classifyExternalMutationToolCall,
  decideExternalMutationPolicy,
  listExternalMutationPolicyDefinitions,
} from "../src/tools/external-mutation-policy.js";

test("external mutation policy registry exposes only unattended CLI mutation gates", () => {
  const definitions = listExternalMutationPolicyDefinitions();
  assert.deepEqual(definitions, [
    {
      id: "github-cli-mutation",
      system: "github",
      surface: "cli",
      command: "gh",
      tool_names: ["run_command"],
      kind: "mutation",
      request_classes: ["background", "verification"],
      decision: "deny",
      review_surface: "loop inbox external_action_approval",
      description: "Deny known mutating GitHub CLI operations in unattended request classes.",
    },
    {
      id: "npm-cli-package-publish",
      system: "npm",
      surface: "cli",
      command: "npm",
      tool_names: ["run_command"],
      kind: "mutation",
      request_classes: ["background", "verification"],
      decision: "deny",
      review_surface: "loop inbox external_action_approval",
      description: "Deny npm package publish commands in unattended request classes.",
    },
  ]);

  definitions[0]!.tool_names.push("mutated");
  assert.deepEqual(listExternalMutationPolicyDefinitions()[0]?.tool_names, ["run_command"]);
});

test("external mutation classifier identifies GitHub CLI mutations structurally", () => {
  assert.deepEqual(classifyExternalMutationCommand("gh issue close 42 --repo owner/repo"), {
    system: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "issue",
    operation: "close",
  });
  assert.deepEqual(classifyExternalMutationCommand("GH_TOKEN=x sudo gh api repos/owner/repo/issues/42 --method PATCH -f title=updated"), {
    system: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "api",
    operation: "patch",
  });
  assert.equal(classifyExternalMutationCommand("gh api notifications -F per_page=25 --method GET"), undefined);
  assert.equal(classifyExternalMutationCommand("gh issue view 42 --repo owner/repo"), undefined);
  assert.equal(classifyExternalMutationCommand("gh pr checks 17 --repo owner/repo && gh run view 9001 --log"), undefined);
});

test("external mutation classifier identifies npm package publish structurally", () => {
  assert.deepEqual(classifyExternalMutationCommand("npm publish --tag latest"), {
    system: "npm",
    surface: "cli",
    command: "npm",
    kind: "mutation",
    area: "package",
    operation: "publish",
  });
  assert.equal(classifyExternalMutationCommand("npm publish --dry-run"), undefined);
  assert.equal(classifyExternalMutationCommand("npm publish --dry-run=true"), undefined);
  assert.equal(classifyExternalMutationCommand("npm view inferoa version"), undefined);
});

test("external mutation classifier routes supported tool calls through the policy registry", () => {
  assert.deepEqual(classifyExternalMutationToolCall("run_command", { command: "gh pr merge 17 --repo owner/repo" }), {
    system: "github",
    surface: "cli",
    command: "gh",
    kind: "mutation",
    area: "pr",
    operation: "merge",
  });
  assert.deepEqual(classifyExternalMutationToolCall("run_command", { command: "npm publish --tag beta" }), {
    system: "npm",
    surface: "cli",
    command: "npm",
    kind: "mutation",
    area: "package",
    operation: "publish",
  });
  assert.equal(classifyExternalMutationToolCall("run_command", { command: "gh pr view 17 --repo owner/repo" }), undefined);
  assert.equal(classifyExternalMutationToolCall("skill_read", { command: "gh pr merge 17" }), undefined);
});

test("external mutation policy denies unattended mutations and allows interactive mutations", () => {
  const action = classifyExternalMutationCommand("gh workflow run deploy.yml --repo owner/repo -f env=prod");
  assert.ok(action);
  const denied = decideExternalMutationPolicy(action, "background");
  assert.equal(denied.status, "deny");
  assert.equal(denied.needs_review, true);
  assert.equal(denied.policy_id, "github-cli-mutation");
  assert.equal(denied.policy_kind, "external_mutation");
  assert.equal(denied.review_surface, "loop inbox external_action_approval");

  const allowed = decideExternalMutationPolicy(action, "interactive");
  assert.equal(allowed.status, "allow");
  assert.equal(allowed.needs_review, false);
});
