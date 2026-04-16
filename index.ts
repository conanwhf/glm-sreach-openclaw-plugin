import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createGlmWebSearchProvider,
  createGlmSearchToolDefinition,
} from "./src/glm-web-search-provider.js";

export default definePluginEntry({
  id: "glm-search",
  name: "GLM Search",
  description: "Web search via GLM/Z.AI web search MCP server (global & CN endpoints)",
  register(api) {
    // Register as a web search provider (used when set as default)
    api.registerWebSearchProvider(createGlmWebSearchProvider());

    // Also register as a standalone tool (always available regardless of default)
    api.registerTool(createGlmSearchToolDefinition());
  },
});
