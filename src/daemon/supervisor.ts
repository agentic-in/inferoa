import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/config.js";
import { resolveWorkspace } from "../session/workspace.js";
import { SessionStore, type SupervisorJob } from "../session/store.js";
import { Runtime } from "../runtime.js";
import type { JsonObject } from "../types.js";
import { homeStateDir, pathExists } from "../util/fs.js";
import { randomId } from "../util/hash.js";
import { readGoalState } from "../goals/state.js";
import { buildGoalWorkPrompt } from "../goals/supervisor-prompts.js";
import { DEFAULT_GOAL_SUPERVISOR_MAX_ITERATIONS, runGoalSupervisor } from "../goals/supervisor.js";

export interface DaemonStatus {
  pid?: number;
  alive: boolean;
  pid_file: string;
  jobs: SupervisorJob[];
}

export function daemonPidFile(stateDir?: string): string {
  return path.join(resolvedStateDir(stateDir), "daemon.json");
}

export async function startDaemon(options: { stateDir?: string; foreground?: boolean }): Promise<DaemonStatus> {
  if (options.foreground) {
    await serveDaemon({ stateDir: options.stateDir });
    return daemonStatus(options.stateDir);
  }
  const status = await daemonStatus(options.stateDir);
  if (status.alive) {
    return status;
  }
  const servePath = fileURLToPath(new URL("./serve.js", import.meta.url));
  const args = [servePath];
  if (options.stateDir) {
    args.push("--state-dir", options.stateDir);
  }
  const env = { ...process.env };
  if (options.stateDir) {
    env.INFEROA_STATE_DIR = options.stateDir;
  } else if (!env.INFEROA_STATE_DIR) {
    delete env.INFEROA_STATE_DIR;
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 300));
  return daemonStatus(options.stateDir);
}

export async function daemonStatus(stateDir?: string): Promise<DaemonStatus> {
  const store = await SessionStore.open(stateDir);
  try {
    const pidFile = daemonPidFile(stateDir);
    let pid: number | undefined;
    if (await pathExists(pidFile)) {
      const data = JSON.parse(await fs.readFile(pidFile, "utf8")) as { pid?: number };
      pid = data.pid;
    }
    return {
      pid,
      alive: pid ? processAlive(pid) : false,
      pid_file: pidFile,
      jobs: store.listSupervisorJobs(),
    };
  } finally {
    store.close();
  }
}

export async function queueDaemonRun(options: {
  stateDir?: string;
  workspaceRoot: string;
  sessionId?: string;
  prompt: string;
  title?: string;
  configPath?: string;
}): Promise<SupervisorJob> {
  const configPath = daemonConfigPath(options.workspaceRoot, options.stateDir, options.configPath);
  const { config } = await loadConfig(options.workspaceRoot, configPath);
  const workspace = await resolveWorkspace(options.workspaceRoot, config, options.workspaceRoot);
  const store = await SessionStore.open(options.stateDir);
  try {
    const session = options.sessionId
      ? store.getSession(options.sessionId) ?? store.findSessionByPrefix(workspace.id, options.sessionId)
      : store.createSession(workspace, options.title ?? `daemon:${options.prompt.slice(0, 40)}`);
    if (!session) {
      throw new Error(`Unknown session for daemon run: ${options.sessionId}`);
    }
    return store.createSupervisorJob(session.session_id, workspace.root, options.prompt, {
      metadata: metadataWithConfigPath({}, configPath),
    });
  } finally {
    store.close();
  }
}

