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
INFEROA_OMNI_E2E_TOOL=vision \
npm run validate:omni-e2e-runtime
```

The runtime E2E runner uses a local scripted OpenAI-compatible controller to
force one selected Omni tool call through the normal Inferoa `Runtime.run()`
loop. Supported `INFEROA_OMNI_E2E_TOOL` values are `vision`,
`image_generation`, `image_edit`, `video_generation`, `audio_generation`,
`video_generation_async`, `speech_generation`, and `speech_voices`.
`video_generation` uses sync `/videos/sync`, while `video_generation_async`
uses async `/videos` plus status polling and content download. The tool call
itself targets the
remote vLLM-Omni service, persists managed resources when the capability
produces artifacts, and returns through a second model turn. This keeps the
validation deterministic while still proving the remote Omni model service is
used by the actual Inferoa tool loop.

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
2026-06-08 UTC. It is evidence for this adaptation pass, not a permanent
product requirement. Exact endpoint addresses, raw reports, and media remain in
ignored local or remote evidence directories.

| Profile | Model / served name | Checks | Result | Evidence summary |
| --- | --- | --- | --- | --- |
| Qwen2.5-Omni | `Qwen/Qwen2.5-Omni-7B` / `qwen2.5-omni-7b` | `routes`, `chat`, `vision`, runtime-loop `vision_understanding` | `pass` | `validate:omni-real` passed routes, direct chat, and `vision_understanding`; runtime E2E executed `vision_understanding` through `Runtime.run()`, called the remote model, persisted an `omni.vision` resource, and returned through the final model turn. Direct chat also returned an audio payload from the Omni model. |
| Qwen3-TTS CustomVoice | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` / `qwen3-tts-0.6b-custom` | `routes`, `/audio/voices`, `/audio/speech`, runtime-loop `speech_voices`, runtime-loop `speech_generation` | `pass` | Remote smoke listed 9 voices and generated `audio/wav`; runtime E2E executed both `speech_voices` and `speech_generation`, with speech output stored as managed media and metadata resources. |
| Qwen3-TTS Base | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | TTS Base smoke | `blocked` | Base task requires reference audio plus transcript and has no preset voices; cache from exploration was removed to recover disk headroom. |
| Image profile | `zai-org/GLM-Image` / `glm-image` | `routes`, `image_generation`, `image_edit`, runtime-loop `image_generation`, runtime-loop `image_edit` | `pass` | After freeing non-current model caches, GLM-Image loaded successfully. Real smoke and runtime E2E generated images, edited a 64x64 validation PNG, and persisted `omni.image_generation` and `omni.image_edit` managed resources. |
| Video profile | `Wan-AI/Wan2.1-T2V-1.3B-Diffusers` / `wan2.1-t2v-1.3b` | `routes`, async `/videos`, sync `/videos/sync`, runtime-loop sync `video_generation`, runtime-loop async `video_generation_async` | `pass` | Wan2.1 T2V 1.3B loaded from the online serving recipe. Real smoke passed sync and async video generation; runtime E2E validated sync `/videos/sync` and async `/videos` job polling/content download, with generated `video/mp4` stored as managed media resources. |
| Audio diffusion profile | `zhangj1an/AudioX` / `audiox` | `routes`, `/audio/generate`, runtime-loop `audio_generation` | `pass` | AudioX loaded as an `AudioXPipeline` profile. Real smoke called `/audio/generate` through the Inferoa ToolRegistry and produced `audio/wav`; runtime E2E executed `audio_generation` through `Runtime.run()`, persisted `omni.audio_generation` metadata plus `omni.audio_generation.media`, and returned through the final model turn. |
| Stable Audio profile | `stabilityai/stable-audio-open-1.0` | `audio_generation` | `blocked` | The Stable Audio container reached model download, but startup failed because the Hugging Face model is gated and requires license/access approval. This is tracked as an additional profile-access blocker; `/audio/generate` coverage is satisfied by the AudioX profile above. |

When a row is `blocked`, keep Inferoa implementation status separate from
testbed readiness. A blocked row can become `pass` by switching to a compatible
profile and rerunning `validate:omni-real`; it is not a wrong-route or request
serialization failure by itself.
