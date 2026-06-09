---
title: Installation
sidebar_label: Installation
---

Install Inferoa from npm when you want the published CLI:

```bash
npm install -g inferoa
inferoa setup
inferoa
```

Use a local checkout when developing Inferoa itself:

```bash
git clone https://github.com/agentic-in/inferoa.git
cd inferoa
npm install
npm run build
npm link
inferoa setup
```

## Requirements

- Node.js 24 or newer.
- An OpenAI-compatible chat endpoint for the main agent model.
- A writable state directory. By default, Inferoa uses `~/.inferoa/`.
- Optional vLLM-Omni endpoints for image, video, audio, and speech tools.

## State Directory

Inferoa stores local runtime state in the state directory:

- `config.yaml` contains endpoint URLs, selected models, context settings, and
  vault references.
- The local vault stores raw API keys.
- Session databases store event logs, tool traces, resources, prompt hashes,
  and endpoint evidence.

Set a custom state location when needed:

```bash
inferoa --state-dir .inferoa setup
inferoa --state-dir .inferoa
```

You can also set `INFEROA_STATE_DIR` before running Inferoa.

## Verify The CLI

```bash
inferoa --help
inferoa debug status
```

`inferoa --help` prints the command surface. `inferoa debug status` loads the
current configuration and reports runtime status without opening the TUI.