export async function queueDaemonGoal(options: {
  stateDir?: string;
  workspaceRoot: string;
  sessionId: string;
  prompt?: string;
  maxIterations?: number;
  configPath?: string;
}): Promise<SupervisorJob> {
  const configPath = daemonConfigPath(options.workspaceRoot, options.stateDir, options.configPath);
  const { config } = await loadConfig(options.workspaceRoot, configPath);
  const workspace = await resolveWorkspace(options.workspaceRoot, config, options.workspaceRoot);
  const store = await SessionStore.open(options.stateDir);
  try {
    const session = store.getSession(options.sessionId) ?? store.findSessionByPrefix(workspace.id, options.sessionId);
    if (!session) {
      throw new Error(`Unknown session for daemon goal: ${options.sessionId}`);
    }
    const goal = readGoalState(store, session.session_id);
    if (!goal || goal.goal.status === "complete" || goal.goal.status === "dropped") {
      throw new Error("No active goal is available for daemon supervision.");
    }
    return store.createSupervisorJob(session.session_id, workspace.root, options.prompt ?? buildGoalWorkPrompt(goal.goal.objective), {
      kind: "goal",
      goal_id: goal.goal.id,
      metadata: metadataWithConfigPath({ max_iterations: options.maxIterations ?? 1000 }, configPath),
    });
  } finally {
    store.close();
  }
}

