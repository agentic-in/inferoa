import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, OmniCapabilityName, OmniEndpointConfig, OmniEndpointName, ToolResult } from "../types.js";
import { endpointApiKey } from "../config/config.js";
import { fail, ok, truncateText } from "../util/limit.js";
import { delay, numberOrDefault, stringField } from "../util/types.js";
import { resolveReadablePath } from "../util/fs.js";
import type { ToolExecutionContext } from "./context.js";
import { dataUriToBuffer, mediaFromResource, resolveResourceReference } from "./resource-resolver.js";

export async function visionUnderstanding(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  return await understanding("vision", "vision", args, context, "image_url");
}

export async function videoUnderstanding(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  return await understanding("video_understanding", "video_understanding", args, context, "video_url");
}

export async function audioUnderstanding(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  return await understanding("audio_understanding", "audio_understanding", args, context, "audio_url");
}

export async function imageGeneration(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const body = generationJsonBody(args, endpointModel("image_generation", context), ["prompt"]);
  return await postManagedJsonOrMedia("image_generation", "image_generation", "/images/generations", body, context);
}

export async function imageEdit(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const endpoint = endpointFor("image_edit", context);
  if (!endpoint.ok) {
    return endpoint.result;
  }
  const form = new FormData();
  form.set("model", String(args.model ?? endpoint.config.model));
  form.set("prompt", String(args.prompt));
  appendOptionalFormFields(form, args, [
    "n",
    "size",
    "response_format",
    "output_format",
    "background",
    "output_compression",
    "user",
    "negative_prompt",
    "num_inference_steps",
    "guidance_scale",
    "strength",
    "true_cfg_scale",
    "seed",
    "generator_device",
    "lora",
    "layers",
    "resolution",
  ]);
  for (const input of arrayOfStrings(args.images ?? args.image)) {
    await appendImageEditInput(form, input, context);
  }
  if (typeof args.mask_image === "string") {
    await appendFormInput(form, "mask_image", args.mask_image, context);
  }
  if (typeof args.reference_image === "string") {
    await appendFormInput(form, "reference_image", args.reference_image, context);
  }
  const response = await postFormJson(endpoint.config, "/images/edits", form);
  if (!response.ok) {
    return fail("image_edit_failed", response.error);
  }
  return managedJsonResult("image_edit", endpoint.config.model, formFieldsPreview(form), response.json, context);
}

export async function videoGeneration(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  if (args.mode === "sync" || args.sync === true) {
    return await videoGenerationSync(args, context);
  }
  return await videoGenerationJob(args, context);
}

export async function audioGeneration(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const body = generationJsonBody(args, endpointModel("audio_generation", context), ["input", "prompt"]);
  if (body.input === undefined && body.prompt !== undefined) {
    body.input = body.prompt;
  }
  if (typeof body.input === "string") {
    const normalized = normalizeTextPrompt(body.input, context);
    if (!normalized.ok) {
      return normalized.result;
    }
    body.input = normalized.text;
  }
  if (body.audio_length === undefined && body.duration !== undefined) {
    body.audio_length = body.duration;
  }
  delete body.prompt;
  delete body.duration;
  return await postManagedJsonOrMedia("audio_generation", "audio_generation", "/audio/generate", body, context);
}

export async function speechGeneration(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const body = generationJsonBody(args, endpointModel("speech", context), ["input"]);
  if (typeof args.ref_audio === "string") {
    body.ref_audio = await normalizeInput(args.ref_audio, context);
  }
  return await postManagedJsonOrMedia("speech_generation", "speech", "/audio/speech", body, context);
}

export async function speechVoices(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const endpoint = endpointFor("speech", context);
  if (!endpoint.ok) {
    return endpoint.result;
  }
  const response = await getJson(endpoint.config, "/audio/voices");
  if (!response.ok) {
    return fail("speech_voices_failed", response.error);
  }
  const voices = voicesFromResponse(response.json);
  const resource =
    JSON.stringify(response.json).length > 20_000
      ? context.store.putResource(context.session_id, "omni.speech_voices", JSON.stringify(response.json, null, 2), {
          capability: "speech_voices",
          model: endpoint.config.model,
          voice_count: voices.length,
        }).uri
      : undefined;
  return {
    ok: true,
    summary: `speech_voices listed ${voices.length} voice(s)`,
    data: {
      capability: "speech_voices",
      model: endpoint.config.model,
      voices: voices as never,
      resource_uri: resource,
    },
    resource_uri: resource,
  };
}

