---
title: First Session
sidebar_label: First session
---

A session is the durable unit of work in Inferoa. It keeps the transcript,
workspace identity, prompt epochs, tool traces, managed resources, and endpoint
evidence together.

## Start

```bash
inferoa
```

Describe a concrete task in the composer. For coding work, include the outcome
you want and any constraints that matter:

```text
Inspect this package, find the test entrypoints, and add a missing docs build check.
```

You can also start a session and submit a prompt from the shell:

```bash
inferoa "Inspect this package and add a missing docs build check."
```

## Use Modes Deliberately

- Use plain chat for small questions and one-turn inspections.
- Run [`/loop`](../workflows/loop-mode.md) when you want to start a recursive
  long-horizon loop.
- Use [`/plan set`](../workflows/plan-mode.md) when scope is ambiguous and you
  want a plan before execution.
- Use `/loop mode research` when the task is experiment-shaped and needs repeated
  measurement.
- Use `/doctor status` when checking the local endpoint setup before a session.

## Inspect Evidence

During or after the session:

```text
/context                      Show context and compression state
/tools last                   Show the latest tool trace
/tokenmaxxing                 Show token, cache, RTK, and routing pressure
/sessions all                 Show active and archived sessions
```

The session log is designed to prove what happened: which files were read,
which tools ran, which endpoint handled the request, and which artifacts were
stored. See [Evidence and sessions](../operations/evidence-and-sessions.md)
for the event log model.

## Resume Later

Open the session picker from the TUI:

```text
/sessions resume
```

Or run the top-level `/resume` slash command to attach to a previous session.
The resumed session keeps its workspace identity and event log; you can keep
using `/loop`, `/plan`, `/loop mode research`, and the rest of the TUI surfaces
without losing continuity.

## Next Steps

- [Loop mode](../workflows/loop-mode.md) is the loop-engineering surface for
  recursive long-horizon loops.
- [Plan mode](../workflows/plan-mode.md) turns ambiguous scope into an
  inspectable plan before execution begins.
- Research loops under [Loop mode](../workflows/loop-mode.md) run
  benchmark-style iteration when the task depends on repeated measurement.
- [Coding workflow](../workflows/coding-workflow.md) describes the recommended
  inspect-edit-verify loop for repository work.
- [Evidence and sessions](../operations/evidence-and-sessions.md) explains the
  event log model and how to troubleshoot session state.
- [Context optimization](../concepts/context-optimization.md) covers
  compression, code intelligence, and how Inferoa keeps the next turn focused.
