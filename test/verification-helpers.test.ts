import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getVerificationHelperDefinition, listVerificationHelperDefinitions } from "../src/loop/verification-helpers.js";

test("verification helper registry exposes current native verifier definitions", () => {
  const definitions = listVerificationHelperDefinitions();
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
  assert.equal(definitions.every((definition) => definition.system && definition.verifier_role && definition.description && definition.run), true);
  assert.equal(getVerificationHelperDefinition("github-notification-status")?.system, "github");
  assert.equal(getVerificationHelperDefinition("github-workflow-run-status")?.system, "github");
  assert.equal(getVerificationHelperDefinition("github-deployment-status")?.system, "github");
  assert.equal(getVerificationHelperDefinition("github-release-status")?.system, "github");
  assert.equal(getVerificationHelperDefinition("git-clean")?.system, "git");
  assert.equal(getVerificationHelperDefinition("http-health")?.verifier_role, "http-health");
  assert.equal(getVerificationHelperDefinition("npm-package-status")?.system, "npm");
  assert.equal(getVerificationHelperDefinition("missing"), undefined);
});

test("provider-specific verifier CLI commands are no longer public surface", () => {
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  for (const command of [
    "verify-github-pr",
    "verify-github-pr-status",
    "verify-github-review-request",
    "verify-github-issue-status",
    "verify-github-notification",
    "verify-github-run",
    "verify-github-workflow",
    "verify-github-deployment",
    "verify-github-release",
    "verify-npm-package",
    "verify-git-clean",
    "verify-http",
  ]) {
    const result = spawnSync(process.execPath, [cliPath, command, "session"], { encoding: "utf8" });
    assert.notEqual(result.status, 0, command);
    assert.match(result.stderr, /was removed/);
    assert.match(result.stderr, /inferoa verify <session>/);
  }
});
