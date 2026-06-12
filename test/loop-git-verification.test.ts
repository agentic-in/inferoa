import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createGoalState, writeGoalState } from "../src/goals/state.js";
import { verifyGitClean } from "../src/loop/git-verification.js";
import { readLoopMetrics } from "../src/loop/metrics.js";
import { readGoalVerificationRecords } from "../src/loop/verification.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("git clean verifier records hard pass for a clean working tree", async () => {
  const fixture = await createFixture("inferoa-loop-git-clean-");
  try {
    await execFileAsync("git", ["init"], { cwd: fixture.workspace.root });
    await writeFile(path.join(fixture.workspace.root, "README.md"), "clean\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: fixture.workspace.root });
    await execFileAsync("git", ["-c", "user.name=Inferoa Test", "-c", "user.email=inferoa@example.test", "commit", "-m", "initial"], { cwd: fixture.workspace.root });

    const verification = await verifyGitClean(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      run_id: "verify_git_clean_pass",
    });

    assert.equal(verification.provider, "checker");
    assert.equal(verification.verifier_role, "git-clean");
    assert.equal(verification.verdict, "pass");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.evidence?.system, "git");
    assert.equal(verification.metrics?.clean, 1);
    assert.equal(verification.metrics?.changed_paths, 0);

    const records = readGoalVerificationRecords(fixture.store, fixture.session.session_id);
    assert.equal(records[0]?.verifier_role, "git-clean");
    const metrics = readLoopMetrics(fixture.store, fixture.workspace);
    assert.equal(metrics.by_system.some((group) => group.key === "git" && group.verification.pass === 1), true);
  } finally {
    await fixture.cleanup();
  }
});

test("git clean verifier records hard failure for local changes", async () => {
  const fixture = await createFixture("inferoa-loop-git-clean-dirty-");
  try {
    await execFileAsync("git", ["init"], { cwd: fixture.workspace.root });
    await writeFile(path.join(fixture.workspace.root, "feature.txt"), "draft\n", "utf8");

    const verification = await verifyGitClean(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      run_id: "verify_git_clean_fail",
    });

    assert.equal(verification.provider, "checker");
    assert.equal(verification.verdict, "fail");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.metrics?.clean, 0);
    assert.equal(verification.metrics?.changed_paths, 1);
    assert.equal(verification.metrics?.untracked_paths, 1);
    assert.match(verification.failure_reason ?? "", /feature\.txt/);
  } finally {
    await fixture.cleanup();
  }
});
async function createFixture(prefix: string): Promise<{
  dir: string;
  stateDir: string;
  store: SessionStore;
  workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  session: ReturnType<SessionStore["createSession"]>;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const store = await SessionStore.open(stateDir);
  const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
  const session = store.createSession(workspace, "git clean verification");
  const goal = createGoalState({ objective: "Verify git state" });
  writeGoalState(store, session.session_id, goal, "goal_git_clean");
  return {
    dir,
    stateDir,
    store,
    workspace,
    session,
    cleanup: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
