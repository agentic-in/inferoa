import { setTimeout as delay } from "node:timers/promises";
import type {
  EndpointSignalSnapshot,
  ClarifyRequest,
  ClarifyResponse,
  JsonObject,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  RtkSavingsSummary,
  SessionRecord,
  ToolCall,
  ToolDefinition,
  ToolResult,
  VllmAgentConfig,
  WorkspaceIdentity,
} from "./types.js";
import { SessionStore } from "./session/store.js";
import { randomId } from "./util/hash.js";
import { PromptBuilder } from "./context/prompt.js";
import { ContextCompressor } from "./context/compressor.js";
import { ModelGateway } from "./model/gateway.js";
import { EndpointSignals, providerId } from "./model/endpoint-signals.js";
import { ToolRegistry } from "./tools/registry.js";
import { SkillRegistry } from "./skills/registry.js";
import { CodeIntelligenceHub } from "./code-intelligence/hub.js";
import { fail } from "./util/limit.js";
import { isAbortError, throwIfAborted } from "./util/abort.js";
import {
  applyGoalUsage,
  goalCompletionReportForRun,
  isGoalFrontierExhausted,
  modelUsageTokenCost,
  readGoalState,
  recordGoalCompletionReport,
  type GoalCompletionReport,
} from "./goals/state.js";

export interface RuntimeRunOptions {
  prompt: string;
  session_id?: string;
  title?: string;
  client_id?: string;
  owner_kind?: "cli" | "daemon";
  onDelta?: (text: string) => void;
  onStatus?: (event: RuntimeStatusEvent) => void;
  onClarify?: (request: ClarifyRequest) => Promise<ClarifyResponse>;
  max_tool_rounds?: number;
  request_class?: ModelRequest["request_class"];
  visibility?: "normal" | "internal";
  run_id?: string;
  signal?: AbortSignal;
}

export type RuntimeStatusEvent =
  | { type: "model_start"; model: string }
  | { type: "model_retry"; model: string; attempt: number; next_attempt: number; delay_ms: number; max_attempts?: number; error: string }
  | {
      type: "compression_start";
      reason: string;
      estimated_tokens: number;
      threshold_tokens: number;
    }
  | {
      type: "compression_end";
      reason: string;
      estimated_tokens: number;
      threshold_tokens: number;
      archive_resource_uri: string;
      archived_events: number;
      protected_tail_events: number;
      summary: string;
      protected_user_prompts?: string[];
    }
  | { type: "tool_start"; session_id: string; run_id: string; tool_name: string; tool_call_id: string; summary?: string }
  | {
      type: "tool_end";
      session_id: string;
      run_id: string;
      tool_name: string;
      tool_call_id: string;
      ok: boolean;
      summary: string;
      duration_ms: number;
    };

export interface RuntimeRunResult {
  session: SessionRecord;
  run_id: string;
  content: string;
  tool_rounds: number;
  tool_calls: number;
  duration_ms: number;
  tokens_used: number;
  rtk: RtkSavingsSummary;
  goal_report?: string;
}

export class Runtime {
  private readonly gateway: ModelGateway;
  private readonly endpointSignals: EndpointSignals;
  private readonly tools: ToolRegistry;
  private readonly promptBuilder: PromptBuilder;
  private readonly compressor: ContextCompressor;
  private readonly skills: SkillRegistry;
  readonly codeIntelligence: CodeIntelligenceHub;

  constructor(
    private readonly config: VllmAgentConfig,
    private readonly workspace: WorkspaceIdentity,
    private readonly store: SessionStore,
  ) {
    this.gateway = new ModelGateway(config);
    this.endpointSignals = new EndpointSignals(config);
    this.codeIntelligence = new CodeIntelligenceHub(config, workspace);
    this.tools = new ToolRegistry(config, workspace, store, this.codeIntelligence);
    this.promptBuilder = new PromptBuilder(config, store, workspace);
    this.compressor = new ContextCompressor(config, store, workspace, this.gateway);
    this.skills = new SkillRegistry(workspace, config);
  }

  async createSession(title?: string): Promise<SessionRecord> {
    return this.store.createSession(this.workspace, title);
  }

