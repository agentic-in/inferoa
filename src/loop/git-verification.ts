import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readGoalState } from "../goals/state.js";
import type { SessionStore } from "../session/store.js";
import type { JsonObject, WorkspaceIdentity } from "../types.js";
import { randomId } from "../util/hash.js";
import type { GoalLoopVerification } from "./types.js";
import { recordGoalVerification } from "./verification.js";

const execFileAsync = promisify(execFile);

export interface VerifyGitCleanOptions {
  session_id: string;
  run_id?: string;
}

export async function verifyGitClean(
  store: SessionStore,
  workspace: WorkspaceIdentity,
  options: VerifyGitCleanOptions,
): Promise<GoalLoopVerification> {
  const state = readGoalState(store, options.session_id);
  if (!state || state.goal.status === "dropped") {
    throw new Error(`Session ${options.session_id} has no verifiable goal.`);
  }
  const runId = options.run_id ?? randomId("verify_git");
  store.appendEvent({
    session_id: options.session_id,
    run_id: runId,
    type: "goal.verification.requested",
    data: {
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      provider: "connector",
      connector: "git",
      role: "git-clean",
      workspace_root: workspace.root,
    },
  });

  try {
    const result = await execFileAsync("git", ["-C", workspace.root, "status", "--porcelain=v1", "--untracked-files=normal"], {
      maxBuffer: 1024 * 1024,
    });
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    const summary = summarizeGitPorcelain(lines);
    const clean = summary.total === 0;
    return recordGoalVerification(store, options.session_id, {
      provider: "connector",
      verifier_role: "git-clean",
      verdict: clean ? "pass" : "fail",
      confidence: "hard",
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      run_id: runId,
      evidence: {
        connector: "git",
        verifier: "git-clean",
        workspace_root: workspace.root,
        clean,
        sample_paths: summary.sample_paths,
      },
      metrics: {
        clean: clean ? 1 : 0,
        changed_paths: summary.total,
        staged_paths: summary.staged,
        unstaged_paths: summary.unstaged,
        untracked_paths: summary.untracked,
        conflicted_paths: summary.conflicted,
      },
      summary: clean
        ? "Git working tree is clean."
        : `Git working tree has ${summary.total} changed ${summary.total === 1 ? "path" : "paths"}.`,
      failure_reason: clean ? undefined : `Local git changes remain: ${summary.sample_paths.join(", ") || "unlisted paths"}.`,
    }, runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return recordGoalVerification(store, options.session_id, {
      provider: "connector",
      verifier_role: "git-clean",
      verdict: "blocked",
      confidence: "soft",
      goal_id: state.goal.id,
      horizon_generation: state.goal.horizon_generation,
      run_id: runId,
      evidence: {
        connector: "git",
        verifier: "git-clean",
        workspace_root: workspace.root,
        command: "git status --porcelain=v1 --untracked-files=normal",
      },
      metrics: {
        clean: 0,
        changed_paths: 0,
      },
      summary: "Git clean verifier could not read workspace status.",
      failure_reason: message,
    }, runId);
  }
}

function summarizeGitPorcelain(lines: string[]): {
  total: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  sample_paths: string[];
} {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  const paths: string[] = [];
  for (const line of lines) {
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    if (line.startsWith("??")) {
      untracked += 1;
    } else {
      if (x !== " " && x !== "?") {
        staged += 1;
      }
      if (y !== " " && y !== "?") {
        unstaged += 1;
      }
      if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
        conflicted += 1;
      }
    }
    paths.push(pathFromPorcelainLine(line));
  }
  return {
    total: lines.length,
    staged,
    unstaged,
    untracked,
    conflicted,
    sample_paths: paths.filter(Boolean).slice(0, 20),
  };
}

function pathFromPorcelainLine(line: string): string {
  const value = line.slice(3).trim();
  const renamed = value.split(" -> ");
  return renamed[renamed.length - 1] ?? value;
}
