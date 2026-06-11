---
title: Evidence And Sessions
sidebar_label: Evidence and sessions
---

Inferoa records work as events attached to a session. This lets a later turn,
resumed TUI, or acceptance audit reconstruct what happened without trusting the
final message alone.

## Session Evidence

The event log can include:

- model runs and token usage;
- tool calls and summaries;
- background process records;
- prompt epochs and hashes;
- endpoint evidence;
- managed resources;
- goal and plan state;
- daemon job state.

## Managed Resources

Large or binary outputs should be stored as resources, not pasted into the
prompt. This is especially important for generated images, videos, audio, and
long reports.

## Useful Commands

```text
/sessions all                 Show active and archived sessions
/sessions resume              Attach to a previous session
/tools last                   Show the latest tool trace
/tokenmaxxing                 Show token, cache, RTK, and routing savings
/context                      Show context and compression state
```

Use these commands to inspect the session before writing a final report or
debugging a failed workflow. The full registry, including aliases, is in
[Slash commands](../reference/slash-commands.md).

## Event Types

Each event in the session log has a type, timestamp, and payload. The main
event types are:

| Type | What It Records |
| --- | --- |
| `model_run` | Model id, token usage, endpoint, request id, cache fields |
| `tool_call` | Tool name, arguments summary, result summary, duration |
| `process` | Background process id, command, exit status |
| `prompt_epoch` | Epoch hash, section hashes, tool schema hash |
| `resource` | Managed resource id, type, size, export path |
| `goal` | Loop objective, step status changes, verification, and loop decisions |
| `plan` | Plan objective, draft body, approval state |
| `job` | Job id, state transitions (queued, running, detached, etc.) |

## Session Storage

Sessions are stored under the state directory (default `~/.inferoa/`). Each
session has a unique id tied to the workspace root, so sessions from different
repositories do not collide. The session database stores the event log, prompt
epochs, and managed resource references.

## Troubleshooting

- **Session appears empty after resume.** Check that you are resuming the
  correct session with `/sessions resume`. Sessions are scoped to the workspace
  root; opening Inferoa from a different directory creates a new session.
- **Tool traces are missing.** Long successful tool runs may be folded by
  `/tools compact`. Use `/tools expand` to open the latest folded trace.
- **Cache fields are not shown.** Not every provider reports cache details.
  Inferoa omits cache hit fields rather than fabricating a number. Switch to a
  provider that exposes usage detail if cache evidence is required for
  acceptance.
- **Managed resources are not found.** Resources are stored relative to the
  session's state directory. If the state directory was moved or cleaned,
  resource references in the event log may point to missing files.
