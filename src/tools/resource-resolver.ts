import type { ResourceRecord } from "../session/store.js";
import type { JsonObject, JsonValue } from "../types.js";
import type { ToolExecutionContext } from "./context.js";

export interface ResourceLookupFailure {
  code: "resource_not_found" | "resource_uri_ambiguous";
  message: string;
  ambiguous?: ResourceRecord[];
}

export type ResourceLookupResult = { ok: true; resource: ResourceRecord } | { ok: false; failure: ResourceLookupFailure };

export interface ResourceMediaPayload {
  bytes?: Buffer;
  contentType: string;
  name: string;
  sourceResource: ResourceRecord;
  mediaIndex: number;
  remoteUrl?: string;
}

export type ResourceMediaResult =
  | { ok: true; media: ResourceMediaPayload }
  | { ok: false; failure: ResourceLookupFailure | { code: "resource_has_no_media" | "resource_has_remote_url_only"; message: string } };

export function resolveResourceReference(uri: string, context: ToolExecutionContext): ResourceLookupResult {
  const exact = context.store.readResource(uri);
  if (exact) {
    return { ok: true, resource: exact };
  }
  const resources = context.store.listResources(context.session_id, 50);
  const matches = resources.filter((resource) => resource.uri === uri || resource.uri.endsWith(uri) || resource.uri.includes(uri));
  if (matches.length === 1) {
    return { ok: true, resource: matches[0]! };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      failure: {
        code: "resource_uri_ambiguous",
        message: `Resource URI is ambiguous: ${uri}`,
        ambiguous: matches,
      },
    };
  }
  return {
    ok: false,
    failure: {
      code: "resource_not_found",
      message: `Resource not found: ${uri}`,
    },
  };
}

export function listResourceSummaries(context: ToolExecutionContext, limit = 20): JsonObject[] {
  return context.store.listResources(context.session_id, limit).map(resourceRecordSummary);
}

export function resourceRecordSummary(resource: ResourceRecord): JsonObject {
  return {
    uri: resource.uri,
    kind: resource.kind,
    created_at: resource.created_at,
    bytes: Buffer.byteLength(resource.content),
    metadata: resource.metadata,
  };
}

export function resolveResourceMedia(input: string, context: ToolExecutionContext, mediaIndex = 0): ResourceMediaResult {
  const resolved = resolveResourceReference(input, context);
  if (!resolved.ok) {
    return { ok: false, failure: resolved.failure };
  }
  return mediaFromResource(resolved.resource, context, mediaIndex, new Set());
}

export function mediaFromResource(resource: ResourceRecord, context: ToolExecutionContext, mediaIndex = 0, seen = new Set<string>()): ResourceMediaResult {
  if (seen.has(resource.uri)) {
    return { ok: false, failure: { code: "resource_has_no_media", message: `Resource media reference cycle: ${resource.uri}` } };
  }
  seen.add(resource.uri);

  if (resource.metadata.encoding === "base64") {
    const contentType = stringMetadata(resource.metadata.content_type) ?? "application/octet-stream";
    return {
      ok: true,
      media: {
        bytes: Buffer.from(resource.content, "base64"),
        contentType,
        name: resourceFileName(resource, contentType),
        sourceResource: resource,
        mediaIndex,
      },
    };
  }

  const refs = mediaResourceRefs(resource.metadata);
  if (refs.length > 0) {
    const selected = refs[Math.max(0, Math.min(mediaIndex, refs.length - 1))]!;
    const resolved = resolveResourceReference(selected, context);
    if (!resolved.ok) {
      return { ok: false, failure: resolved.failure };
    }
    return mediaFromResource(resolved.resource, context, mediaIndex, seen);
  }

  const embedded = embeddedMediaFromJson(resource, mediaIndex);
  if (embedded) {
    return { ok: true, media: embedded };
  }

  const remoteUrl = embeddedRemoteUrl(resource, mediaIndex);
  if (remoteUrl) {
    return {
      ok: false,
      failure: {
        code: "resource_has_remote_url_only",
        message: `Resource contains only a remote media URL and no embedded bytes: ${remoteUrl}`,
      },
    };
  }

  return {
    ok: false,
    failure: {
      code: "resource_has_no_media",
      message: `Resource does not contain exportable media: ${resource.uri}`,
    },
  };
}

export function dataUriToBuffer(input: string, fallbackName: string): { bytes: Buffer; contentType: string; name: string } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(input);
  if (!match) {
    throw new Error("Invalid data URI.");
  }
  const contentType = match[1] || "application/octet-stream";
  const data = match[3] ?? "";
  const bytes = match[2] ? Buffer.from(data, "base64") : Buffer.from(decodeURIComponent(data), "utf8");
  return { bytes, contentType, name: `${fallbackName}.${extensionForContentType(contentType)}` };
}

export function extensionForContentType(contentType: string): string {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("json")) return "json";
  if (normalized.includes("text")) return "txt";
  return "bin";
}

function embeddedMediaFromJson(resource: ResourceRecord, mediaIndex: number): ResourceMediaPayload | undefined {
  const parsed = parseJson(resource.content);
  if (!parsed) {
    return undefined;
  }
  const response = objectValue(parsed.response) ?? parsed;
  const request = objectValue(parsed.request);
  const data = arrayValue(response.data);
  const selected = data?.[mediaIndex];
  if (!selected || typeof selected !== "object") {
    return undefined;
  }
  const item = selected as JsonObject;
  const encoded = stringValue(item.b64_json);
  if (!encoded) {
    return undefined;
  }
  const contentType = imageContentTypeFromRequest(request);
  return {
    bytes: Buffer.from(encoded, "base64"),
    contentType,
    name: resourceFileName(resource, contentType, mediaIndex),
    sourceResource: resource,
    mediaIndex,
  };
}

function embeddedRemoteUrl(resource: ResourceRecord, mediaIndex: number): string | undefined {
  const parsed = parseJson(resource.content);
  if (!parsed) {
    return undefined;
  }
  const response = objectValue(parsed.response) ?? parsed;
  const data = arrayValue(response.data);
  const selected = data?.[mediaIndex];
  if (!selected || typeof selected !== "object") {
    return undefined;
  }
  return stringValue((selected as JsonObject).url);
}

function mediaResourceRefs(metadata: JsonObject): string[] {
  const refs: string[] = [];
  const primary = stringMetadata(metadata.primary_media_resource);
  const single = stringMetadata(metadata.media_resource);
  if (primary) refs.push(primary);
  if (single && single !== primary) refs.push(single);
  const many = metadata.media_resources;
  if (Array.isArray(many)) {
    for (const item of many) {
      if (typeof item === "string" && !refs.includes(item)) {
        refs.push(item);
      }
    }
  }
  return refs;
}

function imageContentTypeFromRequest(request: JsonObject | undefined): string {
  const format = stringValue(request?.output_format) ?? stringValue(request?.response_format);
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  if (format === "gif") return "image/gif";
  return "image/png";
}

function resourceFileName(resource: ResourceRecord, contentType: string, index?: number): string {
  const id = resource.uri.split("/").pop() ?? "resource";
  const suffix = index === undefined ? "" : `-${index}`;
  return `${id}${suffix}.${extensionForContentType(contentType)}`;
}

function stringMetadata(value: JsonValue): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function arrayValue(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function parseJson(content: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}
