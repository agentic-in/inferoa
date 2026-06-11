import type {
  EndpointSignalSnapshot,
  JsonObject,
  JsonValue,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelSetup,
  ToolCall,
  ToolDefinition,
  VllmAgentConfig,
} from "../types.js";
import { endpointApiKey } from "../config/config.js";
import { throwIfAborted } from "../util/abort.js";
import { stableJson } from "../util/hash.js";
import { authHeaders, modelBaseUrl, normalizeUsage, providerId, signalHeaders } from "./endpoint-signals.js";
import { externalProviderById, externalProviderProfileForModel, externalProviderRequiresApiKey } from "./providers.js";
import { openAiResponsesPromptCacheControls } from "./prompt-cache.js";

interface OpenAiToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
}

class ModelGatewayError extends Error {
  constructor(message: string, readonly diagnostics?: JsonObject) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

export class ModelGateway {
  constructor(private readonly config: VllmAgentConfig) {}

  capabilities(): JsonObject {
    const setup = this.config.model_setup;
    return {
      mode: setup.mode,
      provider: setup.provider ?? setup.router ?? "unknown",
      profile: setup.profile,
      base_url: setup.base_url,
      model: setup.model,
      tool_calling: true,
      streaming: true,
    };
  }

  async stream(request: ModelRequest, onDelta?: (text: string) => void, signal?: AbortSignal): Promise<ModelResponse> {
    throwIfAborted(signal);
    const setup = this.config.model_setup;
    if (!setup.base_url) {
      throw new Error("No model endpoint configured. Set model_setup.base_url or INFEROA_BASE_URL.");
    }
    if (!setup.model && !request.model) {
      throw new Error("No model configured. Set model_setup.model or INFEROA_MODEL.");
    }
    const externalProvider = setup.provider === "external" ? externalProviderById(setup.provider_id) : undefined;
    if (setup.provider === "external" && (!externalProvider || externalProviderRequiresApiKey(externalProvider)) && !endpointApiKey(setup)) {
      throw new Error(`No API key found for ${externalProvider?.label ?? "the external provider"}. Run /setup and paste the key once; config stores only api_key_ref.`);
    }
    const effectiveProfile =
      setup.provider === "external"
        ? externalProviderProfileForModel(externalProvider, request.model || setup.model, setup.profile)
        : setup.profile;
    const effectiveSetup = effectiveProfile === setup.profile ? setup : { ...setup, profile: effectiveProfile };
    if (setup.provider === "external" && effectiveProfile === "openai_responses") {
      return await this.callOpenAiResponses(effectiveSetup, request, onDelta, signal);
    }
    if (setup.provider === "external" && effectiveProfile === "anthropic") {
      return await this.callAnthropic(effectiveSetup, request, onDelta, signal);
    }
    if (setup.provider === "external" && effectiveProfile === "gemini") {
      return await this.callGemini(effectiveSetup, request, onDelta, signal);
    }
    return await this.callOpenAiCompatible(effectiveSetup, request, onDelta, signal);
  }

