---
slug: announcing-inferoa
title: "Inferoa: Inference-native Tokenmaxxing Agent Harness"
description: "Inferoa is an Inference-native Tokenmaxxing Agent Harness for long-horizon coding work across prefix-cache discipline, context optimization, routing, and high-throughput model serving."
image: /img/inferoa-line-hero.png
authors: []
tags: [inferoa, tokenmaxxing, agents, inference, vllm]
---

![Inferoa Agent Harness](/img/inferoa-line-hero.png)

Most agents call models as if inference were a black box.

The agent loop lives in one place, routing policy in another, serving behavior
somewhere else, and context management becomes a last-minute fight with the
window. That split is tolerable for one-turn chat. It breaks down when agents
run for hours, recover from failures, compress context, warm prefix cache, route
between model paths, and still need to prove the work at the end.

> Prefix cache stability is ignored. Routing is bolted on later. Context is
> pasted until it fits. Users pay for that gap.

Inferoa = Infer(Inference-native)o(Tokenmaxxing)a(Agent Harness).

Inferoa is an **Inference-native Tokenmaxxing Agent Harness** for
**long-horizon coding work**. It starts from the inference stack and designs the
agent loop around **tokenmaxxing**: **prefix-cache discipline**,
**context optimization** with
[CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph) and
[RTK](https://github.com/rtk-ai/rtk), **intelligent routing** with
[vLLM Semantic Router](https://github.com/vllm-project/semantic-router),
**high-throughput model serving** with
[vLLM Engine](https://github.com/vllm-project/vllm) and
[vLLM Omni](https://github.com/vllm-project/vllm-omni), plus
**autoresearch** and **verification** inside the same durable session.

<!-- truncate -->

![Inferoa welcome session](/img/screenshots/inferoa-welcome.png)

## What Breaks

Long-horizon agents are not one prompt. They are many turns of planning, repo
inspection, shell commands, edits, retries, compaction, cache warmup, route
selection, and verification. If the harness treats every turn as generic chat
traffic, it throws away the optimization surface underneath it.

The failure modes are familiar:

- prompt shape drifts, so prefix cache cannot be reused reliably;
- context selection becomes "paste more" instead of "select better";
- cheap, private, or mechanical turns still take expensive model paths;
- compression preserves a summary but loses continuity;
- multimodal work becomes a disconnected side call;
- serving and cache signals arrive too late to shape the next action.

Inferoa treats those as harness design problems, not analytics problems.

## What Changes

Inferoa makes inference behavior visible to the agent loop. The point is not to
add another dashboard. The point is to let the runtime choose better prompts,
better context, better routes, and better recovery behavior while the task is
still running.

| Surface | Substrate | What Inferoa Makes Native | Why It Matters |
| --- | --- | --- | --- |
| Agent Harness | [Inferoa](https://github.com/agentic-in/inferoa) | Goals, plans, autoresearch, sessions, tools, recovery, verification, and prefix-cache discipline | Long work stays coherent while preserving reusable prompt prefixes |
| Context Optimization | [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph), [RTK](https://github.com/rtk-ai/rtk) | Compression, graph-shaped repo context, bounded tool output, and evidence selection | The model sees evidence, not raw sprawl |
| Intelligent Routing | [vLLM Semantic Router](https://github.com/vllm-project/semantic-router) | Model paths respond to cost, safety, privacy, capability, and session pressure | Turns can route between self-hosted vLLM models and external frontier models |
| Model Serving | [vLLM Engine](https://github.com/vllm-project/vllm), [vLLM Omni](https://github.com/vllm-project/vllm-omni) | High-throughput, memory-efficient serving and multimodal endpoints stay visible to the harness | Cache, cost, latency, and data-control surfaces stay native |

This is the core design: the agent is not merely calling an inference system.
It is shaped by it.

## What You Can Do Today

Inferoa is a terminal-first harness, but the product surface is not just a
shell. It makes long-horizon state visible while the agent works.

Start with **`/tokenmaxxing`**. It is the savings ledger for prefix-cache reuse,
context optimization, [RTK](https://github.com/rtk-ai/rtk) tool-output savings,
recent turn usage, and model-selection pressure. This is the place to see
whether the harness is actually tokenmaxxing the session, not just reporting
token usage after the fact.

![Inferoa tokenmaxxing report](/img/screenshots/tokenmaxxing.png)

Goal mode keeps the objective durable. The agent can decompose work, update
steps, attach evidence, and avoid mistaking an empty checklist for a finished
goal.

![Inferoa goal mode](/img/screenshots/inferoa-goal.png)

Plan mode turns ambiguous scope into an inspectable decision. A plan can stay in
drafting, move to approval, or become executable context without becoming a
hard runtime failure.

![Inferoa plan mode](/img/screenshots/inferoa-plan-ready.png)

Prefix-cache reporting separates warmup from steady state. The harness tracks
prompt epochs, schema hashes, cache salt, and cached-token evidence so the user
can see whether the session shape is staying reusable.

Autoresearch mode makes the evaluation loop native: define the experiment, run
the harness, record failures, patch the implementation, and keep the metric
trail inside the same session.

![Inferoa autoresearch iteration](/img/screenshots/inferoa-autoresearch-iteration.png)

The core command surface stays small: `/goal` for durable objectives, `/plan`
for inspectable scope, `/autoresearch` for metric-driven iteration, and
`/tokenmaxxing` for the savings ledger across prefix cache,
[CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph) and
[RTK](https://github.com/rtk-ai/rtk) context savings, recent turn usage, and
model-selection cost pressure.

## Proof Of Value

The value story is not one benchmark score. It is whether the tokenmaxxing path
stays stable, measurable, and cheaper as the work gets longer.

Key results from the long-horizon stress suite:

- **Stable prefixes**: the longest simulated run completed **64 tool loops**
  with **one prompt epoch, one tool schema hash, and one cache salt**.
- **Provider cache evidence**: repeated stable-prefix requests reported
  **99.2% cached prompt tokens** after warmup.
- **Bounded prompt path**: a **3.48M prompt-token** raw transcript baseline fell
  to **987.6K prompt tokens**, then **507.1K input-token-equivalent tokens**
  after cache-adjusted prefill work.
- **Independent context savings**:
  [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph)-style
  symbol/range context saved **80.8%** and
  [RTK](https://github.com/rtk-ai/rtk) command records saved **61.4%** of
  command-token footprint.

![Inferoa optimization surfaces](/img/experiments/inferoa-optimization-surfaces.svg)

The exact numbers will move with workload and pricing. The direction is the
important part: long-horizon agents need a harness that protects stability and
uses every inference surface available.

## Built With The vLLM Ecosystem

Inferoa starts with the vLLM ecosystem because vLLM exposes the right surfaces:
serving behavior, routing, multimodal paths, endpoint signals, and prefix-cache
economics.

- [**vLLM Engine**](https://github.com/vllm-project/vllm) provides
  high-performance OpenAI-compatible inference and the prefix-cache behavior
  Inferoa protects across long sessions.
- [**vLLM Semantic Router**](https://github.com/vllm-project/semantic-router)
  brings model routing into the agent loop so routes can respond to cost,
  safety, privacy, capability, and session pressure.
- [**vLLM Omni**](https://github.com/vllm-project/vllm-omni) brings image,
  video, and audio understanding or generation into the same durable agent
  contract.

Inferoa is the harness layer above that stack: the place where long-horizon
agent behavior and inference behavior meet.

## Try It

```bash
npm install -g inferoa
inferoa setup
inferoa
```

The larger goal is simple: agents should not waste the inference stack they are
already paying for. Inferoa makes those signals native to the loop.