async function understanding(
  capability: OmniCapabilityName,
  endpointKey: OmniEndpointName,
  args: JsonObject,
  context: ToolExecutionContext,
  inputType: "image_url" | "video_url" | "audio_url",
): Promise<ToolResult> {
  const endpoint = endpointFor(endpointKey, context);
  if (!endpoint.ok) {
    return endpoint.result;
  }
  const inputs = Array.isArray(args.inputs) ? args.inputs.map(String) : [];
  const content: JsonObject[] = [{ type: "text", text: String(args.prompt) }];
  for (const input of inputs) {
    content.push({ type: inputType, [inputType]: { url: await normalizeInput(input, context) } });
  }
  const response = await postJson(endpoint.config, "/chat/completions", {
    model: String(args.model ?? endpoint.config.model),
    messages: [
      {
        role: "user",
        content,
      },
    ],
    temperature: 0,
  });
  if (!response.ok) {
    return fail(`${capability}_failed`, response.error);
  }
  const text = extractChatText(response.json);
  const truncated = truncateText(text, 16_000);
  const resource =
    truncated.truncated || JSON.stringify(response.json).length > 20_000
      ? context.store.putResource(context.session_id, `omni.${capability}`, JSON.stringify(response.json, null, 2), {
          capability,
          model: endpoint.config.model,
        }).uri
      : undefined;
  return {
    ok: true,
    summary: `${capability} completed`,
    data: {
      capability,
      model: endpoint.config.model,
      answer: truncated.text,
      raw_usage: (response.json.usage as JsonObject | undefined) ?? {},
    },
    resource_uri: resource,
  };
}

function generationJsonBody(args: JsonObject, model: string | undefined, promptKeys: string[]): JsonObject {
  const body: JsonObject = {
    model: String(args.model ?? model),
  };
  for (const key of promptKeys) {
    if (args[key] !== undefined) {
      body[key] = String(args[key]);
      break;
    }
  }
  for (const key of [
    "n",
    "size",
    "seed",
    "response_format",
    "output_format",
    "duration",
    "audio_length",
    "audio_start",
    "negative_prompt",
    "guidance_scale",
    "true_cfg_scale",
    "num_inference_steps",
    "speed",
    "stream_format",
    "voice",
    "instructions",
    "task_type",
    "language",
    "ref_text",
    "x_vector_only_mode",
    "speaker_embedding",
    "max_new_tokens",
    "initial_codec_chunk_frames",
    "extra_params",
    "system_prompt",
    "use_system_prompt",
    "layers",
    "generator_device",
    "lora",
    "vae_use_slicing",
    "vae_use_tiling",
  ]) {
    if (args[key] !== undefined) {
      body[key] = args[key] as never;
    }
  }
  if (body.audio_length === undefined && args.duration !== undefined) {
    body.audio_length = args.duration as never;
  }
  return body;
}

async function postManagedJsonOrMedia(
  capability: OmniCapabilityName,
  endpointKey: OmniEndpointName,
  apiPath: string,
  body: JsonObject,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  const endpoint = endpointFor(endpointKey, context);
  if (!endpoint.ok) {
    return endpoint.result;
  }
  const response = await postJsonOrBytes(endpoint.config, apiPath, body);
  if (!response.ok) {
    return fail(`${capability}_failed`, response.error);
  }
  if (response.bytes) {
    return managedBytesResult(capability, endpoint.config.model, body, response.bytes, response.content_type, context, response.headers);
  }
  return managedJsonResult(capability, endpoint.config.model, body, response.json ?? {}, context);
}