  async run(options: RuntimeRunOptions): Promise<RuntimeRunResult> {
    const session = options.session_id ? this.requiredSession(options.session_id) : await this.createSession(options.title ?? titleFromPrompt(options.prompt));
    const clientId = options.client_id ?? randomId("c");
    const runId = options.run_id ?? randomId("run");
    const requestClass = options.request_class ?? "interactive";
    const visibility = options.visibility ?? (requestClass === "reflection" ? "internal" : "normal");
    const startedAt = Date.now();
    let goalTokenUsage = 0;
    let toolRounds = 0;
    let toolCalls = 0;
    this.store.acquireLock(session.session_id, clientId, options.owner_kind ?? "cli");
    const heartbeat = setInterval(() => {
      this.store.heartbeatLock(session.session_id, clientId);
    }, 15_000);
    heartbeat.unref();
    try {
      throwIfAborted(options.signal);
      const discoveredSkills = await this.skills.discover();
      const enabledSkillNames = this.config.skills.enabled.slice().sort();
      const loadedSkills = await this.skills.loadEnabled(discoveredSkills);
      const availableTools = toolsForRequestClass(this.tools.list(), requestClass);
      this.store.appendEvent({
        session_id: session.session_id,
        run_id: runId,
        type: "session.resumed",
        data: {
          title: session.title,
          skill_count: discoveredSkills.length,
          enabled_skill_count: loadedSkills.length,
          enabled_skills: loadedSkills.map((skill) => skill.name),
        },
      });
      this.store.appendEvent({
        session_id: session.session_id,
        run_id: runId,
        type: "user.prompt",
        data: { prompt: options.prompt, request_class: requestClass, visibility },
      });
      toolCalls += await this.prefetchPromptUrls(options.prompt, session.session_id, runId, requestClass, visibility, options.onStatus, options.signal);

      let currentPrompt = options.prompt;
      let response: ModelResponse | undefined;
      const maxToolRounds = normalizeMaxToolRounds(options.max_tool_rounds);
      let stopped: JsonObject | undefined;
      let compressedThisRun = false;
      while (true) {
        throwIfAborted(options.signal);
        const sessionNow = this.requiredSession(session.session_id);
        const promptContext = this.promptBuilder.build(sessionNow, currentPrompt, availableTools, discoveredSkills, runId, enabledSkillNames);
        const pressure = await this.compressor.assess(promptContext);
        if (pressure.should_compact && (pressure.reason !== "forced-by-config" || !compressedThisRun)) {
          options.onStatus?.({
            type: "compression_start",
            reason: pressure.reason,
            estimated_tokens: pressure.estimated_tokens,
            threshold_tokens: pressure.threshold_tokens,
          });
          const compacted = await this.compressor.compact(sessionNow, promptContext, availableTools, pressure.reason, {
            activeRunId: runId,
            currentPrompt,
            skills: discoveredSkills,
            enabledSkillNames,
          });
          compressedThisRun = true;
          this.store.appendEvent({
            session_id: session.session_id,
            run_id: runId,
            type: "evidence.context_compression",
            data: {
              reason: pressure.reason,
              estimated_tokens: pressure.estimated_tokens,
              threshold_tokens: pressure.threshold_tokens,
              epoch_id: compacted.epoch_id,
              archive_resource_uri: compacted.resource_uri,
              archived_events: compacted.archived_events,
              protected_tail_events: compacted.protected_tail_events,
              protected_prompt_count: compacted.protected_user_prompts.length,
              protected_user_prompts: compacted.protected_user_prompts,
            },
          });
          options.onStatus?.({
            type: "compression_end",
            reason: pressure.reason,
            estimated_tokens: pressure.estimated_tokens,
            threshold_tokens: pressure.threshold_tokens,
            archive_resource_uri: compacted.resource_uri,
            archived_events: compacted.archived_events,
            protected_tail_events: compacted.protected_tail_events,
            summary: compacted.summary,
            protected_user_prompts: compacted.protected_user_prompts,
          });
        }
        throwIfAborted(options.signal);
        const rebuilt = this.promptBuilder.build(
          this.requiredSession(session.session_id),
          currentPrompt,
          availableTools,
          discoveredSkills,
          runId,
          enabledSkillNames,
        );
        const request: ModelRequest = {
          session_id: session.session_id,
          run_id: runId,
          mode: this.config.model_setup.mode,
          provider_id: providerId(this.config),
          model: this.config.model_setup.model ?? "",
          messages: rebuilt.messages,
          tools: availableTools,
          request_class: requestClass,
          prompt_hash: rebuilt.prompt_hash,
          tool_schema_hash: rebuilt.tool_schema_hash,
          prompt_epoch_id: rebuilt.epoch.prompt_epoch_id,
          cache_salt: rebuilt.epoch.cache_salt,
        };
        this.store.appendEvent({
          session_id: session.session_id,
          run_id: runId,
          type: "model.request.started",
          data: {
            provider_id: request.provider_id,
            mode: request.mode,
            model: request.model,
            request_class: request.request_class,
            prompt_hash: request.prompt_hash,
            tool_schema_hash: request.tool_schema_hash,
            estimated_tokens: rebuilt.estimated_tokens,
            prompt_epoch_id: request.prompt_epoch_id,
            visibility,
          },
        });
        options.onStatus?.({ type: "model_start", model: request.model });
        response = await this.streamModelWithRetry(request, options.onDelta, options.onStatus, options.signal);
        throwIfAborted(options.signal);
        const endpointSnapshot: EndpointSignalSnapshot = await this.endpointSignals.snapshot().catch((error) => ({
          mode: request.mode,
          provider_id: request.provider_id,
          base_url: this.config.model_setup.base_url,
          model: request.model,
          errors: [`endpoint snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`],
        }));
        this.store.recordEndpointEvidence(
          session.session_id,
          runId,
          request.provider_id,
          mergeEndpointEvidence(endpointSnapshot, this.gateway.evidenceFromResponse(request, response)),
          request.prompt_hash,
          request.tool_schema_hash,
        );
        this.store.appendEvent({
          session_id: session.session_id,
          run_id: runId,
          type: "model.response.settled",
          data: {
            content: response.content,
            tool_calls: response.tool_calls as never,
            usage: response.usage as never,
            request_id: response.request_id,
            response_id: response.response_id,
            model: response.model,
            request_class: requestClass,
            visibility,
          },
        });
        goalTokenUsage += modelUsageTokenCost(response.usage);
        if (!response.tool_calls.length) {
          break;
        }
        if (maxToolRounds !== undefined && toolRounds >= maxToolRounds) {
          stopped = { reason: "max_tool_rounds", max_tool_rounds: maxToolRounds };
          break;
        }
        toolRounds += 1;
        let shouldYieldAfterToolCalls = false;
        for (const call of response.tool_calls) {
          throwIfAborted(options.signal);
          await this.executeToolCall(call, session.session_id, runId, requestClass, visibility, options.onStatus, options.onClarify);
          toolCalls += 1;
          throwIfAborted(options.signal);
          const yieldEvent = goalYieldEventAfterToolCall(this.store, session.session_id, runId, requestClass, visibility);
          if (yieldEvent) {
            this.store.appendEvent(yieldEvent);
            shouldYieldAfterToolCalls = true;
            break;
          }
        }
        if (shouldYieldAfterToolCalls) {
          break;
        }
        currentPrompt =
          "Continue the task using the tool results. Failed tool results are evidence, not a reason to stop; use corrected arguments or another available tool when useful. Do not repeat the exact same failed call unless the arguments change. If independent reads, searches, edits, tests, or web fetches remain, keep calling tools; otherwise finish with a concise evidence-based summary.";
      }
      const finalSessionNow = this.requiredSession(session.session_id);
      const finalPromptContext = this.promptBuilder.build(finalSessionNow, currentPrompt, availableTools, discoveredSkills, runId, enabledSkillNames);
      const finalPressure = await this.compressor.assess(finalPromptContext);
      if (finalPressure.should_compact && (finalPressure.reason !== "forced-by-config" || !compressedThisRun)) {
        options.onStatus?.({
          type: "compression_start",
          reason: `post-run:${finalPressure.reason}`,
          estimated_tokens: finalPressure.estimated_tokens,
          threshold_tokens: finalPressure.threshold_tokens,
        });
        const compacted = await this.compressor.compact(finalSessionNow, finalPromptContext, availableTools, `post-run:${finalPressure.reason}`, {
          activeRunId: runId,
          currentPrompt,
          skills: discoveredSkills,
          enabledSkillNames,
        });
        compressedThisRun = true;
        this.store.appendEvent({
          session_id: session.session_id,
          run_id: runId,
          type: "evidence.context_compression",
          data: {
            reason: `post-run:${finalPressure.reason}`,
            estimated_tokens: finalPressure.estimated_tokens,
            threshold_tokens: finalPressure.threshold_tokens,
            epoch_id: compacted.epoch_id,
            archive_resource_uri: compacted.resource_uri,
            archived_events: compacted.archived_events,
            protected_tail_events: compacted.protected_tail_events,
            protected_prompt_count: compacted.protected_user_prompts.length,
            protected_user_prompts: compacted.protected_user_prompts,
          },
        });
        options.onStatus?.({
          type: "compression_end",
          reason: `post-run:${finalPressure.reason}`,
          estimated_tokens: finalPressure.estimated_tokens,
          threshold_tokens: finalPressure.threshold_tokens,
          archive_resource_uri: compacted.resource_uri,
          archived_events: compacted.archived_events,
          protected_tail_events: compacted.protected_tail_events,
          summary: compacted.summary,
          protected_user_prompts: compacted.protected_user_prompts,
        });
      }
      const metrics = runMetrics(startedAt, goalTokenUsage, toolRounds, toolCalls);
      const rtk = rtkSavingsForRun(this.store, session.session_id, runId, goalTokenUsage, toolCalls, this.config);
      if (stopped) {
        applyGoalUsage(
          this.store,
          session.session_id,
          metrics,
          runId,
        );
        const goalReport = recordGoalCompletionReport(this.store, session.session_id, runId);
        if (goalReport) {
          const reportBlock = renderGoalReportBlock(goalReport);
          response = response ? { ...response, content: appendGoalReport(response.content, reportBlock) } : response;
          options.onDelta?.(reportBlock);
        }
        this.store.appendEvent({
          session_id: session.session_id,
          run_id: runId,
          type: "run.stopped",
          data: {
            ...stopped,
            tool_rounds: toolRounds,
            tool_calls: toolCalls,
            tokens: goalTokenUsage,
            rtk: rtk as never,
            duration_ms: metrics.duration_ms,
          },
        });
      } else {
        applyGoalUsage(
          this.store,
          session.session_id,
          metrics,
          runId,
        );
        const goalReport = recordGoalCompletionReport(this.store, session.session_id, runId);
        if (goalReport) {
          const reportBlock = renderGoalReportBlock(goalReport);
          response = response ? { ...response, content: appendGoalReport(response.content, reportBlock) } : response;
          options.onDelta?.(reportBlock);
        }
        this.store.appendEvent({
          session_id: session.session_id,
          run_id: runId,
          type: "run.completed",
          data: {
            tool_rounds: toolRounds,
            tool_calls: toolCalls,
            tokens: goalTokenUsage,
            rtk: rtk as never,
            duration_ms: metrics.duration_ms,
          },
        });
      }
      return {
        session: this.requiredSession(session.session_id),
        run_id: runId,
        content: response?.content ?? "",
        tool_rounds: toolRounds,
        tool_calls: toolCalls,
        duration_ms: metrics.duration_ms,
        tokens_used: goalTokenUsage,
        rtk,
        goal_report: goalCompletionReportForRun(this.store, session.session_id, runId),
      };
    } catch (error) {
      const metrics = runMetrics(startedAt, goalTokenUsage, toolRounds, toolCalls);
      const rtk = rtkSavingsForRun(this.store, session.session_id, runId, goalTokenUsage, toolCalls, this.config);
      applyGoalUsage(
        this.store,
        session.session_id,
        metrics,
        runId,
      );
      const goalReport = recordGoalCompletionReport(this.store, session.session_id, runId);
      if (goalReport) {
        options.onDelta?.(renderGoalReportBlock(goalReport));
      }
      this.store.appendEvent({
        session_id: session.session_id,
        run_id: runId,
        type: "run.failed",
        data: {
          error: errorMessage(error),
          tool_rounds: toolRounds,
          tool_calls: toolCalls,
          tokens: goalTokenUsage,
          rtk: rtk as never,
          duration_ms: metrics.duration_ms,
        },
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
      this.store.releaseLock(session.session_id, clientId);
    }
  }

  private async streamModelWithRetry(
    request: ModelRequest,
    onDelta?: (text: string) => void,
    onStatus?: RuntimeRunOptions["onStatus"],
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const retry = normalizeModelRetryConfig(this.config.model_retry);
    let attempt = 1;
    while (true) {
      throwIfAborted(signal);
      let emittedDelta = false;
      try {
        return await this.streamModelAttempt(
          request,
          onDelta
            ? (text) => {
                emittedDelta = true;
                onDelta(text);
              }
            : undefined,
          signal,
          retry.request_timeout_ms,
        );
      } catch (error) {
        throwIfAborted(signal);
        if (isAbortError(error)) {
          throw error;
        }
        const retryable = isRetryableModelError(error);
        const canRetry = retryable && !emittedDelta && hasRemainingRetryAttempt(attempt, retry.max_attempts);
        if (!canRetry) {
          this.store.appendEvent({
            session_id: request.session_id,
            run_id: request.run_id,
            type: "model.request.failed",
            data: {
              provider_id: request.provider_id,
              mode: request.mode,
              model: request.model,
              request_class: request.request_class,
              prompt_hash: request.prompt_hash,
              tool_schema_hash: request.tool_schema_hash,
              prompt_epoch_id: request.prompt_epoch_id,
              attempt,
              retryable,
              streamed_delta: emittedDelta,
              error: errorMessage(error),
            },
          });
          throw error;
        }
        const delayMs = retryDelayMs(attempt, retry);
        this.store.appendEvent({
          session_id: request.session_id,
          run_id: request.run_id,
          type: "model.request.retry",
          data: {
            provider_id: request.provider_id,
            mode: request.mode,
            model: request.model,
            request_class: request.request_class,
            prompt_hash: request.prompt_hash,
            tool_schema_hash: request.tool_schema_hash,
            prompt_epoch_id: request.prompt_epoch_id,
            attempt,
            next_attempt: attempt + 1,
            delay_ms: delayMs,
            max_attempts: retry.max_attempts,
            error: errorMessage(error),
          },
        });
        onStatus?.({
          type: "model_retry",
          model: request.model,
          attempt,
          next_attempt: attempt + 1,
          delay_ms: delayMs,
          max_attempts: retry.max_attempts,
          error: errorMessage(error),
        });
        await delay(delayMs, undefined, { signal });
        attempt += 1;
      }
    }
  }

  private async streamModelAttempt(
    request: ModelRequest,
    onDelta: ((text: string) => void) | undefined,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<ModelResponse> {
    if (timeoutMs <= 0) {
      return await this.gateway.stream(request, onDelta, signal);
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(modelRequestTimeoutError(timeoutMs));
    }, timeoutMs);
    timeout.unref();
    const abortFromParent = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      abortFromParent();
    } else {
      signal?.addEventListener("abort", abortFromParent, { once: true });
    }
    try {
      return await this.gateway.stream(request, onDelta, controller.signal);
    } catch (error) {
      if (timedOut) {
        throw modelRequestTimeoutError(timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    }
  }

  async status(): Promise<Record<string, unknown>> {
    const signal = await this.endpointSignals.snapshot();
    return {
      workspace: {
        alias: this.workspace.alias,
        root: this.workspace.root,
      },
      model: this.gateway.capabilities(),
      endpoint_signals: signal,
      omni: {
        enabled: this.config.omni.enabled,
        endpoints: Object.fromEntries(
          Object.entries(this.config.omni.endpoints).map(([name, value]) => [
            name,
            {
              configured: Boolean(value?.base_url && value.model),
              base_url: value?.base_url,
              model: value?.model,
            },
          ]),
        ),
      },
      tools: this.tools.list().map((tool) => tool.name),
      rtk: await this.rtkStatus(),
    };
  }

  private async rtkStatus(): Promise<Record<string, unknown>> {
    const { resolveRtkStatus } = await import("./rtk/manager.js");
    return (await resolveRtkStatus(this.config, { allowDownload: false })) as unknown as Record<string, unknown>;
  }

  dispose(): void {
    this.codeIntelligence.dispose();
  }

  private async prefetchPromptUrls(
    prompt: string,
    sessionId: string,
    runId: string,
    requestClass: ModelRequest["request_class"],
    visibility: "normal" | "internal",
    onStatus?: RuntimeRunOptions["onStatus"],
    signal?: AbortSignal,
  ): Promise<number> {
    const urls = directHttpUrls(prompt).slice(0, 3);
    let toolCalls = 0;
    for (const url of urls) {
      throwIfAborted(signal);
      const result = await this.executeToolCall(
        { id: randomId("prefetch"), name: "web_open", arguments: { url, max_bytes: 1_000_000 } },
        sessionId,
        runId,
        requestClass,
        visibility,
        onStatus,
      );
      toolCalls += 1;
      throwIfAborted(signal);
      this.store.appendEvent({
        session_id: sessionId,
        run_id: runId,
        type: "web.prefetch",
        data: {
          url,
          ok: result.ok,
          summary: result.summary,
          resource_uri: result.resource_uri,
          data: result.data as JsonObject | undefined,
          error: result.error as JsonObject | undefined,
          request_class: requestClass,
          visibility,
        },
      });
    }
    return toolCalls;
  }

  private async executeToolCall(
    call: ToolCall,
    sessionId: string,
    runId: string,
    requestClass: ModelRequest["request_class"],
    visibility: "normal" | "internal",
    onStatus?: RuntimeRunOptions["onStatus"],
    onClarify?: RuntimeRunOptions["onClarify"],
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    onStatus?.({
      type: "tool_start",
      session_id: sessionId,
      run_id: runId,
      tool_name: call.name,
      tool_call_id: call.id,
      summary: summarizeToolStart(call.name, call.arguments),
    });
    let result: ToolResult;
    try {
      result = await this.tools.call(call, { session_id: sessionId, run_id: runId, request_class: requestClass, visibility, clarify: onClarify });
    } catch (error) {
      result = fail("tool_runtime_exception", error instanceof Error ? error.message : String(error));
      this.store.appendEvent({
        session_id: sessionId,
        run_id: runId,
        type: "tool.result",
        data: {
          tool_call_id: call.id,
          tool_name: call.name,
          request_class: requestClass,
          visibility,
          result: result as unknown as JsonObject,
        },
      });
    }
    onStatus?.({
      type: "tool_end",
      session_id: sessionId,
      run_id: runId,
      tool_name: call.name,
      tool_call_id: call.id,
      ok: result.ok,
      summary: result.summary,
      duration_ms: Date.now() - startedAt,
    });
    return result;
  }

  private requiredSession(sessionId: string): SessionRecord {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }
}

function titleFromPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 80) || "New session";
}

interface NormalizedModelRetryConfig {
  max_attempts?: number;
  initial_delay_ms: number;
  max_delay_ms: number;
  backoff_factor: number;
  jitter_ratio: number;
  request_timeout_ms: number;
}

function runMetrics(startedAt: number, tokens: number, toolRounds: number, toolCalls: number): {
  tokens: number;
  time_seconds: number;
  tool_rounds: number;
  tool_calls: number;
  duration_ms: number;
} {
  const durationMs = Date.now() - startedAt;
  return {
    tokens,
    time_seconds: Math.floor(durationMs / 1000),
    tool_rounds: toolRounds,
    tool_calls: toolCalls,
    duration_ms: durationMs,
  };
}

function rtkSavingsForRun(
  store: SessionStore,
  sessionId: string,
  runId: string,
  modelTokens: number,
  toolCalls: number,
  config: VllmAgentConfig,
): RtkSavingsSummary {
  const events = store.listEvents(sessionId).filter((event) => event.run_id === runId && event.type === "rtk.tool_savings");
  let rtkCommands = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let savedTokens = 0;
  let okEvents = 0;
  let unavailableEvents = 0;
  let nonOkEvents = 0;
  for (const event of events) {
    const data = event.data;
    rtkCommands += numberField(data.rtk_commands);
    inputTokens += numberField(data.input_tokens);
    outputTokens += numberField(data.output_tokens);
    savedTokens += numberField(data.saved_tokens);
    const status = stringField(data.status);
    if (status === "ok") {
      okEvents += 1;
    } else if (status === "unavailable") {
      unavailableEvents += 1;
      nonOkEvents += 1;
    } else if (status) {
      nonOkEvents += 1;
    }
  }
  const status = !config.rtk.enabled ? "disabled" : nonOkEvents > 0 && okEvents === 0 && unavailableEvents > 0 ? "unavailable" : nonOkEvents > 0 ? "partial" : "ok";
  return {
    tool_calls: toolCalls,
    rtk_tool_calls: events.length,
    rtk_commands: rtkCommands,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    saved_tokens: savedTokens,
    savings_pct: inputTokens > 0 ? (savedTokens / inputTokens) * 100 : 0,
    estimated_without_rtk_tokens: modelTokens + savedTokens,
    status,
  };
}

function goalYieldEventAfterToolCall(
  store: SessionStore,
  sessionId: string,
  runId: string,
  requestClass: ModelRequest["request_class"],
  visibility: "normal" | "internal",
): { session_id: string; run_id: string; type: string; data: JsonObject } | undefined {
  const state = readGoalState(store, sessionId);
  if (requestClass === "reflection") {
    if (state?.goal.last_reflection_run_id === runId && state.goal.reflection_status === "completed" && state.goal.last_reflection_decision) {
      return {
        session_id: sessionId,
        run_id: runId,
        type: "goal.reflection.decision_recorded",
        data: {
          goal_id: state.goal.id,
          frontier_generation: state.goal.frontier_generation,
          decision: state.goal.last_reflection_decision,
          request_class: requestClass,
          visibility,
        },
      };
    }
    return undefined;
  }
  if (!state?.enabled || state.goal.status !== "active" || !isGoalFrontierExhausted(state.goal)) {
    return undefined;
  }
  return {
    session_id: sessionId,
    run_id: runId,
    type: "goal.frontier.exhausted",
    data: {
      goal_id: state.goal.id,
      frontier_generation: state.goal.frontier_generation,
      request_class: requestClass,
      visibility,
    },
  };
}

function normalizeMaxToolRounds(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("max_tool_rounds must be a non-negative finite number when provided");
  }
  return Math.floor(value);
}

