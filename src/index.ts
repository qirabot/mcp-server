#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { QiraClient } from "./client.js";
import { registerTools } from "./tools.js";

const VERSION = "0.1.0";
const API_KEY_HEADER = "x-qira-api-key";

interface Config {
  serverURL: string;
  apiKey: string;
  transport: "stdio" | "http";
  port: number;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  let serverURL = process.env.QIRA_SERVER_URL ?? "";
  let apiKey = process.env.QIRA_API_KEY ?? "";
  let transport: "stdio" | "http" = "stdio";
  let port = 3100;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--server" || args[i] === "-s") && args[i + 1]) {
      serverURL = args[++i];
    } else if ((args[i] === "--api-key" || args[i] === "-k") && args[i + 1]) {
      apiKey = args[++i];
    } else if (args[i] === "--transport" || args[i] === "-t") {
      const val = args[++i];
      if (val !== "stdio" && val !== "http") {
        console.error(`Error: --transport must be "stdio" or "http"`);
        process.exit(1);
      }
      transport = val;
    } else if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.error(`qira-mcp-server v${VERSION}

Usage:
  # Local stdio mode — api-key required at startup
  qira-mcp-server --server <url> --api-key <key>

  # Remote HTTP mode — api-key passed per-request via ${API_KEY_HEADER} header
  qira-mcp-server --server <url> --transport http [--port 3100]

Options:
  --server, -s      Server-lite base URL (or QIRA_SERVER_URL env)
  --api-key, -k     API key (required for stdio; ignored for http)
  --transport, -t   Transport mode: "stdio" (default) or "http"
  --port, -p        HTTP server port (default: 3100, only for http mode)
  --help, -h        Show this help message

Claude Code (remote):
  claude mcp add --scope user --header "${API_KEY_HEADER}: YOUR_API_KEY" --transport http qira https://your-server/mcp

Cursor (remote):
  { "mcpServers": { "qira": { "url": "https://your-server/mcp", "headers": { "${API_KEY_HEADER}": "YOUR_API_KEY" } } } }`);
      process.exit(0);
    }
  }

  if (!serverURL) {
    console.error(
      "Error: --server is required (or set QIRA_SERVER_URL)"
    );
    process.exit(1);
  }

  if (transport === "stdio" && !apiKey) {
    console.error(
      "Error: --api-key is required for stdio mode (or set QIRA_API_KEY)"
    );
    process.exit(1);
  }

  return { serverURL, apiKey, transport, port };
}

function createServer(
  client: QiraClient,
  shutdownSignal?: AbortSignal
): McpServer {
  const server = new McpServer({
    name: "qira",
    version: VERSION,
  });
  registerTools(server, client, shutdownSignal);
  return server;
}

async function startStdio(serverURL: string, apiKey: string): Promise<void> {
  const client = new QiraClient(serverURL, apiKey);
  const shutdownController = new AbortController();
  const server = createServer(client, shutdownController.signal);
  const transport = new StdioServerTransport();

  const shutdown = () => {
    if (!shutdownController.signal.aborted) {
      console.error("[qira-mcp-server] pipe disconnected, cancelling tasks");
      shutdownController.abort();
      client.closeWebSocket();
    }
  };

  process.stdin.on("close", shutdown);
  transport.onclose = shutdown;

  await server.connect(transport);
}

async function startHTTP(serverURL: string, port: number): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: VERSION });
  });

  app.post("/mcp", async (req, res) => {
    const apiKey = req.headers[API_KEY_HEADER] as string | undefined;
    if (!apiKey) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Missing ${API_KEY_HEADER} header`,
        },
        id: null,
      });
      return;
    }

    const client = new QiraClient(serverURL, apiKey);
    const shutdownController = new AbortController();
    const server = createServer(client, shutdownController.signal);
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        shutdownController.abort();
        client.closeWebSocket();
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.listen(port, () => {
    console.error(
      `[qira-mcp-server] v${VERSION} HTTP server listening on port ${port}`
    );
  });
}

async function main(): Promise<void> {
  const { serverURL, apiKey, transport, port } = parseArgs();

  console.error(
    `[qira-mcp-server] v${VERSION} starting, transport=${transport}, server_url=${serverURL}`
  );

  if (transport === "http") {
    await startHTTP(serverURL, port);
  } else {
    await startStdio(serverURL, apiKey);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