async function videoGenerationJob(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const endpoint = endpointFor("video_generation", context);
  if (!endpoint.ok) {
    return endpoint.result;
  }

  const referenceConflict = videoReferenceConflict(args);
  if (referenceConflict) {
    return referenceConflict;
  }
  const form = await videoForm(args, endpoint.config.model, context);
  const submitted = await postFormJson(endpoint.config, "/videos", form);
  if (!submitted.ok) {
    return fail("video_generation_failed", submitted.error);
  }
  const jobId = stringField(submitted.json.id) ?? stringField(submitted.json.video_id) ?? stringField(submitted.json.job_id);
  if (!jobId) {
    return managedJsonResult("video_generation", endpoint.config.model, formFieldsPreview(form), submitted.json, context);
  }

  const deadline = Date.now() + numberOrDefault(args.timeout_ms, 180_000);
  let statusJson = submitted.json;
  while (Date.now() < deadline) {
    const status = statusText(statusJson);
    if (["completed", "succeeded", "success", "finished"].includes(status)) {
      break;
    }
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      return fail("video_generation_failed", `Video job ${jobId} ${status}`, { job_id: jobId, status: statusJson });
    }
    await delay(numberOrDefault(args.poll_ms, 2_000));
    const polled = await getJson(endpoint.config, `/videos/${encodeURIComponent(jobId)}`);
    if (!polled.ok) {
      return fail("video_generation_status_failed", polled.error, { job_id: jobId });
    }
    statusJson = polled.json;
  }

  if (!["completed", "succeeded", "success", "finished"].includes(statusText(statusJson))) {
    return fail("video_generation_timeout", `Video job ${jobId} did not finish before timeout.`, {
      job_id: jobId,
      status: statusJson,
    });
  }

  const content = await getBytes(endpoint.config, `/videos/${encodeURIComponent(jobId)}/content`);
  if (!content.ok) {
    return fail("video_generation_download_failed", content.error, { job_id: jobId, status: statusJson });
  }
  return managedBytesResult(
    "video_generation",
    endpoint.config.model,
    { request: formFieldsPreview(form), job_id: jobId, status: statusJson },
    content.bytes,
    content.content_type,
    context,
    content.headers,
  );
}

async function videoGenerationSync(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const endpoint = endpointFor("video_generation", context);
  if (!endpoint.ok) {
    return endpoint.result;
  }
  const referenceConflict = videoReferenceConflict(args);
  if (referenceConflict) {
    return referenceConflict;
  }
  const form = await videoForm(args, endpoint.config.model, context);
  const response = await postFormBytes(endpoint.config, "/videos/sync", form);
  if (!response.ok) {
    return fail("video_generation_failed", response.error);
  }
  return managedBytesResult("video_generation", endpoint.config.model, formFieldsPreview(form), response.bytes, response.content_type, context, response.headers);
}

async function videoForm(args: JsonObject, model: string | undefined, context: ToolExecutionContext): Promise<FormData> {
  const form = new FormData();
  form.set("model", String(args.model ?? model));
  form.set("prompt", String(args.prompt));
  if (args.duration !== undefined && args.seconds === undefined) {
    form.set("seconds", String(args.duration));
  }
  appendOptionalFormFields(form, args, [
    "seconds",
    "size",
    "user",
    "width",
    "height",
    "num_frames",
    "fps",
    "num_inference_steps",
    "guidance_scale",
    "guidance_scale_2",
    "boundary_ratio",
    "flow_shift",
    "true_cfg_scale",
    "seed",
    "negative_prompt",
    "enable_frame_interpolation",
    "frame_interpolation_exp",
    "frame_interpolation_scale",
    "frame_interpolation_model_path",
    "lora",
    "extra_params",
  ]);
  if (args.extra_params && typeof args.extra_params === "object") {
    form.set("extra_params", JSON.stringify(args.extra_params));
  }
  if (typeof args.input_reference === "string") {
    await appendFormFileInput(form, "input_reference", args.input_reference, context);
  }
  if (typeof args.image_reference === "string") {
    form.set("image_reference", JSON.stringify({ image_url: await normalizeInput(args.image_reference, context) }));
  }
  if (typeof args.video_reference === "string") {
    form.set("video_reference", JSON.stringify({ video_url: await normalizeInput(args.video_reference, context) }));
  }
  return form;
}

function videoReferenceConflict(args: JsonObject): ToolResult | undefined {
  const present = ["input_reference", "image_reference", "video_reference"].filter((key) => typeof args[key] === "string" && args[key]);
  if (present.length <= 1) {
    return undefined;
  }
  return fail("video_generation_reference_conflict", `Use only one video reference input at a time: ${present.join(", ")}.`);
}

