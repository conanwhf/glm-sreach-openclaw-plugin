/**
 * GLM MCP Tools (Reader, Zread) for OpenClaw
 *
 * Provides standalone tools that call GLM/Z.AI MCP servers directly.
 */
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Shared MCP Streamable HTTP client
// ---------------------------------------------------------------------------

const GLM_API_KEY_ENV_VARS = [
  "Z_AI_API_KEY",
  "ZAI_API_KEY",
  "GLM_API_KEY",
  "ZHIPU_API_KEY",
] as const;

const ENDPOINTS = {
  reader: "https://api.z.ai/api/mcp/web_reader/mcp",
  readerCn: "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
  zread: "https://api.z.ai/api/mcp/zread/mcp",
  zreadCn: "https://open.bigmodel.cn/api/mcp/zread/mcp",
  search: "https://api.z.ai/api/mcp/web_search_prime/mcp",
  searchCn: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
} as const;

function resolveGlmApiKey(): string | undefined {
  for (const v of GLM_API_KEY_ENV_VARS) {
    const val = process.env[v];
    if (val) return val;
  }
  return undefined;
}

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
    } catch { /* ignore */ }
  }
  return undefined;
}

async function callGlmMcpTool(params: {
  endpoint: string;
  apiKey: string;
  toolName: string;
  arguments: Record<string, unknown>;
  timeoutSeconds?: number;
}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${params.apiKey}`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    (params.timeoutSeconds ?? 30) * 1000,
  );

  try {
    // Step 1: Initialize
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
          clientInfo: { name: "openclaw-glm-tools", version: "1.0.0" },
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

    const sessionId = initRes.headers.get("mcp-session-id");
    if (sessionId) headers["mcp-session-id"] = sessionId;
    await initRes.text();

    // Step 2: Initialized notification
    await fetch(params.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      signal: controller.signal,
    });

    // Step 3: Call tool
    const toolRes = await fetch(params.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: params.toolName,
          arguments: params.arguments,
        },
      }),
      signal: controller.signal,
    });

    if (!toolRes.ok) {
      const detail = await toolRes.text();
      throw new Error(
        `GLM MCP tool call error (${toolRes.status}): ${detail || toolRes.statusText}`,
      );
    }

    // Parse response
    const contentType = toolRes.headers.get("content-type") || "";
    let rpcResponse: Record<string, unknown>;

    if (contentType.includes("text/event-stream")) {
      const text = await toolRes.text();
      const parsed = parseSseJsonRpc(text);
      if (!parsed) throw new Error("GLM MCP: failed to parse SSE response");
      rpcResponse = parsed;
    } else {
      rpcResponse = (await toolRes.json()) as Record<string, unknown>;
    }

    if (rpcResponse.error) {
      const err = rpcResponse.error as Record<string, unknown>;
      throw new Error(
        `GLM MCP error (${err.code ?? "unknown"}): ${err.message ?? "unknown error"}`,
      );
    }

    return rpcResponse.result as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

function extractTextContent(result: Record<string, unknown>): string {
  const content = result.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return "";
  const textItem = content.find((c) => c.type === "text");
  const text = textItem?.text;
  if (typeof text !== "string") return "";
  // The text may be a JSON-encoded string
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
    return JSON.stringify(parsed);
  } catch {
    return text;
  }
}

function missingKeyError() {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: "missing_glm_api_key",
          message:
            "GLM tools need a Z.AI API key. Set Z_AI_API_KEY, ZAI_API_KEY, GLM_API_KEY, or ZHIPU_API_KEY.",
        }),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// GLM Reader tool
// ---------------------------------------------------------------------------

export function createGlmReaderToolDefinition() {
  return {
    name: "glm_reader",
    description:
      "Read and extract content from a web page URL using GLM/Z.AI Web Reader MCP server. Returns page title, description, body content, and metadata. Handles anti-bot pages better than standard fetch.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL of the web page to read." }),
      return_format: Type.Optional(
        Type.Enum(
          { text: "text", markdown: "markdown" },
          { description: "Output format. Default: text." },
        ),
      ),
      no_cache: Type.Optional(
        Type.Boolean({
          description: "Bypass cache and fetch fresh content. Default: false.",
        }),
      ),
    }),
    async execute(
      _id: string,
      params: Record<string, unknown>,
    ) {
      const apiKey = resolveGlmApiKey();
      if (!apiKey) return missingKeyError();

      try {
        const result = await callGlmMcpTool({
          endpoint: ENDPOINTS.reader,
          apiKey,
          toolName: "webReader",
          arguments: {
            url: params.url,
            return_format: params.return_format ?? "text",
            no_cache: params.no_cache ?? false,
          },
          timeoutSeconds: 30,
        });

        const text = extractTextContent(result);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// GLM Zread tool
// ---------------------------------------------------------------------------

export function createGlmZreadToolDefinition() {
  return {
    name: "glm_zread",
    description:
      "Read GitHub repository structure and file contents using GLM/Z.AI Zread MCP server. Supports browsing repo trees and reading individual files.",
    parameters: Type.Object({
      action: Type.Enum(
        {
          structure: "structure",
          file: "file",
        },
        {
          description:
            "Action to perform: 'structure' to get repo directory tree, 'file' to read a specific file.",
        },
      ),
      repo_name: Type.String({
        description: "GitHub repository in owner/repo format, e.g. 'openclaw/openclaw'.",
      }),
      path: Type.Optional(
        Type.String({
          description: "File path (for 'file' action) or subdirectory (for 'structure' action).",
        }),
      ),
    }),
    async execute(
      _id: string,
      params: Record<string, unknown>,
    ) {
      const apiKey = resolveGlmApiKey();
      if (!apiKey) return missingKeyError();

      try {
        const toolName =
          params.action === "file" ? "read_file" : "get_repo_structure";
        const args: Record<string, unknown> = {
          repo_name: params.repo_name,
        };
        if (params.path) args.path = params.path;

        const result = await callGlmMcpTool({
          endpoint: ENDPOINTS.zread,
          apiKey,
          toolName,
          arguments: args,
          timeoutSeconds: 30,
        });

        const text = extractTextContent(result);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
        };
      }
    },
  };
}
