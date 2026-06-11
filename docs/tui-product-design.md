# TUI Product Design

Inferoa should feel like a purpose-built inference-native terminal product,
not a generic chat prompt.

## Brand Direction

The terminal UI should express:

- vLLM-native inference awareness;
- fast local/remote endpoint control;
- long-running coding focus;
- visible cache/context discipline;
- precise tool execution.

Visual language:

- dark, high-contrast base;
- cyan, blue, white, and graphite as the primary palette;
- sparing amber/red for warnings and destructive states;
- thin borders, compact panels, and dense but readable information;
- animated status accents for streaming, endpoint probing, tool execution, and
  compression;
- no decorative gradients or unrelated illustrations.

## Default Screen

`inferoa` opens the TUI home/chat surface.

First viewport:

- product wordmark;
- short workspace path;
- short session id/title;
- selected provider and model;
- compact Omni capability status;
- git branch and dirty state;
- context usage and compression status;
- recent sessions;
- full-width composer with `/` command discovery and `$` skill
  discovery.

The default chat banner should not expose base URLs, workspace ids, run ids,
client ids, cache salts, prompt epoch ids, or other internal routing values.
Those belong in explicit diagnostic views such as `/system` (also
`/endpoints`) and `/tokenmaxxing` (also `/activity`, `/cache`, `/rtk`,
`/evidence`, `/history`).

The UI should make the product identity obvious without forcing the user through
a marketing page.

Branding animation:

- the first launch should use a short full-screen intro that establishes the
  Inferoa mark, then dissolves into the working UI;
- the animation should use a terminal-native gradient/shine treatment with a
  fallback for 256-color and narrow terminals;
- the intro must be skippable with Enter, Space, Escape, or Ctrl-C;
- the working welcome screen should keep a lighter animated accent, not a
  constantly distracting full-screen animation.

## Input Model

Supported entrypoints:

- plain text submits a chat turn;
- `/` opens command palette;
- `$` opens skill catalog and skill filter;
- `!` opens shell command helper;
- file/path mentions trigger local path autocomplete;
- model/provider selectors are opened from setup or status views;
- image/video artifacts can be attached or referenced when Omni endpoints are
  configured.

`inferoa "prompt"` opens the same UI and sends the prompt as the first user
turn after initialization.

## Setup UX

Setup is scene-based and interactive.

Setup shell:

- full-screen splash;
- cross-dissolve transition into setup scenes;
- scene header with Inferoa mark, step count, title, and subtitle;
- tabbed panels where one setup step contains multiple related choices;
- modal input for secrets, callback URLs, endpoint probing, and confirmation;
- footer with keyboard hints;
- outro transition back to chat.

Provider setup flow:

1. Choose direct vLLM, auto Semantic Router, or external provider.
2. Enter endpoint URL.
3. Enter API key in a masked field; setup stores it in the local vault and
   writes only `api_key_ref`.
4. Probe `/v1/models`.
5. Select a model from a TUI list.
6. Run a minimal capability probe.
7. Review and save config.

Omni setup flow:

1. Add capability endpoint cards for vision, image generation, video
   understanding, video generation, audio understanding, and audio generation.
2. Probe each enabled endpoint independently.
3. Select model per capability.
4. Show unavailable capabilities as disabled, not failed.

## Chat Transcript

The transcript should render structured cards:

- user turns;
- assistant streaming output;
- tool call pending/running/complete/failed states;
- file diff preview;
- shell process output;
- git summary;
- todo/activity updates;
- code-intelligence references;
- context compression summaries;
- endpoint evidence;
- image/video artifacts.

Cards should be compact by default and expandable for large output or managed
resources.

Tool cards:

- pending/running cards use animated borders or spinner accents with bounded
  frame rates;
- completed cards switch to success/error styling without leaving active
  timers;
- arguments render inline when collapsed and as a JSON tree when expanded;
- results use tool-specific renderers instead of generic JSON whenever
  possible;
- image results render inline when the terminal supports images and fall back
  to dimensions/type markers when it does not.

File diff cards:

- show a streaming preview before the edit is applied;
- avoid jitter from partial streamed JSON by trimming trailing unbalanced
  removal/hunk lines until the matching additions arrive;
- show line numbers in a stable gutter;
- color removed and added lines distinctly;
- highlight changed tokens inside replaced lines;
- visualize leading tabs/spaces subtly so indentation edits are visible;
- syntax-highlight unchanged context lines when a language can be inferred.