  private async callOpenAiCompatible(
    setup: ModelSetup,
    request: ModelRequest,
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    throwIfAborted(signal);
    const base = modelBaseUrl(setup);
    const headers = new Headers(authHeaders(setup, "chat_completions"));
    headers.set("accept", "text/event-stream");
    headers.set("x-session-id", request.session_id);
    headers.set("x-inferoa-session-id", request.session_id);
    headers.set("x-inferoa-run-id", request.run_id);
    if (request.request_class) {
      headers.set("x-inferoa-request-class", request.request_class);
    }
    const body = {
      model: request.model || setup.model,
      messages: request.messages.map(toOpenAiMessage),
      tools: sortedTools(request.tools).map(toOpenAiTool),
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
      temperature: request.temperature ?? 0.2,
      max_tokens: request.max_tokens,
      cache_salt: setup.provider === "vllm" ? request.cache_salt ?? setup.cache_salt : undefined,
    };
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const headerSignals = signalHeaders(response.headers);
    if (!response.ok || !response.body) {
      throw await modelGatewayHttpError("Model", response, headerSignals);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let content = "";
    let usage: ReturnType<typeof normalizeUsage>;
    let responseId: string | undefined;
    let responseModel: string | undefined;
    const toolCalls = new Map<number, OpenAiToolCallAccumulator>();
    let lastToolCallIndex: number | undefined;
    let lastRaw: JsonObject | undefined;
    const streamWarnings: string[] = [];

    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) {
          continue;
        }
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          continue;
        }
        const json = parseSseJsonPayload(payload, streamWarnings);
        if (!json) {
          continue;
        }
        lastRaw = json as JsonObject;
        responseId = typeof json.id === "string" ? json.id : responseId;
        responseModel = typeof json.model === "string" ? json.model : responseModel;
        usage = normalizeUsage(json.usage) ?? usage;
        const choices = Array.isArray(json.choices) ? (json.choices as Record<string, unknown>[]) : [];
        for (const choice of choices) {
          const delta = choice.delta as Record<string, unknown> | undefined;
          const text = typeof delta?.content === "string" ? delta.content : "";
          if (text) {
            content += text;
            onDelta?.(text);
          }
          const deltas = Array.isArray(delta?.tool_calls) ? (delta.tool_calls as Record<string, unknown>[]) : [];
          for (const toolDelta of deltas) {
            const index = accumulateOpenAiToolDelta(toolDelta, toolCalls, lastToolCallIndex);
            lastToolCallIndex = index;
          }
          const legacyFunctionCall = delta?.function_call as Record<string, unknown> | undefined;
          if (legacyFunctionCall) {
            const index = accumulateOpenAiLegacyFunctionCall(legacyFunctionCall, toolCalls, lastToolCallIndex);
            lastToolCallIndex = index;
          }
          const message = choice.message as Record<string, unknown> | undefined;
          if (typeof message?.content === "string" && message.content) {
            content += message.content;
            onDelta?.(message.content);
          }
          const messageToolCalls = Array.isArray(message?.tool_calls) ? (message.tool_calls as Record<string, unknown>[]) : [];
          for (const toolCall of messageToolCalls) {
            const index = accumulateOpenAiToolDelta(toolCall, toolCalls, lastToolCallIndex, { replaceArguments: true });
            lastToolCallIndex = index;
          }
          const messageFunctionCall = message?.function_call as Record<string, unknown> | undefined;
          if (messageFunctionCall) {
            const index = accumulateOpenAiLegacyFunctionCall(messageFunctionCall, toolCalls, lastToolCallIndex, { replaceArguments: true });
            lastToolCallIndex = index;
          }
        }
      }
    }

    const parsedToolCalls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call], index) => parseToolCall(call, index))
      .filter((call): call is ToolCall => Boolean(call));

    return {
      content,
      tool_calls: parsedToolCalls,
      usage,
      http_status: response.status,
      request_id: headerSignals["x-request-id"] ?? headerSignals["x-vllm-request-id"] ?? headerSignals["request-id"],
      response_id: responseId,
      model: responseModel ?? request.model,
      route: routeFromHeaders(headerSignals),
      raw: streamWarnings.length ? { ...(lastRaw ?? {}), stream_warnings: streamWarnings as never } : lastRaw,
    };
  }

  private async callAnthropic(
    setup: ModelSetup,
    request: ModelRequest,
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    throwIfAborted(signal);
    const base = modelBaseUrl(setup).replace(/\/v1$/, "");
    const headers = new Headers(authHeaders(setup, "messages"));
    headers.set("anthropic-version", "2023-06-01");
    headers.set("x-session-id", request.session_id);
    headers.set("x-inferoa-session-id", request.session_id);
    headers.set("x-inferoa-run-id", request.run_id);
    if (request.request_class) {
      headers.set("x-inferoa-request-class", request.request_class);
    }
    const system = request.messages.find((message) => message.role === "system")?.content;
    const body = {
      model: request.model || setup.model,
      max_tokens: request.max_tokens ?? 4096,
      system: typeof system === "string" ? system : undefined,
      messages: request.messages.filter((message) => message.role !== "system").map(toAnthropicMessage),
      tools: sortedTools(request.tools).map(toAnthropicTool),
    };
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const headerSignals = signalHeaders(response.headers);
    if (!response.ok) {
      throw await modelGatewayHttpError("Anthropic", response, headerSignals);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const contentBlocks = Array.isArray(json.content) ? (json.content as Record<string, unknown>[]) : [];
    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const block of contentBlocks) {
      if (block.type === "text" && typeof block.text === "string") {
        content += block.text;
        onDelta?.(block.text);
      }
      if (block.type === "tool_use" && typeof block.name === "string") {
        toolCalls.push({
          id: typeof block.id === "string" ? block.id : `tool_${toolCalls.length}`,
          name: block.name,
          arguments: (block.input && typeof block.input === "object" ? block.input : {}) as JsonObject,
        });
      }
    }
    return {
      content,
      tool_calls: toolCalls,
      usage: normalizeUsage(json.usage),
      http_status: response.status,
      request_id: headerSignals["x-request-id"] ?? headerSignals["request-id"],
      response_id: typeof json.id === "string" ? json.id : undefined,
      model: typeof json.model === "string" ? json.model : request.model,
      raw: json as JsonObject,
    };
  }

  private async callGemini(
    setup: ModelSetup,
    request: ModelRequest,
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    throwIfAborted(signal);
    const base = modelBaseUrl(setup).replace(/\/v1$/, "");
    const model = request.model || setup.model;
    const apiKey = endpointApiKey(setup);
    const url = `${base}/v1beta/models/${encodeURIComponent(model ?? "")}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`;
    const headers = new Headers(authHeaders({ ...setup, api_key: undefined, api_key_ref: undefined }, "chat_completions"));
    headers.set("x-session-id", request.session_id);
    headers.set("x-inferoa-session-id", request.session_id);
    headers.set("x-inferoa-run-id", request.run_id);
    if (request.request_class) {
      headers.set("x-inferoa-request-class", request.request_class);
    }
    const body = {
      contents: request.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: messageTextContent(message) }],
        })),
      systemInstruction: {
        parts: request.messages
          .filter((message) => message.role === "system")
          .map((message) => ({ text: messageTextContent(message) })),
      },
    };
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const headerSignals = signalHeaders(response.headers);
    if (!response.ok) {
      throw await modelGatewayHttpError("Gemini", response, headerSignals);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const candidates = Array.isArray(json.candidates) ? (json.candidates as Record<string, unknown>[]) : [];
    const parts = ((candidates[0]?.content as Record<string, unknown> | undefined)?.parts as Record<string, unknown>[] | undefined) ?? [];
    const content = parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
    if (content) {
      onDelta?.(content);
    }
    return {
      content,
      tool_calls: [],
      usage: normalizeUsage(json.usageMetadata),
      http_status: response.status,
      request_id: headerSignals["x-request-id"] ?? headerSignals["request-id"],
      model,
      raw: json as JsonObject,
    };
  }

  private async callOpenAiResponses(
    setup: ModelSetup,
    request: ModelRequest,
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    throwIfAborted(signal);
    const base = modelBaseUrl(setup);
    const headers = new Headers(authHeaders(setup, "responses"));
    headers.set("accept", "text/event-stream");
    headers.set("x-session-id", request.session_id);
    headers.set("x-inferoa-session-id", request.session_id);
    headers.set("x-inferoa-run-id", request.run_id);
    if (request.request_class) {
      headers.set("x-inferoa-request-class", request.request_class);
    }
    const body = {
      model: request.model || setup.model,
      instructions: openAiResponsesInstructions(request.messages),
      input: openAiResponsesInput(request.messages),
      store: false,
      tools: sortedTools(request.tools).map(toOpenAiResponseTool),
      stream: true,
      ...openAiResponsesPromptCacheControls(setup, request),
    };
    const response = await fetch(`${base}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const headerSignals = signalHeaders(response.headers);
    if (!response.ok || !response.body) {
      throw await modelGatewayHttpError("Responses", response, headerSignals);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    const streamWarnings: string[] = [];
    const toolCalls = new Map<number, OpenAiToolCallAccumulator>();
    const streamEventTypes: Record<string, number> = {};
    let buffer = "";
    let content = "";
    let responseId: string | undefined;
    let responseModel: string | undefined;
    let responseStatus: string | undefined;
    let responseError: JsonValue | undefined;
    let incompleteDetails: JsonValue | undefined;
    let usage: ReturnType<typeof normalizeUsage>;
    let lastRaw: JsonObject | undefined;
    let terminalRaw: JsonObject | undefined;
    let abnormalRaw: JsonObject | undefined;
    let streamEventCount = 0;

    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) {
          continue;
        }
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          continue;
        }
        const json = parseSseJsonPayload(payload, streamWarnings);
        if (!json) {
          continue;
        }
        lastRaw = json as JsonObject;
        const eventType = typeof json.type === "string" ? json.type : "";
        streamEventCount += 1;
        streamEventTypes[eventType || "unknown"] = (streamEventTypes[eventType || "unknown"] ?? 0) + 1;
        const responsePayload = json.response as Record<string, unknown> | undefined;
        responseId = typeof responsePayload?.id === "string" ? responsePayload.id : responseId;
        responseModel = typeof responsePayload?.model === "string" ? responsePayload.model : responseModel;
        responseStatus = typeof responsePayload?.status === "string" ? responsePayload.status : responseStatus;
        responseError = responsePayload?.error !== undefined ? jsonValue(responsePayload.error) : responseError;
        incompleteDetails = responsePayload?.incomplete_details !== undefined ? jsonValue(responsePayload.incomplete_details) : incompleteDetails;
        usage = normalizeUsage(responsePayload?.usage) ?? usage;
        if (eventType === "response.completed" || eventType === "response.failed" || eventType === "response.incomplete") {
          terminalRaw = json as JsonObject;
        }
        if (eventType.includes("failed") || eventType.includes("incomplete") || json.error !== undefined || responsePayload?.error !== undefined || responsePayload?.incomplete_details !== undefined) {
          abnormalRaw = json as JsonObject;
        }
        if (eventType === "response.output_text.delta" && typeof json.delta === "string") {
          content += json.delta;
          onDelta?.(json.delta);
        }
        if (eventType === "response.function_call_arguments.delta" && typeof json.delta === "string") {
          const index = typeof json.output_index === "number" ? json.output_index : toolCalls.size;
          const current = toolCalls.get(index) ?? { arguments: "" };
          current.arguments += json.delta;
          toolCalls.set(index, current);
        }
        const item = (json.item ?? json.output_item) as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          const index = typeof json.output_index === "number" ? json.output_index : toolCalls.size;
          const current = toolCalls.get(index) ?? { arguments: "" };
          if (typeof item.call_id === "string") {
            current.id = item.call_id;
          } else if (typeof item.id === "string") {
            current.id = item.id;
          }
          if (typeof item.name === "string") {
            current.name = item.name;
          }
          if (typeof item.arguments === "string") {
            current.arguments = item.arguments;
          }
          toolCalls.set(index, current);
        }
      }
    }

    const diagnostics = openAiResponsesDiagnostics({
      httpStatus: response.status,
      headerSignals,
      streamEventCount,
      streamEventTypes,
      responseStatus,
      responseError,
      incompleteDetails,
      lastRaw,
      terminalRaw,
      abnormalRaw,
      streamWarnings,
    });
    const failureType = responsesFailureType(responseStatus, abnormalRaw);
    if (failureType) {
      throw new ModelGatewayError(`Responses stream ended with ${failureType}`, diagnostics);
    }

    const parsedToolCalls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call], index) => parseToolCall(call, index))
      .filter((call): call is ToolCall => Boolean(call));

    return {
      content,
      tool_calls: parsedToolCalls,
      usage,
      http_status: response.status,
      request_id: headerSignals["x-request-id"] ?? headerSignals["request-id"],
      response_id: responseId,
      model: responseModel ?? request.model,
      route: routeFromHeaders(headerSignals),
      raw: streamWarnings.length ? { ...(lastRaw ?? {}), stream_warnings: streamWarnings as never } : lastRaw,
      diagnostics,
    };
  }

  evidenceFromResponse(request: ModelRequest, response: ModelResponse): EndpointSignalSnapshot {
    const promptCache = openAiResponsesPromptCacheControls(this.config.model_setup, request);
    return {
      mode: this.config.model_setup.mode,
      provider_id: providerId(this.config),
      step_id: request.step_id,
      step_index: request.step_index,
      base_url: this.config.model_setup.base_url,
      model: response.model ?? request.model,
      usage: response.usage,
      http_status: response.http_status,
      request_id: response.request_id,
      response_id: response.response_id,
      response_status: typeof response.diagnostics?.response_status === "string" ? response.diagnostics.response_status : undefined,
      request_class: request.request_class,
      prompt_hash: request.prompt_hash,
      tool_schema_hash: request.tool_schema_hash,
      prompt_epoch_id: request.prompt_epoch_id,
      prompt_cache_key: promptCache.prompt_cache_key,
      prompt_cache_retention: promptCache.prompt_cache_retention,
      router: response.route,
      response_diagnostics: response.diagnostics,
    };
  }
}

async function modelGatewayHttpError(label: string, response: Response, headerSignals: Record<string, string>): Promise<ModelGatewayError> {
  const text = await response.text().catch(() => "");
  return new ModelGatewayError(`${label} request failed ${response.status}: ${text}`, httpErrorDiagnostics(response.status, headerSignals, text));
}

function httpErrorDiagnostics(httpStatus: number, headerSignals: Record<string, string>, text: string): JsonObject {
  const parsed = parseJsonValue(text);
  return {
    http_status: httpStatus,
    headers: headerSignals,
    response_status: "http_error",
    response_error: responseErrorFromBody(parsed, text),
    raw_error_body: rawErrorBody(parsed, text),
  };
}

function openAiResponsesDiagnostics(input: {
  httpStatus: number;
  headerSignals: Record<string, string>;
  streamEventCount: number;
  streamEventTypes: Record<string, number>;
  responseStatus?: string;
  responseError?: JsonValue;
  incompleteDetails?: JsonValue;
  lastRaw?: JsonObject;
  terminalRaw?: JsonObject;
  abnormalRaw?: JsonObject;
  streamWarnings: string[];
}): JsonObject {
  return {
    http_status: input.httpStatus,
    headers: input.headerSignals,
    stream_event_count: input.streamEventCount,
    stream_event_types: input.streamEventTypes,
    response_status: input.responseStatus,
    response_error: input.responseError,
    incomplete_details: input.incompleteDetails,
    last_raw_event: boundedJsonObject(input.lastRaw),
    terminal_raw_event: boundedJsonObject(input.terminalRaw),
    abnormal_raw_event: boundedJsonObject(input.abnormalRaw),
    stream_warnings: input.streamWarnings,
  };
}

function parseJsonValue(text: string): JsonValue | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return undefined;
  }
}

function responseErrorFromBody(parsed: JsonValue | undefined, text: string): JsonValue {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const body = parsed as JsonObject;
    if (body.error !== undefined) {
      return jsonValue(body.error);
    }
    const errorFields = pickStringFields(body, ["code", "type", "status", "message"]);
    if (Object.keys(errorFields).length > 0) {
      return errorFields;
    }
  }
  return { message: truncateDiagnosticText(text) };
}

function rawErrorBody(parsed: JsonValue | undefined, text: string): JsonObject {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return boundedJsonObject(parsed as JsonObject) ?? {};
  }
  return { text: truncateDiagnosticText(text) };
}

function pickStringFields(body: JsonObject, keys: string[]): JsonObject {
  const out: JsonObject = {};
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function responsesFailureType(responseStatus: string | undefined, abnormalRaw: JsonObject | undefined): string | undefined {
  const eventType = typeof abnormalRaw?.type === "string" ? abnormalRaw.type : undefined;
  if (eventType === "response.failed" || eventType === "response.incomplete") {
    return eventType;
  }
  if (responseStatus === "failed" || responseStatus === "incomplete") {
    return `response.${responseStatus}`;
  }
  if (abnormalRaw?.error !== undefined) {
    return eventType ? `${eventType} error` : "response.error";
  }
  return undefined;
}

function truncateDiagnosticText(value: string, limit = 20_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`;
}

function boundedJsonObject(value: JsonObject | undefined, limit = 20_000): JsonObject | undefined {
  if (!value) {
    return undefined;
  }
  const text = JSON.stringify(value);
  if (text.length <= limit) {
    return value;
  }
  return {
    truncated: true,
    chars: text.length,
    preview: text.slice(0, limit),
  };
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function sortedTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function toOpenAiTool(tool: ToolDefinition): JsonObject {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: canonicalJsonObject(tool.parameters),
    },
  };
}

