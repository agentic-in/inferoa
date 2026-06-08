# vLLM-Omni Endpoint Adaptation

Inferoa treats vLLM-Omni capabilities as endpoint-backed tools. The main
agent loop continues to use an OpenAI-compatible chat endpoint, while
multimodal capabilities are exposed to the model only when the matching
endpoint is configured.

## Design Model

- Chat, coding, planning, and tool selection use `/v1/chat/completions`.
- Omni capabilities are wrapped as tools such as `vision_understanding`,
  `image_generation`, and `video_generation`.
- A tool is injected into the model-facing tool list only when its capability
  has `base_url` and `model` configured.
- Tool handlers call the matching vLLM-Omni endpoint, persist large media or
  raw responses as managed resources, and return compact evidence to the
  agent loop.

## Capability Levels

Endpoint support is tracked at four levels:

| Level | Meaning |
| --- | --- |
| `configured` | Inferoa config contains `base_url` and `model` for the capability. |
| `route_present` | The endpoint route is visible from OpenAPI or a lightweight HTTP probe. |
| `profile_compatible` | The active vLLM-Omni model/profile is expected to support the capability. |
| `runtime_passed` | Inferoa successfully exercised the capability through its tool loop. |

This distinction matters because each vLLM-Omni server instance is bound to a
single model profile. A route can exist while the active model cannot execute
that capability.

## Acceptance Strategy

Unit tests use mock OpenAI-compatible endpoints and must not depend on remote
GPU availability. Real endpoint validation is run explicitly against a model
testbed and records the active profile, model, route status, runtime result,
artifacts, and any unavailable capability reason.

Real validation reports should live in local ignored evidence storage. Upstream
pull requests should include the implementation, tests, and reusable runbook,
but not generated media, raw API keys, model caches, or local testbed logs.
