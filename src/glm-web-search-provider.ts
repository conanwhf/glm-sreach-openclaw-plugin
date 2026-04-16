/**
 * GLM Web Search Provider for OpenClaw
 *
 * Calls the GLM/Z.AI web search MCP server (Streamable HTTP transport).
 * Supports both global (api.z.ai) and CN (open.bigmodel.cn) endpoints.
 *
 * Structure mirrors the bundled MiniMax web search provider.
 */
import { Type } from "@sinclair/typebox";
import {
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  buildSearchCacheKey,
  formatCliCommand,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  setProviderWebSearchPluginConfigValue,
  setTopLevelCredentialValue,
  wrapWebContent,
  writeCachedSearchPayload,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
} from "openclaw/plugin-sdk/provider-web-search";

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const GLM_SEARCH_ENDPOINT_GLOBAL =
  "https://api.z.ai/api/mcp/web_search_prime/mcp";
const GLM_SEARCH_ENDPOINT_CN =
  "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";

// Env vars checked in priority order (same as the glm-mcp-server-use skill)
const GLM_API_KEY_ENV_VARS = [
  "Z_AI_API_KEY",
  "ZAI_API_KEY",
  "GLM_API_KEY",
  "ZHIPU_API_KEY",
] as const;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function resolveGlmApiKey(
  searchConfig?: SearchConfigRecord,
): string | undefined {
  return (
    readConfiguredSecretString(
      searchConfig?.apiKey,
      "tools.web.search.apiKey",
    ) ?? readProviderEnvValue([...GLM_API_KEY_ENV_VARS])
  );
}

function resolveGlmEndpoint(searchConfig?: SearchConfigRecord): string {
  const glm =
    typeof searchConfig?.glm === "object" &&
    searchConfig.glm !== null &&
    !Array.isArray(searchConfig.glm)
      ? (searchConfig.glm as Record<string, unknown>)
      : undefined;
  const region =
    typeof glm?.region === "string"
      ? (glm as { region: string }).region
      : undefined;
  if (region === "cn") return GLM_SEARCH_ENDPOINT_CN;
  return GLM_SEARCH_ENDPOINT_GLOBAL;
}

// ---------------------------------------------------------------------------
// Minimal MCP Streamable HTTP client
// ---------------------------------------------------------------------------

/**
 * Parse the last JSON-RPC message from an SSE text stream.
 */