function toOpenAiResponseTool(tool: ToolDefinition): JsonObject {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: canonicalJsonObject(tool.parameters),
  };
}

function toOpenAiMessage(message: ModelMessage): JsonObject {
  const base: JsonObject = {
    role: message.role,
    content: stableMessageContent(message.content),
  };
  if (message.tool_call_id) {
    base.tool_call_id = message.tool_call_id;
  }
  if (message.name) {
    base.name = message.name;
  }
  if (message.tool_calls?.length) {
    base.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: stableJson(call.arguments),
      },
    }));
  }
  return base;
}

function openAiResponsesInstructions(messages: ModelMessage[]): string {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map(messageTextContent)
    .map((content) => content.trim())
    .filter(Boolean)
    .join("\n\n");
  return instructions || "You are Inferoa.";
}

function openAiResponsesInput(messages: ModelMessage[]): JsonObject[] {
  return messages.flatMap(toOpenAiResponseInputItems);
}

function toOpenAiResponseInputItems(message: ModelMessage): JsonObject[] {
  if (message.role === "system") {
    return [];
  }
  if (message.role === "tool") {
    return [{
      type: "function_call_output",
      call_id: message.tool_call_id ?? message.name ?? "tool",
      output: messageTextContent(message),
    }];
  }
  const items: JsonObject[] = [];
  if (message.role === "assistant" && message.tool_calls?.length) {
    for (const call of message.tool_calls) {
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: stableJson(call.arguments),
      });
    }
    if (!messageTextContent(message).trim()) {
      return items;
    }
  }
  const role = message.role === "assistant" ? "assistant" : "user";
  const contentType = role === "assistant" ? "output_text" : "input_text";
  items.push({
    role,
    content: [{ type: contentType, text: messageTextContent(message) }],
  });
  return items;
}