function endpointModel(endpointKey: OmniEndpointName, context: ToolExecutionContext): string | undefined {
  return context.config.omni.endpoints[endpointKey]?.model;
}

function endpointFor(endpointKey: OmniEndpointName, context: ToolExecutionContext):
  | { ok: true; config: OmniEndpointConfig }
  | { ok: false; result: ToolResult } {
  if (!context.config.omni.enabled) {
    return { ok: false, result: fail("omni_disabled", "Omni tools are not enabled in config.") };
  }
  const config = context.config.omni.endpoints[endpointKey];
  if (!config?.base_url || !config.model) {
    return {
      ok: false,
      result: fail("omni_capability_unavailable", `Omni endpoint ${endpointKey} is not configured with base_url and model.`),
    };
  }
  return { ok: true, config };
}

async function postJson(
  endpoint: OmniEndpointConfig,
  apiPath: string,
  body: JsonObject,
): Promise<{ ok: true; json: JsonObject } | { ok: false; error: string }> {
  const response = await postJsonOrBytes(endpoint, apiPath, body);
  if (!response.ok) {
    return response;
  }
  if (response.json) {
    return { ok: true, json: response.json };
  }
  return { ok: false, error: `Expected JSON response from ${apiPath}, got ${response.content_type}` };
}

async function postJsonOrBytes(
  endpoint: OmniEndpointConfig,
  apiPath: string,
  body: JsonObject,
): Promise<{ ok: true; json?: JsonObject; bytes?: Buffer; content_type: string; headers: JsonObject } | { ok: false; error: string }> {
  const base = endpoint.base_url?.replace(/\/$/, "");
  const apiKey = endpointApiKey(endpoint);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(endpoint.headers ?? {}),
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  try {
    const response = await fetch(`${base}${apiPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const responseHeaders = responseHeadersObject(response.headers);
    if (contentType.includes("application/json")) {
      const text = await response.text();
      if (!response.ok) {
        return { ok: false, error: `${response.status}: ${text}` };
      }
      return { ok: true, json: text ? (JSON.parse(text) as JsonObject) : {}, content_type: contentType, headers: responseHeaders };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      return { ok: false, error: `${response.status}: ${bytes.toString("utf8")}` };
    }
    return { ok: true, bytes, content_type: contentType, headers: responseHeaders };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function postFormJson(
  endpoint: OmniEndpointConfig,
  apiPath: string,
  form: FormData,
): Promise<{ ok: true; json: JsonObject } | { ok: false; error: string }> {
  const response = await postForm(endpoint, apiPath, form);
  if (!response.ok) {
    return response;
  }
  if (!response.json) {
    return { ok: false, error: `Expected JSON response from ${apiPath}, got ${response.content_type}` };
  }
  return { ok: true, json: response.json };
}

async function postFormBytes(
  endpoint: OmniEndpointConfig,
  apiPath: string,
  form: FormData,
): Promise<{ ok: true; bytes: Buffer; content_type: string; headers: JsonObject } | { ok: false; error: string }> {
  const response = await postForm(endpoint, apiPath, form);
  if (!response.ok) {
    return response;
  }
  if (!response.bytes) {
    return { ok: false, error: `Expected binary response from ${apiPath}, got ${response.content_type}` };
  }
  return { ok: true, bytes: response.bytes, content_type: response.content_type, headers: response.headers };
}

async function postForm(
  endpoint: OmniEndpointConfig,
  apiPath: string,
  form: FormData,
): Promise<{ ok: true; json?: JsonObject; bytes?: Buffer; content_type: string; headers: JsonObject } | { ok: false; error: string }> {
  const base = endpoint.base_url?.replace(/\/$/, "");
  const apiKey = endpointApiKey(endpoint);
  const headers: Record<string, string> = { ...(endpoint.headers ?? {}) };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  try {
    const response = await fetch(`${base}${apiPath}`, {
      method: "POST",
      headers,
      body: form,
    });
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const responseHeaders = responseHeadersObject(response.headers);
    if (contentType.includes("application/json")) {
      const text = await response.text();
      if (!response.ok) {
        return { ok: false, error: `${response.status}: ${text}` };
      }
      return { ok: true, json: text ? (JSON.parse(text) as JsonObject) : {}, content_type: contentType, headers: responseHeaders };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      return { ok: false, error: `${response.status}: ${bytes.toString("utf8")}` };
    }
    return { ok: true, bytes, content_type: contentType, headers: responseHeaders };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function getJson(
  endpoint: OmniEndpointConfig,
  apiPath: string,
): Promise<{ ok: true; json: JsonObject } | { ok: false; error: string }> {
  const base = endpoint.base_url?.replace(/\/$/, "");
  const response = await get(endpoint, `${base}${apiPath}`);
  if (!response.ok) {
    return response;
  }
  try {
    return { ok: true, json: response.text ? (JSON.parse(response.text) as JsonObject) : {} };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function getBytes(
  endpoint: OmniEndpointConfig,
  apiPath: string,
): Promise<{ ok: true; bytes: Buffer; content_type: string; headers: JsonObject } | { ok: false; error: string }> {
  const base = endpoint.base_url?.replace(/\/$/, "");
  const apiKey = endpointApiKey(endpoint);
  const headers: Record<string, string> = { ...(endpoint.headers ?? {}) };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  try {
    const response = await fetch(`${base}${apiPath}`, { headers });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      return { ok: false, error: `${response.status}: ${bytes.toString("utf8")}` };
    }
    return {
      ok: true,
      bytes,
      content_type: response.headers.get("content-type") ?? "application/octet-stream",
      headers: responseHeadersObject(response.headers),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function get(
  endpoint: OmniEndpointConfig,
  url: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const apiKey = endpointApiKey(endpoint);
  const headers: Record<string, string> = { ...(endpoint.headers ?? {}) };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  try {
    const response = await fetch(url, { headers });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, error: `${response.status}: ${text}` };
    }
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function managedJsonResult(
  capability: OmniCapabilityName,
  model: string | undefined,
  request: JsonObject,
  response: JsonObject,
  context: ToolExecutionContext,
): ToolResult {
  const mediaItems = extractEmbeddedMedia(response, request);
  const mediaResources = mediaItems.map((item, index) =>
    context.store.putResource(context.session_id, `omni.${capability}.media`, item.bytes.toString("base64"), {
      capability,
      model,
      content_type: item.contentType,
      encoding: "base64",
      bytes: item.bytes.length,
      media_index: index,
      revised_prompt: item.revisedPrompt,
    }),
  );
  const mediaResourceUris = mediaResources.map((resource) => resource.uri);
  const content = JSON.stringify(
    {
      capability,
      request,
      response,
      primary_media_resource: mediaResourceUris[0],
      media_resources: mediaResourceUris,
    },
    null,
    2,
  );
  const evidenceResource = context.store.putResource(context.session_id, `omni.${capability}`, content, {
    capability,
    model,
    media_count: mediaResources.length,
    primary_media_resource: mediaResourceUris[0],
    media_resources: mediaResourceUris as never,
    content_type: "application/json",
  });
  const resources = [
    ...mediaResources.map((resource, index) => resourceSummary(resource.uri, mediaItems[index]?.contentType ?? "application/octet-stream", mediaItems[index]?.bytes.length ?? 0)),
    resourceSummary(evidenceResource.uri, "application/json", Buffer.byteLength(content)),
  ];
  const outputResource = mediaResources[0]?.uri ?? evidenceResource.uri;
  return {
    ok: true,
    summary: `${capability} completed with ${mediaResources.length} media item(s); output stored as ${outputResource}`,
    data: {
      capability,
      model,
      media_count: mediaResources.length,
      resources: resources as never,
    },
    resource_uri: evidenceResource.uri,
  };
}

function managedBytesResult(
  capability: OmniCapabilityName,
  model: string | undefined,
  request: JsonObject,
  bytes: Buffer,
  contentType: string,
  context: ToolExecutionContext,
  headers: JsonObject = {},
): ToolResult {
  const mediaResource = context.store.putResource(context.session_id, `omni.${capability}.media`, bytes.toString("base64"), {
    capability,
    model,
    content_type: contentType,
    encoding: "base64",
    bytes: bytes.length,
    headers,
  });
  const evidenceContent = JSON.stringify({ capability, request, media_resource: mediaResource.uri, content_type: contentType, bytes: bytes.length, headers }, null, 2);
  const evidenceResource = context.store.putResource(context.session_id, `omni.${capability}`, evidenceContent, {
    capability,
    model,
    media_resource: mediaResource.uri,
    content_type: "application/json",
    bytes: bytes.length,
  });
  return {
    ok: true,
    summary: `${capability} completed with 1 media item; output stored as ${mediaResource.uri}`,
    data: {
      capability,
      model,
      media_count: 1,
      resources: [
        resourceSummary(mediaResource.uri, contentType, bytes.length),
        resourceSummary(evidenceResource.uri, "application/json", Buffer.byteLength(evidenceContent)),
      ] as never,
    },
    resource_uri: evidenceResource.uri,
  };
}

function resourceSummary(uri: string, contentType: string, bytes: number): JsonObject {
  return { uri, content_type: contentType, bytes };
}

function appendOptionalFormFields(form: FormData, args: JsonObject, keys: string[]): void {
  for (const key of keys) {
    if (args[key] !== undefined) {
      const value = args[key];
      form.set(key, typeof value === "object" && value !== null ? JSON.stringify(value) : String(value));
    }
  }
}

async function appendImageEditInput(form: FormData, input: string, context: ToolExecutionContext): Promise<void> {
  if (/^https?:/.test(input)) {
    form.append("url", input);
    return;
  }
  await appendFormInput(form, "image", input, context);
}

async function appendFormInput(form: FormData, key: string, input: string, context: ToolExecutionContext): Promise<void> {
  if (/^https?:/.test(input)) {
    form.set(key, input);
    return;
  }
  const file = await fileInput(input, key, context);
  const blobBytes = new Uint8Array(file.bytes.length);
  blobBytes.set(file.bytes);
  form.set(key, new Blob([blobBytes], { type: file.contentType }), file.name);
}

async function appendFormFileInput(form: FormData, key: string, input: string, context: ToolExecutionContext): Promise<void> {
  if (/^https?:/.test(input)) {
    throw new Error(`${key} expects a resource URI, data URI, or readable local file path for multipart upload.`);
  }
  const file = await fileInput(input, key, context);
  const blobBytes = new Uint8Array(file.bytes.length);
  blobBytes.set(file.bytes);
  form.set(key, new Blob([blobBytes], { type: file.contentType }), file.name);
}

async function fileInput(input: string, fallbackName: string, context: ToolExecutionContext): Promise<{ bytes: Buffer; contentType: string; name: string }> {
  if (input.startsWith("data:")) {
    return dataUriFile(input, fallbackName);
  }
  const resolved = resourceInput(input, context);
  if (resolved) {
    if (!resolved.ok) {
      throw new Error(resolved.failure.message);
    }
    const media = mediaFromResource(resolved.resource, context);
    if (!media.ok) {
      throw new Error(media.failure.message);
    }
    if (!media.media.bytes) {
      throw new Error(`Resource does not contain embedded bytes: ${resolved.resource.uri}`);
    }
    return { bytes: media.media.bytes, contentType: media.media.contentType, name: media.media.name };
  }
  return await localFile(input, context);
}

async function localFile(input: string, context: ToolExecutionContext): Promise<{ bytes: Buffer; contentType: string; name: string }> {
  const file = resolveReadablePath(context.workspace.root, input).file;
  const bytes = await fs.readFile(file);
  const name = path.basename(file);
  return { bytes, contentType: mimeType(file), name };
}

async function dataUriFile(input: string, fallbackName: string): Promise<{ bytes: Buffer; contentType: string; name: string }> {
  return dataUriToBuffer(input, fallbackName);
}

async function normalizeInput(input: string, context: ToolExecutionContext): Promise<string> {
  if (/^(https?:|data:)/.test(input)) {
    return input;
  }
  const resolved = resourceInput(input, context);
  if (resolved) {
    if (!resolved.ok) {
      throw new Error(resolved.failure.message);
    }
    const media = mediaFromResource(resolved.resource, context);
    if (!media.ok) {
      throw new Error(media.failure.message);
    }
    if (media.media.remoteUrl) {
      return media.media.remoteUrl;
    }
    if (!media.media.bytes) {
      throw new Error(`Resource does not contain embedded bytes: ${resolved.resource.uri}`);
    }
    return `data:${media.media.contentType};base64,${media.media.bytes.toString("base64")}`;
  }
  const file = resolveReadablePath(context.workspace.root, input).file;
  const bytes = await fs.readFile(file);
  return `data:${mimeType(file)};base64,${bytes.toString("base64")}`;
}

function normalizeTextPrompt(input: string, context: ToolExecutionContext): { ok: true; text: string } | { ok: false; result: ToolResult } {
  if (!input.startsWith("resource://")) {
    return { ok: true, text: input };
  }
  const resolved = resolveResourceReference(input, context);
  if (!resolved.ok) {
    return {
      ok: false,
      result: fail(resolved.failure.code, resolved.failure.message),
    };
  }
  const media = mediaFromResource(resolved.resource, context);
  if (media.ok) {
    return {
      ok: false,
      result: fail("invalid_resource_for_text_prompt", `audio_generation input expects a text resource, but ${resolved.resource.uri} contains media.`),
    };
  }
  return { ok: true, text: resolved.resource.content };
}

function resourceInput(input: string, context: ToolExecutionContext): ReturnType<typeof resolveResourceReference> | undefined {
  const resolved = resolveResourceReference(input, context);
  if (resolved.ok || resolved.failure.code === "resource_uri_ambiguous" || input.startsWith("resource://")) {
    return resolved;
  }
  return undefined;
}

function mimeType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".flac") return "audio/flac";
  return "application/octet-stream";
}

function extractChatText(json: JsonObject): string {
  const choices = json.choices as JsonObject[] | undefined;
  const message = choices?.[0]?.message as JsonObject | undefined;
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(json);
}

interface EmbeddedMediaItem {
  bytes: Buffer;
  contentType: string;
  revisedPrompt?: string;
}

function extractEmbeddedMedia(json: JsonObject, request: JsonObject): EmbeddedMediaItem[] {
  const data = json.data as JsonObject[] | undefined;
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((item): EmbeddedMediaItem | undefined => {
      if (typeof item.b64_json !== "string" || !item.b64_json) {
        return undefined;
      }
      return {
        bytes: Buffer.from(item.b64_json, "base64"),
        contentType: imageContentTypeFromRequest(request),
        revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
      };
    })
    .filter((item): item is EmbeddedMediaItem => Boolean(item));
}

function imageContentTypeFromRequest(request: JsonObject): string {
  const format = typeof request.output_format === "string" ? request.output_format : typeof request.response_format === "string" ? request.response_format : "png";
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  if (format === "gif") return "image/gif";
  return "image/png";
}

function statusText(json: JsonObject): string {
  const status = stringField(json.status) ?? stringField(json.state) ?? stringField((json.data as JsonObject | undefined)?.status);
  return (status ?? "queued").toLowerCase();
}

function voicesFromResponse(json: JsonObject): string[] {
  const voices = json.voices ?? json.data ?? json.items;
  if (Array.isArray(voices)) {
    return voices.map((voice) => (typeof voice === "string" ? voice : stringField((voice as JsonObject).name) ?? stringField((voice as JsonObject).id) ?? JSON.stringify(voice)));
  }
  if (voices && typeof voices === "object") {
    return Object.keys(voices);
  }
  return [];
}

function arrayOfStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [String(value)];
}

function formFieldsPreview(form: FormData): JsonObject {
  const preview: JsonObject = {};
  const entries = (form as unknown as { entries(): Iterable<[string, FormDataEntryValue]> }).entries();
  for (const [key, value] of entries) {
    if (typeof value === "string") {
      preview[key] = value;
    } else {
      preview[key] = { file: value.name, type: value.type, size: value.size };
    }
  }
  return preview;
}

function responseHeadersObject(headers: Headers): JsonObject {
  const out: JsonObject = {};
  for (const key of ["x-request-id", "x-model", "x-inference-time-s", "content-type"]) {
    const value = headers.get(key);
    if (value) {
      out[key] = value;
    }
  }
  return out;
}
