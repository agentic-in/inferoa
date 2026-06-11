import { Runtime } from "../runtime.js";
import type { JsonObject, ToolResult, WorkspaceIdentity } from "../types.js";
import { fail, truncateText } from "../util/limit.js";
import { randomId } from "../util/hash.js";
import { isLoopSubagentSession, queueLoopSubagent, type LoopSubagentIsolation } from "../loop/subagents.js";
import type { ToolExecutionContext } from "./context.js";

export async function subagentTool(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  if (context.request_class === "reflection" || context.request_class === "verification" || context.request_class === "compaction") {
    return fail("subagent_context_not_allowed", "subagent can only be used by the main work agent.");
  }
  if (isLoopSubagentSession(context.store, context.session_id)) {
    return fail("subagent_nested_not_allowed", "subagents cannot spawn nested subagents.");
  }
  const task = stringArg(args.task);
  if (!task) {
    return fail("subagent_task_required", "task is required.");
  }
  const isolation = parseIsolation(args.isolation);
  if (!isolation) {
    return fail("subagent_isolation_invalid", "isolation must be session or worktree.");
  }
  const parent = context.store.getSession(context.session_id);
  if (!parent) {
    return fail("subagent_parent_missing", "current session is missing.");
  }
  const queued = await queueLoopSubagent({
    store: context.store,
    workspace: context.workspace,
    parent_session: parent,
    task,
    source: "tool",
    isolation,
    metadata: {
      parent_run_id: context.run_id,
      parent_step_id: context.step_id,
      parent_tool_call_id: context.tool_call_id,
    },
  });
  const runId = randomId("subagent");
  context.store.updateSupervisorJob(queued.job_id, { status: "running", run_id: runId });
  context.store.appendEvent({
    session_id: context.session_id,
    run_id: context.run_id,
    type: "loop.subagent.started",
    data: {
      subagent_id: queued.subagent_id,
      child_session_id: queued.child_session_id,
      job_id: queued.job_id,
      run_id: runId,
      isolation: queued.isolation,
      worktree_id: queued.worktree?.worktree_id,
    },
  });
  try {
    const runtime = new Runtime(context.config, subagentWorkspace(context.workspace, queued.workspace_root), context.store);
    const result = await runtime.run({
      prompt: queued.prompt,
      session_id: queued.child_session_id,
      run_id: runId,
      client_id: `subagent:${queued.subagent_id}`,
      owner_kind: "daemon",
      request_class: "background",
      visibility: "internal",
    });
    context.store.updateSupervisorJob(queued.job_id, { status: "complete", run_id: result.run_id });
    const content = truncateText(result.content, 4000);
    context.store.appendEvent({
      session_id: context.session_id,
      run_id: context.run_id,
      type: "loop.subagent.completed",
      data: {
        subagent_id: queued.subagent_id,
        child_session_id: queued.child_session_id,
        job_id: queued.job_id,
        run_id: result.run_id,
        tool_rounds: result.tool_rounds,
        tool_calls: result.tool_calls,
        tokens_used: result.tokens_used,
      },
    });
    return {
      ok: true,
      summary: "Sub-agent completed.",
      data: {
        subagent_id: queued.subagent_id,
        child_session_id: queued.child_session_id,
        job_id: queued.job_id,
        run_id: result.run_id,
        isolation: queued.isolation,
        worktree_id: queued.worktree?.worktree_id,
        tool_rounds: result.tool_rounds,
        tool_calls: result.tool_calls,
        tokens_used: result.tokens_used,
        content: content.text,
        truncated: content.truncated,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.store.updateSupervisorJob(queued.job_id, { status: "failed", run_id: runId });
    context.store.appendEvent({
      session_id: context.session_id,
      run_id: context.run_id,
      type: "loop.subagent.failed",
      data: {
        subagent_id: queued.subagent_id,
        child_session_id: queued.child_session_id,
        job_id: queued.job_id,
        run_id: runId,
        error: message,
      },
    });
    return fail("subagent_failed", message, {
      subagent_id: queued.subagent_id,
      child_session_id: queued.child_session_id,
      job_id: queued.job_id,
      run_id: runId,
    });
  }
}

function parseIsolation(value: unknown): LoopSubagentIsolation | undefined {
  if (value === undefined || value === null || value === "" || value === "session") {
    return "session";
  }
  if (value === "worktree") {
    return "worktree";
  }
  return undefined;
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function subagentWorkspace(workspace: WorkspaceIdentity, workspaceRoot: string): WorkspaceIdentity {
  if (workspaceRoot === workspace.root) {
    return workspace;
  }
  return {
    ...workspace,
    root: workspaceRoot,
    gitRoot: workspaceRoot,
  };
}
