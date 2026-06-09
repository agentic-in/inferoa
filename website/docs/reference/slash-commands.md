---
title: Slash Commands
sidebar_label: Slash commands
---

Slash commands are entered inside the Inferoa TUI.

| Command | Purpose |
| --- | --- |
| `/setup` | Open endpoint, provider, web search, and Omni setup |
| `/model` | Open model and provider selector |
| `/system` | Show model, web search, Omni, and runtime status |
| `/access` | Change workspace file and tool access |
| `/skills` | List or manage enabled skills |
| [`/goal`](../workflows/goal-mode.md) | Start or manage goal mode |
| [`/plan`](../workflows/plan-mode.md) | Start or manage plan mode |
| [`/autoresearch`](../workflows/autoresearch-mode.md) | Start or manage autoresearch experiments |
| `/tokenmaxxing` | Show token, cache, RTK, and routing savings |
| `/context` | Show context usage and compression state |
| `/tools` | Show fixed tool schemas and renderer status |
| `/sessions` | Manage chat sessions |
| `/jobs` | Open daemon and supervisor jobs |
| `/todo` | Open the task ledger |
| `/acceptance` | Open final acceptance workflow |
| `/help` | Show keyboard shortcuts and slash commands |
| `/clear` | Start a fresh session |
| `/resume` | Resume a previous session |
| `/exit` | Exit the TUI |

## Common Subcommands

```text
/goal show
/goal set
/goal plan
/goal pause
/goal resume
/goal budget
/goal complete
/goal drop

/plan show
/plan set
/plan pause
/plan resume
/plan approve
/plan drop

/context reindex
/tools expand
/tools compact
/tools last
/sessions resume
/sessions new
/sessions all
/jobs status
/jobs queue
/jobs attach
/jobs detach
/jobs cancel
/acceptance status
/acceptance run
```
