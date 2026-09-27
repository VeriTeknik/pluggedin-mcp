#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, createServerFactory } from "./mcp-proxy.js";
import { Command } from "commander";
import { startStreamableHTTPServer, resolveRequireApiAuth } from "./streamable-http.js";
import { getPluggedinMCPApiKey } from "./utils.js";
import { validateApiUrl, validateBearerToken } from "./security-utils.js";

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
  .option(
    "--transport <type>",
    "Transport type: stdio (default) or streamable-http",
    "stdio"
  )
  .option(
    "--port <number>",
    "Port for Streamable HTTP server (default: 8081, respects PORT env var)",
    "8081"
  )
  .option(
    "--stateless",
    "Enable stateless mode for Streamable HTTP (new transport per request)"
  )
  .option(
    "--require-api-auth",
    "Require API key authentication for Streamable HTTP requests (overrides REQUIRE_API_AUTH env var; on by default when BIND_HOST is not loopback and an API key is configured)"
  )
  // Allow unknown options and excess arguments to prevent errors when called by MCP inspector
  .allowUnknownOption()
  .allowExcessArguments()
  // Removed --report option
  .parse(process.argv);

const options = program.opts();

// Validate command line arguments before setting environment variables.
// Reject bad input instead of rewriting it: a silently altered base URL sends the
// API key to a different host, and an altered key fails in confusing ways later.
if (options['pluggedinApiKey']) {
  const apiKey = String(options['pluggedinApiKey']).trim();
  if (!validateBearerToken(apiKey)) {
    // Never echo the key itself
    console.error("Invalid API key format provided via --pluggedin-api-key");
    process.exit(1);
  }
  process.env.PLUGGEDIN_API_KEY = apiKey;
}
if (options.pluggedinApiBaseUrl) {
  const baseUrl = String(options.pluggedinApiBaseUrl).trim();
  // validateApiUrl parses with new URL() and checks the scheme
  if (!validateApiUrl(baseUrl)) {
    console.error("Invalid API base URL provided via --pluggedin-api-base-url: expected an absolute https:// URL (http:// only for localhost, 127.0.0.1 or [::1])");
    process.exit(1);
  }
  process.env.PLUGGEDIN_API_BASE_URL = baseUrl;
}

async function main() {
  // Removed --report flag handling

  try {
    // Process-wide proxy cleanup (downstream sessions, rate limiters)
    let serverCleanup: () => Promise<void>;
    // Initialize transport based on the selected type
    let transportCleanup: (() => Promise<void>) | null = null;
    
    if (options.transport === 'streamable-http') {
      // Streamable HTTP transport
      // Priority: PORT env var > CLI arg > default (8081)
      const port = parseInt(process.env.PORT || options.port, 10) || 8081;
      // Only log to console for HTTP transport, not STDIO
      console.log(`Starting Streamable HTTP server on port ${port}...`);

      // Priority: --require-api-auth flag > REQUIRE_API_AUTH env var > fail-closed default
      const { requireApiAuth, notice } = resolveRequireApiAuth({
        cliFlag: options.requireApiAuth,
        envValue: process.env.REQUIRE_API_AUTH,
        bindHost: process.env.BIND_HOST,
        hasApiKey: Boolean(getPluggedinMCPApiKey()),
      });
      if (notice) {
        console.error(notice);
      }

      // One MCP Server per session: the SDK connects a Server to a single transport
      const serverFactory = createServerFactory();
      serverCleanup = serverFactory.cleanup;
      transportCleanup = await startStreamableHTTPServer(serverFactory.createServer, {
        port,
        requireApiAuth,
        stateless: options.stateless
      });
      
      // For HTTP server, we don't need to handle stdin
    } else {
      // Default to STDIO transport
      const { server, cleanup } = await createServer();
      serverCleanup = cleanup;
      const transport = new StdioServerTransport();
      await server.connect(transport);
      
      // Cleanup function for STDIO
      transportCleanup = async () => {
        await transport.close();
        await server.close();
      };
      
      // Handle stdin for STDIO mode
      process.stdin.resume();
      process.stdin.on("end", () => process.exit(0));
      process.stdin.on("close", () => process.exit(0));
    }

    // Combined cleanup handler
    const handleExit = async () => {
      await serverCleanup();
      if (transportCleanup) {
        await transportCleanup();
      }
      process.exit(0);
    };

    // Cleanup on exit signals
    process.on("SIGINT", handleExit);
    process.on("SIGTERM", handleExit);

  } catch (error) {
    // Exit if startup fails
    process.exit(1);
  }
}

// Keep the outer catch for any unhandled promise rejections from main itself
main().catch((error) => {
  // Don't log to console for STDIO transport as it interferes with protocol
  process.exit(1); // Ensure exit on unhandled error
});
