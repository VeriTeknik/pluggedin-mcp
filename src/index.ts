#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp-proxy.js";
import { Command } from "commander";

const program = new Command();

program
  .name("pluggedin-mcp-proxy")
  .description("Pluggedin MCP Server - The One MCP to manage all your MCPs")
  .option(
    "--pluggedin-api-key <key>",
    "API key for Pluggedin (can also be set via PLUGGEDIN_API_KEY env var)"
  )
  .option(
    "--pluggedin-api-base-url <url>",
    "Base URL for Pluggedin API (can also be set via PLUGGEDIN_API_BASE_URL env var)"
  )
  .parse(process.argv);

const options = program.opts();

// Set environment variables from command line arguments
if (options.pluggedinApiKey) {
  process.env.PLUGGEDIN_API_KEY = options.pluggedinApiKey;
}
if (options.pluggedinApiBaseUrl) {
  process.env.PLUGGEDIN_API_BASE_URL = options.pluggedinApiBaseUrl;
}

async function main() {
  const transport = new StdioServerTransport();
  const { server, cleanup } = await createServer();

  await server.connect(transport);

  const handleExit = async () => {
    await cleanup();
    await transport.close();
    await server.close();
    process.exit(0);
  };

  // Cleanup on exit
  process.on("SIGINT", handleExit);
  process.on("SIGTERM", handleExit);

  process.stdin.resume();
  process.stdin.on("end", handleExit);
  process.stdin.on("close", handleExit);
}

main().catch((error) => {
  console.error("Server error:", error);
});