function normalizeModelRetryConfig(config: VllmAgentConfig["model_retry"]): NormalizedModelRetryConfig {
  const maxAttempts =
    config?.max_attempts === undefined || config.max_attempts <= 0 || !Number.isFinite(config.max_attempts) ? undefined : Math.floor(config.max_attempts);
  return {
    max_attempts: maxAttempts,
    initial_delay_ms: positiveFinite(config?.initial_delay_ms, 1000),
    max_delay_ms: positiveFinite(config?.max_delay_ms, 60_000),
    backoff_factor: Math.max(1, positiveFinite(config?.backoff_factor, 2)),
    jitter_ratio: Math.max(0, Math.min(1, finiteNumber(config?.jitter_ratio, 0.2))),
    request_timeout_ms: positiveFinite(config?.request_timeout_ms, 300_000),
  };
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function hasRemainingRetryAttempt(attempt: number, maxAttempts?: number): boolean {
  return maxAttempts === undefined || attempt < maxAttempts;
}

function retryDelayMs(attempt: number, config: NormalizedModelRetryConfig): number {
  const base = Math.min(config.max_delay_ms, config.initial_delay_ms * config.backoff_factor ** Math.max(0, attempt - 1));
  if (base <= 0 || config.jitter_ratio <= 0) {
    return Math.round(base);
  }
  const jitter = base * config.jitter_ratio * Math.random();
  return Math.round(Math.min(config.max_delay_ms, base + jitter));
}

function isRetryableModelError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  const message = errorMessage(error);
  const status = modelErrorStatus(message);
  if (status !== undefined) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  return /fetch failed|network|socket|timeout|timed out|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR|terminated/i.test(message);
}

