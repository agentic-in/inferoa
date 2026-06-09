---
title: Acceptance
sidebar_label: Acceptance
---

Acceptance proves that Inferoa can complete a real task through the same
runtime paths users rely on: model calls, tools, sessions, context compression,
endpoint evidence, and multimodal resources.

## TUI Workflow

```text
/acceptance status
/acceptance run
```

The acceptance view checks whether the required direct model endpoint and Omni
endpoints are configured. It should fail fast when a required endpoint is
missing.

## Debug Runner

The repository also includes a debug runner:

```bash
npm run build
node dist/src/cli.js debug acceptance --daemon
```

The debug runner is useful for automation, but final product acceptance should
be visible from the TUI.

## Required Evidence

An acceptance report should include:

- repository and task description;
- configured provider, direct vLLM, router, and Omni endpoints;
- model names;
- files changed;
- tool calls used by category;
- tests or commands run;
- context compression evidence;
- endpoint usage and cache evidence when exposed;
- managed resources for multimodal artifacts;
- session id and resume evidence;
- daemon attach, detach, status, and cancel evidence when daemon behavior is in
  scope.

## Pass Flow

```mermaid
flowchart TB
  Config["Configure endpoints"]
  Probe["Probe models and capabilities"]
  Task["Run real repository task"]
  Tools["Use built-in tools"]
  Compress["Trigger and survive compression"]
  Omni["Run Omni tools"]
  Evidence["Persist evidence"]
  Report["Final report"]

  Config --> Probe
  Probe --> Task
  Task --> Tools
  Tools --> Compress
  Compress --> Omni
  Omni --> Evidence
  Evidence --> Report
```

Acceptance should not pass on mock-only evidence or manual calls outside the
Inferoa runtime loop.
