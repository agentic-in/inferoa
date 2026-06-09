---
title: Model Endpoints
sidebar_label: Model endpoints
---

Inferoa talks to model providers through configured endpoint profiles. The main
agent model can use direct vLLM, vLLM Semantic Router, or an external compatible
provider.

## Setup Wizard

```bash
inferoa setup
```

Or from the TUI:

```text
/setup
/model
/system
```

The setup flow writes endpoint URLs, selected models, context windows, and
vault references. Raw API keys are stored in the local vault.

## Direct vLLM

The default configuration expects a local OpenAI-compatible vLLM endpoint:

```yaml
model_setup:
  mode: direct
  provider: vllm
  base_url: http://localhost:8000/v1
  model: your-model-id
  context_window: 32768
```

Inferoa probes `/v1/models` and, for vLLM endpoints, may read optional load or
metrics routes when available.

## vLLM Semantic Router

Use auto mode when vLLM Semantic Router should select the model path:

```yaml
model_setup:
  mode: auto
  router: vllm-sr
  base_url: http://localhost:8000/v1
  model: auto
```

You can also set:

```bash
INFEROA_MODE=auto inferoa
```

## External Compatible Providers

External providers are useful for compatibility validation or fallback paths.
Inferoa supports custom OpenAI-compatible endpoints and provider profiles for
hosted APIs. Prefer the setup wizard so credentials go into the local vault.

For environment overrides:

```bash
INFEROA_BASE_URL=https://example.com/v1 \
INFEROA_MODEL=model-id \
inferoa
```

`VLLM_BASE_URL` and `VLLM_MODEL` are accepted as fallback environment variable
names.

## Signal Flow

```mermaid
flowchart LR
  Config["Config and vault"]
  Probe["Endpoint probe"]
  Runtime["Runtime request"]
  Usage["Usage and headers"]
  Store["Session evidence"]

  Config --> Probe
  Probe --> Runtime
  Runtime --> Usage
  Usage --> Store
```
