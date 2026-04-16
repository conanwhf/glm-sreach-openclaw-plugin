import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createGlmWebSearchProvider } from "./src/glm-web-search-provider.js";

export default definePluginEntry({
  id: "glm-search",
  name: "GLM Search",
  description: "Web search via GLM/Z.AI web search MCP server (global & CN endpoints)",
  register(api) {
    api.registerWebSearchProvider(createGlmWebSearchProvider());
  },
});
