<p align="center">
  <img src="assets/inferoa-logo.svg" alt="Inferoa" width="420" />
</p>

<p align="center">
  <strong>Inference-native Tokenmaxxing Agent Harness for Loop Engineering</strong>
</p>

<p align="center">
  <a href="https://github.com/agentic-in/inferoa">GitHub</a>
  ·
  <a href="https://inferoa.agentic-in.ai/docs/intro">Docs</a>
  ·
  <a href="https://inferoa.agentic-in.ai/blog/announcing-inferoa">Blog</a>
</p>

Prompting is no longer the whole interface. The frontier is **Loop
Engineering**: give the model an objective, feedback, verification, memory, and tools,
then let it self-correct until the work is proven.

But every loop is also an inference workload. As turns accumulate, prompt
prefixes drift, cache reuse collapses, stale evidence fills context, model
routing gets harder, and serving choices start to matter.

Inferoa is an **Inference-native Tokenmaxxing Agent Harness for Loop
Engineering**:

- **Inference-native**: the loop sees serving, routing, context windows, prefix
  cache, multimodal endpoints, and self-hosted model paths.
- **Tokenmaxxing**: each turn is shaped to preserve cacheable prefixes, bound
  mutable context, expose token pressure, and pick the right inference path.
- **Loop Engineering**: `/loop` runs durable recursive loops that inspect, edit,
  test, verify, decide, remember, and continue across loop tasks.

## Loop is All You Need

<div align="center">
  <p><strong>Loop Mode</strong></p>
  <img src="website/static/gif/loop.gif" alt="Inferoa loop mode" width="860" />
  <p><strong>Code Index</strong></p>
  <img src="website/static/gif/welcome.gif" alt="Inferoa code index" width="860" />
  <p><strong>Plan Mode</strong></p>
  <img src="website/static/gif/plan.gif" alt="Inferoa plan mode" width="860" />
  <p><strong>Loop Research</strong></p>
  <img src="website/static/gif/research.gif" alt="Inferoa research loop" width="860" />
</div>

## Why Inferoa

Inferoa = **Infer**(Inference-native)**o**(Tokenmaxxing Loop)**a**(Agent Harness).

<div align="center">
  <img src="website/static/img/readme-why-inferoa.png" alt="Why Inferoa: Inference-native Loop Tokenmaxxing" width="860" />
</div>

Inferoa gives that loop an inference-native runtime:

- **Loop/rubric driven work**: `/loop` carries an objective across loop tasks,
  verification, decisions, recovery, and completion evidence instead of stopping after the
  next answer.
- **Independent feedback surfaces**: plans, tests, tool results, research
  metrics, and completion evidence give the loop something concrete to improve
  against.
- **Memory and context control**: compression, summaries, graph-shaped repo
  context, bounded history, and bounded tool output keep useful evidence in the
  window without letting stale state take over.
- **Prefix-cache discipline**: prompt epochs, deterministic tool schemas, and
  bounded system sections protect reusable prefixes while the loop runs.
- **Serving and routing remain visible**: model paths can respond to cost,
  safety, privacy, capability, session pressure, multimodal needs, and whether
  a self-hosted vLLM path is enough.

## The Tokenmaxxing Stack

Inferoa is built on top of the vLLM ecosystem and extends tokenmaxxing across
the inference stack:

| Surface | Substrate | Inferoa role | Tokenmaxxing target |
| --- | --- | --- | --- |
| Loop Engineering | [Loop Mode](https://github.com/agentic-in/inferoa) | Recursive long-horizon loops, loop tasks, attempts, verification, decisions, completion evidence, and recovery | Keep the engineering loop running until the work is proven |
| Agent Harness | [Inferoa](https://github.com/agentic-in/inferoa) | Sessions, tools, plans, loops, resources, evidence, and prefix-cache discipline | Give the loop a durable runtime while preserving reusable prompt prefixes |
| Context Optimization | [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph), [RTK](https://github.com/rtk-ai/rtk) | Select evidence and shrink mutable context without losing task continuity | Spend fewer prompt and tool-output tokens |
| Intelligent routing | [vLLM Semantic Router](https://github.com/vllm-project/semantic-router) | Choose model paths by cost, safety, privacy, capability, and session pressure | Avoid one expensive path for every turn |
| Model Serving | [vLLM Engine](https://github.com/vllm-project/vllm), [vLLM Omni](https://github.com/vllm-project/vllm-omni) | Use high-throughput, memory-efficient serving and multimodal endpoints while respecting inference-engine optimization rules | Control cost, safety, privacy, and data sovereignty when an external frontier model is unnecessary |

<div align="center">

**/tokenmaxxing inside a session 📽️**

  <img src="website/static/img/screenshots/tokenmaxxing.png" alt="Welcome" width="860" />

</div>

## Installation

```bash
npm install -g inferoa@dev
```

The `@dev` dist-tag tracks the latest build published from `main`. The npm
`latest` dist-tag is reserved for stable releases.

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

Start a recursive long-horizon loop from inside the TUI:

```text
/loop Improve this repository and prove it with tests.
```

Run a single non-interactive request without opening the TUI:

```bash
inferoa --print "Summarize the README in one paragraph."
```

## Documentation

- [Quickstart](https://inferoa.agentic-in.ai/docs/quickstart) and
  [Architecture](https://inferoa.agentic-in.ai/docs/architecture) on the docs
  site for the full walk-through.
- [CLI reference](https://inferoa.agentic-in.ai/docs/reference/cli),
  [Slash commands](https://inferoa.agentic-in.ai/docs/reference/slash-commands),
  and [Configuration reference](https://inferoa.agentic-in.ai/docs/reference/configuration).
- The source tree under `docs/` holds internal design notes (roadmap, TUI
  product design, vLLM-Omni validation, public-source hygiene).

### Core Slash Commands

Use these commands as the task grows:

- `/loop` starts a recursive long-horizon loop: Inferoa keeps the objective,
  loop tasks, attempts, verification evidence, and decisions active until the work is proven.
- `/plan` turns ambiguous scope into an inspectable plan before execution.
- `/tokenmaxxing` shows token and cost pressure across prefix-cache reuse,
  context savings, recent turn usage, and model-selection pressure.

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