export async function cancelDaemonJob(stateDir: string | undefined, jobId: string): Promise<SupervisorJob> {
  const store = await SessionStore.open(stateDir);
  try {
    const job = store.getSupervisorJob(jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    if (job.status === "queued") {
      store.updateSupervisorJob(jobId, { status: "cancelled" });
      store.appendEvent({
        session_id: job.session_id,
        type: "daemon.job.cancelled",
        data: { job_id: jobId },
      });
      return store.getSupervisorJob(jobId)!;
    }
    if (["complete", "failed", "cancelled"].includes(job.status)) {
      store.appendEvent({
        session_id: job.session_id,
        type: "daemon.job.cancel_observed",
        data: { job_id: jobId, status: job.status },
      });
      return job;
    }
    store.updateSupervisorJob(jobId, { status: "cancel_requested" });
    store.appendEvent({
      session_id: job.session_id,
      type: "daemon.job.cancel_requested",
      data: { job_id: jobId },
    });
    return store.getSupervisorJob(jobId)!;
  } finally {
    store.close();
  }
}

export async function detachDaemonJob(stateDir: string | undefined, jobId: string): Promise<SupervisorJob> {
  const store = await SessionStore.open(stateDir);
  try {
    const job = store.getSupervisorJob(jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    if (job.status === "queued" || job.status === "running") {
      store.updateSupervisorJob(jobId, { status: "detached" });
      store.appendEvent({ session_id: job.session_id, type: "daemon.job.detached", data: { job_id: jobId } });
    } else {
      store.appendEvent({ session_id: job.session_id, type: "daemon.job.detach_observed", data: { job_id: jobId, status: job.status } });
    }
    return store.getSupervisorJob(jobId)!;
  } finally {
    store.close();
  }
}

export async function attachDaemonJob(
  stateDir: string | undefined,
  jobId: string,
  options: { follow?: boolean; pollMs?: number } = {},
): Promise<{ job: SupervisorJob; events: unknown[] }> {
  const store = await SessionStore.open(stateDir);
  try {
    let job = store.getSupervisorJob(jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    store.appendEvent({ session_id: job.session_id, type: "daemon.job.attached", data: { job_id: jobId } });
    if (job.status === "detached") {
      store.updateSupervisorJob(jobId, { status: "running" });
      job = store.getSupervisorJob(jobId)!;
    }
    if (!options.follow) {
      return { job, events: store.listEvents(job.session_id, 80) };
    }
    let seen = 0;
    while (true) {
      job = store.getSupervisorJob(jobId)!;
      const events = store.listEvents(job.session_id);
      const next = events.filter((event) => (event.id ?? 0) > seen);
      for (const event of next) {
        console.log(`${event.created_at} ${event.type} ${JSON.stringify(event.data)}`);
        seen = Math.max(seen, event.id ?? seen);
      }
      if (["complete", "failed", "cancelled"].includes(job.status)) {
        return { job, events: store.listEvents(job.session_id, 80) };
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
    }
  } finally {
    store.close();
  }
}

export async function serveDaemon(options: { stateDir?: string; once?: boolean } = {}): Promise<void> {
  const stateDir = options.stateDir ?? process.env.INFEROA_STATE_DIR;
  const store = await SessionStore.open(stateDir);
  const pidFile = daemonPidFile(stateDir);
  await fs.mkdir(path.dirname(pidFile), { recursive: true });
  await fs.writeFile(pidFile, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2));
  try {
    while (true) {
      const queued = [...store.listSupervisorJobs("queued"), ...store.listSupervisorJobs("detached")];
      for (const job of queued) {
        const latest = store.getSupervisorJob(job.job_id);
        if (!latest || (latest.status !== "queued" && latest.status !== "detached")) {
          continue;
        }
        await runJob(store, latest, stateDir);
      }
      if (options.once) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    store.close();
  }
}

function resolvedStateDir(stateDir?: string): string {
  return stateDir || process.env.INFEROA_STATE_DIR || homeStateDir();
}

async function runJob(store: SessionStore, job: SupervisorJob, stateDir?: string): Promise<void> {
  if (job.status === "cancelled") {
    return;
  }
  if (job.kind === "goal") {
    await runGoalJob(store, job, stateDir);
    return;
  }
  const runId = randomId("run");
  store.updateSupervisorJob(job.job_id, { status: "running", run_id: runId });
  store.appendEvent({
    session_id: job.session_id,
    run_id: runId,
    type: "daemon.job.started",
    data: { job_id: job.job_id },
  });
  try {
    const { config } = await loadConfig(job.workspace_root, configPathFromMetadata(job.metadata));
    const workspace = await resolveWorkspace(job.workspace_root, config, job.workspace_root);
    const runtime = new Runtime(config, workspace, store);
    await runtime.run({
      prompt: job.prompt,
      session_id: job.session_id,
      client_id: `daemon:${process.pid}`,
      owner_kind: "daemon",
      request_class: "background",
    });
    let after = store.getSupervisorJob(job.job_id);
    if (after?.status !== "cancel_requested") {
      await runGoalSupervisor({
        store,
        sessionId: job.session_id,
        supervisor: "daemon",
        maxIterations: numberMeta(job.metadata.goal_max_iterations, DEFAULT_GOAL_SUPERVISOR_MAX_ITERATIONS),
        workRequestClass: "background",
        shouldContinue: () => {
          const latest = store.getSupervisorJob(job.job_id);
          return Boolean(latest && latest.status !== "cancel_requested" && latest.status !== "cancelled");
        },
        runTurn: async (request) =>
          await runtime.run({
            prompt: request.prompt,
            session_id: job.session_id,
            client_id: `daemon:${process.pid}:goal-auto`,
            owner_kind: "daemon",
            request_class: request.requestClass,
            visibility: request.visibility,
            run_id: request.runId,
          }),
      });
    }
    after = store.getSupervisorJob(job.job_id);
    if (after?.status === "cancel_requested") {
      store.updateSupervisorJob(job.job_id, { status: "cancelled" });
      store.appendEvent({ session_id: job.session_id, run_id: runId, type: "daemon.job.cancelled", data: { job_id: job.job_id } });
    } else {
      store.updateSupervisorJob(job.job_id, { status: "complete" });
      store.appendEvent({ session_id: job.session_id, run_id: runId, type: "daemon.job.complete", data: { job_id: job.job_id } });
    }
  } catch (error) {
    store.updateSupervisorJob(job.job_id, { status: "failed" });
    store.appendEvent({
      session_id: job.session_id,
      run_id: runId,
      type: "daemon.job.failed",
      data: { job_id: job.job_id, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function runGoalJob(store: SessionStore, job: SupervisorJob, stateDir?: string): Promise<void> {
  const startedRunId = randomId("run");
  store.updateSupervisorJob(job.job_id, { status: "running", run_id: startedRunId });
  store.appendEvent({
    session_id: job.session_id,
    run_id: startedRunId,
    type: "goal.supervisor.continued",
    data: { job_id: job.job_id, goal_id: job.goal_id, iteration: job.iteration },
  });
  try {
    const { config } = await loadConfig(job.workspace_root, configPathFromMetadata(job.metadata));
    const workspace = await resolveWorkspace(job.workspace_root, config, job.workspace_root);
    const runtime = new Runtime(config, workspace, store);
    let currentIteration = job.iteration;
    const outcome = await runGoalSupervisor({
      store,
      sessionId: job.session_id,
      supervisor: "daemon",
      maxIterations: numberMeta(job.metadata.max_iterations, DEFAULT_GOAL_SUPERVISOR_MAX_ITERATIONS),
      workRequestClass: "background",
      shouldContinue: () => {
        const latest = store.getSupervisorJob(job.job_id);
        return Boolean(latest && latest.status !== "cancel_requested" && latest.status !== "cancelled");
      },
      onIteration: (iteration) => {
        currentIteration = iteration;
        store.updateSupervisorJob(job.job_id, { status: "running", iteration });
      },
      runTurn: async (request) => {
        const run = await runtime.run({
          prompt: request.prompt,
          session_id: job.session_id,
          client_id: `daemon:${process.pid}:goal`,
          owner_kind: "daemon",
          request_class: request.requestClass,
          visibility: request.visibility,
          run_id: request.runId,
        });
        store.updateSupervisorJob(job.job_id, { run_id: run.run_id, iteration: currentIteration });
        return run;
      },
    });
    const latestJob = store.getSupervisorJob(job.job_id);
    if (!latestJob || latestJob.status === "cancel_requested" || latestJob.status === "cancelled" || outcome.status === "stopped") {
      store.updateSupervisorJob(job.job_id, { status: "cancelled", iteration: currentIteration });
      store.appendEvent({ session_id: job.session_id, run_id: outcome.run_id ?? startedRunId, type: "daemon.job.cancelled", data: { job_id: job.job_id } });
      return;
    }
    if (outcome.status === "idle") {
      const state = readGoalState(store, job.session_id);
      if (state && state.goal.status !== "complete" && state.goal.status !== "dropped") {
        store.updateSupervisorJob(job.job_id, {
          status: "paused",
          iteration: currentIteration,
          metadata: { ...latestJob.metadata, pause_reason: state.goal.status },
        });
        store.appendEvent({
          session_id: job.session_id,
          run_id: outcome.run_id ?? startedRunId,
          type: "goal.supervisor.paused",
          data: { job_id: job.job_id, goal_id: state.goal.id, status: state.goal.status },
        });
        return;
      }
    }
    if (outcome.status === "complete" || outcome.status === "idle") {
      store.updateSupervisorJob(job.job_id, { status: "complete", iteration: currentIteration });
      store.appendEvent({ session_id: job.session_id, run_id: outcome.run_id ?? startedRunId, type: "daemon.job.complete", data: { job_id: job.job_id, kind: "goal" } });
      return;
    }
    store.updateSupervisorJob(job.job_id, {
      status: outcome.status === "blocked" ? "blocked" : "paused",
      iteration: currentIteration,
      metadata: { ...latestJob.metadata, pause_reason: outcome.reason ?? outcome.status },
    });
  } catch (error) {
    store.updateSupervisorJob(job.job_id, { status: "failed" });
    store.appendEvent({
      session_id: job.session_id,
      run_id: startedRunId,
      type: "daemon.job.failed",
      data: { job_id: job.job_id, kind: "goal", error: error instanceof Error ? error.message : String(error) },
    });
  }
}

function numberMeta(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function daemonConfigPath(workspaceRoot: string, stateDir: string | undefined, configPath: string | undefined): string | undefined {
  if (configPath) {
    return path.resolve(workspaceRoot, configPath);
  }
  return stateDir ? path.join(stateDir, "config.yaml") : undefined;
}

function metadataWithConfigPath(metadata: JsonObject, configPath: string | undefined): JsonObject {
  return configPath ? { ...metadata, config_path: configPath } : metadata;
}

function configPathFromMetadata(metadata: JsonObject): string | undefined {
  return typeof metadata.config_path === "string" && metadata.config_path.trim() ? metadata.config_path : undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
