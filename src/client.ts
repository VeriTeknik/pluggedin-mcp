import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ServerParameters } from "./types.js";
import { createRequire } from 'module';
import { debugLog, debugError } from './debug-log.js';

const customRequire = createRequire(import.meta.url);
const packageJson = customRequire('../package.json');

// Removed logger

const sleep = (time: number) =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), time));
export interface ConnectedClient {
  client: Client;
  cleanup: () => Promise<void>;
}

// Validate command to prevent command injection
function validateCommand(command: string): boolean {
  // Only allow alphanumeric, hyphens, underscores, dots, and forward slashes
  // This should cover most legitimate executable paths
  return /^[a-zA-Z0-9\-_./]+$/.test(command);
}

// Validate arguments. The STDIO transport spawns without a shell (cross-spawn with
// shell: false; on Windows cross-spawn escapes cmd.exe metacharacters itself), so
// arguments are passed through unchanged. Rewriting them would corrupt legitimate
// values such as passwords, URLs and Windows paths without adding any protection.
// Returns undefined if any argument cannot be passed to a process (NUL byte).
function validateArgs(args: string[]): string[] | undefined {
  const validated = args.map(arg => String(arg));
  return validated.some(arg => arg.includes('\0')) ? undefined : validated;
}

// Build an auth provider from the configured OAuth token or OAuth settings
function createAuthProvider(serverParams: ServerParameters): any {
  if (serverParams.oauthToken) {
    // Create a simple auth provider that returns the token
    return {
      tokens: async () => ({ access_token: serverParams.oauthToken }),
      authorize: async () => { throw new Error("Authorization not implemented"); },
      refresh: async () => { throw new Error("Refresh not implemented"); }
    };
  } else if (serverParams.oauth) {
    // Create a more comprehensive auth provider for OAuth flows
    return {
      tokens: async () => {
        // If we have a stored token, return it
        if (serverParams.oauthToken) {
          return { access_token: serverParams.oauthToken };
        }
        // Otherwise, trigger authorization flow
        throw new Error("Authorization required");
      },
      authorize: async () => {
        // This would trigger the OAuth authorization flow
        // The actual implementation depends on the OAuth provider
        debugError(`OAuth authorization required for ${serverParams.name}`);
        throw new Error("OAuth authorization required - please authorize through the UI");
      },
      refresh: async (_refreshToken: string) => {
        // Implement token refresh if supported by the provider
        debugError(`OAuth token refresh not implemented for ${serverParams.name}`);
        throw new Error("Token refresh not implemented");
      }
    };
  }
  return undefined;
}

// Validate environment variables
function validateEnv(env: Record<string, string>): Record<string, string> {
  const validated: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // Only allow valid environment variable names
    if (/^[A-Z0-9_]+$/i.test(key)) {
      // Sanitize the value to prevent injection
      validated[key] = String(value).replace(/[\0\r\n]/g, '');
    }
  }
  return validated;
}

export const createPluggedinMCPClient = (
  serverParams: ServerParameters
): { client: Client | undefined; transport: Transport | undefined } => {
  let transport: Transport | undefined;

  // Create the appropriate transport based on server type
  // Default to "STDIO" if type is undefined
  if (!serverParams.type || serverParams.type === "STDIO") {
    // Validate command before use
    if (!serverParams.command || !validateCommand(serverParams.command)) {
      debugError(`Invalid command for server ${serverParams.name}: ${serverParams.command}`);
      return { client: undefined, transport: undefined };
    }

    const args = serverParams.args ? validateArgs(serverParams.args) : undefined;
    if (serverParams.args && !args) {
      debugError(`Invalid arguments for server ${serverParams.name}: arguments must not contain NUL bytes`);
      return { client: undefined, transport: undefined };
    }

    const stdioParams: StdioServerParameters = {
      command: serverParams.command,
      args,
      env: serverParams.env ? validateEnv(serverParams.env) : undefined,
      // Use default values for other optional properties
      // stderr and cwd will use their default values
    };
    transport = new StdioClientTransport(stdioParams);
  } else if (serverParams.type === "SSE" && serverParams.url) {
    // Validate URL before use
    try {
      const url = new URL(serverParams.url);
      // Only allow http and https protocols
      if (!['http:', 'https:'].includes(url.protocol)) {
        debugError(`Invalid protocol for SSE server ${serverParams.name}: ${url.protocol}`);
        return { client: undefined, transport: undefined };
      }
      // Headers apply to both the event stream and posted messages
      const transportOptions: any = {};
      if (serverParams.headers) {
        transportOptions.requestInit = { headers: serverParams.headers };
        debugLog(`[MCP] SSE transport: Adding ${Object.keys(serverParams.headers).length} custom headers for ${serverParams.name}`);
      }
      const authProvider = createAuthProvider(serverParams);
      if (authProvider) {
        transportOptions.authProvider = authProvider;
      }

      transport = new SSEClientTransport(url, transportOptions);
    } catch (error) {
      debugError(`Invalid URL for SSE server ${serverParams.name}: ${serverParams.url}`);
      return { client: undefined, transport: undefined };
    }
  } else if (serverParams.type === "STREAMABLE_HTTP" && serverParams.url) {
    // Validate URL before use
    try {
      const url = new URL(serverParams.url);
      // Only allow http and https protocols
      if (!['http:', 'https:'].includes(url.protocol)) {
        debugError(`Invalid protocol for Streamable HTTP server ${serverParams.name}: ${url.protocol}`);
        return { client: undefined, transport: undefined };
      }
      
      // Create transport options
      const transportOptions: any = {
        requestInit: {}
      };
      
      // Add headers if provided
      if (serverParams.headers) {
        transportOptions.requestInit.headers = serverParams.headers;
        debugLog(`[MCP] StreamableHTTP transport: Adding ${Object.keys(serverParams.headers).length} custom headers for ${serverParams.name}`);
      }
      
      // Add session ID if provided
      if (serverParams.sessionId) {
        transportOptions.sessionId = serverParams.sessionId;
        debugLog(`[MCP] StreamableHTTP transport: Using session ID for ${serverParams.name}`);
      }
      
      // Add OAuth configuration if provided
      const authProvider = createAuthProvider(serverParams);
      if (authProvider) {
        transportOptions.authProvider = authProvider;
      }

      transport = new StreamableHTTPClientTransport(url, transportOptions);
    } catch (error) {
      debugError(`Invalid URL for Streamable HTTP server ${serverParams.name}: ${serverParams.url}`);
      return { client: undefined, transport: undefined };
    }
  } else {
    // logger.error(`Unsupported server type: ${serverParams.type} for server ${serverParams.name} (${serverParams.uuid})`); // Removed logging
    return { client: undefined, transport: undefined };
  }

  const client = new Client(
    {
      name: "PluggedinMCP",
      version: packageJson.version, // Use version from package.json
    },
    {
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
      },
    }
  );
  return { client, transport };
};

export const connectPluggedinMCPClient = async (
  client: Client,
  transport: Transport
): Promise<ConnectedClient | undefined> => {
  const waitFor = 2500;
  const retries = 3;
  let count = 0;
  let retry = true;

  while (retry) {
    try {
      await client.connect(transport);

      return {
        client,
        cleanup: async () => {
          await transport.close();
          await client.close();
        },
      };
    } catch (error) {
      count++;
      retry = count < retries;
      if (retry) {
        try {
          await client.close();
        } catch {}
        await sleep(waitFor);
      }
    }
  }
};