function parseSseJsonRpc(
  text: string,
): Record<string, unknown> | undefined {
  let lastData: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      lastData = line.slice(6);
    }
  }
  if (lastData) {
    try {
      return JSON.parse(lastData);
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

interface GlmSearchResultEntry {
  title?: string;
  url?: string;
  link?: string;
  snippet?: string;
  description?: string;
  summary?: string;
  date?: string;
  published?: string;
  siteName?: string;
  icon?: string;
}

interface GlmSearchResponse {
  results?: GlmSearchResultEntry[];
  related_searches?: Array<{ query?: string }>;
}

async function callGlmMcpSearch(params: {
  query: string;
  apiKey: string;
  endpoint: string;
  timeoutSeconds: number;
}): Promise<{
  results: Array<Record<string, unknown>>;
  relatedSearches?: string[];
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${params.apiKey}`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutSeconds * 1000,
  );

  try {
    // ---- Step 1: Initialize MCP session ----
    const initRes = await fetch(params.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "openclaw-glm-search",
            version: "1.0.0",
          },
        },
      }),
      signal: controller.signal,
    });

    if (!initRes.ok) {
      const detail = await initRes.text();
      throw new Error(
        `GLM MCP initialize error (${initRes.status}): ${detail || initRes.statusText}`,
      );
    }

    // Preserve session id if the server returns one
    const sessionId = initRes.headers.get("mcp-session-id");
    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
    }

    // Drain the init body
    await initRes.text();

    // ---- Step 2: Send initialized notification ----
    await fetch(params.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      signal: controller.signal,
    });

    // ---- Step 3: Call webSearchPrime ----
    const searchRes = await fetch(params.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "webSearchPrime",
          arguments: { search_query: params.query },
        },
      }),
      signal: controller.signal,
    });

    if (!searchRes.ok) {
      const detail = await searchRes.text();
      throw new Error(
        `GLM MCP search error (${searchRes.status}): ${detail || searchRes.statusText}`,
      );
    }

    // ---- Parse response (JSON or SSE) ----
    const contentType = searchRes.headers.get("content-type") || "";
    let rpcResponse: Record<string, unknown>;

    if (contentType.includes("text/event-stream")) {
      const text = await searchRes.text();
      const parsed = parseSseJsonRpc(text);
      if (!parsed) {
        throw new Error("GLM MCP: failed to parse SSE response");
      }
      rpcResponse = parsed;
    } else {
      rpcResponse = (await searchRes.json()) as Record<string, unknown>;
    }

    // Check for JSON-RPC level error
    if (rpcResponse.error) {
      const err = rpcResponse.error as Record<string, unknown>;
      throw new Error(
        `GLM MCP error (${err.code ?? "unknown"}): ${err.message ?? "unknown error"}`,
      );
    }

    // ---- Extract tool content ----
    const result = rpcResponse.result as
      | Record<string, unknown>
      | undefined;
    const content = result?.content as
      | Array<Record<string, unknown>>
      | undefined;

    if (!Array.isArray(content) || content.length === 0) {
      return { results: [] };
    }

    const textContent = content.find((c) => c.type === "text");
    if (!textContent?.text || typeof textContent.text !== "string") {
      return { results: [] };
    }

    // The text field holds the search results as JSON
    let searchData: GlmSearchResponse | GlmSearchResultEntry[];
    try {
      searchData = JSON.parse(textContent.text);
    } catch {
      return { results: [] };
    }

    const entries: GlmSearchResultEntry[] = Array.isArray(searchData)
      ? searchData
      : (searchData as GlmSearchResponse).results ?? [];

    const results = entries.map((entry) => {
      const url = entry.url ?? entry.link ?? "";
      const snippet =
        entry.snippet ?? entry.description ?? entry.summary ?? "";
      return {
        title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
        url,
        description: snippet
          ? wrapWebContent(snippet, "web_search")
          : "",
        published: entry.date || entry.published || undefined,
        siteName:
          entry.siteName || resolveSiteName(url) || undefined,
      };
    });

    const relatedSearches = Array.isArray(
      (searchData as GlmSearchResponse).related_searches,
    )
      ? (searchData as GlmSearchResponse).related_searches!
          .map((r) => r.query)
          .filter(
            (q): q is string => typeof q === "string" && q.length > 0,
          )
          .map((q) => wrapWebContent(q, "web_search"))
      : undefined;

    return { results, relatedSearches };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const GlmSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    }),
  ),
});

function missingGlmKeyPayload() {
  return {
    error: "missing_glm_api_key",
    message: `web_search (glm) needs a GLM/Z.AI API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set Z_AI_API_KEY, ZAI_API_KEY, GLM_API_KEY, or ZHIPU_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function createGlmToolDefinition(
  searchConfig?: SearchConfigRecord,
  config?: Record<string, unknown>,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using GLM/Z.AI Search MCP server. Returns titles, URLs, and snippets.",
    parameters: GlmSearchSchema,
    execute: async (args) => {
      const apiKey = resolveGlmApiKey(searchConfig);
      if (!apiKey) {
        return missingGlmKeyPayload();
      }

      const query = readStringParam(args, "query", { required: true });
      const count =
        readNumberParam(args, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;

      const resolvedCount = resolveSearchCount(count, DEFAULT_SEARCH_COUNT);
      const endpoint = resolveGlmEndpoint(searchConfig);

      const cacheKey = buildSearchCacheKey([
        "glm",
        endpoint,
        query,
        resolvedCount,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
      const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);

      const { results, relatedSearches } = await callGlmMcpSearch({
        query,
        apiKey,
        endpoint,
        timeoutSeconds,
      });

      const payload: Record<string, unknown> = {
        query,
        provider: "glm",
        count: results.length,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "glm",
          wrapped: true,
        },
        results: results.slice(0, resolvedCount),
      };

      if (relatedSearches && relatedSearches.length > 0) {
        payload.relatedSearches = relatedSearches;
      }

      writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
      return payload;
    },
  };
}

// ---------------------------------------------------------------------------
// Standalone tool (always available, regardless of default search provider)
// ---------------------------------------------------------------------------

export function createGlmSearchToolDefinition() {
  return {
    name: "glm_search",
    description:
      "Search the web using GLM/Z.AI Search. Returns titles, URLs, and snippets. Use this for Chinese-language queries or when other search providers are unavailable.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query string." }),
      count: Type.Optional(
        Type.Number({
          description: "Number of results to return (1-10).",
          minimum: 1,
          maximum: 10,
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      // Resolve API key from env (same logic as the provider)
      const apiKey = readProviderEnvValue([...GLM_API_KEY_ENV_VARS]);
      if (!apiKey) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(missingGlmKeyPayload()),
            },
          ],
        };
      }

      const query = readStringParam(params, "query", { required: true });
      const count = readNumberParam(params, "count", { integer: true });
      const resolvedCount = resolveSearchCount(count, DEFAULT_SEARCH_COUNT);
      const endpoint = resolveGlmEndpoint();

      const cacheKey = buildSearchCacheKey([
        "glm-tool",
        endpoint,
        query,
        resolvedCount,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return { content: [{ type: "text" as const, text: JSON.stringify(cached) }] };
      }

      const start = Date.now();
      const timeoutSeconds = 30;
      const cacheTtlMs = 15 * 60 * 1000;

      const { results, relatedSearches } = await callGlmMcpSearch({
        query,
        apiKey,
        endpoint,
        timeoutSeconds,
      });

      const payload: Record<string, unknown> = {
        query,
        provider: "glm",
        count: results.length,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "glm",
          wrapped: true,
        },
        results: results.slice(0, resolvedCount),
      };

      if (relatedSearches && relatedSearches.length > 0) {
        payload.relatedSearches = relatedSearches;
      }

      writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    },
  };
}

// ---------------------------------------------------------------------------
// Provider registration (exported)
// ---------------------------------------------------------------------------

export function createGlmWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "glm",
    label: "GLM Search",
    hint: "Structured results via GLM/Z.AI web search MCP server",
    credentialLabel: "GLM/Z.AI API key",
    envVars: [...GLM_API_KEY_ENV_VARS],
    placeholder: "zai-...",
    signupUrl: "https://z.ai/manage-apikey/apikey-list",
    docsUrl: "https://docs.z.ai/devpack/mcp/search-mcp-server",
    autoDetectOrder: 12,
    credentialPath: "plugins.entries.glm-search.config.webSearch.apiKey",
    inactiveSecretPaths: [
      "plugins.entries.glm-search.config.webSearch.apiKey",
    ],
    getCredentialValue: (searchConfig) => searchConfig?.apiKey,
    setCredentialValue: setTopLevelCredentialValue,
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "glm-search")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(
        configTarget,
        "glm-search",
        "apiKey",
        value,
      );
    },
    createTool: (ctx) =>
      createGlmToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "glm",
          resolveProviderWebSearchPluginConfig(ctx.config, "glm-search"),
          { mirrorApiKeyToTopLevel: true },
        ) as SearchConfigRecord | undefined,
        ctx.config as Record<string, unknown> | undefined,
      ),
  };
}
