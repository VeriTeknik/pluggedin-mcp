#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp-proxy.js";
import { Command } from "commander";
// import { reportAllCapabilities } from "./report-tools.js"; // Removed reporting
// import { cleanupAllSessions } from "./sessions.js"; // Cleanup handled by createServer return

const program = new Command();

program
  .name("pluggedin-mcp-proxy")
  .description("PluggedinMCP MCP Server - The One MCP to manage all your MCPs")
  .option(
    "--pluggedin-api-key <key>",
    "API key for PluggedinMCP (can also be set via PLUGGEDIN_API_KEY env var)"
  )
  .option(
    "--pluggedin-api-base-url <url>",
    "Base URL for PluggedinMCP API (can also be set via PLUGGEDIN_API_BASE_URL env var)"
  )
  // Removed --report option
  .parse(process.argv);

const options = program.opts();

// Validate and sanitize command line arguments before setting environment variables
if (options['pluggedinApiKey']) {
  // Validate API key format (alphanumeric, hyphens, underscores)
  const sanitizedApiKey = String(options['pluggedinApiKey']).replace(/[^a-zA-Z0-9_-]/g, '');
  if (sanitizedApiKey.length > 0) {
    process.env.PLUGGEDIN_API_KEY = sanitizedApiKey;
  }
}
if (options.pluggedinApiBaseUrl) {
  // Validate URL format (basic URL characters only)
  const sanitizedUrl = String(options.pluggedinApiBaseUrl).replace(/[^a-zA-Z0-9:/.\\-_]/g, '');
  // Basic URL validation
  try {
    new URL(sanitizedUrl);
    process.env.PLUGGEDIN_API_BASE_URL = sanitizedUrl;
  } catch (error) {
    console.error("Invalid API base URL provided");
    process.exit(1);
  }
}

async function main() {
  // Removed --report flag handling

  try {
    // Removed initial tool discovery/reporting during startup
    // console.log("Starting initial tool discovery..."); // REMOVED - Cannot log to stdout
    // await reportAllTools(); // REMOVED - This was causing slow startup/timeouts
    // console.log("Initial tool discovery completed"); // REMOVED - Cannot log to stdout

    // Then create and start the server
    const transport = new StdioServerTransport();
    const { server, cleanup } = await createServer();

    // Connect the server to the transport
  await server.connect(transport);

  // Note: Debug logging for raw outgoing messages needs to be implemented
  // within the transport layer or by modifying the SDK if direct access is needed.
  // The wrapper attempt here was incorrect due to type mismatches.

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

  // Start listening (moved inside try block)
  // Note: The original code didn't explicitly call listen, assuming connect handles it.
  // If listen() is needed, it should be called here. Assuming connect is sufficient based on original code.

  } catch (error) {
    // Catch errors during startup, including reportAllTools
    console.error("Error during startup:", error);
    process.exit(1); // Exit if startup fails
  }
}

// Keep the outer catch for any unhandled promise rejections from main itself
main().catch((error) => {
  console.error("Unhandled error in main execution:", error);
  process.exit(1); // Ensure exit on unhandled error
});
