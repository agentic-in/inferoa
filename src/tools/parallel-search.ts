import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JsonObject, ToolResult } from "../types.js";
import { fail, ok, truncateText } from "../util/limit.js";
import type { ToolExecutionContext } from "./context.js";

const SEARCH_URL = "https://search.parallel.ai/mcp";
const TIMEOUT_MS = 20_000;

export async function parallelSearch(query: string, limit: number, context: ToolExecutionContext): Promise<ToolResult> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const client = new Client({ name: "inferoa", version: "0.14.19" });
  const transport = new StreamableHTTPClientTransport(new URL(SEARCH_URL), {
    requestInit: { headers: { "user-agent": "inferoa/0.14.19" } },
    // Bound discovery, notifications and response bodies as well as the tool call.
    fetch: (input, init) => fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    }),
  });
  try {
    await client.connect(transport, { signal, timeout: TIMEOUT_MS });
    const tools = await client.listTools({}, { signal, timeout: TIMEOUT_MS });
    if (!tools.tools.some((tool) => tool.name === "web_search")) {
      return fail("parallel_search_unavailable", "Parallel MCP did not advertise web_search.");
    }
    const response = CallToolResultSchema.parse(await client.callTool({
      name: "web_search",
      arguments: {
        objective: query,
        search_queries: [query],
        session_id: context.session_id,
        model_name: context.config.model_setup.model,
      },
    }, CallToolResultSchema, { signal, timeout: TIMEOUT_MS }));
    const text = response.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    if (response.isError) {
      return fail("parallel_search_failed", truncateText(text || "Parallel search failed.", 2_000).text);
    }
    const payload = response.structuredContent ?? JSON.parse(text) as unknown;
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as JsonObject).results)) {
      return fail("parallel_search_invalid_response", "Parallel MCP returned no results array.");
    }
    const results: JsonObject[] = [];
    for (const item of (payload as { results: unknown[] }).results) {
      if (!item || typeof item !== "object") continue;
      const result = item as Record<string, unknown>;
      if (typeof result.url !== "string" || !/^https?:\/\//i.test(result.url)) continue;
      const title = typeof result.title === "string" ? result.title : result.url;
      const excerpts = Array.isArray(result.excerpts) ? result.excerpts.filter((value): value is string => typeof value === "string") : [];
      results.push({ title, url: result.url, snippet: excerpts.join("\n") });
      if (results.length >= limit) break;
    }
    const fullText = [`search: ${query}`, ...results.map((result, index) =>
      `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`)].join("\n");
    const preview = truncateText(fullText, 12_000);
    const resource = preview.truncated
      ? context.store.putResource(context.session_id, "web_search.raw", fullText, { query, provider: "parallel" }).uri
      : undefined;
    return {
      ...ok(`Found ${results.length} results via Parallel`, {
        query, provider: "parallel", limit, results, results_text: preview.text,
      }),
      resource_uri: resource,
    };
  } catch (error) {
    if (signal.aborted) {
      return fail("parallel_search_timeout", `Timed out after ${TIMEOUT_MS}ms`);
    }
    return fail("parallel_search_failed", error instanceof Error ? error.message : String(error));
  } finally {
    await client.close().catch(() => undefined);
  }
}
