import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../src/session/store.js";
import type { WorkspaceIdentity } from "../src/types.js";

test("SessionStore persists sessions, locks, events, resources, and endpoint evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-store-"));
  const store = await SessionStore.open(dir);
  try {
    const workspace: WorkspaceIdentity = { id: "w_test", root: dir, alias: "test" };
    const session = store.createSession(workspace, "unit");
    assert.equal(store.listSessions(workspace.id).length, 1);
    const lock = store.acquireLock(session.session_id, "client", "cli");
    assert.equal(lock.owner_client_id, "client");
    store.appendEvent({ session_id: session.session_id, type: "session.note", data: { note: "hello" } });
    assert.ok(store.listEvents(session.session_id).some((event) => event.type === "session.note"));
    const resource = store.putResource(session.session_id, "test", "line1\nline2", { source: "unit" });
    assert.equal(store.readResource(resource.uri)?.content, "line1\nline2");
    store.recordEndpointEvidence(
      session.session_id,
      "run",
      "direct:vllm",
      {
        mode: "direct",
        provider_id: "direct:vllm",
        step_id: "step_store",
        step_index: 2,
        request_class: "interactive",
        prompt_epoch_id: "pe_test",
        usage: { prompt_tokens: 10, cached_prompt_tokens: 5 },
      },
      "prompt",
      "tools",
    );
    const endpointEvidence = store.listEndpointEvidence(session.session_id);
    assert.equal(endpointEvidence.length, 1);
    assert.equal(endpointEvidence[0]?.run_id, "run");
    assert.equal(endpointEvidence[0]?.prompt_hash, "prompt");
    assert.equal(endpointEvidence[0]?.tool_schema_hash, "tools");
    assert.equal(endpointEvidence[0]?.step_id, "step_store");
    assert.equal(endpointEvidence[0]?.step_index, 2);
    assert.equal(endpointEvidence[0]?.request_class, "interactive");
    assert.equal(endpointEvidence[0]?.prompt_epoch_id, "pe_test");
    assert.equal(endpointEvidence[0]?.cache_hit_rate, 0.5);
    const endpointEvent = store.listEvents(session.session_id).find((event) => event.type === "endpoint.evidence.recorded");
    assert.equal(endpointEvent?.data.step_id, "step_store");
    assert.equal(endpointEvent?.data.step_index, 2);
    assert.equal(endpointEvent?.data.request_class, "interactive");
    assert.equal(endpointEvent?.data.prompt_epoch_id, "pe_test");
    assert.equal(endpointEvent?.data.cache_hit_rate, 0.5);
    const renamed = store.renameSession(session.session_id, "renamed session");
    assert.equal(renamed.title, "renamed session");
    assert.ok(store.listEvents(session.session_id).some((event) => event.type === "session.renamed"));
    const archived = store.archiveSession(session.session_id);
    assert.equal(archived.status, "archived");
    assert.equal(store.listSessions(workspace.id).length, 0);
    assert.equal(store.listSessions(workspace.id, { includeArchived: true }).length, 1);
    assert.ok(store.listEvents(session.session_id).some((event) => event.type === "session.archived"));
    store.releaseLock(session.session_id, "client");
    assert.equal(store.getSession(session.session_id)?.status, "archived");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore records terminal run status distinctly from active runs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-store-status-"));
  const store = await SessionStore.open(dir);
  try {
    const workspace: WorkspaceIdentity = { id: "w_status", root: dir, alias: "status" };
    const completed = store.createSession(workspace, "completed");
    store.appendEvent({ session_id: completed.session_id, run_id: "run_done", type: "run.completed", data: { tool_rounds: 1 } });
    assert.equal(store.getSession(completed.session_id)?.status, "idle");

    const stopped = store.createSession(workspace, "stopped");
    store.appendEvent({ session_id: stopped.session_id, run_id: "run_stop", type: "run.stopped", data: { reason: "max_tool_rounds", max_tool_rounds: 1 } });
    assert.equal(store.getSession(stopped.session_id)?.status, "stopped");

    const completedGoal = store.createSession(workspace, "completed goal");
    store.appendEvent({ session_id: completedGoal.session_id, run_id: "run_goal", type: "model.request.started", data: { model: "test" } });
    store.appendEvent({ session_id: completedGoal.session_id, run_id: "run_goal", type: "run.completed", data: { tool_rounds: 1 } });
    store.appendEvent({ session_id: completedGoal.session_id, run_id: "run_goal", type: "goal.updated", data: { enabled: false, goal: { status: "complete" } } });
    store.appendEvent({ session_id: completedGoal.session_id, run_id: "run_goal", type: "goal.completion_report", data: { report: "done" } });
    assert.equal(store.getSession(completedGoal.session_id)?.status, "idle");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore clears stale locks with an unlock event", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-store-stale-lock-"));
  const store = await SessionStore.open(dir);
  try {
    const workspace: WorkspaceIdentity = { id: "w_stale_lock", root: dir, alias: "stale-lock" };
    const session = store.createSession(workspace, "stale-lock");
    store.acquireLock(session.session_id, "stale-client", "cli", 60_000);
    store.appendEvent({ session_id: session.session_id, run_id: "run_stale", type: "user.prompt", data: { prompt: "keep working" } });
    store.appendEvent({ session_id: session.session_id, run_id: "run_stale", type: "model.request.started", data: { model: "test" } });
    const cleared = store.clearStaleLocks(0);

    assert.equal(cleared, 1);
    assert.equal(store.getLock(session.session_id), undefined);
    assert.ok(
      store
        .listEvents(session.session_id)
        .some((event) => event.type === "run.stopped" && event.run_id === "run_stale" && event.data.reason === "stale_lock"),
    );
    assert.ok(
      store
        .listEvents(session.session_id)
        .some((event) => event.type === "session.unlocked" && event.data.owner_client_id === "stale-client" && event.data.reason === "stale_lock"),
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
