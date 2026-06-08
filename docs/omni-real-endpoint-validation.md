# vLLM-Omni Real Endpoint Validation

Inferoa keeps deployment control outside product code. Real Omni validation is
run manually against a prepared OpenAI-compatible vLLM-Omni endpoint and writes
reports to an ignored evidence directory.

## Evidence Location

Use `.inferoa/omni-evidence/` by default. The repository already ignores
`.inferoa/`, so reports, generated media resources, local state databases, API
keys, and large artifacts do not enter Git.

## Runner

Build and run:

```sh
INFEROA_OMNI_REAL_BASE_URL=http://host:8091/v1 \
INFEROA_OMNI_REAL_MODEL=model-id \
INFEROA_OMNI_REAL_PROFILE=qwen2.5-omni \
INFEROA_OMNI_REAL_TOOLS=routes,chat,vision \
npm run validate:omni-real
```

For an Inferoa runtime-loop E2E validation, run:

```sh
INFEROA_OMNI_REAL_BASE_URL=http://host:8091/v1 \
INFEROA_OMNI_REAL_MODEL=model-id \
INFEROA_OMNI_REAL_PROFILE=qwen2.5-omni-runtime \
npm run validate:omni-e2e-runtime
```

The runtime E2E runner uses a local scripted OpenAI-compatible controller to
force one `vision_understanding` tool call through the normal Inferoa
`Runtime.run()` loop. The tool call itself targets the remote vLLM-Omni service,
persists managed resources, and returns through a second model turn. This keeps
the validation deterministic while still proving the remote Omni model service
is used by the actual Inferoa tool loop.

Equivalent flags:

```sh
npm run validate:omni-real -- \
  --endpoint http://host:8091/v1 \
  --model model-id \
  --profile qwen2.5-omni \
  --tools routes,chat,vision \
  --evidence-dir .inferoa/omni-evidence
```

Supported tool names are:

- `routes`
- `chat`
- `vision`
- `image_generation`
- `image_edit`
- `video_generation`
- `video_sync`
- `audio_generation`
- `speech_generation`
- `speech_voices`

Each report records profile, model, endpoint URL, HTTP status when available,
artifact resource IDs, resource metadata, summary, and failure reason.
Runtime E2E reports additionally record model request count, tool-round count,
tool results, managed resources, status events, and final assistant content.

## Acceptance Interpretation

Use three levels:

- `pass`: the configured profile completed the runtime check and, for media
  generation tools, persisted a managed resource.
- `blocked`: the route and Inferoa request path were usable, but the active
  profile cannot support the task, the model is not loaded, or the testbed lacks
  required runtime flags or disk/model assets.
- `fail`: Inferoa formed the wrong request, called the wrong route, failed to
  persist resources for a successful generation result, or the endpoint returned
  an unexpected protocol error.

Do not mark a route-present generation capability as `pass` until a real
profile-compatible tool invocation succeeds.

## Profile Matrix Plan

Run one profile at a time. A single vLLM-Omni server is not expected to expose
every runtime capability simultaneously.

- Qwen/Qwen2.5-Omni-7B: `routes,chat,vision`
- Qwen3-TTS: `routes,speech_voices,speech_generation`
- Image profile: `routes,image_generation,image_edit`
- Video profile: `routes,video_generation,video_sync`
- Audio diffusion profile: `routes,audio_generation`

Before switching profiles, record current container image, served model, port,
and OpenAPI routes in the ignored evidence directory. After switching, rerun
`routes` and the profile-specific tools.

## Current Testbed Matrix

This matrix records the external vLLM-Omni testbed state observed on
2026-06-08. It is evidence for this adaptation pass, not a permanent product
requirement. Exact endpoint addresses, raw reports, and media remain in ignored
local or remote evidence directories.

| Profile | Model / served name | Checks | Result | Evidence summary |
| --- | --- | --- | --- | --- |
| Qwen2.5-Omni | `Qwen/Qwen2.5-Omni-7B` / `qwen2.5-omni-7b` | `routes`, `chat`, `vision` | `pass` | `validate:omni-real` passed routes, direct chat, and `vision_understanding`; vision produced a managed resource. Direct chat also returned an audio payload from the Omni model. |
| Qwen3-TTS CustomVoice | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` / `qwen3-tts-0.6b-custom` | `/audio/voices`, `/audio/speech` | `pass` | Remote TTS smoke returned built-in voices including `vivian` and generated a 230444-byte `audio/wav` file at 24000 Hz mono PCM. |
| Qwen3-TTS Base | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | TTS Base smoke | `blocked` | Base task requires reference audio plus transcript and has no preset voices; cache from exploration was removed to recover disk headroom. |
| Image profile | Image diffusion model such as `zai-org/GLM-Image` | `image_generation`, `image_edit` | `blocked` | Routes are present, but the active Qwen2.5 profile has no diffusion stage. The image model is about 33.3 GiB before runtime overhead while the host had about 9.2 GiB free. |
| Video profile | Wan-style video diffusion profile | `video_generation`, `video_sync` | `blocked` | Routes are present, but the active profile exposes an `llm` stage, not a video diffusion stage. The available `vllm/vllm-omni-rocm:v0.20.0` image did not include the newer Wan deploy profiles needed during setup. |
| Audio diffusion profile | `stabilityai/stable-audio-open-1.0` or equivalent | `audio_generation` | `blocked` | Route is present, but the active profile is not an audio diffusion model. Stable Audio cache size is about 14.6 GiB, above current host disk headroom. |

When a row is `blocked`, keep Inferoa implementation status separate from
testbed readiness. A blocked row can become `pass` by switching to a compatible
profile and rerunning `validate:omni-real`; it is not a wrong-route or request
serialization failure by itself.
