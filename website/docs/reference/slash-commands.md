---
title: Slash Commands
sidebar_label: Slash commands
---

Slash commands are entered inside the Inferoa TUI. They form a small,
purpose-built command registry — they are not a mirror of legacy CLI
subcommands.

## Top-Level Commands

| Command | Purpose |
| --- | --- |
| `/setup` | Open endpoint, provider, web search, and Omni setup wizard |
| `/model` | Open model and provider selector |
| `/system` | Show model, web search, Omni, and runtime status (also `/endpoint`, `/endpoints`) |
| `/access` | Change this workspace's file and tool access |
| `/skills` | List discovered skills or manage enabled skills |
| [`/loop`](../workflows/loop-mode.md) | Start or manage task and research loops |
| `/inbox` | Show loop review, blocker, automation, and self-improve items |
| `/self-improve` | Manage loop learning proposals and replay reports |
| [`/plan`](../workflows/plan-mode.md) | Start or manage plan mode |
| `/tokenmaxxing` | Show token, cache, RTK, and routing savings (also `/cache`, `/rtk`, `/activity`, `/evidence`, `/history`) |
| `/context` | Show context usage, compression state, and code intelligence |
| `/tools` | Show fixed tool schemas and renderer status |
| `/sessions` | Manage chat sessions |
| `/daemon` | Manage background daemon runs |
| `/doctor` | Check endpoint, tool, and optional Omni health |
| `/help` | Show keyboard shortcuts and slash commands |
| `/clear` | Start a fresh session |
| `/resume` | Resume a previous session |
| `/exit` | Exit the TUI |

## Common Subcommands

```text
# Loop mode
/loop status                 Show active loop state
/loop                        Start a recursive long-horizon loop
/loop mode auto              Start a default auto loop
/loop mode focus             Start a focused loop
/loop mode explore           Start an exploratory loop
/loop mode timebox 2h        Start a timeboxed loop
/loop mode research          Start a research loop
/loop review                 Review a pending loop decision
/loop verify                 Run an independent loop verification pass
/loop pause                  Pause the current loop
/loop resume                 Resume a paused loop
/loop drop                   Drop the current loop

# Self-improve
/self-improve status         Show learning evidence and proposals
/self-improve propose        Stage a learned workspace skill proposal
/self-improve run --replay   Run structured replay/gating
/self-improve report         Show the latest replay report
/self-improve adopt          Adopt a staged learned workspace skill

# Plan mode
/plan show                   Show active plan state
/plan set                    Set or replace the plan objective
/plan pause                  Pause the current plan
/plan resume                 Resume a paused plan
/plan approve                Approve the current plan for execution
/plan drop                   Drop the current plan

# Skills
/skills list                 Show discovered skills
/skills manage               Enable or disable skills

# Access
/access status               Show this workspace's access mode
/access full                 Full local file and tool access
/access auto                 Auto-approve routine tools
/access ask                  Ask before risky access
/access custom               Use custom config rules

# Context
/context                     Show context and code intelligence state
/context reindex             Rebuild the context index

# Tools
/tools                       Show fixed tool schemas
/tools expand                Expand the latest tool run
/tools compact               Fold long successful tool runs
/tools last                  Show the latest tool trace

# Sessions
/sessions all                Show active and archived sessions
/sessions resume             Attach to a previous session
/sessions new                Start a fresh session

# Daemon
/daemon status               Show daemon and background run state
/daemon queue                Queue a supervised run
/daemon attach               Attach to a supervised run
/daemon detach               Detach a supervised run
/daemon cancel               Cancel a supervised run

# Doctor
/doctor status               Show configuration health
/doctor run                  Probe configured endpoint and optional Omni routes
/doctor tools                Ask the current agent to regress built-in tools
```

## Aliases

Several top-level commands accept friendly aliases so muscle memory from
related surfaces still resolves:

| Alias | Resolves To |
| --- | --- |
| `/endpoint`, `/endpoints` | `/system` |
| `/cache`, `/rtk`, `/activity`, `/evidence`, `/history` | `/tokenmaxxing` |
