---
id: quickstart
title: Quickstart
---

This quickstart gets Inferoa running against an OpenAI-compatible endpoint.

Install the CLI globally:

```bash
npm install -g inferoa
```

Then start the setup wizard and launch the TUI:

```bash
inferoa setup
inferoa
```

Run a one-shot prompt without opening the interactive interface:

```bash
inferoa --print "Inspect this repository and summarize the test entrypoints."
```

## Basic Loop

```mermaid
sequenceDiagram
  participant U as User
  participant T as Inferoa TUI
  participant M as Model endpoint
  participant W as Workspace tools

  U->>T: inferoa setup
  T->>M: probe /v1/models
  U->>T: describe a task
  T->>W: inspect, edit, test
  T->>M: request next action
  T->>U: return answer with evidence
```

## First Commands

- Use `/setup` when you need to change provider, model, endpoint, web search,
  or Omni configuration.
- Use `/system` to inspect model, web search, Omni, and runtime status.
- Use [`/goal set`](./workflows/goal-mode.md) for a durable objective that
  should survive multiple turns.
- Use [`/plan set`](./workflows/plan-mode.md) for ambiguous work that needs an
  inspectable plan before execution.
- Use [`/autoresearch`](./workflows/autoresearch-mode.md) for experiment-shaped
  work that needs repeated measurement.
- Use `/tokenmaxxing` to see token, cache, RTK, and routing pressure.

## Repository Development

When working from a source checkout, install dependencies, build, and link the
local CLI:

```bash
npm install
npm run build
npm link
```

Useful development commands:

```bash
npm test
make docs-preview
make docs-build
```

Configuration is stored under `~/.inferoa/`. Endpoint keys are stored in the
local vault; config files store key references.
