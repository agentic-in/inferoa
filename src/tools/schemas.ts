import type { JsonObject, ToolDefinition, VllmAgentConfig } from "../types.js";

function objectSchema(properties: Record<string, JsonObject>, required: string[] = []): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

const string = (description: string): JsonObject => ({ type: "string", description });
const number = (description: string): JsonObject => ({ type: "number", description });
const boolean = (description: string): JsonObject => ({ type: "boolean", description });
const jsonObject = (description: string): JsonObject => ({ type: "object", description, additionalProperties: true });

const goalStep = objectSchema(
  {
    id: string("Optional stable step id. If omitted, one is derived from the title."),
    title: string("Concrete goal step title."),
    status: string("Optional status: pending, in_progress, completed, blocked, or skipped."),
    notes: string("Optional short notes for the step."),
    evidence: jsonObject("Optional structured evidence for this step."),
  },
  ["title"],
);

const clarifyChoice = objectSchema(
  {
    id: string("Optional stable choice id."),
    label: string("User-facing choice label."),
    description: string("Optional short explanation of this choice."),
  },
  ["label"],
);

const DEFINITIONS = [
  {
    name: "apply_patch",
    description: "Apply a complete unified diff patch in the workspace. Prefer this for code edits. Include file headers and valid hunk headers/context; read the target file first when uncertain.",
    permission: "write",
    parameters: objectSchema({ patch: string("Complete unified diff patch with file headers and valid hunks.") }, ["patch"]),
  },
  {
    name: "ast_edit",
    description: "Apply a structured AST edit for TypeScript/JavaScript or Python selectors. Escaped newlines in content are normalized, and successful edits return a diff.",
    permission: "write",
    parameters: objectSchema(
      {
        language: string("Language id: typescript, javascript, tsx, jsx, or python."),
        path: string("Workspace-relative file path."),
        operation: string("replace_node, insert_before, insert_after, or delete_node."),
        selector: string("Selector such as function:name, class:name, import, or text:literal."),
        content: string("Replacement or inserted content. JSON escaped newlines such as \\n are accepted."),
        position: string("Optional language-specific position hint."),
      },
      ["language", "path", "operation", "selector"],
    ),
  },
  {
    name: "ast_grep",
    description: "Search TypeScript/JavaScript or Python structure with a compact selector.",
    permission: "read",
    parameters: objectSchema(
      {
        language: string("Language id."),
        path: string("Workspace-relative file path."),
        selector: string("Selector such as function:name, class:name, import, or text:literal."),
        limit: number("Maximum matches."),
        page: string("Opaque page token."),
      },
      ["language", "path", "selector"],
    ),
  },
  {
    name: "audio_generation",
    description: "Generate audio through a configured endpoint-backed Omni tool.",
    permission: "network",
    parameters: objectSchema(
      {
        input: string("Text prompt describing the audio to generate, or a text resource:// URI."),
        prompt: string("Legacy alias for input."),
        model: string("Optional model override."),
        response_format: string("Optional response format: wav, pcm, flac, mp3, aac, or opus."),
        speed: number("Optional speed multiplier."),
        duration: number("Optional audio length in seconds; aliases audio_length."),
        audio_length: number("Optional audio length in seconds."),
        audio_start: number("Optional audio start time in seconds."),
        negative_prompt: string("Optional negative prompt."),
        guidance_scale: number("Optional diffusion guidance scale."),
        num_inference_steps: number("Optional diffusion step count."),
        seed: number("Optional seed."),
      },
      ["input"],
    ),
  },
  {
    name: "audio_understanding",
    description: "Analyze audio inputs through a configured endpoint-backed Omni tool.",
    permission: "network",
    parameters: objectSchema(
      {
        inputs: { type: "array", items: string("Audio URL, file path, data URI, or resource:// URI.") },
        prompt: string("Question or instruction."),
        model: string("Optional model override."),
      },
      ["inputs", "prompt"],
    ),
  },
  {
    name: "clarify",
    description: "Ask the user for a missing decision before taking an action that would otherwise rely on a risky assumption. Provide concise choices when possible, allow free-form input when the user may need to explain constraints, and use the returned answer as tool evidence.",
    permission: "read",
    parameters: objectSchema(
      {
        question: string("The specific question to ask the user."),
        details: string("Optional short context explaining why the answer is needed."),
        choices: { type: "array", description: "Optional mutually exclusive choices for the user.", items: clarifyChoice },
        allow_freeform: boolean("Allow the user to type a custom answer. Defaults to true."),
        placeholder: string("Optional placeholder for free-form input."),
      },
      ["question"],
    ),
  },
  {
    name: "complete_step",
    description: "Record that a milestone/task step completed with concrete evidence.",
    permission: "read",
    parameters: objectSchema(
      {
        step_id: string("Stable step id."),
        evidence: jsonObject("Evidence object or concise structured proof."),
      },
      ["step_id", "evidence"],
    ),
  },
  {
    name: "edit_file",
    description: "Replace exact text in a workspace file, or in an absolute local file when workspace access is full. If no exact match is found, the result includes nearby similar lines; escaped multiline text is accepted as a fallback.",
    permission: "write",
    parameters: objectSchema(
      {
        path: string("Workspace-relative path, or absolute local path when access is full."),
        old_text: string("Exact text to replace. Escaped multiline text such as \\n is accepted as a fallback."),
        new_text: string("Replacement text."),
        occurrence: number("1-based occurrence to replace. Defaults to 1."),
      },
      ["path", "old_text", "new_text"],
    ),
  },
  {
    name: "file_search",
    description: "Search workspace text using rg when available, then grep or a bounded built-in fallback.",
    permission: "read",
    parameters: objectSchema(
      {
        query: string("Search query or regex."),
        path: string("Optional workspace-relative path."),
        glob: string("Optional glob filter."),
        regex: boolean("Treat query as regex."),
        case_sensitive: boolean("Case-sensitive search."),
        limit: number("Maximum results."),
        page: string("Opaque page token."),
      },
      ["query"],
    ),
  },
  {
    name: "git_diff",
    description: "Show bounded git diff output.",
    permission: "read",
    parameters: objectSchema({
      cwd: string("Optional workspace-relative cwd."),
      staged: boolean("Show staged diff."),
      path: string("Optional path filter."),
    }),
  },
  {
    name: "git_show",
    description: "Show a bounded git object or file at revision.",
    permission: "read",
    parameters: objectSchema({
      rev: string("Revision or object."),
      cwd: string("Optional workspace-relative cwd."),
      path: string("Optional path filter."),
    }, ["rev"]),
  },
  {
    name: "git_status",
    description: "Show bounded git status.",
    permission: "read",
    parameters: objectSchema({ cwd: string("Optional workspace-relative cwd.") }),
  },
  {
    name: "glob",
    description: "Find workspace paths using a simple glob pattern.",
    permission: "read",
    parameters: objectSchema(
      {
        pattern: string("Glob pattern."),
        cwd: string("Optional workspace-relative cwd."),
        limit: number("Maximum paths."),
        page: string("Opaque page token."),
      },
      ["pattern"],
    ),
  },
  {
    name: "goal",
    description: "Manage the active goal-mode objective and its internal planning state for this session. Use create only when no goal exists; decompose/update_plan to keep a native frontier current; update_step as work, evidence, and blockers change; audit can only be recorded by an internal audit run and records a tool-enabled frontier audit decision; get to inspect budget/status; resume for paused goals; complete only after the objective is genuinely achieved and the latest audit decision is done with verification evidence unless force is true; drop only when the goal should be discarded.",
    permission: "read",
    parameters: objectSchema(
      {
        op: string("Operation: create, get, decompose, update_plan, update_step, audit, resume, complete, or drop."),
        objective: string("Goal objective. Required for op=create."),
        token_budget: number("Optional positive token budget for op=create."),
        steps: { type: "array", description: "Concrete internal goal steps for op=create, decompose, or update_plan.", items: goalStep },
        active_step_id: string("Optional active step id for op=create, decompose, update_plan, or update_step."),
        step_id: string("Step id to update for op=update_step."),
        title: string("Optional replacement title or title for a newly inserted step when op=update_step."),
        status: string("Step status for op=update_step: pending, in_progress, completed, blocked, or skipped."),
        notes: string("Optional notes for op=update_step. Empty string clears notes."),
        evidence: jsonObject("Optional structured step evidence for op=update_step."),
        decision: string("Audit decision for op=audit in an internal audit run only: expand, done, blocked, or retry."),
        verification_evidence: jsonObject("Structured verification evidence for op=audit with decision=done in an internal audit run."),
        blocker: string("Optional blocker details for op=audit with decision=blocked or retry in an internal audit run."),
        summary: string("Completion summary for op=complete, or reason for op=drop."),
        force: boolean("Allow op=complete even if internal goal plan has unfinished steps."),
      },
      ["op"],
    ),
  },
  {
    name: "image_edit",
    description: "Edit one or more images through a configured endpoint-backed Omni tool.",
    permission: "network",
    parameters: objectSchema(
      {
        prompt: string("Image edit instruction."),
        images: { type: "array", items: string("Image URL, file path, data URI, or resource:// URI.") },
        image: string("Single image URL, file path, data URI, or resource:// URI."),
        model: string("Optional model override."),
        mask_image: string("Optional mask image URL, file path, data URI, or resource:// URI."),
        reference_image: string("Optional reference image URL, file path, data URI, or resource:// URI."),
        n: number("Optional image count."),
        size: string("Optional size such as 1024x1024 or auto."),
        response_format: string("Optional response format such as b64_json or url."),
        output_format: string("Optional output format such as png, jpeg, or webp."),
        background: string("Optional background mode."),
        output_compression: number("Optional output compression 0-100."),
        negative_prompt: string("Optional negative prompt."),
        num_inference_steps: number("Optional diffusion step count."),
        guidance_scale: number("Optional guidance scale."),
        strength: number("Optional edit strength."),
        true_cfg_scale: number("Optional true CFG scale."),
        seed: number("Optional seed."),
      },
      ["prompt"],
    ),
  },
  {
    name: "image_generation",
    description: "Generate images through a configured endpoint-backed Omni tool.",
    permission: "network",
    parameters: objectSchema(
      {
        prompt: string("Image generation prompt."),
        model: string("Optional model override."),
        size: string("Optional size such as 1024x1024."),
        n: number("Optional image count."),
        response_format: string("Optional response format such as b64_json or url."),
        output_format: string("Optional output format such as png, jpeg, or webp."),
        negative_prompt: string("Optional negative prompt."),
        num_inference_steps: number("Optional diffusion step count."),
        guidance_scale: number("Optional guidance scale."),
        true_cfg_scale: number("Optional true CFG scale."),
        seed: number("Optional seed."),
      },
      ["prompt"],
    ),
  },
  {
    name: "init_experiment",
    description: "Initialize an active autoresearch experiment after ./autoresearch.sh exists. Defines the primary metric, direction, scope, constraints, and soft iteration cap.",
    permission: "read",
    parameters: objectSchema(
      {
        name: string("Experiment name."),
        goal: string("Optional experiment goal."),
        primary_metric: string("Primary metric name printed by the harness as METRIC name=value."),
        metric_unit: string("Metric unit such as ms, tokens, or percent."),
        direction: string("Better direction: lower or higher."),
        scope_paths: { type: "array", items: string("Expected-to-modify path or glob.") },
        off_limits: { type: "array", items: string("Path or glob that should not be modified.") },
        constraints: { type: "array", items: string("Free-form experiment constraint.") },
        max_iterations: number("Optional positive keep-run cap."),
        validate_harness: boolean("Run ./autoresearch.sh during initialization and require the primary metric. Defaults to true."),
      },
      ["name", "primary_metric"],
    ),
  },
  {
    name: "list_dir",
    description: "List files and folders in a workspace directory, or an absolute local directory when workspace access is full.",
    permission: "read",
    parameters: objectSchema(
      {
        path: string("Workspace-relative directory path, or absolute local directory when access is full. Use '.' or '/' for the workspace root."),
        limit: number("Maximum entries."),
        page: string("Opaque page token."),
      },
      ["path"],
    ),
  },
  {
    name: "plan",
    description: "Manage plan mode for this session. Use create only to start planning; when a plan is already active, use get/update instead. Use update to persist questions, decisions, markdown plan body, and summary. Use approve only when the plan is ready for the user to confirm execution.",
    permission: "read",
    parameters: objectSchema(
      {
        op: string("Operation: create, get, update, approve, pause, resume, or drop."),
        objective: string("Plan objective. Required for op=create when no active plan exists; optional replacement for op=update."),
        body: string("Self-contained markdown plan body for op=create, update, or approve."),
        summary: string("Concise plan summary or approval summary."),
      },
      ["op"],
    ),
  },
  {
    name: "log_experiment",
    description: "Log the latest pending autoresearch run. Use keep for accepted improvements, discard/crash/checks_failed for failed runs. Records the primary metric, description, secondary metrics, and ASI metadata.",
    permission: "read",
    parameters: objectSchema(
      {
        status: string("Run outcome: keep, discard, crash, or checks_failed."),
        metric: number("Primary metric value to record. Optional when the pending run parsed the primary metric."),
        description: string("Short description of what changed or what the run measured."),
        metrics: jsonObject("Optional secondary metric values."),
        asi: jsonObject("Optional structured autoresearch metadata."),
      },
      ["status", "description"],
    ),
  },
  {
    name: "lsp",
    description: "Run lightweight code-intelligence actions such as status, diagnostics, symbols, hover, references, and rename.",
    permission: "read",
    parameters: objectSchema(
      {
        action: string("status, diagnostics, definition, references, hover, symbols, rename, rename_file, or code_actions."),
        path: string("Workspace-relative path."),
        line: number("1-based line."),
        character: number("1-based character."),
        symbol: string("Symbol name."),
        query: string("Search query."),
        new_name: string("Rename target."),
        apply: boolean("Apply mutation for rename actions."),
        timeout_ms: number("Timeout in milliseconds."),
      },
      ["action"],
    ),
  },
  {
    name: "read_file",
    description: "Read a bounded window from a workspace-relative or absolute local file path.",
    permission: "read",
    parameters: objectSchema(
      {
        path: string("Workspace-relative path, absolute local path, or file:// URL."),
        start_line: number("1-based start line."),
        line_count: number("Number of lines."),
      },
      ["path"],
    ),
  },
  {
    name: "read_process",
    description: "Read recent output from a background process.",
    permission: "read",
    parameters: objectSchema(
      {
        process_id: string("Session-scoped process id."),
        since_seq: number("Read output after this sequence."),
        max_bytes: number("Maximum bytes."),
      },
      ["process_id"],
    ),
  },
  {
    name: "read_resource",
    description: "Read a bounded page from a managed resource URI. Use uri='list' to discover current-session resources; unique short suffixes are accepted.",
    permission: "read",
    parameters: objectSchema(
      {
        uri: string("Managed resource URI, 'list', or a unique suffix of a current-session resource URI."),
        page: string("Opaque page token or numeric offset."),
        line_count: number("Number of lines to read."),
      },
      ["uri"],
    ),
  },
  {
    name: "export_resource",
    description: "Export a managed resource URI to a local file for preview or manual validation. Media bytes are exported when available; text and JSON resources are written as UTF-8.",
    permission: "write",
    parameters: objectSchema(
      {
        uri: string("Managed resource URI or a unique suffix of a current-session resource URI."),
        path: string("Optional workspace-relative output path. Defaults to .inferoa/exports/<resource-id>.<ext>."),
        media_index: number("Optional zero-based media index when an evidence resource contains multiple media items."),
      },
      ["uri"],
    ),
  },
  {
    name: "run_command",
    description: "Run a bounded shell command, optionally as a background process.",
    permission: "shell",
    parameters: objectSchema(
      {
        command: string("Shell command to run."),
        cwd: string("Optional workspace-relative cwd."),
        timeout_ms: number("Timeout in milliseconds."),
        env: jsonObject("Additional environment variables."),
        background: boolean("Run in background and return process_id."),
      },
      ["command"],
    ),
  },
  {
    name: "run_experiment",
    description: "Run the active autoresearch benchmark harness with `bash autoresearch.sh`, capture output as a resource, and parse METRIC and ASI lines.",
    permission: "shell",
    parameters: objectSchema({
      timeout_ms: number("Timeout in milliseconds. Defaults to 600000."),
      timeout_seconds: number("Timeout in seconds. Used when timeout_ms is not supplied."),
    }),
  },
  {
    name: "session_note",
    description: "Append a durable session note.",
    permission: "read",
    parameters: objectSchema(
      {
        note: string("Note body."),
        tags: { type: "array", items: string("Tag.") },
      },
      ["note"],
    ),
  },
  {
    name: "skill_list",
    description: "List discovered skills as a compact index without loading full skill bodies.",
    permission: "read",
    parameters: objectSchema({
      query: string("Optional case-insensitive filter over id, name, or description."),
      include_disabled: boolean("Include skills that are not enabled in config. Defaults to true."),
      limit: number("Maximum skills."),
    }),
  },
  {
    name: "skill_enable",
    description: "Enable discovered skills by id or name and persist the workspace skill selection.",
    permission: "write",
    parameters: objectSchema(
      {
        ids: { type: "array", items: string("Skill id or exact skill name.") },
      },
      ["ids"],
    ),
  },
  {
    name: "skill_disable",
    description: "Disable skills by id or name and persist the workspace skill selection.",
    permission: "write",
    parameters: objectSchema(
      {
        ids: { type: "array", items: string("Skill id, exact skill name, or enabled entry.") },
      },
      ["ids"],
    ),
  },
  {
    name: "skill_read",
    description: "Read the full body for one discovered skill by id or name.",
    permission: "read",
    parameters: objectSchema(
      {
        id: string("Skill id or exact skill name."),
        line_count: number("Maximum lines to return."),
      },
      ["id"],
    ),
  },
  {
    name: "stop_process",
    description: "Stop a background process.",
    permission: "shell",
    parameters: objectSchema(
      {
        process_id: string("Session-scoped process id."),
        signal: string("Signal name. Defaults to SIGTERM."),
      },
      ["process_id"],
    ),
  },
  {
    name: "todo_write",
    description: "Replace the durable task ledger for this session.",
    permission: "read",
    parameters: objectSchema(
      {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      ["items"],
    ),
  },
  {
    name: "speech_generation",
    description: "Generate speech through a configured vLLM-Omni Speech endpoint.",
    permission: "network",
    parameters: objectSchema(
      {
        input: string("Text to synthesize."),
        model: string("Optional model override."),
        voice: string("Optional voice name."),
        instructions: string("Optional voice style or emotion instructions."),
        response_format: string("Optional response format: wav, pcm, flac, mp3, aac, or opus."),
        speed: number("Optional speed multiplier."),
        task_type: string("Optional Qwen3-TTS task type: CustomVoice, VoiceDesign, or Base."),
        language: string("Optional language name or Auto."),
        ref_audio: string("Optional reference audio URL, file path, data URI, or resource:// URI."),
        ref_text: string("Optional reference transcript."),
        seed: number("Optional seed."),
        max_new_tokens: number("Optional maximum tokens to generate."),
        extra_params: jsonObject("Optional model-specific extra parameters."),
      },
      ["input"],
    ),
  },
  {
    name: "speech_voices",
    description: "List voices exposed by a configured vLLM-Omni Speech endpoint.",
    permission: "network",
    parameters: objectSchema({}),
  },
  {
    name: "update_notes",
    description: "Persist the active autoresearch notes or append a single idea under an Ideas section.",
    permission: "read",
    parameters: objectSchema({
      body: string("Replacement notes body. Defaults to existing notes when append_idea is set."),
      append_idea: string("Optional idea to append as a bullet."),
    }),
  },
  {
    name: "video_generation",
    description: "Generate videos through a configured endpoint-backed Omni tool.",
    permission: "network",
    parameters: objectSchema(
      {
        prompt: string("Video generation prompt."),
        model: string("Optional model override."),
        mode: string("Optional mode: async (default) or sync for /videos/sync."),
        sync: boolean("Use the synchronous /videos/sync endpoint."),
        seconds: string("Optional duration in seconds as an integer string."),
        duration: number("Duration in seconds."),
        image_reference: string("Optional image reference URL, file path, data URI, or resource:// URI. Sent as vLLM-Omni image_reference JSON payload."),
        input_reference: string("Optional multipart input reference file path, data URI, or resource:// URI."),
        video_reference: string("Optional video reference URL, file path, data URI, or resource:// URI. Sent as vLLM-Omni video_reference JSON payload."),
        size: string("Optional size."),
        width: number("Optional video width."),
        height: number("Optional video height."),
        num_frames: number("Optional frame count."),
        fps: number("Optional frames per second."),
        num_inference_steps: number("Optional diffusion step count."),
        guidance_scale: number("Optional guidance scale."),
        guidance_scale_2: number("Optional secondary guidance scale."),
        boundary_ratio: number("Optional boundary ratio."),
        flow_shift: number("Optional flow shift."),
        true_cfg_scale: number("Optional true CFG scale."),
        negative_prompt: string("Optional negative prompt."),
        enable_frame_interpolation: boolean("Optionally enable frame interpolation."),
        frame_interpolation_exp: number("Optional frame interpolation exponent."),
        frame_interpolation_scale: number("Optional frame interpolation scale."),
        frame_interpolation_model_path: string("Optional frame interpolation model path."),
        lora: string("Optional LoRA adapter."),
        extra_params: jsonObject("Optional model-specific parameters."),
        seed: number("Optional seed."),
        timeout_ms: number("Optional job timeout in milliseconds."),
        poll_ms: number("Optional polling interval in milliseconds."),
      },
      ["prompt"],
    ),
  },
  {
    name: "video_understanding",
    description: "Analyze video inputs through a configured endpoint-backed Omni tool.",
    permission: "network",
    parameters: objectSchema(
      {
        inputs: { type: "array", items: string("Video URL, file path, data URI, or resource:// URI.") },
        prompt: string("Question or instruction."),
        model: string("Optional model override."),
        detail: string("Optional detail level."),
      },
      ["inputs", "prompt"],
    ),
  },
  {
    name: "vision_understanding",
    description: "Analyze images or screenshots through a configured multimodal endpoint.",
    permission: "network",
    parameters: objectSchema(
      {
        inputs: { type: "array", items: string("Image URL, file path, data URI, or resource:// URI.") },
        prompt: string("Question or instruction."),
        model: string("Optional model override."),
        detail: string("Optional detail level."),
      },
      ["inputs", "prompt"],
    ),
  },
  {
    name: "web_fetch",
    description: "Fetch a direct HTTP/HTTPS URL and extract readable text. This does not require a web_search provider. Use this for any user-provided URL or search result inspection.",
    permission: "network",
    parameters: objectSchema(
      {
        url: string("HTTP or HTTPS URL to fetch."),
        max_bytes: number("Maximum response bytes to read. Defaults to 1000000."),
        timeout_ms: number("Request timeout in milliseconds. Defaults to 20000."),
        format: string("text for extracted readable text, or html for raw HTML."),
      },
      ["url"],
    ),
  },
  {
    name: "web_open",
    description: "Open/surface an HTTP/HTTPS URL and return a lightweight readable preview. This does not require a web_search provider. Use web_fetch when the task needs full extraction controls.",
    permission: "network",
    parameters: objectSchema(
      {
        url: string("HTTP or HTTPS URL to open, surface, and preview."),
        note: string("Optional reason or instruction for the opened URL."),
        max_bytes: number("Maximum response bytes to read for the preview. Defaults to 500000."),
        timeout_ms: number("Request timeout in milliseconds. Defaults to 20000."),
        format: string("text for extracted readable text, or html for raw HTML."),
      },
      ["url"],
    ),
  },
  {
    name: "web_search",
    description: "Search the web for keyword queries through the configured provider or the default zero-key HTTP fallback chain. If the query contains a direct HTTP/HTTPS URL, it is fetched directly instead of being searched.",
    permission: "network",
    parameters: objectSchema(
      {
        query: string("Search query."),
        limit: number("Maximum results."),
        recency_days: number("Optional recency filter in days."),
      },
      ["query"],
    ),
  },
  {
    name: "write_file",
    description: "Create or replace a workspace file, or an absolute local file when workspace access is full.",
    permission: "write",
    parameters: objectSchema(
      {
        path: string("Workspace-relative path, or absolute local path when access is full."),
        content: string("Full file content."),
        overwrite: boolean("Allow replacing an existing file."),
      },
      ["path", "content"],
    ),
  },
  {
    name: "write_process",
    description: "Write stdin to a background process.",
    permission: "shell",
    parameters: objectSchema(
      {
        process_id: string("Session-scoped process id."),
        input: string("Input to write."),
        close_stdin: boolean("Close stdin after writing."),
      },
      ["process_id", "input"],
    ),
  },
] satisfies ToolDefinition[];

export const CORE_TOOL_DEFINITIONS: ToolDefinition[] = DEFINITIONS.slice().sort((a, b) => a.name.localeCompare(b.name));

const OMNI_TOOL_CAPABILITY: Record<string, keyof VllmAgentConfig["omni"]["endpoints"]> = {
  audio_generation: "audio_generation",
  audio_understanding: "audio_understanding",
  image_edit: "image_edit",
  image_generation: "image_generation",
  speech_generation: "speech",
  speech_voices: "speech",
  video_generation: "video_generation",
  video_understanding: "video_understanding",
  vision_understanding: "vision",
};

export function configuredToolDefinitions(config: VllmAgentConfig): ToolDefinition[] {
  return CORE_TOOL_DEFINITIONS.filter((tool) => {
    const capability = OMNI_TOOL_CAPABILITY[tool.name];
    if (!capability) {
      return true;
    }
    if (!config.omni.enabled) {
      return false;
    }
    const endpoint = config.omni.endpoints[capability];
    return Boolean(endpoint?.base_url && endpoint.model);
  });
}
