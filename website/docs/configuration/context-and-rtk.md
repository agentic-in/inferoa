---
title: Context And RTK
sidebar_label: Context and RTK
---

Inferoa uses context settings and RTK to reduce token waste while preserving
the evidence required for accurate work.

## Context Settings

```yaml
context:
  compression_threshold: 0.8
  context_window: 32768
  protected_recent_loops: 3
  engine:
    provider: auto
    startup: welcome
    require_ready_before_chat: true
    watch: true
```

`compression_threshold` controls when Inferoa starts compacting older context.
`protected_recent_loops` keeps recent model and tool work visible. The context
engine can use automatic detection, CodeGraph, built-in behavior, or be turned
off.

## RTK Settings

```yaml
rtk:
  enabled: true
  delivery: managed
  version: 0.42.3
  auto_download: true
```

Environment overrides:

```bash
INFEROA_RTK=false inferoa
INFEROA_RTK_PATH=/path/to/rtk inferoa
INFEROA_RTK_AUTO_DOWNLOAD=false inferoa
```

## Operational Views

```text
/context
/tokenmaxxing
```

`/context` reports context usage and compression state. `/tokenmaxxing` reports
RTK savings and token pressure alongside endpoint usage evidence.
