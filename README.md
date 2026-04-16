# GLM Search & Tools Plugin for OpenClaw

GLM/Z.AI tools for OpenClaw via MCP servers: **web search**, **page reader**, and **GitHub repo reader**.

## Tools

| Tool | MCP Server | Description |
|------|-----------|-------------|
| `glm_search` | web_search_prime | Search the web via GLM (currently returns empty results due to a GLM service-side issue) |
| `glm_reader` | web_reader | Read and extract content from any URL — handles anti-bot pages |
| `glm_zread` | zread | Browse GitHub repo structure and read files |

All three tools are **standalone** — available regardless of your default search provider.

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

### Region (optional)

To force CN endpoints, add to your OpenClaw config:

```yaml
tools:
  web:
    search:
      glm:
        region: cn
```

## Get API Key

- **Global**: [Z.AI Console](https://z.ai/manage-apikey/apikey-list)
- **CN**: [智谱开放平台](https://open.bigmodel.cn/usercenter/apikeys)

## Usage Examples

```
# Read a web page
glm_reader url="https://example.com/article"

# Browse a GitHub repo
glm_zread action="structure" repo_name="openclaw/openclaw"

# Read a specific file from a repo
glm_zread action="file" repo_name="openclaw/openclaw" path="package.json"

# Search the web (when GLM fixes their service)
glm_search query="latest AI news"
```

## Known Issues

- **`glm_search`** returns empty results (`[]`) for all queries. This is a GLM/Z.AI service-side issue, not a plugin bug. Other tools (reader, zread) work fine.

## Development

```bash
# Test locally
openclaw plugins install ./glm-search-plugin

# Publish to ClawHub
clawhub package publish ./glm-search-plugin --dry-run
clawhub package publish ./glm-search-plugin
```

## License

MIT
