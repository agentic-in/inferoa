---
title: Configuration Reference
sidebar_label: Configuration
---

Inferoa loads configuration from the user config path unless `--config` is
provided. By default, the user config path is:

```text
~/.inferoa/config.yaml
```

Use `INFEROA_STATE_DIR` or `--state-dir` to change the state directory. The
state directory also holds the local secret vault, session database, and other
durable state.

## Top-Level Shape

The full default configuration is written by `inferoa debug init`. The defaults
shipped in [`src/config/defaults.ts`](https://github.com/agentic-in/inferoa/blob/main/src/config/defaults.ts)
are:

```yaml
model_setup:
  mode: direct
  provider: vllm
  base_url: http://localhost:8000/v1
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
  compression_threshold: 0.75
  context_window: 256000
  auto_compact_failure_limit: 3
  compact_recent_file_limit: 5
  compact_recent_file_token_limit: 5000
  compact_recent_total_token_limit: 25000
  protected_recent_loops: 3
  engine:
    provider: auto
    startup: welcome
    require_ready_before_chat: true
    watch: true

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

## Key Fields

- `model_setup.mode` — one of `direct`, `auto`, or `external`. `auto`
  delegates model selection to vLLM Semantic Router.
- `model_setup.provider` — provider id such as `vllm`, `vllm-sr`, or an
  external provider id from the setup wizard.
- `omni.endpoints` — keyed by capability. Supported keys are `vision`,
  `image_generation`, `image_edit`, `video_understanding`, `video_generation`,
  `audio_understanding`, `audio_generation`, and `speech`.
- `permissions.mode` — workspace permission mode. One of `full_access`,
  `auto_approve`, `ask`, or `custom`. Override per workspace from the TUI with
  [`/access`](../reference/slash-commands.md).
- `context.engine.provider` — `auto`, `codegraph`, `builtin`, or `off`.
- `skills.managed_installs` — `ask`, `always`, or `never`.

## Environment Overrides

Environment variables override config at startup. They never persist to disk.

| Variable | Effect |
| --- | --- |
| `INFEROA_BASE_URL` | Overrides `model_setup.base_url` |
| `VLLM_BASE_URL` | Fallback override for `model_setup.base_url` |
| `INFEROA_MODEL` | Overrides `model_setup.model` |
| `VLLM_MODEL` | Fallback override for `model_setup.model` |
| `INFEROA_MODE=auto` | Sets `model_setup.mode=auto` and uses the vLLM Semantic Router |
| `INFEROA_RTK` | Enables or disables RTK |
| `INFEROA_RTK_PATH` | Uses a specific RTK binary path |
| `INFEROA_RTK_AUTO_DOWNLOAD` | Enables or disables managed RTK download |
| `INFEROA_OMNI_VISION_URL` | Enables and configures the Omni vision endpoint URL |
| `INFEROA_OMNI_IMAGE_URL` | Enables and configures image generation |
| `INFEROA_OMNI_IMAGE_EDIT_URL` | Enables and configures image editing |
| `INFEROA_OMNI_VIDEO_URL` | Enables and configures video generation |
| `INFEROA_OMNI_SPEECH_URL` | Enables and configures speech generation |

Each Omni URL override also supports a matching `INFEROA_OMNI_<KEY>_MODEL`
variable. The accepted keys are the endpoint names: `VISION`, `IMAGE`,
`IMAGE_EDIT`, `VIDEO`, `SPEECH`.

## Secret Handling

Config files should store `api_key_ref`, not raw `api_key` values. The setup
wizard writes raw secrets into the local vault and stores only references in
the YAML file. The same rule applies to `model_setup`,
`omni.endpoints.*.api_key`, and `web_search.api_key`.

`inferoa debug setup` redacts any `*api_key*` field before printing. Public
docs, progress logs, and evidence artifacts must not include raw keys.

## Parallel web search

Choose **Parallel** in `/setup`, or set the following in your Inferoa config:

```yaml
web_search:
  provider: parallel
```

This opt-in provider uses [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
at `https://search.parallel.ai/mcp` over Streamable HTTP. No API key or OAuth is
needed. Anonymous requests use Fast mode with free-tier rate limits; inference
still uses your configured model endpoint. Parallel ignores `web_search.base_url`,
`api_key`, and `api_key_ref`, and does not read Parallel credentials from the environment.

The agent discovers `web_search` through `tool_search` and runs it through
`capability_call`. Results include source URLs, titles, and relevant excerpts in
the existing `results` and `results_text` fields. `limit` caps the returned results
locally (1–20); it does not change the server's search settings. Each search has a
20-second deadline, and service errors are returned without switching providers.

The default `auto` chain still tries DuckDuckGo HTML, DuckDuckGo Instant, then
Jina. Other explicitly selected providers and direct URL opening are unchanged.
