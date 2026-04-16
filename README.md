# GLM Search Plugin for OpenClaw

Web search provider plugin using the **GLM/Z.AI** web search MCP server.

## Features

- Web search via GLM's `webSearchPrime` MCP tool
- Supports both **global** (`api.z.ai`) and **CN** (`open.bigmodel.cn`) endpoints
- Region auto-detection or manual config (`glm.region: "cn"`)
- Caching, timeout, and credential management via OpenClaw's web search SDK

## Install

```bash
openclaw plugins install clawhub:@conanwhf/openclaw-glm-search
```

Or from source:

```bash
openclaw plugins install /path/to/glm-search-plugin
```

## Configuration

### API Key

Set one of these environment variables in your OpenClaw gateway:

```bash
export Z_AI_API_KEY="your-api-key"
# or: ZAI_API_KEY, GLM_API_KEY, ZHIPU_API_KEY
```

Or configure via OpenClaw:

```bash
openclaw configure --section web
```

### Region (optional)

To force the CN endpoint, add to your OpenClaw config:

```yaml
tools:
  web:
    search:
      glm:
        region: cn
```

By default, the plugin uses the **global** endpoint (`api.z.ai`).

## Get API Key

- **Global**: [Z.AI Console](https://z.ai/manage-apikey/apikey-list)
- **CN**: [智谱开放平台](https://open.bigmodel.cn/usercenter/apikeys)

## Development

```bash
# Test install locally
openclaw plugins install ./glm-search-plugin

# Publish to ClawHub
clawhub package publish ./glm-search-plugin --dry-run
clawhub package publish ./glm-search-plugin
```

## How it works

This plugin implements a minimal MCP Streamable HTTP client that:

1. Initializes an MCP session with the GLM search server
2. Sends an `initialized` notification
3. Calls the `webSearchPrime` tool with the search query
4. Parses the JSON/SSE response and returns structured results

## License

MIT
