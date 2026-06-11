import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { queueDaemonGoalInWorktree, queueDaemonRunInWorktree } from "../src/daemon/supervisor.js";
import { createGoalState, writeGoalState } from "../src/goals/state.js";
import { adoptLoopWorktree, cleanupLoopWorktrees, createLoopWorktree, listLoopWorktrees, readLoopWorktreeHealth, removeLoopWorktree } from "../src/loop/worktree.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("managed loop worktrees create, list, and remove real git worktrees", async () => {
  const fixture = await createGitFixture("inferoa-loop-worktree-");
  const store = await SessionStore.open(fixture.stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), fixture.workspaceRoot);
    const worktree = await createLoopWorktree(store, workspace, {
      branch: "inferoa/loop/test-create",
    });
    assert.equal(worktree.status, "active");
    assert.equal(worktree.workspace_id, workspace.id);
    assert.match(worktree.path, /\.inferoa-worktrees[/\\][^/\\]+[/\\]wt_/);
    assert.equal(listLoopWorktrees(store, workspace).length, 1);

    const removed = await removeLoopWorktree(store, workspace, worktree.worktree_id);
    assert.equal(removed.status, "removed");
    assert.equal(listLoopWorktrees(store, workspace).length, 0);
    assert.equal(listLoopWorktrees(store, workspace, { includeRemoved: true }).length, 1);
  } finally {
    store.close();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("managed loop worktrees can be adopted into the active checkout", async () => {
  const fixture = await createGitFixture("inferoa-loop-worktree-adopt-");
  const store = await SessionStore.open(fixture.stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), fixture.workspaceRoot);
    const worktree = await createLoopWorktree(store, workspace, {
      branch: "inferoa/loop/test-adopt",
    });
    const worktreeWorkspace = path.join(worktree.path, "repo");
    await writeFile(path.join(worktreeWorkspace, "ADOPT.md"), "adopted change\n", "utf8");
    await execFileAsync("git", ["add", "repo/ADOPT.md"], { cwd: worktree.path });
    await execFileAsync("git", ["commit", "-m", "worktree change"], { cwd: worktree.path });

    const check = await adoptLoopWorktree(store, workspace, worktree.worktree_id, { dry_run: true });
    assert.equal(check.status, "ready");
    assert.equal(store.getManagedWorktree(worktree.worktree_id)?.status, "active");

    const adopted = await adoptLoopWorktree(store, workspace, worktree.worktree_id);
    assert.equal(adopted.status, "adopted");
    assert.equal(adopted.worktree.status, "adopted");
    assert.equal(await readFile(path.join(fixture.workspaceRoot, "ADOPT.md"), "utf8"), "adopted change\n");
    assert.equal(listLoopWorktrees(store, workspace).length, 0);
    assert.equal(listLoopWorktrees(store, workspace, { includeRemoved: true }).length, 1);
    const health = readLoopWorktreeHealth(store, workspace, { cleanup_due_ms: 0 });
    assert.equal(health.counts.adopted, 1);
    assert.equal(health.cleanup_due_count, 1);
    assert.equal(health.items[0]?.reasons.includes("cleanup_due"), true);

    const cleanupCheck = await cleanupLoopWorktrees(store, workspace, { dry_run: true, older_than_ms: 0 });
    assert.equal(cleanupCheck.candidates.length, 1);
    assert.equal(store.getManagedWorktree(worktree.worktree_id)?.status, "adopted");
    const cleanup = await cleanupLoopWorktrees(store, workspace, { older_than_ms: 0 });
    assert.equal(cleanup.removed.length, 1);
    assert.equal(store.getManagedWorktree(worktree.worktree_id)?.status, "removed");
  } finally {
    store.close();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("managed loop worktree adoption refuses tracked dirty checkout", async () => {
  const fixture = await createGitFixture("inferoa-loop-worktree-adopt-dirty-");
  const store = await SessionStore.open(fixture.stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), fixture.workspaceRoot);
    const worktree = await createLoopWorktree(store, workspace, {
      branch: "inferoa/loop/test-adopt-dirty",
    });
    await writeFile(path.join(worktree.path, "repo", "ADOPT.md"), "dirty guard\n", "utf8");
    await execFileAsync("git", ["add", "repo/ADOPT.md"], { cwd: worktree.path });
    await execFileAsync("git", ["commit", "-m", "worktree dirty guard"], { cwd: worktree.path });
    await writeFile(path.join(fixture.workspaceRoot, "README.md"), "# dirty\n", "utf8");

    await assert.rejects(
      adoptLoopWorktree(store, workspace, worktree.worktree_id),
      /tracked changes/,
    );
    assert.equal(store.getManagedWorktree(worktree.worktree_id)?.status, "active");
  } finally {
    store.close();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("daemon worktree queue binds isolated workspace roots to run and goal jobs", async () => {
  const fixture = await createGitFixture("inferoa-loop-worktree-queue-");
  const store = await SessionStore.open(fixture.stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), fixture.workspaceRoot);
    const session = store.createSession(workspace, "goal in worktree");
    const goal = createGoalState({ objective: "Ship isolated background work" });
    writeGoalState(store, session.session_id, goal);
  } finally {
    store.close();
  }

  const run = await queueDaemonRunInWorktree({
    stateDir: fixture.stateDir,
    workspaceRoot: fixture.workspaceRoot,
    prompt: "Run isolated validation",
    configPath: fixture.configPath,
    branch: "inferoa/loop/test-run",
  });
  assert.equal(run.job.kind, "run");
  assert.equal(run.job.metadata.isolation, "worktree");
  assert.equal(run.job.metadata.worktree_id, run.worktree.worktree_id);
  assert.equal(path.dirname(run.job.workspace_root), run.worktree.path);
  assert.equal(path.basename(run.job.workspace_root), "repo");

  const verifyStore = await SessionStore.open(fixture.stateDir);
  try {
    const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), fixture.workspaceRoot);
    const session = verifyStore.listSessions(workspace.id, { includeArchived: true }).find((item) => item.title === "goal in worktree");
    assert.ok(session);
    const goal = await queueDaemonGoalInWorktree({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      sessionId: session.session_id,
      configPath: fixture.configPath,
      branch: "inferoa/loop/test-goal",
    });
    assert.equal(goal.job.kind, "goal");
    assert.equal(goal.job.goal_id, goal.worktree.metadata.goal_id);
    assert.equal(goal.job.metadata.isolation, "worktree");
    assert.equal(goal.job.metadata.worktree_id, goal.worktree.worktree_id);
    assert.equal(path.dirname(goal.job.workspace_root), goal.worktree.path);
    assert.equal(path.basename(goal.job.workspace_root), "repo");

    const tracked = verifyStore.getManagedWorktree(goal.worktree.worktree_id);
    assert.equal(tracked?.session_id, session.session_id);
    assert.equal(tracked?.job_id, goal.job.job_id);
  } finally {
    verifyStore.close();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("worktree command can create, list, and remove managed worktrees", async () => {
  const fixture = await createGitFixture("inferoa-loop-worktree-cli-");
  try {
    const cliPath = path.resolve("dist/src/cli.js");
    const baseArgs = [
      cliPath,
      "--workspace",
      fixture.workspaceRoot,
      "--config",
      fixture.configPath,
      "--state-dir",
      fixture.stateDir,
      "--json",
      "worktree",
    ];
    const created = JSON.parse(
      (await execFileAsync(process.execPath, [...baseArgs, "create", "--branch", "inferoa/loop/test-cli"], { maxBuffer: 1024 * 1024 })).stdout,
    ) as { worktree_id: string; status: string; branch: string; path: string };
    assert.ok(created.worktree_id.startsWith("wt_"));
    assert.equal(created.status, "active");
    assert.equal(created.branch, "inferoa/loop/test-cli");
    const createdPath = created.path;
    await writeFile(path.join(createdPath, "repo", "CLI_ADOPT.md"), "cli adopt\n", "utf8");
    await execFileAsync("git", ["add", "repo/CLI_ADOPT.md"], { cwd: createdPath });
    await execFileAsync("git", ["commit", "-m", "cli worktree change"], { cwd: createdPath });

    const listed = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "list"], { maxBuffer: 1024 * 1024 })).stdout) as {
      worktrees: { worktree_id: string; status: string }[];
    };
    assert.equal(listed.worktrees.length, 1);
    assert.equal(listed.worktrees[0]?.worktree_id, created.worktree_id);

    const checked = JSON.parse(
      (await execFileAsync(process.execPath, [...baseArgs, "adopt", created.worktree_id, "--dry-run"], { maxBuffer: 1024 * 1024 })).stdout,
    ) as { status: string; dry_run: boolean };
    assert.equal(checked.status, "ready");
    assert.equal(checked.dry_run, true);

    const adopted = JSON.parse(
      (await execFileAsync(process.execPath, [...baseArgs, "adopt", created.worktree_id], { maxBuffer: 1024 * 1024 })).stdout,
    ) as { status: string; worktree: { status: string } };
    assert.equal(adopted.status, "adopted");
    assert.equal(adopted.worktree.status, "adopted");
    assert.equal(await readFile(path.join(fixture.workspaceRoot, "CLI_ADOPT.md"), "utf8"), "cli adopt\n");

    const health = JSON.parse((await execFileAsync(process.execPath, [...baseArgs, "health"], { maxBuffer: 1024 * 1024 })).stdout) as {
      counts: { adopted: number };
      items: { worktree: { worktree_id: string } }[];
    };
    assert.equal(health.counts.adopted, 1);
    assert.equal(health.items[0]?.worktree.worktree_id, created.worktree_id);

    const cleanupCheck = JSON.parse(
      (await execFileAsync(process.execPath, [...baseArgs, "cleanup", "--all", "--dry-run"], { maxBuffer: 1024 * 1024 })).stdout,
    ) as { dry_run: boolean; candidates: { worktree_id: string }[] };
    assert.equal(cleanupCheck.dry_run, true);
    assert.equal(cleanupCheck.candidates[0]?.worktree_id, created.worktree_id);

    const cleanup = JSON.parse(
      (await execFileAsync(process.execPath, [...baseArgs, "cleanup", "--all"], { maxBuffer: 1024 * 1024 })).stdout,
    ) as { removed: { worktree_id: string; status: string }[] };
    assert.equal(cleanup.removed[0]?.worktree_id, created.worktree_id);
    assert.equal(cleanup.removed[0]?.status, "removed");

    const removed = JSON.parse(
      (await execFileAsync(process.execPath, [...baseArgs, "remove", created.worktree_id], { maxBuffer: 1024 * 1024 })).stdout,
    ) as { worktree_id: string; status: string };
    assert.equal(removed.worktree_id, created.worktree_id);
    assert.equal(removed.status, "removed");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

async function createGitFixture(prefix: string): Promise<{ dir: string; workspaceRoot: string; stateDir: string; configPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const gitRoot = path.join(dir, "repo-root");
  const workspaceRoot = path.join(gitRoot, "repo");
  const stateDir = path.join(dir, "state");
  const configPath = path.join(workspaceRoot, ".inferoa", "config.yaml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(gitRoot, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: gitRoot });
  await execFileAsync("git", ["config", "user.email", "inferoa@example.test"], { cwd: gitRoot });
  await execFileAsync("git", ["config", "user.name", "Inferoa Test"], { cwd: gitRoot });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "README.md"), "# fixture\n", "utf8");
  await writeFile(configPath, YAML.stringify(DEFAULT_CONFIG), "utf8");
  await execFileAsync("git", ["add", "repo/README.md"], { cwd: gitRoot });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: gitRoot });
  return { dir, workspaceRoot, stateDir, configPath };
}
