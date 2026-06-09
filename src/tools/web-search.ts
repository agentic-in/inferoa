import type { JsonObject, ToolResult } from "../types.js";
import { fail, ok, truncateText } from "../util/limit.js";
import { endpointApiKey } from "../config/config.js";
import type { ToolExecutionContext } from "./context.js";

const DEFAULT_FETCH_BYTES = 1_000_000;
const MAX_FETCH_BYTES = 5_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;
const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const DDG_INSTANT_URL = "https://api.duckduckgo.com/";

type WebSearchProvider = ToolExecutionContext["config"]["web_search"]["provider"];

interface SearchAttempt {
  provider: string;
  status: "ok" | "skipped" | "failed";
  message: string;
}

interface SearchResultItem {
  title: string;
  url: string;
  snippet?: string;
}

export async function webSearch(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  if (!query) {
    return fail("web_search_missing_query", "web_search requires a non-empty query.");
  }
  const directUrl = firstHttpUrl(query);
  if (directUrl) {
    const opened = await webOpen(
      {
        url: directUrl.toString(),
        max_bytes: args.max_bytes,
        timeout_ms: args.timeout_ms,
      },
      context,
    );
    return {
      ...opened,
      summary: opened.ok ? `Opened direct URL from search query: ${directUrl.host}` : opened.summary,
      data: {
        ...objectField(opened.data),
        query,
        direct_url: directUrl.toString(),
        via_search: true,
      },
    };
  }
  const limit = typeof args.limit === "number" ? Math.max(1, Math.min(args.limit, 20)) : 5;
  const provider = context.config.web_search.provider;
  try {
    if (provider === "auto" || provider === "off") {
      return await defaultSearchChain(query, limit, context, provider);
    }
    const configured = await configuredProviderSearch(provider, query, limit, context);
    if (configured.ok) {
      return configured;
    }
    return configured;
  } catch (error) {
    return fail("web_search_failed", error instanceof Error ? error.message : String(error));
  }
}