## Session UX

`/sessions` is a chat-local overlay, not a separate command screen. It should
support:

- Resume: attach to an existing non-archived session;
- New session: create a fresh session in the current workspace;
- Rename: update the human-readable session title;
- Archive: hide a completed or stale session from the default list;
- Show all: include archived sessions and lock state.

Session rows show short session id, title, status, updated time, and a lock
summary such as `unlocked` or `locked daemon 2m`. They must not show
`workspace_id`, `run_id`, `client_id`, prompt epoch ids, or cache salts.

Shell/process cards:

- show command header, live output, and cancel hint;
- throttle high-throughput output updates so rendering cannot starve the event
  loop;
- keep full output in resources while the visible panel shows a bounded live
  preview;
- support expand/collapse after completion;
- show exit code, cancellation, hidden-line count, and truncation notices.

Turn footer:

- every assistant turn ends with a compact usage/cache footer;
- direct vLLM footer fields: prompt tokens, cached prompt tokens, cache hit
  rate, output tokens, request id, model, endpoint mode, and latency;
- external provider footer fields: prompt/output tokens and provider usage
  metadata when available;
- unsupported cache evidence is displayed as unavailable, not as zero.

## Animation Rules

Animations should communicate state, not decorate.

- streaming assistant text uses a subtle cursor or shimmer;
- endpoint probing shows a short pulse/spinner and resolves to success,
  warning, or error;
- tool execution shows elapsed time and changing status;
- shell/process output scrolls in a bounded panel;
- context compression shows a short transition from "archiving" to
  "summarized";
- image/video generation shows queued, generating, storing, and ready states.

Animations must stop when the underlying operation stops and must not flood the
event loop or corrupt terminal resize behavior.

Animation timing:

- setup splash can update around 30 FPS;
- pending tool borders can redraw up to the renderer's normal frame cadence
  while advancing spinner glyphs more slowly;
- high-throughput process output should be throttled and coalesced;
- todo/activity completion can use a short reveal animation, then settle.

## Status Line

The status line should prioritize:

- provider/model;
- endpoint mode: direct, auto, external;
- Omni capability status;
- workspace short path;
- session short id/title;
- git branch;
- context usage;
- daemon/job state;
- permission mode.

Internal ids such as workspace id, run id, client id, prompt epoch id, and cache
salt do not appear in normal UI.

The status line is not the only evidence surface. Per-turn cache hit rate must
be visible in the transcript footer so users can see whether a specific request
hit the vLLM prefix cache.

## Slash Commands

Slash commands are TUI-native commands, not legacy CLI aliases.

Initial command set:

- `/setup`: open setup wizard;
- `/model`: open model/provider selector;
- `/system`: open endpoint capability and signal view (also `/endpoint`,
  `/endpoints`);
- `/skills`: open discovered skill picker and enable/disable skills;
- `/tokenmaxxing`: show per-turn and aggregate token, cache, RTK, and
  routing savings (also `/cache`, `/rtk`, `/activity`, `/evidence`,
  `/history`);
- `/context`: show context and compression breakdown;
- `/tools`: show active fixed tool schemas and tool renderer status;
- `/sessions`: open session picker;
- `/daemon`: manage background daemon runs;
- `/doctor`: check endpoint, tool, optional Omni health, and trigger in-session tool regression;
- `/help`: show keyboard shortcuts and command list;
- `/exit`: exit the TUI.

Commands that do not map to Inferoa product surfaces should be deleted from
the active registry rather than retained for compatibility.

## Acceptance UX

Release acceptance is a strict development workflow, separate from the user
health check. The user-facing `/doctor` view should show:

- coding endpoint configuration and probe result;
- optional Omni capabilities without requiring every endpoint;
- daemon availability;
- tool and context readiness hints;
- `/doctor tools` as a non-release in-session regression that returns a report
  and improvement suggestions from the current agent.

Release acceptance may call automation underneath and should remain inspectable
for project maintainers:

- preflight endpoint checklist;
- AMD deployment checklist;
- external provider checklist;
- coding task progress;
- tool coverage checklist;
- compression evidence;
- Omni artifact checklist;
- daemon attach/detach/status/cancel checklist;
- final evidence report.

The TUI may call automation underneath, but the user should be able to watch
and inspect the acceptance run from the terminal app.
