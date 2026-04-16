import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createGlmWebSearchProvider,
  createGlmSearchToolDefinition,
} from "./src/glm-web-search-provider.js";
import {
  createGlmReaderToolDefinition,
  createGlmZreadToolDefinition,
} from "./src/glm-mcp-tools.js";

export default definePluginEntry({
  id: "glm-search",
  name: "GLM Search",
  description:
    "GLM/Z.AI tools: web search, page reader, and GitHub repo reader via MCP servers",
  register(api) {
    api.registerWebSearchProvider(createGlmWebSearchProvider());
    api.registerTool(createGlmSearchToolDefinition());
    api.registerTool(createGlmReaderToolDefinition());
    api.registerTool(createGlmZreadToolDefinition());
  },
});
