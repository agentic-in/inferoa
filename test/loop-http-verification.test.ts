import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createGoalState, writeGoalState } from "../src/goals/state.js";
import { verifyHttpHealth } from "../src/loop/http-verification.js";
import { readLoopMetrics } from "../src/loop/metrics.js";
import { readGoalVerificationRecords } from "../src/loop/verification.js";
import { SessionStore } from "../src/session/store.js";
import { resolveWorkspace } from "../src/session/workspace.js";

const execFileAsync = promisify(execFile);

test("HTTP health verifier records hard pass from expected status", async () => {
  const fixture = await createFixture("inferoa-loop-http-verification-");
  const server = await startServer({ "/health": 204 });
  try {
    const verification = await verifyHttpHealth(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      url: server.url("/health"),
      expected_status: 204,
      run_id: "verify_http_pass",
    });

    assert.equal(verification.provider, "checker");
    assert.equal(verification.verifier_role, "http-health");
    assert.equal(verification.verdict, "pass");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.evidence?.system, "http");
    assert.equal(verification.evidence?.verifier, "http-health");
    assert.equal(verification.evidence?.status, 204);
    assert.equal(verification.evidence?.expected_status, 204);
    assert.equal(verification.metrics?.reachable, 1);
    assert.equal(verification.metrics?.status_match, 1);

    const records = readGoalVerificationRecords(fixture.store, fixture.session.session_id);
    assert.equal(records[0]?.verifier_role, "http-health");
    const metrics = readLoopMetrics(fixture.store, fixture.workspace);
    assert.equal(metrics.by_system.some((group) => group.key === "http" && group.verification.pass === 1), true);
  } finally {
    await server.close();
    await fixture.cleanup();
  }
});

test("HTTP health verifier records hard failure from unexpected status", async () => {
  const fixture = await createFixture("inferoa-loop-http-verification-fail-");
  const server = await startServer({ "/health": 503 });
  try {
    const verification = await verifyHttpHealth(fixture.store, fixture.workspace, {
      session_id: fixture.session.session_id,
      url: server.url("/health"),
      expected_status: 200,
      run_id: "verify_http_fail",
    });

    assert.equal(verification.provider, "checker");
    assert.equal(verification.verifier_role, "http-health");
    assert.equal(verification.verdict, "fail");
    assert.equal(verification.confidence, "hard");
    assert.equal(verification.metrics?.reachable, 1);
    assert.equal(verification.metrics?.status, 503);
    assert.equal(verification.metrics?.expected_status, 200);
    assert.equal(verification.metrics?.status_match, 0);
    assert.match(verification.failure_reason ?? "", /status 503/);
  } finally {
    await server.close();
    await fixture.cleanup();
  }
});
async function createFixture(prefix: string): Promise<{
  dir: string;
  stateDir: string;
  workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  store: SessionStore;
  session: ReturnType<SessionStore["createSession"]>;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(dir, "state");
  const workspaceRoot = path.join(dir, "workspace");
  await mkdir(path.join(workspaceRoot, ".inferoa"), { recursive: true });
  const store = await SessionStore.open(stateDir);
  const workspace = await resolveWorkspace(process.cwd(), structuredClone(DEFAULT_CONFIG), workspaceRoot);
  const session = store.createSession(workspace, "HTTP verifier");
  writeGoalState(store, session.session_id, createGoalState({ objective: "Verify HTTP health" }), "seed");
  return {
    dir,
    stateDir,
    workspace,
    store,
    session,
    cleanup: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function startServer(routes: Record<string, number>): Promise<{
  server: Server;
  url: (pathname: string) => string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    const status = routes[request.url ?? ""] ?? 404;
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(String(status));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: (pathname: string) => `http://127.0.0.1:${address.port}${pathname}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
