import type { JsonObject, ModelMessage, SessionRecord, ToolDefinition, VllmAgentConfig, WorkspaceIdentity } from "../types.js";
import { ModelGateway } from "../model/gateway.js";
import { SessionStore } from "../session/store.js";
import { hashJson, randomId } from "../util/hash.js";
import { truncateText } from "../util/limit.js";
import { estimateTokens, PromptBuilder, type PromptContext } from "./prompt.js";
import type { SkillDescriptor } from "../skills/registry.js";

const COMPACTION_PROTECTED_PROMPT_LIMIT = 4_000;

export interface CompactDecision {
  should_compact: boolean;
  reason: string;
  estimated_tokens: number;
  threshold_tokens: number;
}

export class ContextCompressor {
  constructor(
    private readonly config: VllmAgentConfig,
    private readonly store: SessionStore,
    private readonly workspace: WorkspaceIdentity,
    private readonly gateway: ModelGateway,
  ) {}

  async assess(context: PromptContext): Promise<CompactDecision> {
    const estimated = context.estimated_tokens;
    const contextWindow = this.config.model_setup.context_window ?? this.config.context.context_window;
    const threshold = Math.floor(contextWindow * this.config.context.compression_threshold);
    if (this.config.context.force_compression) {
      return {
        should_compact: true,
        reason: "forced-by-config",
        estimated_tokens: estimated,
        threshold_tokens: threshold,
      };
    }
    if (estimated >= threshold) {
      return {
        should_compact: true,
        reason: "threshold",
        estimated_tokens: estimated,
        threshold_tokens: threshold,
      };
    }
    return {
      should_compact: false,
      reason: "below-threshold",
      estimated_tokens: estimated,
      threshold_tokens: threshold,
    };
  }

