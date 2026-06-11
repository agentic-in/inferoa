import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../src/session/store.js";
import { renderToolCards } from "../src/tui/tool-renderer.js";
import { stripAnsi } from "../src/tui/ansi.js";
import type { SessionEvent, WorkspaceIdentity } from "../src/types.js";

test("TUI tool renderer formats shell, diff, and todo cards", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-tui-renderer-"));
  const store = await SessionStore.open(dir);
  try {
    const workspace: WorkspaceIdentity = { id: "w_tui_renderer", root: dir, alias: "renderer" };
    const session = store.createSession(workspace, "renderer");
    const events: SessionEvent[] = [
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.call",
        data: { tool_call_id: "a", tool_name: "run_command", arguments: { command: "printf ok" } },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "a",
          tool_name: "run_command",
          result: { ok: true, summary: "Command exited 0", data: { command: "printf ok", cwd: ".", code: 0, output: "ok" } },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.call",
        data: { tool_call_id: "b", tool_name: "apply_patch", arguments: { patch: "--- a\n+++ a\n@@ -1,2 +1,2 @@\n const same = true;\n-  value = \"old\";\n+  value = \"new\";\n" } },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: { tool_call_id: "b", tool_name: "apply_patch", result: { ok: true, summary: "Patch applied", data: {} } },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "c",
          tool_name: "todo_write",
          result: {
            ok: true,
            summary: "Updated 3 todo items",
            data: {
              items: [
                { id: "one", status: "done", content: "ship renderer" },
                { id: "two", status: "in_progress", content: "polish todo card" },
                { id: "three", status: "pending", content: "verify clarify UX" },
              ],
            },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "d",
          tool_name: "write_file",
          result: {
            ok: true,
            summary: "Wrote demo.txt",
            data: {
              path: "demo.txt",
              bytes: 8,
              diff: "--- a/demo.txt\n+++ b/demo.txt\n@@ -0,0 +1,1 @@\n+created\n",
            },
          },
        },
      },
    ];
    const output = renderToolCards(events, store).join("\n");
    const plain = stripAnsi(output);
    assert.match(plain, /Ran printf ok · exited 0/);
    assert.doesNotMatch(plain, /Ran command/);
    assert.doesNotMatch(plain, /\bcmd printf ok\b/);
    assert.doesNotMatch(plain, /\bcwd \./);
    assert.doesNotMatch(plain, /\n\s*exit 0\b/);
    assert.match(output, /Applied patch/);
    assert.match(output, /Updated todo/);
    assert.match(output, /Wrote file/);
    assert.match(plain, /progress 1 done · 1 active · 1 queued/);
    assert.match(output, /ship renderer/);
    assert.match(output, /polish todo card/);
    assert.match(output, /verify clarify UX/);
    assert.match(plain, /1\s+1\s+ \s+│ const same = true/);
    assert.match(plain, /2\s+\s+-\s+│ ··value = "old"/);
    assert.match(plain, /\s+2\s+\+\s+│ ··value = "new"/);
    assert.match(plain, /\s+1\s+\+\s+│ created/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("TUI tool renderer hides failed basic file read, write, and list cards", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-tui-renderer-hidden-file-failures-"));
  const store = await SessionStore.open(dir);
  try {
    const workspace: WorkspaceIdentity = { id: "w_tui_renderer_hidden_file_failures", root: dir, alias: "renderer" };
    const session = store.createSession(workspace, "renderer");
    const events: SessionEvent[] = [
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "a",
          tool_name: "read_file",
          result: {
            ok: false,
            summary: "read_file_failed: ENOENT: no such file or directory, open 'README.md'",
            data: { path: "README.md" },
            error: { code: "read_file_failed", message: "ENOENT: no such file or directory, open 'README.md'" },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "b",
          tool_name: "write_file",
          result: {
            ok: false,
            summary: "write_file_failed: EACCES: permission denied, open 'blocked.md'",
            data: { path: "blocked.md" },
            error: { code: "write_file_failed", message: "EACCES: permission denied, open 'blocked.md'" },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "c",
          tool_name: "list_dir",
          result: {
            ok: false,
            summary: "list_dir_failed: ENOENT: no such file or directory, scandir '/missing'",
            data: { path: "/missing" },
            error: { code: "list_dir_failed", message: "ENOENT: no such file or directory, scandir '/missing'" },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "d",
          tool_name: "read_file",
          result: { ok: true, summary: "Read 1 line from visible.md", data: { path: "visible.md", content: "ok" } },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "e",
          tool_name: "run_command",
          result: { ok: false, summary: "Command exited 1", data: { command: "false", cwd: ".", code: 1, output: "" } },
        },
      },
    ];
    const plain = stripAnsi(renderToolCards(events, store, { collapseCompact: false }).join("\n"));

    assert.doesNotMatch(plain, /Read file failed/);
    assert.doesNotMatch(plain, /Wrote file failed/);
    assert.doesNotMatch(plain, /Listed directory failed/);
    assert.doesNotMatch(plain, /read_file_failed/);
    assert.doesNotMatch(plain, /write_file_failed/);
    assert.doesNotMatch(plain, /list_dir_failed/);
    assert.doesNotMatch(plain, /README\.md/);
    assert.doesNotMatch(plain, /blocked\.md/);
    assert.doesNotMatch(plain, /\/missing/);
    assert.match(plain, /Read file .*visible\.md/);
    assert.match(plain, /Ran failed false · exited 1/);
    assert.doesNotMatch(plain, /\bcmd false\b/);
    assert.doesNotMatch(plain, /No display data/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("TUI tool renderer keeps consecutive compact tools tight", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-tui-renderer-tight-"));
  const store = await SessionStore.open(dir);
  try {
    const workspace: WorkspaceIdentity = { id: "w_tui_renderer_tight", root: dir, alias: "renderer" };
    const session = store.createSession(workspace, "renderer");
    const events: SessionEvent[] = [
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: { tool_call_id: "a", tool_name: "list_dir", result: { ok: true, summary: "Listed 3 entries in .", data: { entries: [] } } },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: { tool_call_id: "b", tool_name: "glob", result: { ok: true, summary: "Found 2 paths for *.ts", data: { matches: ["a.ts", "b.ts"] } } },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "c",
          tool_name: "web_fetch",
          result: { ok: true, summary: "Fetched 200 text/html from example.test", data: { final_url: "https://example.test/", status: 200, content_type: "text/html", title: "Example", text: "Hello\nworld" } },
        },
      },
    ];
    const plain = stripAnsi(renderToolCards(events, store).join("\n"));
    assert.match(plain, /Listed directory/);
    assert.match(plain, /Scanned files/);
    assert.match(plain, /Fetched URL/);
    assert.doesNotMatch(plain, /Listed directory[^\n]*\n\n[^\n]*Scanned files/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("TUI tool renderer uses key-value fallbacks instead of raw JSON", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-tui-renderer-fallback-"));
  const store = await SessionStore.open(dir);
  try {
    const workspace: WorkspaceIdentity = { id: "w_tui_renderer_fallback", root: dir, alias: "renderer" };
    const session = store.createSession(workspace, "renderer");
    const events: SessionEvent[] = [
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "a",
          tool_name: "list_dir",
          result: { ok: false, summary: "Listed entries", data: { entries: [{ type: "socket", mode: "rw", size: 12 }, { type: "file", name: "ok.ts" }] } },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "b",
          tool_name: "todo_write",
          result: { ok: true, summary: "Updated 1 todo item", data: { items: [{ status: "in_progress", estimate: 3 }] } },
        },
      },
    ];
    const plain = stripAnsi(renderToolCards(events, store, { collapseCompact: false }).join("\n"));

    assert.match(plain, /sock type=socket .*mode=rw .*size=12/);
    assert.match(plain, /active\s+status=in_progress .*estimate=3/);
    assert.doesNotMatch(plain, /[{}"]/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("TUI tool renderer folds long consecutive compact tool runs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-tui-renderer-fold-"));
  const store = await SessionStore.open(dir);
  try {
    const workspace: WorkspaceIdentity = { id: "w_tui_renderer_fold", root: dir, alias: "renderer" };
    const session = store.createSession(workspace, "renderer");
    const events: SessionEvent[] = Array.from({ length: 12 }, (_, index) => ({
      session_id: session.session_id,
      run_id: "run",
      type: "tool.result",
      data: {
        tool_call_id: `t${index}`,
        tool_name: "glob",
        result: { ok: true, summary: `Found ${index} paths for *.ts`, data: { matches: [] } },
      },
    }));
    const plain = stripAnsi(renderToolCards(events, store).join("\n"));
    assert.match(plain, /Tool batch/);
    assert.match(plain, /12 calls/);
    assert.match(plain, /12 scan/);
    assert.match(plain, /Ctrl\+T expand/);
    assert.match(plain, /├ Found 0 paths/);
    assert.match(plain, /╰ Found 11 paths/);
    assert.match(plain, /Found 0 paths/);
    assert.match(plain, /Found 11 paths/);
    assert.doesNotMatch(plain, /Found 5 paths/);
    assert.doesNotMatch(plain, /Tool batch[^\n]*\n\n[^\n]*Found 0 paths/);

    const expanded = stripAnsi(renderToolCards(events, store, { collapseCompact: false }).join("\n"));
    assert.doesNotMatch(expanded, /Tool batch/);
    assert.match(expanded, /Found 5 paths/);
    assert.match(expanded, /Found 11 paths/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("TUI tool renderer formats goal, plan, and autoresearch tools as native mode cards", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inferoa-tui-renderer-modes-"));
  const store = await SessionStore.open(dir);
  try {
    const workspace: WorkspaceIdentity = { id: "w_tui_renderer_modes", root: dir, alias: "renderer" };
    const session = store.createSession(workspace, "renderer");
    const events: SessionEvent[] = [
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "goal",
          tool_name: "goal",
          result: {
            ok: true,
            summary: "Loop complete: Ship mode",
            data: {
              goal: {
                objective: "Ship mode",
                status: "complete",
                summary: "Done",
                tool_rounds_used: 1,
                tool_calls_used: 2,
                planning: {
                  active_step_id: "verify",
                  steps: [
                    { id: "inspect", title: "Inspect flow", status: "completed" },
                    { id: "verify", title: "Run verification", status: "in_progress" },
                  ],
                },
              },
              horizons: [
                {
                  generation: 0,
                  current: false,
                  summary: "First pass",
                  steps: [{ id: "inspect", title: "Inspect flow", status: "completed" }],
                },
                {
                  generation: 1,
                  current: true,
                  summary: "Verification pass",
                  active_step_id: "verify",
                  steps: [{ id: "verify", title: "Run verification", status: "in_progress" }],
                },
              ],
              completion_budget_report: "Loop achieved. 1 tool loop · 2 tool calls · 3s · 34 tokens used.",
              remaining_tokens: null,
            },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.call",
        data: { tool_call_id: "goal_step", tool_name: "goal", arguments: { op: "update_step", step_id: "verify", status: "completed", notes: "Tests passed." } },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "goal_step",
          tool_name: "goal",
          result: {
            ok: true,
            summary: "Goal step updated: Ship mode",
            data: {
              goal: {
                objective: "Ship mode",
                status: "active",
                planning: {
                  active_step_id: "verify",
                  steps: [{ id: "verify", title: "Run verification", status: "completed" }],
                },
              },
            },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.call",
        data: { tool_call_id: "goal_reflect", tool_name: "goal", arguments: { op: "reflect", decision: "expand" } },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "goal_reflect",
          tool_name: "goal",
          result: {
            ok: true,
            summary: "Loop task expanded: Ship mode",
            data: {
              goal: {
                objective: "Ship mode",
                status: "active",
                horizon_generation: 2,
                last_reflection_decision: "expand",
                planning: {
                  active_step_id: "polish",
                  steps: [{ id: "polish", title: "Polish trace", status: "in_progress" }],
                },
              },
            },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.call",
        data: { tool_call_id: "goal_bad_args", tool_name: "goal", arguments: { op: "set_strategy", approach: "surgical" } },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "goal_bad_args",
          tool_name: "goal",
          result: {
            ok: false,
            summary: "Invalid goal arguments: arguments.approach must be one of \"focus\", \"explore\", \"timebox\"",
            data: {
              issues: [{ path: "arguments.approach", message: "must be one of \"focus\", \"explore\", \"timebox\"" }],
            },
            error: {
              code: "invalid_tool_arguments",
              message: "Invalid goal arguments: arguments.approach must be one of \"focus\", \"explore\", \"timebox\"",
            },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "ar_init_failed",
          tool_name: "init_experiment",
          result: {
            ok: false,
            summary: "harness exited 2; missing METRIC latency_ms=value",
            data: {
              autoresearch: { enabled: true, goal: "recover harness" },
              harness_status: { ok: false, message: "harness exited 2; missing METRIC latency_ms=value" },
            },
            error: {
              code: "harness_validation_failed",
              message: "harness exited 2; missing METRIC latency_ms=value",
            },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "ar_pending",
          tool_name: "run_experiment",
          result: {
            ok: false,
            summary: "run 1 is still pending; call log_experiment before starting another run",
            data: {
              pending_run: { id: 1, exit_code: 0, output_resource_uri: "resource://run-1" },
              progress: { logged_runs: 1, kept_runs: 0, keep_cap: 3, pending_runs: 1 },
            },
            error: {
              code: "autoresearch_pending_run",
              message: "run 1 is still pending; call log_experiment before starting another run",
            },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "goal_blocked",
          tool_name: "goal",
          result: {
            ok: false,
            summary: "Cannot complete goal with unfinished internal plan steps: verify",
            data: {
              goal: {
                objective: "Blocked goal",
                status: "active",
                planning: {
                  active_step_id: "verify",
                  steps: [
                    { id: "inspect", title: "Inspect flow", status: "completed" },
                    { id: "verify", title: "Run verification", status: "in_progress" },
                  ],
                },
              },
            },
            error: {
              code: "goal_incomplete_plan",
              message: "Cannot complete goal with unfinished internal plan steps: verify",
            },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "plan_blocked",
          tool_name: "plan",
          result: {
            ok: false,
            summary: "Plan approval requires a written plan body. Continue planning, update the plan body, then approve.",
            data: { plan: { objective: "Blocked mode", status: "drafting" } },
            error: {
              code: "plan_not_ready",
              message: "Plan approval requires a written plan body. Continue planning, update the plan body, then approve.",
            },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "plan_empty",
          tool_name: "plan",
          result: {
            ok: true,
            summary: "Plan created: Empty mode",
            data: { plan: { objective: "Empty mode", status: "drafting" } },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "plan",
          tool_name: "plan",
          result: { ok: true, summary: "Plan approved: Ship mode", data: { plan: { objective: "Ship mode", status: "approved", summary: "Ready" } } },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "plan_draft",
          tool_name: "plan",
          result: {
            ok: true,
            summary: "Plan updated: Draft mode",
            data: {
              plan: {
                objective: "Draft mode",
                status: "drafting",
                summary: "Ready for review",
                body: "## Plan\n- Inspect current flow\n- Verify with tests",
              },
            },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "ar_run",
          tool_name: "run_experiment",
          result: {
            ok: true,
            summary: "Run 1 timed out exit=null in 0.5s",
            data: {
              exit_code: null,
              duration_ms: 510,
              parsed_primary: null,
              timed_out: true,
              output_truncated: true,
              progress: { logged_runs: 1, kept_runs: 0, keep_cap: 3, pending_runs: 1 },
            },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "ar",
          tool_name: "log_experiment",
          result: {
            ok: true,
            summary: "Logged run 2: crash latency_ms=missing",
            data: {
              result: { run_id: 2, status: "crash", metric: null, description: "missing metric after harness crash" },
              progress: { logged_runs: 2, kept_runs: 1, keep_cap: 3, pending_runs: 0 },
            },
          },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "clarify",
          tool_name: "clarify",
          result: { ok: true, summary: "Question answered: Safe path", data: { question: "Pick path?", answer: "Use additive schema first.", choice_id: "safe", choice_label: "Safe path", freeform: false } },
        },
      },
      {
        session_id: session.session_id,
        run_id: "run",
        type: "tool.result",
        data: {
          tool_call_id: "evidence",
          tool_name: "complete_step",
          result: { ok: true, summary: "Completed verify", data: { step_id: "verify", evidence: { test: "npm test", ok: true, files: ["src/runtime.ts"] } } },
        },
      },
    ];

    const rendered = renderToolCards(events, store, { collapseCompact: false });
    const plain = stripAnsi(rendered.join("\n"));
    const goalBlock = plain.slice(0, plain.indexOf("Initialized experiment failed"));
    assert.match(goalBlock, /Completed loop · Ship mode · complete/);
    assert.match(goalBlock, /Updated loop step · verify · completed/);
    assert.match(goalBlock, /step verify · completed/);
    assert.match(goalBlock, /Expanded loop task · expand · loop task 2/);
    assert.match(goalBlock, /summary Done/);
    assert.doesNotMatch(goalBlock, /objective Ship mode/);
    assert.doesNotMatch(goalBlock, /loops 1 · tools 2/);
    assert.match(goalBlock, /report Loop achieved\. 1 tool loop · 2 tool calls · 3s · 34 tokens used\./);
    assert.match(goalBlock, /loop task 0/);
    assert.match(goalBlock, /step .*inspect Inspect flow/);
    assert.match(goalBlock, /loop task 1 .*Verification pass .*current/);
    assert.match(goalBlock, /step .*\* verify Run verification/);
    assert.match(goalBlock, /task plan 1 completed · 1 in progress/);
    assert.match(goalBlock, /active step \* verify Run verification/);
    assert.match(goalBlock, /Set loop approach failed · focus/);
    assert.match(goalBlock, /argument error Invalid goal arguments: arguments\.approach must be one of "focus", "explore", "timebox"/);
    assert.doesNotMatch(goalBlock, /Set loop approach failed · surgical[\s\S]*No active loop\./);
    assert.match(plain, /Updated loop failed · Blocked goal · active/);
    assert.match(plain, /goal_incomplete_plan: Cannot complete goal with unfinished internal plan steps: verify/);
    assert.match(plain, /Initialized experiment failed · harness exited 2; missing METRIC latency_ms=value/);
    assert.match(plain, /goal recover harness/);
    assert.match(plain, /harness harness exited 2; missing METRIC latency_ms=value/);
    assert.doesNotMatch(plain, /experiment unknown/);
    assert.match(plain, /Updated plan · Ship mode · approved/);
    assert.match(plain, /summary Ready/);
    assert.match(plain, /Updated plan · Draft mode · drafting/);
    assert.match(plain, /review ready for approval/);
    assert.match(plain, /Proposed Plan/);
    assert.match(plain, /Inspect current flow/);
    const proposedPlanLine = rendered.find((line) => stripAnsi(line).includes("Proposed Plan"));
    assert.ok(proposedPlanLine?.startsWith("\x1b[48;5;236m"));
    assert.match(plain, /Updated plan · Empty mode · drafting/);
    assert.match(plain, /review needs plan body/);
    assert.match(plain, /Updated plan failed · Blocked mode · drafting/);
    assert.match(plain, /plan_not_ready: Plan approval requires a written plan body/);
    assert.match(plain, /Ran experiment · timeout · primary missing/);
    assert.match(plain, /status timeout/);
    assert.match(plain, /output truncated/);
    assert.match(plain, /progress 1 logged · 0\/3 keep · 1 pending/);
    assert.match(plain, /Ran experiment failed · pending run 1/);
    assert.match(plain, /pending run 1/);
    assert.match(plain, /output resource:\/\/run-1/);
    assert.match(plain, /autoresearch_pending_run: run 1 is still pending/);
    assert.match(plain, /Logged experiment · run 2 · crash · metric missing/);
    assert.match(plain, /metric missing/);
    assert.doesNotMatch(plain, /metric unknown/);
    assert.match(plain, /progress 2 logged · 1\/3 keep/);
    assert.match(plain, /Questions answered · Pick path\?/);
    assert.match(plain, /answer Use additive schema first/);
    assert.doesNotMatch(plain, /choice Safe path/);
    assert.match(plain, /Recorded evidence · Completed verify/);
    assert.match(plain, /evidence test npm test/);
    assert.match(plain, /ok true/);
    assert.doesNotMatch(plain, /"objective"/);
    assert.doesNotMatch(plain, /"run_id"/);
    assert.doesNotMatch(plain, /"test"/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
