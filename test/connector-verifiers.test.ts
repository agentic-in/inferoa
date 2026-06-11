import test from "node:test";
import assert from "node:assert/strict";
import { getConnectorVerifierDefinition, listConnectorVerifierDefinitions } from "../src/loop/connector-verifiers.js";

test("connector verifier registry exposes current native verifier definitions", () => {
  const definitions = listConnectorVerifierDefinitions();
  assert.deepEqual(definitions.map((definition) => definition.id), [
    "github-pr-checks",
    "github-pr-status",
    "github-review-request",
    "github-issue-status",
    "github-notification-status",
    "github-actions-run",
    "github-workflow-run-status",
    "github-deployment-status",
    "github-release-status",
    "git-clean",
    "http-health",
    "npm-package-status",
  ]);
  assert.equal(definitions.every((definition) => definition.connector && definition.verifier_role && definition.cli_command && definition.tui_action), true);
  assert.equal(getConnectorVerifierDefinition("github-notification-status")?.cli_command, "verify-github-notification");
  assert.equal(getConnectorVerifierDefinition("github-workflow-run-status")?.cli_command, "verify-github-workflow");
  assert.equal(getConnectorVerifierDefinition("github-deployment-status")?.cli_command, "verify-github-deployment");
  assert.equal(getConnectorVerifierDefinition("github-release-status")?.cli_command, "verify-github-release");
  assert.equal(getConnectorVerifierDefinition("git-clean")?.connector, "git");
  assert.equal(getConnectorVerifierDefinition("http-health")?.verifier_role, "http-health");
  assert.equal(getConnectorVerifierDefinition("npm-package-status")?.cli_command, "verify-npm-package");
  assert.equal(getConnectorVerifierDefinition("missing"), undefined);
});