function stableMessageContent(content: ModelMessage["content"]): ModelMessage["content"] {
  return typeof content === "string" ? content : content.map((item) => canonicalJsonValue(item));
}

function canonicalJsonValue(value: JsonValue): JsonValue {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalJsonValue(item));
  }
  const record = value as JsonObject;
  const sorted: JsonObject = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child !== undefined) {
      sorted[key] = canonicalJsonValue(child);
    }
  }
  return sorted;
}

function canonicalJsonObject(value: JsonObject): JsonObject {
  return canonicalJsonValue(value) as JsonObject;
}

function toAnthropicMessage(message: ModelMessage): JsonObject {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: messageTextContent(message),
        },
      ],
    };
  }
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: messageTextContent(message),
  };
}

function messageTextContent(message: ModelMessage): string {
  return typeof message.content === "string" ? message.content : stableJson(message.content);
}

function toAnthropicTool(tool: ToolDefinition): JsonObject {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: canonicalJsonObject(tool.parameters),
  };
}

function parseToolCall(call: OpenAiToolCallAccumulator, index: number): ToolCall | undefined {
  if (!call.name) {
    return undefined;
  }
  let args: JsonObject = {};
  if (call.arguments.trim()) {
    try {
      args = JSON.parse(call.arguments) as JsonObject;
    } catch {
      args = { raw_arguments: call.arguments };
    }
  }
  return {
    id: call.id ?? `tool_${index}`,
    name: call.name,
    arguments: args,
  };
}