  async compact(
    session: SessionRecord,
    promptContext: PromptContext,
    tools: ToolDefinition[],
    reason: string,
    options: { activeRunId?: string; currentPrompt?: string; skills?: SkillDescriptor[]; enabledSkillNames?: string[] } = {},
  ): Promise<{ summary: string; epoch_id: string; resource_uri: string; archived_events: number; protected_tail_events: number; protected_user_prompts: string[] }> {
    const events = this.store.listEvents(session.session_id);
    const previousCompaction = events.filter((event) => event.type === "context.compacted").at(-1);
    const previousSummary = previousCompaction?.data.summary;
    const previousCutoff =
      typeof previousCompaction?.data.compacted_through_event_id === "number"
        ? previousCompaction.data.compacted_through_event_id
        : (previousCompaction?.id ?? 0);
    const compactedRegion = events.filter((event) => (event.id ?? 0) > previousCutoff);
    const summaryRegion = compactedRegion.filter((event) => !isInternalRawEvent(event));
    const protection = protectedLoopContext(events.filter((event) => !isInternalRawEvent(event)), options.activeRunId, options.currentPrompt, this.config.context.protected_recent_loops ?? 3);
    const protectedPromptExcerpts = protection.protected_user_prompts.map(protectedPromptExcerpt);
    const raw = JSON.stringify(compactedRegion, null, 2);
    const resource = this.store.putResource(session.session_id, "compaction.archive", raw, {
      reason,
      event_count: compactedRegion.length,
    });
    let summary = deterministicSummary(session, this.workspace.root, summaryRegion, previousSummary, protectedPromptExcerpts);
    if (this.config.model_setup.base_url && this.config.model_setup.model && compactedRegion.length > 0) {
      try {
        const runId = randomId("run");
        const compactionMessages: ModelMessage[] = [
          {
            role: "system",
            content:
              "Summarize Inferoa session state using exactly these headings: Goal, Open Objectives, Constraints And Preferences, Progress, Key Decisions, Files And Code, Commands And Outcomes, Errors And Fixes, Critical Context, Next Steps, Resources And Evidence. Preserve exact paths, commands, endpoint names, resource URIs, and protected user prompt excerpts. Do not invent facts.",
          },
          {
            role: "user",
            content: JSON.stringify({
              previous_summary: previousSummary ?? null,
              archive_resource: resource.uri,
              protected_user_prompts: protectedPromptExcerpts,
              protected_loops: protection.protected_loops.map(boundProtectedLoop),
              compacted_events: summarizeEventsForCompaction(summaryRegion, protection.protected_user_prompts),
            }),
          },
        ];
        const compactionToolSchemaHash = hashJson([]);
        const compactionPromptHash = hashJson({ messages: compactionMessages, tool_schema_hash: compactionToolSchemaHash });
        const response = await this.gateway.stream({
          session_id: session.session_id,
          run_id: runId,
          mode: this.config.model_setup.mode,
          provider_id: this.config.model_setup.provider ?? this.config.model_setup.router ?? "unknown",
          model: this.config.model_setup.model,
          request_class: "compaction",
          messages: compactionMessages,
          tools: [],
          prompt_hash: compactionPromptHash,
          tool_schema_hash: compactionToolSchemaHash,
          prompt_epoch_id: promptContext.epoch.prompt_epoch_id,
          cache_salt: promptContext.epoch.cache_salt,
          max_tokens: 1600,
          temperature: 0,
        });
        if (response.content.trim()) {
          summary = response.content.trim();
          this.store.recordEndpointEvidence(
            session.session_id,
            runId,
            this.config.model_setup.provider ?? this.config.model_setup.router ?? "unknown",
            this.gateway.evidenceFromResponse(
              {
                session_id: session.session_id,
                run_id: runId,
                mode: this.config.model_setup.mode,
                provider_id: this.config.model_setup.provider ?? this.config.model_setup.router ?? "unknown",
                model: this.config.model_setup.model,
                messages: [],
                tools: [],
                request_class: "compaction",
                prompt_hash: compactionPromptHash,
                tool_schema_hash: compactionToolSchemaHash,
                prompt_epoch_id: promptContext.epoch.prompt_epoch_id,
              },
              response,
            ),
            compactionPromptHash,
            compactionToolSchemaHash,
          );
        }
      } catch (error) {
        summary += `\n\nErrors And Fixes\n- Model compaction unavailable; used deterministic summary. Error: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    const compactedThroughEventId = Math.max(0, ...this.store.listEvents(session.session_id).map((event) => event.id ?? 0));
    this.store.appendEvent({
      session_id: session.session_id,
      type: "context.compacted",
      data: {
        reason,
        summary,
        archive_resource_uri: resource.uri,
        archived_events: compactedRegion.length,
        estimated_tokens_before: promptContext.estimated_tokens,
        protected_tail_events: protection.protected_event_count,
        protected_prompt_count: protectedPromptExcerpts.length,
        protected_user_prompts: protectedPromptExcerpts,
        protected_loops: protection.protected_loops.map(boundProtectedLoop),
        compacted_through_event_id: compactedThroughEventId,
      },
    });
    const builder = new PromptBuilder(this.config, this.store, this.workspace);
    const sessionNow = this.store.getSession(session.session_id) ?? session;
    const rebuilt = builder.build(sessionNow, options.currentPrompt ?? "", tools, options.skills ?? [], options.activeRunId, options.enabledSkillNames);
    return {
      summary,
      epoch_id: rebuilt.epoch.prompt_epoch_id,
      resource_uri: resource.uri,
      archived_events: compactedRegion.length,
      protected_tail_events: protection.protected_event_count,
      protected_user_prompts: protectedPromptExcerpts,
    };
  }
}

interface ProtectedLoopContext {
  protected_user_prompts: string[];
  protected_event_count: number;
  protected_loops: JsonObject[];
}

const PROTECTED_TAIL_EVENT_TYPES = new Set([
  "user.prompt",
  "model.response.settled",
  "tool.result",
  "goal.completion_report",
  "run.completed",
  "run.stopped",
  "run.failed",
]);
const PROTECTED_LOOP_TOOL_RESULT_LIMIT = 12;
const COMPACTION_EVENT_TOOL_RESULT_LIMIT_PER_RUN = 12;

function protectedLoopContext(events: { id?: number; run_id?: string; type: string; data: JsonObject; created_at?: string }[], activeRunId?: string, currentPrompt?: string, protectedRecentLoops = 3): ProtectedLoopContext {
  const userEvents = events.filter((event) => event.type === "user.prompt" && typeof event.data.prompt === "string");
  const activeUserEvents = activeRunId ? userEvents.filter((event) => event.run_id === activeRunId) : [];
  const activeIds = new Set(activeUserEvents.map((event) => event.id));
  const priorUserEvents = userEvents.filter((event) => !activeIds.has(event.id));
  const protectedUsers = [...priorUserEvents.slice(-Math.max(0, protectedRecentLoops)), ...activeUserEvents];
  if (currentPrompt && !protectedUsers.some((event) => event.data.prompt === currentPrompt)) {
    protectedUsers.push({ type: "user.prompt", data: { prompt: currentPrompt }, run_id: activeRunId });
  }
  const prompts = uniqueStrings(protectedUsers.map((event) => String(event.data.prompt ?? "")).filter(Boolean));
  const protectedRunIds = new Set(protectedUsers.map((event) => event.run_id).filter((runId): runId is string => Boolean(runId)));
  const protectedLoops = [...protectedRunIds].map((runId) => summarizeLoop(events.filter((event) => event.run_id === runId), runId));
  return {
    protected_user_prompts: prompts,
    protected_event_count: countProtectedTailEvents(events, protectedUsers, protectedRunIds),
    protected_loops: protectedLoops,
  };
}

function countProtectedTailEvents(
  events: { id?: number; run_id?: string; type: string; data: JsonObject; created_at?: string }[],
  protectedUsers: { id?: number; run_id?: string; type: string; data: JsonObject; created_at?: string }[],
  protectedRunIds: Set<string>,
): number {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.run_id && protectedRunIds.has(event.run_id) && PROTECTED_TAIL_EVENT_TYPES.has(event.type)) {
      keys.add(eventKey(event));
    }
  }
  for (const event of protectedUsers) {
    keys.add(eventKey(event));
  }
  return keys.size;
}

function eventKey(event: { id?: number; run_id?: string; type: string; data: JsonObject; created_at?: string }): string {
  if (typeof event.id === "number") {
    return `id:${event.id}`;
  }
  const prompt = typeof event.data.prompt === "string" ? event.data.prompt : "";
  return `${event.run_id ?? ""}:${event.type}:${prompt}:${event.created_at ?? ""}`;
}

function summarizeLoop(events: { type: string; data: JsonObject; created_at?: string }[], runId: string): JsonObject {
  const prompt = events.find((event) => event.type === "user.prompt")?.data.prompt;
  const toolEvents = events.filter((event) => event.type === "tool.result");
  const tools = toolEvents.slice(0, PROTECTED_LOOP_TOOL_RESULT_LIMIT).map(summarizeToolResultEvent);
  const omittedToolResults = Math.max(0, toolEvents.length - tools.length);
  const final = events.filter((event) => event.type === "model.response.settled").at(-1)?.data.content;
  const goalReport = events.filter((event) => event.type === "goal.completion_report").at(-1)?.data.report;
  const goalSummary = events.filter((event) => event.type === "goal.completion_report").at(-1)?.data.completion_summary;
  const runStatus = events.filter((event) => event.type === "run.completed" || event.type === "run.stopped" || event.type === "run.failed").at(-1);
  return {
    run_id: runId,
    user_prompt: typeof prompt === "string" ? protectedPromptExcerpt(prompt) : undefined,
    tool_results: tools,
    omitted_tool_results: omittedToolResults || undefined,
    final_response: typeof final === "string" && final ? final.slice(0, 1000) : undefined,
    goal_report: typeof goalReport === "string" && goalReport ? goalReport.slice(0, 1000) : undefined,
    goal_summary: typeof goalSummary === "string" && goalSummary ? goalSummary.slice(0, 1000) : undefined,
    run_status: runStatus ? summarizeRunLifecycle(runStatus) : undefined,
  };
}

function summarizeEventsForCompaction(
  events: { type: string; data: JsonObject; created_at?: string; run_id?: string }[],
  protectedUserPrompts: string[],
): JsonObject[] {
  const summaries: JsonObject[] = [];
  const toolResultCounts = new Map<string, number>();
  const omittedToolResults = new Map<string, number>();
  for (const event of events) {
    if (event.type === "user.prompt" && !protectedUserPrompts.includes(String(event.data.prompt ?? ""))) {
      continue;
    }
    if (event.type === "tool.result") {
      const runKey = event.run_id ?? "";
      const count = toolResultCounts.get(runKey) ?? 0;
      if (count >= COMPACTION_EVENT_TOOL_RESULT_LIMIT_PER_RUN) {
        omittedToolResults.set(runKey, (omittedToolResults.get(runKey) ?? 0) + 1);
        continue;
      }
      toolResultCounts.set(runKey, count + 1);
    }
    summaries.push(summarizeEventForCompaction(event));
  }
  for (const [runId, omitted] of omittedToolResults) {
    summaries.push({
      type: "tool.results.omitted",
      run_id: runId || undefined,
      omitted_tool_results: omitted,
      limit: COMPACTION_EVENT_TOOL_RESULT_LIMIT_PER_RUN,
    });
  }
  return summaries;
}

function summarizeToolResultEvent(event: { data: JsonObject; created_at?: string }): JsonObject {
  const result = objectField(event.data.result);
  const resourceUris = collectResourceUris(result);
  return {
    tool_name: event.data.tool_name,
    tool_call_id: event.data.tool_call_id,
    summary: result.summary ?? event.data.summary,
    ok: result.ok,
    resource_uri: resourceUris[0],
    resource_uris: resourceUris.length ? resourceUris : undefined,
  };
}

function summarizeEventForCompaction(event: { type: string; data: JsonObject; created_at?: string }): JsonObject {
  if (event.type === "user.prompt") {
    return {
      type: event.type,
      prompt: typeof event.data.prompt === "string" ? protectedPromptExcerpt(event.data.prompt) : event.data.prompt,
      created_at: event.created_at,
    };
  }
  if (event.type === "tool.result") {
    return {
      type: event.type,
      ...summarizeToolResultEvent(event),
      created_at: event.created_at,
    };
  }
  if (event.type === "model.response.settled") {
    const calls = Array.isArray(event.data.tool_calls) ? event.data.tool_calls : [];
    const content = typeof event.data.content === "string" ? event.data.content : "";
    return {
      type: event.type,
      content: content.slice(0, 1000),
      tool_call_count: calls.length,
      created_at: event.created_at,
    };
  }
  if (event.type === "goal.completion_report") {
    return {
      type: event.type,
      completion_summary: typeof event.data.completion_summary === "string" ? event.data.completion_summary.slice(0, 1000) : undefined,
      report: typeof event.data.report === "string" ? event.data.report.slice(0, 1000) : undefined,
      tool_rounds: event.data.tool_rounds,
      tool_calls: event.data.tool_calls,
      tokens: event.data.tokens,
      duration_ms: event.data.duration_ms,
      created_at: event.created_at,
    };
  }
  if (event.type === "goal.reflection.completed") {
    return {
      type: event.type,
      decision: event.data.decision,
      frontier_generation: event.data.frontier_generation,
      summary: stringSummary(event.data.summary),
      verification_evidence: event.data.verification_evidence,
      blocker: stringSummary(event.data.blocker),
      created_at: event.created_at,
    };
  }
  if (event.type === "goal.frontier.expanded") {
    return {
      type: event.type,
      frontier_generation: event.data.frontier_generation,
      step_count: event.data.step_count,
      active_step_id: event.data.active_step_id,
      created_at: event.created_at,
    };
  }
  if (event.type === "model.request.started") {
    return {
      type: event.type,
      provider_id: event.data.provider_id,
      model: event.data.model,
      request_class: event.data.request_class,
      prompt_hash: event.data.prompt_hash,
      tool_schema_hash: event.data.tool_schema_hash,
      prompt_epoch_id: event.data.prompt_epoch_id,
      estimated_tokens: event.data.estimated_tokens,
      created_at: event.created_at,
    };
  }
  if (event.type === "endpoint.evidence.recorded") {
    return {
      type: event.type,
      provider_id: event.data.provider_id,
      mode: event.data.mode,
      model: event.data.model,
      request_id: event.data.request_id,
      response_id: event.data.response_id,
      request_class: event.data.request_class,
      prompt_hash: event.data.prompt_hash,
      tool_schema_hash: event.data.tool_schema_hash,
      prompt_epoch_id: event.data.prompt_epoch_id,
      prompt_tokens: event.data.prompt_tokens,
      cached_prompt_tokens: event.data.cached_prompt_tokens,
      cache_hit_rate: event.data.cache_hit_rate,
      created_at: event.created_at,
    };
  }
  if (event.type === "model.request.retry") {
    return {
      type: event.type,
      provider_id: event.data.provider_id,
      mode: event.data.mode,
      model: event.data.model,
      request_class: event.data.request_class,
      prompt_hash: event.data.prompt_hash,
      tool_schema_hash: event.data.tool_schema_hash,
      prompt_epoch_id: event.data.prompt_epoch_id,
      attempt: event.data.attempt,
      next_attempt: event.data.next_attempt,
      delay_ms: event.data.delay_ms,
      max_attempts: event.data.max_attempts,
      error: stringSummary(event.data.error),
      created_at: event.created_at,
    };
  }
  if (event.type === "model.request.failed") {
    return {
      type: event.type,
      provider_id: event.data.provider_id,
      mode: event.data.mode,
      model: event.data.model,
      request_class: event.data.request_class,
      prompt_hash: event.data.prompt_hash,
      tool_schema_hash: event.data.tool_schema_hash,
      prompt_epoch_id: event.data.prompt_epoch_id,
      attempt: event.data.attempt,
      retryable: event.data.retryable,
      streamed_delta: event.data.streamed_delta,
      error: stringSummary(event.data.error),
      created_at: event.created_at,
    };
  }
  if (event.type === "run.completed" || event.type === "run.stopped" || event.type === "run.failed") {
    return summarizeRunLifecycle(event);
  }
  if (event.type === "evidence.context_compression") {
    return {
      type: event.type,
      reason: event.data.reason,
      estimated_tokens: event.data.estimated_tokens,
      threshold_tokens: event.data.threshold_tokens,
      archive_resource_uri: event.data.archive_resource_uri,
      archived_events: event.data.archived_events,
      protected_tail_events: event.data.protected_tail_events,
      protected_prompt_count: event.data.protected_prompt_count,
      created_at: event.created_at,
    };
  }
  if (event.type === "context.compacted") {
    return {
      type: event.type,
      reason: event.data.reason,
      archive_resource_uri: event.data.archive_resource_uri,
      archived_events: event.data.archived_events,
      protected_tail_events: event.data.protected_tail_events,
      protected_prompt_count: event.data.protected_prompt_count,
      compacted_through_event_id: event.data.compacted_through_event_id,
      created_at: event.created_at,
    };
  }
  return {
    type: event.type,
    created_at: event.created_at,
  };
}

function isInternalRawEvent(event: { type: string; data: JsonObject }): boolean {
  if (event.data.visibility !== "internal" && event.data.request_class !== "reflection") {
    return false;
  }
  return event.type === "user.prompt" || event.type === "model.response.settled" || event.type === "tool.call" || event.type === "tool.result" || event.type === "web.prefetch";
}

function summarizeRunLifecycle(event: { type: string; data: JsonObject; created_at?: string }): JsonObject {
  return {
    type: event.type,
    reason: event.data.reason,
    error: stringSummary(event.data.error),
    tool_rounds: event.data.tool_rounds,
    tool_calls: event.data.tool_calls,
    tokens: event.data.tokens,
    duration_ms: event.data.duration_ms,
    created_at: event.created_at,
  };
}

function stringSummary(value: unknown, max = 1000): string | undefined {
  return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

function objectField(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function collectResourceUris(value: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  function visit(raw: unknown): void {
    if (typeof raw === "string") {
      if (raw.startsWith("resource://") && !seen.has(raw)) {
        seen.add(raw);
        out.push(raw);
      }
      return;
    }
    if (!raw || typeof raw !== "object") {
      return;
    }
    if (Array.isArray(raw)) {
      for (const item of raw) {
        visit(item);
      }
      return;
    }
    for (const [key, nested] of Object.entries(raw)) {
      if (/resource_uri|output_resource_uri|archive_resource_uri/i.test(key)) {
        visit(nested);
        continue;
      }
      if (typeof nested === "object") {
        visit(nested);
      }
    }
  }
  visit(value);
  return out.slice(0, 20);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}

function deterministicSummary(
  session: SessionRecord,
  workspaceRoot: string,
  events: { type: string; data: JsonObject; created_at?: string }[],
  previous: unknown,
  protectedUserPromptExcerpts: string[],
): string {
  const files = new Set<string>();
  const commands: string[] = [];
  const resources: string[] = [];
  for (const event of events) {
    const data = JSON.stringify(event.data);
    for (const match of data.matchAll(/"path":"([^"]+)"/g)) {
      if (match[1]) files.add(match[1]);
    }
    if (event.type === "tool.call" && typeof event.data.tool_name === "string" && event.data.tool_name === "run_command") {
      commands.push(String((event.data.arguments as JsonObject | undefined)?.command ?? ""));
    }
    if (data.includes("resource://")) {
      for (const match of data.matchAll(/resource:\/\/[^"\\\s]+/g)) {
        resources.push(match[0]);
      }
    }
  }
  return [
    `Goal\n- Continue session ${session.session_id} in ${workspaceRoot}.`,
    `Open Objectives\n${protectedUserPromptExcerpts.map((prompt) => `- ${prompt}`).join("\n") || "- No protected user prompts."}`,
    "Constraints And Preferences\n- Preserve user-facing identity as current directory plus session id/title.\n- Keep internal ids out of user workflow.",
    `Progress\n- Compacted ${events.length} older events.\n- Previous summary present: ${typeof previous === "string" && previous.length > 0}.`,
    "Key Decisions\n- Use durable resources for bulky historical data.",
    `Files And Code\n${[...files].slice(0, 20).map((file) => `- ${file}`).join("\n") || "- No file paths detected."}`,
    `Commands And Outcomes\n${commands.slice(-10).map((command) => `- ${command}`).join("\n") || "- No commands detected."}`,
    "Errors And Fixes\n- No deterministic error summary available.",
    "Critical Context\n- Recent tool-call/result pairs remain in the prompt tail outside this summary.",
    "Next Steps\n- Continue from the current request and recent tail.",
    `Resources And Evidence\n${resources.slice(-20).map((uri) => `- ${uri}`).join("\n") || "- No resource handles detected."}`,
  ].join("\n\n");
}

function protectedPromptExcerpt(prompt: string): string {
  return truncateText(prompt, COMPACTION_PROTECTED_PROMPT_LIMIT).text;
}

function boundProtectedLoop(loop: JsonObject): JsonObject {
  const next = { ...loop };
  if (typeof next.user_prompt === "string") {
    next.user_prompt = protectedPromptExcerpt(next.user_prompt);
  }
  return next;
}

export function promptPressureFromMessages(messages: ModelMessage[]): number {
  return estimateTokens(JSON.stringify(messages));
}
