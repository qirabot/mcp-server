# @qirabot/mcp

MCP (Model Context Protocol) server for [Qirabot](https://qirabot.com) — AI-powered device automation for Claude, Cursor, and other MCP clients.

Control mobile and desktop devices with natural language through your AI assistant. The server exposes tools for running automation tasks, taking screenshots, and managing devices.

## Installation

```bash
npm install -g @qirabot/mcp
```

## Configuration

1. Sign up at [qirabot.com](https://qirabot.com) and get your API key from the dashboard.
2. Set it as an environment variable:

```bash
export QIRA_API_KEY="qk_your_api_key"
```

## Setup

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "qira": {
      "command": "qira-mcp-server",
      "env": {
        "QIRA_API_KEY": "qk_your_api_key"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add qira -- qira-mcp-server --api-key $QIRA_API_KEY
```

### Cursor

Add to your Cursor MCP settings (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "qira": {
      "command": "qira-mcp-server",
      "env": {
        "QIRA_API_KEY": "qk_your_api_key"
      }
    }
  }
}
```

### Remote HTTP Mode

For shared or remote deployments, run the server in HTTP mode:

```bash
qira-mcp-server --transport http --port 3100
```

Clients connect with API key in the header:

```json
{
  "mcpServers": {
    "qira": {
      "url": "https://your-server/mcp",
      "headers": {
        "x-qira-api-key": "qk_your_api_key"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `list_devices` | List all active devices with their IDs, OS, type, and resolution |
| `list_model_aliases` | List available AI model aliases (e.g. 'balanced', 'high-quality') |
| `run_task` | Run an automation task on a device with a natural language instruction |
| `get_task` | Get the status and step details of a running or completed task |
| `take_screenshot` | Capture a live screenshot of a device's screen |
| `cancel_task` | Cancel a pending or running task |

## Usage Examples

Once configured, you can ask your AI assistant:

- "List my connected devices"
- "Take a screenshot of my phone"
- "Open Chrome on my device and search for 'weather today'"
- "Go to wikipedia.org and extract the featured article title"
- "Open the Settings app and enable dark mode"

## CLI Options

```
qira-mcp-server [options]

Options:
  --server, -s      Server URL (default: https://app.qirabot.com, or QIRA_SERVER_URL env)
  --api-key, -k     API key (required for stdio; or QIRA_API_KEY env)
  --transport, -t   Transport mode: "stdio" (default) or "http"
  --port, -p        HTTP server port (default: 3100)
  --help, -h        Show help
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `QIRA_SERVER_URL` | Server URL (default: `https://app.qirabot.com`) |
| `QIRA_API_KEY` | API key (alternative to `--api-key`) |

## License

MIT
