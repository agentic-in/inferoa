---
title: Configuration Reference
sidebar_label: Configuration
---

Inferoa loads configuration from the user config path unless `--config` is
provided. By default, the user config path is:

```text
~/.inferoa/config.yaml
```

Use `INFEROA_STATE_DIR` or `--state-dir` to change the state directory.

## Top-Level Shape

```yaml
workspace:
  root: /path/to/workspace

model_setup:
  mode: direct
  provider: vllm
  base_url: http://localhost:8000/v1
  model: model-id
  context_window: 32768

model_retry:
  initial_delay_ms: 1000
  max_delay_ms: 60000
  backoff_factor: 2
  jitter_ratio: 0.2
  request_timeout_ms: 300000

omni:
  enabled: false
  endpoints: {}

permissions:
  mode: full_access

context:
  compression_threshold: 0.8
  context_window: 32768
  protected_recent_loops: 3

skills:
  enabled:
    - coding-workflow
  managed_installs: ask

web_search:
  provider: auto

rtk:
  enabled: true
  delivery: managed
  version: 0.42.3
  auto_download: true

daemon:
  poll_ms: 1000
```

## Environment Overrides

| Variable | Effect |
| --- | --- |
| `INFEROA_BASE_URL` | Overrides `model_setup.base_url` |
| `VLLM_BASE_URL` | Fallback override for `model_setup.base_url` |
| `INFEROA_MODEL` | Overrides `model_setup.model` |
| `VLLM_MODEL` | Fallback override for `model_setup.model` |
| `INFEROA_MODE=auto` | Sets auto mode through vLLM Semantic Router |
| `INFEROA_RTK` | Enables or disables RTK |
| `INFEROA_RTK_PATH` | Uses a specific RTK binary |
| `INFEROA_RTK_AUTO_DOWNLOAD` | Enables or disables managed RTK download |
| `INFEROA_OMNI_VISION_URL` | Enables and configures the Omni vision endpoint URL |
| `INFEROA_OMNI_IMAGE_URL` | Enables and configures image generation |
| `INFEROA_OMNI_IMAGE_EDIT_URL` | Enables and configures image editing |
| `INFEROA_OMNI_VIDEO_URL` | Enables and configures video generation |
| `INFEROA_OMNI_SPEECH_URL` | Enables and configures speech generation |

Each Omni URL override also supports a matching model variable such as
`INFEROA_OMNI_VISION_MODEL`.

## Secret Handling

Config files should store `api_key_ref`, not raw `api_key` values. The setup
wizard writes raw secrets into the local vault and stores only references in
the YAML file.