function parseSseJsonPayload(payload: string, warnings: string[]): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`ignored non-object SSE payload: ${payload.slice(0, 120)}`);
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    warnings.push(`ignored malformed SSE payload: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function accumulateOpenAiToolDelta(
  toolDelta: Record<string, unknown>,
  toolCalls: Map<number, OpenAiToolCallAccumulator>,
  lastIndex: number | undefined,
  options: { replaceArguments?: boolean } = {},
): number {
  const index = resolveOpenAiToolCallIndex(toolDelta, toolCalls, lastIndex);
  const current = toolCalls.get(index) ?? { arguments: "" };
  if (typeof toolDelta.id === "string") {
    current.id = toolDelta.id;
  }
  const fn = toolDelta.function as Record<string, unknown> | undefined;
  if (typeof fn?.name === "string" && fn.name.length > 0) {
    current.name = fn.name;
  }
  if (typeof fn?.arguments === "string") {
    current.arguments = options.replaceArguments ? fn.arguments : current.arguments + fn.arguments;
  }
  toolCalls.set(index, current);
  return index;
}

function accumulateOpenAiLegacyFunctionCall(
  functionCall: Record<string, unknown>,
  toolCalls: Map<number, OpenAiToolCallAccumulator>,
  lastIndex: number | undefined,
  options: { replaceArguments?: boolean } = {},
): number {
  const index = lastIndex ?? 0;
  const current = toolCalls.get(index) ?? { arguments: "" };
  current.id = current.id ?? `function_call_${index}`;
  if (typeof functionCall.name === "string" && functionCall.name.length > 0) {
    current.name = functionCall.name;
  }
  if (typeof functionCall.arguments === "string") {
    current.arguments = options.replaceArguments ? functionCall.arguments : current.arguments + functionCall.arguments;
  }
  toolCalls.set(index, current);
  return index;
}

function resolveOpenAiToolCallIndex(
  delta: Record<string, unknown>,
  toolCalls: Map<number, OpenAiToolCallAccumulator>,
  lastIndex: number | undefined,
): number {
  if (typeof delta.index === "number") {
    return delta.index;
  }
  if (typeof delta.id === "string") {
    for (const [index, current] of toolCalls.entries()) {
      if (current.id === delta.id) {
        return index;
      }
    }
  }
  const fn = delta.function as Record<string, unknown> | undefined;
  if (lastIndex !== undefined) {
    const last = toolCalls.get(lastIndex);
    const isContinuation = !delta.id && !fn?.name;
    const sameNamedCall = typeof fn?.name === "string" && last?.name === fn.name;
    if (isContinuation || sameNamedCall) {
      return lastIndex;
    }
  }
  return toolCalls.size;
}

function routeFromHeaders(headers: Record<string, string>): JsonObject | undefined {
  const route: JsonObject = {};
  for (const key of ["x-router-model", "x-selected-model", "endpoint-load-metrics"]) {
    if (headers[key]) {
      route[key] = headers[key];
    }
  }
  return Object.keys(route).length ? route : undefined;
}
