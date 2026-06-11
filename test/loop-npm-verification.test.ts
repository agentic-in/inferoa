import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createGoalState, writeGoalState } from "../src/goals/state.js";
import { readLoopMetrics } from "../src/loop/metrics.js";
import { verifyNpmPackageStatus } from "../src/loop/npm-verification.js";
import { readGoalVerificationRecords } from "../src/loop/verification.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("npm package verifier records hard pass for published version and dist-tag", async () => {
  const fixture = await createFixture("inferoa-loop-npm-verification-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeNpm(fixture.npmPath, {
      versions: ["0.1.0", "1.2.3"],
      "dist-tags": { latest: "1.2.3", beta: "1.3.0-beta.1" },
    });
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyNpmPackageStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      package_name: "@scope/pkg",
      version: "1.2.3",
      tag: "latest",
      run_id: "verify_npm_package_pass",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verifier_role, "npm-package-status");
    assert.equal(verification.verdict, "pass");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.evidence?.connector, "npm");
    assert.equal(verification.evidence?.package_name, "@scope/pkg");
    assert.equal(verification.evidence?.version, "1.2.3");
    assert.equal(verification.evidence?.tag, "latest");
    assert.equal(verification.evidence?.tag_version, "1.2.3");
    assert.equal(verification.metrics?.version_present, 1);
    assert.equal(verification.metrics?.tag_match, 1);

    const records = readGoalVerificationRecords(fixture.store, fixture.session.session_id);
    assert.equal(records[0]?.verifier_role, "npm-package-status");
    const metrics = readLoopMetrics(fixture.store, fixture.workspace);
    assert.equal(metrics.by_connector.some((group) => group.key === "npm" && group.verification.pass === 1), true);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("npm package verifier records hard failure for missing version or mismatched dist-tag", async () => {
  const fixture = await createFixture("inferoa-loop-npm-verification-fail-");
  const originalPath = process.env.PATH;
  try {
    await writeFakeNpm(fixture.npmPath, {
      versions: ["1.2.2", "1.2.3"],
      "dist-tags": { latest: "1.2.2" },
    });
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ""}`;
    const verification = await verifyNpmPackageStatus(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      package_name: "pkg",
      version: "1.2.3",
      tag: "latest",
      run_id: "verify_npm_package_fail",
    });

    assert.equal(verification.provider, "connector");
    assert.equal(verification.verdict, "fail");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.metrics?.version_present, 1);
    assert.equal(verification.metrics?.tag_match, 0);
    assert.match(verification.failure_reason ?? "", /dist-tag latest points to 1\.2\.2/);
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("verify-npm-package command records npm connector verification", async () => {
  const fixture = await createFixture("inferoa-loop-npm-verification-cli-");
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(fixture.workspace.root, ".inferoa", "config.yaml"), YAML.stringify(DEFAULT_CONFIG), "utf8");
    await writeFakeNpm(fixture.npmPath, {
      versions: ["0.14.1"],
      "dist-tags": { latest: "0.14.1" },
    });
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
      "verify-npm-package",
      fixture.session.session_id,
      "inferoa",
      "--version",
      "0.14.1",
      "--tag",
      "latest",
    ], { maxBuffer: 1024 * 1024 })).stdout) as {
      verification: {
        provider?: string;
        verdict?: string;
        verifier_role?: string;
        evidence?: { tag_version?: string };
      };
    };

    assert.equal(result.verification.provider, "connector");
    assert.equal(result.verification.verdict, "pass");
    assert.equal(result.verification.verifier_role, "npm-package-status");
    assert.equal(result.verification.evidence?.tag_version, "0.14.1");
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

async function createFixture(prefix: string): Promise<{
  dir: string;
  stateDir: string;
  workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  store: SessionStore;
  session: ReturnType<SessionStore["createSession"]>;
  binDir: string;
  npmPath: string;
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
  const session = store.createSession(workspace, "npm verifier");
  writeGoalState(store, session.session_id, createGoalState({ objective: "Verify npm package publication" }), "seed");
  return {
    dir,
    stateDir,
    workspace,
    store,
    session,
    binDir,
    npmPath: path.join(binDir, "npm"),
    cleanup: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function writeFakeNpm(npmPath: string, payload: unknown): Promise<void> {
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