export async function webFetch(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = normalizeHttpUrl(String(args.url ?? ""));
  if (!parsed) {
    return fail("web_fetch_invalid_url", "web_fetch requires an http or https URL.");
  }
  const maxBytes = clampNumber(args.max_bytes, DEFAULT_FETCH_BYTES, 16_384, MAX_FETCH_BYTES);
  const timeoutMs = clampNumber(args.timeout_ms, DEFAULT_TIMEOUT_MS, 1_000, 120_000);
  const format = typeof args.format === "string" ? args.format : "text";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(parsed.toString(), {
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain,application/json,*/*;q=0.8",
        "user-agent": "inferoa/0.1",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "unknown";
    const { text: raw, truncated: byteTruncated, bytes } = await readResponseText(response, maxBytes);
    const extracted = format === "html" ? { text: raw } : extractReadableText(raw, contentType);
    const preview = truncateText(extracted.text, 18_000);
    const needsResource = preview.truncated || byteTruncated || raw.length !== extracted.text.length;
    const resource = needsResource
      ? context.store.putResource(context.session_id, "web_fetch.text", extracted.text, {
          url: parsed.toString(),
          final_url: response.url,
          status: response.status,
          content_type: contentType,
          title: extracted.title,
          byte_truncated: byteTruncated,
        }).uri
      : undefined;
    return {
      ok: response.ok,
      summary: `${response.ok ? "Fetched" : "Fetch returned"} ${response.status} ${contentType} from ${new URL(response.url).host}`,
      data: {
        url: parsed.toString(),
        final_url: response.url,
        status: response.status,
        ok: response.ok,
        content_type: contentType,
        title: extracted.title,
        bytes,
        byte_truncated: byteTruncated,
        text: preview.text,
      },
      resource_uri: resource,
      error: response.ok ? undefined : { code: "web_fetch_http_error", message: `HTTP ${response.status}` },
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return fail("web_fetch_timeout", `Timed out after ${timeoutMs}ms`, { url: parsed.toString(), timeout_ms: timeoutMs });
    }
    return fail("web_fetch_failed", error instanceof Error ? error.message : String(error), { url: parsed.toString() });
  } finally {
    clearTimeout(timeout);
  }
}

export async function webOpen(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = normalizeHttpUrl(String(args.url ?? ""));
  if (!parsed) {
    return fail("web_open_invalid_url", "web_open requires an http or https URL.");
  }
  const preview = await webFetch(
    {
      url: parsed.toString(),
      max_bytes: args.max_bytes ?? 500_000,
      timeout_ms: args.timeout_ms,
      format: args.format,
    },
    context,
  );
  const data = objectField(preview.data);
  const note = typeof args.note === "string" ? args.note : undefined;
  return {
    ...preview,
    summary: preview.ok
      ? preview.summary.replace(/^Fetched/, "Opened")
      : preview.summary.replace(/^Fetch returned/, "Open returned"),
    data: {
      ...data,
      url: parsed.toString(),
      opened: true,
      note,
    },
  };
}

function objectField(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function firstHttpUrl(value: string): URL | undefined {
  const exact = normalizeHttpUrl(value);
  if (exact) {
    return exact;
  }
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
    const parsed = normalizeHttpUrl(trimTrailingUrlPunctuation(match[0] ?? ""));
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function trimTrailingUrlPunctuation(value: string): string {
  let next = value.trim();
  while (/[.,;:!?。，、；：！？]$/.test(next)) {
    next = next.slice(0, -1);
  }
  return next;
}

async function configuredProviderSearch(
  provider: Exclude<WebSearchProvider, "auto" | "off">,
  query: string,
  limit: number,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  if (provider === "brave") {
    return await braveSearch(query, limit, context);
  }
  if (provider === "searxng" || provider === "custom") {
    return await searxngSearch(query, limit, context);
  }
  if (provider === "jina") {
    return await jinaSearch(query, limit, context);
  }
  return fail(
    "web_search_provider_unsupported",
    `${provider} web_search is not implemented in this build. Choose auto, brave, jina, searxng, or custom in /setup.`,
    { query, provider },
  );
}

async function defaultSearchChain(
  query: string,
  limit: number,
  context: ToolExecutionContext,
  mode: "auto" | "off",
): Promise<ToolResult> {
  const attempts: SearchAttempt[] = [];
  const candidates = searchQueryCandidates(query);
  for (const candidate of candidates) {
    const html = await tryDuckDuckGoHtml(candidate, limit, attempts);
    if (html.length) {
      return searchResultsOk("DuckDuckGo", candidate, html, limit, attempts, { mode });
    }
    if (containsCjk(candidate)) {
      const regional = await tryDuckDuckGoHtml(candidate, limit, attempts, "cn-zh");
      if (regional.length) {
        return searchResultsOk("DuckDuckGo", candidate, regional, limit, attempts, { mode, region: "cn-zh" });
      }
    }
  }

  for (const candidate of candidates) {
    const instant = await tryDuckDuckGoInstant(candidate, limit, attempts);
    if (instant.length) {
      return searchResultsOk("DuckDuckGo Instant", candidate, instant, limit, attempts, { mode });
    }
  }

  const jina = await jinaSearch(query, limit, context, true);
  const data = objectField(jina.data);
  return {
    ...jina,
    data: {
      ...data,
      mode,
      attempts: attempts as never,
    },
  };
}

function searchQueryCandidates(query: string): string[] {
  const normalized = query.replace(/\s+/g, " ").trim();
  return normalized ? [normalized] : [];
}

async function tryDuckDuckGoHtml(
  query: string,
  limit: number,
  attempts: SearchAttempt[],
  region?: string,
): Promise<SearchResultItem[]> {
  const label = region ? `duckduckgo:${region}` : "duckduckgo";
  try {
    const url = new URL(DDG_HTML_URL);
    url.searchParams.set("q", query);
    if (region) {
      url.searchParams.set("kl", region);
    }
    const response = await fetchTextWithTimeout(url, {
      accept: "text/html,application/xhtml+xml",
      timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
    });
    if (!response.ok) {
      attempts.push({ provider: label, status: "failed", message: `HTTP ${response.status}` });
      return [];
    }
    const results = parseDuckDuckGoHtml(response.text, limit);
    attempts.push({
      provider: label,
      status: results.length ? "ok" : "skipped",
      message: results.length ? `${results.length} results` : "no results",
    });
    return results;
  } catch (error) {
    attempts.push({ provider: label, status: "failed", message: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

async function tryDuckDuckGoInstant(query: string, limit: number, attempts: SearchAttempt[]): Promise<SearchResultItem[]> {
  try {
    const url = new URL(DDG_INSTANT_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "1");
    const response = await fetchTextWithTimeout(url, {
      accept: "application/json",
      timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
    });
    if (!response.ok) {
      attempts.push({ provider: "duckduckgo:instant", status: "failed", message: `HTTP ${response.status}` });
      return [];
    }
    const results = parseDuckDuckGoInstant(response.text, limit);
    attempts.push({
      provider: "duckduckgo:instant",
      status: results.length ? "ok" : "skipped",
      message: results.length ? `${results.length} results` : "no results",
    });
    return results;
  } catch (error) {
    attempts.push({ provider: "duckduckgo:instant", status: "failed", message: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

function searchResultsOk(
  provider: string,
  query: string,
  results: SearchResultItem[],
  limit: number,
  attempts: SearchAttempt[],
  extra: JsonObject = {},
): ToolResult {
  return ok(`Found ${results.length} results via ${provider}`, {
    query,
    provider,
    fallback: true,
    limit,
    results: results as never,
    results_text: formatSearchResults(query, results),
    attempts: attempts as never,
    ...extra,
  });
}

function parseDuckDuckGoHtml(html: string, limit: number): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  const blocks = html.match(/<div[^>]+class=["'][^"']*\bresult\b[^"']*["'][\s\S]*?(?=<div[^>]+class=["'][^"']*\bresult\b|<\/body>|$)/gi) ?? [html];
  for (const block of blocks) {
    const link = /<a[^>]+class=["'][^"']*\bresult__a\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block)
      ?? /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link?.[1] || !link[2]) {
      continue;
    }
    const url = unwrapDuckDuckGoResultUrl(decodeHtml(link[1]));
    if (!url || results.some((result) => result.url === url)) {
      continue;
    }
    const snippetMatch = /<a[^>]+class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block)
      ?? /<div[^>]+class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const title = normalizeText(decodeHtml(stripTags(link[2]))) || url;
    const snippet = snippetMatch?.[1] ? normalizeText(decodeHtml(stripTags(snippetMatch[1]))) : undefined;
    results.push({ title, url, snippet });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function parseDuckDuckGoInstant(text: string, limit: number): SearchResultItem[] {
  const payload = safeJson(text);
  const results: SearchResultItem[] = [];
  const abstract = stringField(payload.AbstractText);
  const abstractUrl = stringField(payload.AbstractURL);
  if (abstract) {
    results.push({ title: stringField(payload.Heading) ?? abstractUrl ?? "Instant answer", url: abstractUrl ?? "https://duckduckgo.com/", snippet: abstract });
  }
  const answer = stringField(payload.Answer);
  if (answer && !results.some((result) => result.snippet === answer)) {
    results.push({ title: stringField(payload.Heading) ?? "Instant answer", url: abstractUrl ?? "https://duckduckgo.com/", snippet: answer });
  }
  const related = Array.isArray(payload.RelatedTopics) ? flattenInstantTopics(payload.RelatedTopics) : [];
  for (const item of related) {
    const topic = objectField(item);
    const topicText = stringField(topic.Text);
    if (!topicText) {
      continue;
    }
    const url = stringField(topic.FirstURL) ?? "https://duckduckgo.com/";
    results.push({ title: topicText.split(" - ")[0] ?? topicText, url, snippet: topicText });
    if (results.length >= limit) {
      break;
    }
  }
  return results.slice(0, limit);
}

function flattenInstantTopics(values: unknown[]): JsonObject[] {
  const output: JsonObject[] = [];
  for (const value of values) {
    const item = objectField(value);
    const nested = item.Topics;
    if (Array.isArray(nested)) {
      output.push(...flattenInstantTopics(nested));
    } else if (Object.keys(item).length) {
      output.push(item);
    }
  }
  return output;
}

function formatSearchResults(query: string, results: SearchResultItem[]): string {
  const lines = [`search: ${query}`];
  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   ${result.url}`);
    if (result.snippet) {
      lines.push(`   ${truncateText(result.snippet, 280).text}`);
    }
  }
  return lines.join("\n");
}

function formatJsonSearchResults(query: string, results: JsonObject[]): string {
  return formatSearchResults(
    query,
    results.map((result) => {
      const title = stringField(result.title) ?? stringField(result.name) ?? stringField(result.url) ?? "Untitled";
      const url = stringField(result.url) ?? stringField(result.link) ?? stringField(result.href) ?? "";
      const snippet = stringField(result.description) ?? stringField(result.snippet) ?? stringField(result.content);
      return { title, url, snippet };
    }).filter((result) => result.url),
  );
}

function unwrapDuckDuckGoResultUrl(rawUrl: string): string | undefined {
  const candidate = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl.startsWith("/") ? `https://duckduckgo.com${rawUrl}` : rawUrl;
  const parsed = normalizeHttpUrl(candidate);
  if (!parsed) {
    return undefined;
  }
  if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname.startsWith("/l/")) {
    const redirect = parsed.searchParams.get("uddg");
    const unwrapped = redirect ? normalizeHttpUrl(redirect) : undefined;
    return unwrapped?.toString() ?? parsed.toString();
  }
  return parsed.toString();
}

async function fetchTextWithTimeout(
  url: URL,
  options: { accept: string; timeoutMs: number },
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: options.accept,
        "user-agent": "inferoa/0.1",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

function containsCjk(value: string): boolean {
  return [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff);
  });
}

function stripTags(value: string): string {
  return value.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}

function safeJson(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    return objectField(parsed);
  } catch {
    return {};
  }
}

async function braveSearch(query: string, limit: number, context: ToolExecutionContext): Promise<ToolResult> {
  const apiKey = endpointApiKey(context.config.web_search);
  if (!apiKey) {
    return fail("brave_api_key_missing", "BRAVE web search requires api_key or api_key_ref.");
  }
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-subscription-token": apiKey,
    },
  });
  if (!response.ok) {
    return fail("brave_search_failed", `Brave returned ${response.status}: ${await response.text()}`);
  }
  const json = (await response.json()) as JsonObject;
  const results = (((json.web as JsonObject | undefined)?.results as JsonObject[] | undefined) ?? []).slice(0, limit);
  return ok(`Found ${results.length} Brave results`, {
    query,
    provider: "brave",
    results: results as never,
    results_text: formatJsonSearchResults(query, results),
    limit,
  });
}

async function searxngSearch(query: string, limit: number, context: ToolExecutionContext): Promise<ToolResult> {
  if (!context.config.web_search.base_url) {
    return fail("searxng_base_url_missing", "searxng/custom web_search requires base_url.");
  }
  const url = new URL(context.config.web_search.base_url.replace(/\/$/, "") + "/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    return fail("searxng_search_failed", `Search returned ${response.status}: ${await response.text()}`);
  }
  const json = (await response.json()) as JsonObject;
  const results = (((json.results as JsonObject[] | undefined) ?? []) as JsonObject[]).slice(0, limit);
  return ok(`Found ${results.length} search results`, {
    query,
    provider: context.config.web_search.provider,
    results: results as never,
    results_text: formatJsonSearchResults(query, results),
    limit,
  });
}

async function jinaSearch(query: string, limit: number, context: ToolExecutionContext, fallback = false): Promise<ToolResult> {
  const url = new URL("https://s.jina.ai/");
  url.searchParams.set("q", query);
  const apiKey = endpointApiKey(context.config.web_search);
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) {
    return fail("jina_search_failed", `Jina returned ${response.status}: ${text}`);
  }
  const truncated = truncateText(text, 12_000);
  const resource = truncated.truncated ? context.store.putResource(context.session_id, "web_search.raw", text, { query, provider: "jina" }).uri : undefined;
  return {
    ok: true,
    summary: `${fallback ? "Fallback search" : "Jina search"} returned ${text.length} chars`,
    data: {
      query,
      provider: "jina",
      fallback,
      results_text: truncated.text,
      limit,
    },
    resource_uri: resource,
  };
}

function normalizeHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(value), max));
}

async function readResponseText(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    return { text, bytes: Buffer.byteLength(text), truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = value ?? new Uint8Array();
    const remaining = maxBytes - bytes;
    if (chunk.byteLength > remaining) {
      chunks.push(chunk.slice(0, Math.max(0, remaining)));
      bytes = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(chunk);
    bytes += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(concatChunks(chunks, bytes)), bytes, truncated };
}

function concatChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function extractReadableText(raw: string, contentType: string): { title?: string; text: string } {
  if (!/html|xml/i.test(contentType) && !looksLikeHtml(raw)) {
    return { text: normalizeText(raw) };
  }
  const withoutHidden = raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(withoutHidden);
  const title = titleMatch?.[1] ? normalizeText(decodeHtml(titleMatch[1].replace(/<[^>]+>/g, " "))) : undefined;
  const withBreaks = withoutHidden
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ");
  return { title, text: normalizeText(decodeHtml(withBreaks.replace(/<[^>]+>/g, " "))) };
}

function looksLikeHtml(text: string): boolean {
  return /<!doctype\s+html|<html\b|<body\b|<title\b/i.test(text.slice(0, 4096));
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, token: string) => {
    if (token.startsWith("#x")) {
      return fromCodePoint(Number.parseInt(token.slice(2), 16), entity);
    }
    if (token.startsWith("#")) {
      return fromCodePoint(Number.parseInt(token.slice(1), 10), entity);
    }
    const named: Record<string, string> = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: " ",
      quot: "\"",
    };
    return named[token.toLowerCase()] ?? entity;
  });
}

function fromCodePoint(value: number, fallback: string): string {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}
