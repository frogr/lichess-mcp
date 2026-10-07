#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LichessClient } from "./lichess.js";
import { createServer } from "./server.js";

async function main() {
  const client = new LichessClient({
    token: process.env.LICHESS_TOKEN,
    timeoutMs: process.env.LICHESS_TIMEOUT_MS ? Number(process.env.LICHESS_TIMEOUT_MS) : undefined,
  });
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; logs go to stderr.
  console.error(`lichess-mcp running on stdio${client.hasToken ? " (LICHESS_TOKEN set)" : ""}`);
}

main().catch((err) => {
  console.error("lichess-mcp failed to start:", err);
  process.exit(1);
});
