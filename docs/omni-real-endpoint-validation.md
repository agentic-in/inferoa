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
