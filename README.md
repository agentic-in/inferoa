<p align="center">
  <img src="assets/inferoa-logo.svg" alt="Inferoa" width="420" />
</p>

<p align="center">
  <strong>Inference-native Tokenmaxxing Agent Harness</strong>
</p>

<p align="center">
  <a href="https://github.com/agentic-in/inferoa">GitHub</a>
  ·
  <a href="https://inferoa.agentic-in.ai/docs/intro">Docs</a>
  ·
  <a href="https://inferoa.agentic-in.ai/blog/announcing-inferoa">Blog</a>
</p>

Most agents call models as if inference were a **black box**. The agent loop,
router, serving engine, context system, and multimodal path are usually split
apart, so the agent cannot tokenmaxx across the optimization rules that modern
inference systems make possible.

> Prefix cache stability is ignored. Routing is
bolted on later. Context is pasted until it fits. Users pay for that gap.

Inferoa is an **Inference-native Tokenmaxxing Agent Harness** for long-horizon
tasks. It starts from the inference stack and designs the agent loop around
tokenmaxxing: prefix-cache discipline, context optimization, intelligent
routing, high-throughput and memory-efficient vLLM serving, multimodal
capability.

## Preview

<div align="center">
  <p><strong>Welcome</strong></p>
  <img src="website/static/gif/welcome.gif" alt="Welcome" width="860" />
  <p><strong>Goal Mode</strong></p>
  <img src="website/static/gif/goal.gif" alt="Inferoa goal mode" width="860" />
  <p><strong>Plan Mode</strong></p>
  <img src="website/static/gif/plan.gif" alt="Inferoa plan mode" width="860" />
  <p><strong>Autoresearch Mode</strong></p>
  <img src="website/static/gif/research.gif" alt="Inferoa autoresearch mode" width="860" />
</div>

## Why Inferoa

Inferoa = **Infer**(Inference-native)**o**(Tokenmaxxing)**a**(Agent Harness).

Long-horizon agents are not one prompt. They are many turns of planning,
editing, tool use, retries, compaction, cache warmup, route selection, and
verification. If the harness treats every turn as generic chat traffic, it
throws away the optimization surface underneath it.

Inferoa makes those tokenmaxxing surfaces first-class:

- **Prefix cache is protected**, not merely reported after the turn.
- **Goals, plans, and autoresearch** are native long-horizon modes.
- **Context is optimized** through compression, summaries, graph-shaped code
  context, bounded tool output, and evidence selection instead of pasting until
  the window is full.
- **Intelligent routing chooses the model path** by cost, safety, privacy,
  capability, and session pressure.
- **High-performance model serving is respected**: Inferoa follows inference
  engine optimization rules so high-throughput, memory-efficient vLLM serving
  is not treated like generic chat traffic.

## Tokenmaxxing Across The Inference Stack

Inferoa is built on top of the vLLM ecosystem and extends tokenmaxxing across
the inference stack:

| Surface | Substrate | Inferoa role | Tokenmaxxing target |
| --- | --- | --- | --- |
| Agent Harness | [Inferoa](https://github.com/agentic-in/inferoa) | Goals, plans, autoresearch, sessions, tools, recovery, verification, and prefix-cache discipline | Keep long-horizon work coherent while preserving reusable prompt prefixes |
| Context Optimization | [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph), [RTK](https://github.com/rtk-ai/rtk) | Select evidence and shrink mutable context without losing task continuity | Spend fewer prompt and tool-output tokens |
| Intelligent routing | [vLLM Semantic Router](https://github.com/vllm-project/semantic-router) | Choose model paths by cost, safety, privacy, capability, and session pressure | Avoid one expensive path for every turn |
| Model Serving | [vLLM Engine](https://github.com/vllm-project/vllm), [vLLM Omni](https://github.com/vllm-project/vllm-omni) | Use high-throughput, memory-efficient serving and multimodal endpoints while respecting inference-engine optimization rules | Control cost, safety, privacy, and data sovereignty when an external frontier model is unnecessary |

![tokenmaxxing](website/static/img/screenshots/tokenmaxxing.png)

## Core Design

- **Long-horizon modes**: goal, plan, and autoresearch are native workflows,
  not prompt templates.
- **Prefix-cache discipline**: stable prompt epochs, deterministic tool schemas,
  bounded context sections, and cache reports protect reusable prefixes.
- **Continuous context optimization**: compression, summaries, structured repo
  context, bounded history, and bounded tool output preserve evidence while
  reducing token pressure.
- **Intelligent routing**: model paths can respond to cost, safety, privacy,
  capability, and session pressure, including routing between self-hosted vLLM
  models and external frontier models.
- **Inference-engine alignment**: prompt shape, endpoint choice, throughput,
  memory efficiency, cache behavior, and model capacity remain visible to the
  harness so the agent can follow serving optimization rules.

## Installation

```bash
npm install -g inferoa@dev
```

The `@dev` dist-tag tracks the latest build published from `main`. The npm
`latest` dist-tag is reserved for stable releases.

Node.js 24 or newer is required. Use `node --version` to check.

## Quickstart

```bash
inferoa setup
inferoa
```

`inferoa setup` walks through endpoint, model, vault-backed API key, and Omni
configuration. `inferoa` opens the TUI. Pass a prompt as an argument to start a
session and submit it as the first user turn:

```bash
inferoa "Inspect this repository and list the test entrypoints."
```

Run a single non-interactive request without opening the TUI:

```bash
inferoa --print "Summarize the README in one paragraph."
```

## Documentation

- [Quickstart](https://inferoa.agentic-in.ai/docs/quickstart) and
  [Architecture](https://inferoa.agentic-in.ai/docs/architecture) on the docs
  site.
- [CLI reference](https://inferoa.agentic-in.ai/docs/reference/cli),
  [Slash commands](https://inferoa.agentic-in.ai/docs/reference/slash-commands),
  and [Configuration reference](https://inferoa.agentic-in.ai/docs/reference/configuration).
- The source tree under `docs/` holds internal design notes (roadmap, TUI
  product design, vLLM-Omni validation, public-source hygiene).

### Core Commands

Use these commands as the task grows:

- `/goal` keeps a durable objective, decomposition, evidence, and completion
  reflection across long-running work.
- `/plan` turns ambiguous scope into an inspectable plan before execution.
- `/autoresearch` runs benchmark-style iteration with metrics and failure
  evidence in the same session.
- `/tokenmaxxing` shows token and cost pressure across prefix-cache reuse,
  context savings, recent turn usage, and model-selection pressure.

## Repository Development

From a source checkout, build the project and link the local `inferoa` binary
for interactive development:

```bash
npm install
npm run build
make dev-bin
inferoa setup
inferoa
```

Useful development commands: `npm test`, `make docs-preview`, `make docs-build`,
and `make dev-unlink` to remove the global link. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the contributor workflow, documentation
conventions, and publishing details.

## Acknowledgements

Inferoa is built for and with the vLLM ecosystem:

- [vLLM Engine](https://github.com/vllm-project/vllm)
- [vLLM Semantic Router](https://github.com/vllm-project/semantic-router)
- [vLLM Omni](https://github.com/vllm-project/vllm-omni)

Thanks to the projects behind Inferoa's context optimization:

- [RTK](https://github.com/rtk-ai/rtk)
- [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph)

## Contributors

<p align="center">
  <a href="https://agentic-in.ai">
    <img src="assets/agentic-intelligence-lab-lockup.png" alt="Agentic Intelligence Lab" width="320" />
  </a>
</p>

<p align="center">
  <strong>
    Agentic Intelligence Lab
  </strong>
</p>