function modelErrorStatus(message: string): number | undefined {
  const match = message.match(/\b(?:request failed|failed)\s+(\d{3})\b/i);
  if (!match?.[1]) {
    return undefined;
  }
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : undefined;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 600 ? `${message.slice(0, 597)}...` : message;
}

function modelRequestTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Model request timed out after ${timeoutMs}ms`);
  error.name = "ModelRequestTimeoutError";
  return error;
}

function renderGoalReportBlock(completion: GoalCompletionReport): string {
  return `\n\n${grayText(`Goal: ${completion.objective}\n${completion.report}`)}`;
}

function appendGoalReport(content: string, reportBlock: string): string {
  const trimmed = content.trimEnd();
  return trimmed ? `${trimmed}${reportBlock}` : reportBlock.trimStart();
}

function grayText(text: string): string {
  return `\x1b[38;5;244m${text}\x1b[0m`;
}

export function modelMessagesForDisplay(messages: ModelMessage[]): string {
  return messages.map((message) => `${message.role}: ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`).join("\n");
}

function summarizeToolStart(name: string, args: JsonObject): string {
  switch (name) {
    case "run_command":
      return startSummary("Running", stringField(args.command));
    case "run_experiment":
      return "Running autoresearch benchmark";
    case "clarify":
      return startSummary("Waiting for your answer", stringField(args.question));
    case "file_search":
      return startSummary("Searching", stringField(args.query));
    case "export_resource":
      return startSummary("Exporting", stringField(args.uri));
    case "glob":
      return startSummary("Scanning", stringField(args.pattern));
    case "goal":
      return summarizeGoalStart(args);
    case "plan":
      return startSummary("Updating plan", stringField(args.op));
    case "init_experiment":
      return startSummary("Initializing experiment", stringField(args.name));
    case "list_dir":
      return startSummary("Listing", stringField(args.path) ?? ".");
    case "log_experiment":
      return startSummary("Logging experiment", stringField(args.status));
    case "read_file":
    case "read_resource":
      return startSummary("Reading", stringField(args.path) ?? stringField(args.uri));
    case "write_file":
      return startSummary("Writing", stringField(args.path));
    case "edit_file":
    case "ast_edit":
      return startSummary("Editing", stringField(args.path));
    case "apply_patch":
      return "Applying patch";
    case "git_status":
      return "Checking git status";
    case "git_diff":
      return startSummary("Reading diff", stringField(args.path));
    case "git_show":
      return startSummary("Reading revision", stringField(args.rev) ?? stringField(args.revision));
    case "todo_write":
      return "Updating todo list";
    case "update_notes":
      return "Updating autoresearch notes";
    case "skill_list":
      return "Listing skills";
    case "skill_read":
      return startSummary("Reading skill", stringField(args.skill) ?? stringField(args.id));
    case "skill_enable":
    case "skill_disable":
      return startSummary("Updating skill", stringField(args.skill) ?? stringField(args.id));
    case "web_search":
      return startSummary("Searching web", stringField(args.query));
    case "web_fetch":
      return startSummary("Fetching", stringField(args.url));
    case "web_open":
      return startSummary("Opening", stringField(args.url));
    case "vision_understanding":
      return "Vision understanding";
    case "image_generation":
      return "Image generation";
    case "image_edit":
      return "Image edit";
    case "video_understanding":
      return "Video understanding";
    case "video_generation":
      return "Video generation";
    case "audio_understanding":
      return "Audio understanding";
    case "audio_generation":
      return "Audio generation";
    case "speech_generation":
      return "Speech generation";
    case "speech_voices":
      return "Speech voices";
    default:
      if (name.includes("image") || name.includes("vision") || name.includes("video") || name.includes("audio")) {
        return startSummary("Running", humanizeToolName(name));
      }
      return startSummary("Running tool", name);
  }
}

function startSummary(verb: string, detail?: string): string {
  return detail ? `${verb} ${detail}` : verb;
}

function humanizeToolName(name: string): string {
  return name.replace(/_/g, " ");
}

function summarizeGoalStart(args: JsonObject): string {
  switch (stringField(args.op)) {
    case "create":
      return "Starting goal";
    case "decompose":
    case "update_plan":
      return "Planning goal";
    case "update_step":
      return "Updating goal step";
    case "complete":
      return "Completing goal";
    case "drop":
      return "Dropping goal";
    case "resume":
      return "Resuming goal";
    case "get":
      return "Reading goal";
    default:
      return "Updating goal";
  }
}

function directHttpUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
    const raw = match[0]?.replace(/[.,;:!?。，、；：！？]+$/g, "");
    if (!raw || seen.has(raw)) {
      continue;
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        continue;
      }
      const value = parsed.toString();
      seen.add(value);
      urls.push(value);
    } catch {
      continue;
    }
  }
  return urls;
}

function toolsForRequestClass(tools: ToolDefinition[], requestClass: ModelRequest["request_class"]): ToolDefinition[] {
  if (requestClass !== "reflection") {
    return tools;
  }
  const allowed = new Set([
    "ast_grep",
    "file_search",
    "git_diff",
    "git_show",
    "git_status",
    "glob",
    "goal",
    "list_dir",
    "lsp",
    "read_file",
    "read_resource",
    "run_command",
    "session_note",
  ]);
  return tools.filter((tool) => allowed.has(tool.name));
}

function mergeEndpointEvidence(snapshot: EndpointSignalSnapshot, response: EndpointSignalSnapshot): EndpointSignalSnapshot {
  return {
    ...snapshot,
    ...response,
    headers: {
      ...(objectField(snapshot.headers) as Record<string, string>),
      ...(objectField(response.headers) as Record<string, string>),
    },
    errors: mergeStringArrays(snapshot.errors, response.errors),
    models: snapshot.models ?? response.models,
    load: snapshot.load ?? response.load,
    cache_metrics: snapshot.cache_metrics ?? response.cache_metrics,
  };
}

function objectField(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function mergeStringArrays(a: unknown, b: unknown): string[] | undefined {
  const out = [...stringArray(a), ...stringArray(b)];
  return out.length ? out : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
