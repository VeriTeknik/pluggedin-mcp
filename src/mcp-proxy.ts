import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  Tool,
  ListToolsResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ResourceTemplate,
  CompatibilityCallToolResultSchema,
  GetPromptResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getMcpServers } from "./fetch-pluggedinmcp.js";
import { getSessionKey, sanitizeName, isDebugEnabled, getPluggedinMCPApiKey, getPluggedinMCPApiBaseUrl } from "./utils.js";
import { cleanupAllSessions, getSession, initSessions } from "./sessions.js";
import { ConnectedClient } from "./client.js";
import axios from "axios";
// Removed unused imports
import { GetPluggedinToolsTool } from "./tools/get-pluggedin-tools.js";
import { CallPluggedinToolTool } from "./tools/call-pluggedin-tool.js";
import { zodToJsonSchema } from 'zod-to-json-schema';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { ToolExecutionResult } from "./types.js";

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

// Map to store prefixed tool name -> { originalName, serverUuid }
const toolToServerMap: Record<string, { originalName: string; serverUuid: string; }> = {};

// Removed logger

// Define the static discovery tool schema using Zod
const DiscoverToolsInputSchema = z.object({
  server_uuid: z.string().uuid().optional().describe("Optional UUID of a specific server to discover. If omitted, attempts to discover all."),
}).describe("Triggers tool discovery for configured MCP servers in the Pluggedin App.");

// Define the static discovery tool structure
const discoverToolsStaticTool: Tool = {
    name: "pluggedin_discover_tools",
    description: "Triggers discovery of tools (and resources/templates) for configured MCP servers in the Pluggedin App.",
    inputSchema: zodToJsonSchema(DiscoverToolsInputSchema) as any,
};


// Removed old static tool instances (getToolsInstance, callToolInstance) as they are superseded by API fetching

export const createServer = async () => {
  const server = new Server(
    {
      name: "PluggedinMCP",
      version: packageJson.version,
    },
    {
      // Restore resource capabilities
      capabilities: {
        prompts: undefined, // No prompt support
        resources: {}, // Resource support enabled
        tools: {}, // Tool support enabled
      },
    }
  );

  // List Tools Handler - Fetches prefixed tools from Pluggedin App API and adds static tool
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
     let fetchedTools: (Tool & { _serverUuid: string })[] = [];
     try {
       const apiKey = getPluggedinMCPApiKey();
       const baseUrl = getPluggedinMCPApiBaseUrl();
       if (!apiKey || !baseUrl) {
         throw new Error("Pluggedin API Key or Base URL is not configured.");
       }

       const apiUrl = `${baseUrl}/api/tools`; // Assuming this is the correct endpoint

       // Fetch the list of tools (which now include prefixed names and _serverUuid)
       const response = await axios.get<(Tool & { _serverUuid: string })[]>(apiUrl, {
         headers: {
           Authorization: `Bearer ${apiKey}`,
         },
         timeout: 10000,
       });

       const fetchedTools = response.data || [];

       // Clear previous mapping and populate with new data
       Object.keys(toolToServerMap).forEach(key => delete toolToServerMap[key]); // Clear map
       fetchedTools.forEach(tool => {
         // Extract original name (assuming prefix_originalName format)
         const parts = tool.name.split('_');
         const originalName = parts.slice(1).join('_'); // Handle names with underscores
         if (originalName && tool._serverUuid) {
            toolToServerMap[tool.name] = { originalName: originalName, serverUuid: tool._serverUuid };
         } else {
            console.error(`[ListTools Handler] Could not parse original name or missing UUID for tool: ${tool.name}`);
         }
       });

       // Prepare the response payload according to MCP spec { tools: Tool[] }
       // Remove the internal _serverUuid before sending to client
       const toolsForClient: Tool[] = fetchedTools.map(({ _serverUuid, ...rest }) => rest);

       // Note: Pagination not handled here, assumes API returns all tools

       // Always include the static discovery tool
       const allToolsForClient = [discoverToolsStaticTool, ...toolsForClient];

       return { tools: allToolsForClient, nextCursor: undefined };

     } catch (error: any) {
       // Log API fetch error but still return the static tool
       const errorMessage = axios.isAxiosError(error)
         ? `API Error (${error.response?.status}): ${error.message}`
         : error instanceof Error
         ? error.message
         : "Unknown error fetching tools from API";
       console.error("[ListTools Handler Error]", errorMessage);
       throw new Error(`Failed to list tools: ${errorMessage}`);
     }
  });

  // Call Tool Handler - Handles prefixed tool names and proxies to downstream server, plus static tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: requestedToolName, arguments: args } = request.params;
    const meta = request.params._meta;

    try {
        // Handle static discovery tool first
        if (requestedToolName === discoverToolsStaticTool.name) {
            console.error(`[CallTool Handler] Executing static tool: ${requestedToolName}`);
            const validatedArgs = DiscoverToolsInputSchema.parse(args ?? {}); // Validate args

            const apiKey = getPluggedinMCPApiKey();
            const baseUrl = getPluggedinMCPApiBaseUrl();
            if (!apiKey || !baseUrl) {
                throw new Error("Pluggedin API Key or Base URL is not configured for discovery trigger.");
            }

            // Define the API endpoint in pluggedin-app to trigger discovery
            // (This endpoint needs to be created in pluggedin-app)
            const discoveryApiUrl = validatedArgs.server_uuid
                ? `${baseUrl}/api/discover/${validatedArgs.server_uuid}` // Endpoint for specific server
                : `${baseUrl}/api/discover/all`; // Endpoint for all servers

            try {
                // Make POST request to trigger discovery
                const discoveryResponse = await axios.post(discoveryApiUrl, {}, { // Empty body for trigger
                    headers: { Authorization: `Bearer ${apiKey}` },
                    timeout: 30000, // Allow longer timeout for discovery trigger
                });

                // Return success message from the discovery API response
                const responseMessage = discoveryResponse.data?.message || "Discovery process initiated.";
                return {
                    content: [{ type: "text", text: responseMessage }],
                    isError: false,
                } as ToolExecutionResult; // Cast to expected type

            } catch (apiError: any) {
                 const errorMsg = axios.isAxiosError(apiError)
                    ? `API Error (${apiError.response?.status}): ${apiError.response?.data?.error || apiError.message}`
                    : apiError.message;
                 throw new Error(`Failed to trigger discovery via API: ${errorMsg}`);
            }
        }

        // Look up the downstream tool in our map
        const toolInfo = toolToServerMap[requestedToolName];
        if (!toolInfo) {
            throw new Error(`Method not found: ${requestedToolName}`);
        }

        const { originalName, serverUuid } = toolInfo;

        // Get the downstream server session
        // Need to fetch server params again - potentially cache this?
        const serverParams = await getMcpServers(true);
        const params = serverParams[serverUuid];
        if (!params) {
            // Use requestedToolName here
            throw new Error(`Configuration not found for server UUID: ${serverUuid} associated with tool ${requestedToolName}`);
        }
        const sessionKey = getSessionKey(serverUuid, params);
        const session = await getSession(sessionKey, serverUuid, params);

        if (!session) {
            throw new Error(`Session not found for server UUID: ${serverUuid}`);
        }

        // Proxy the call to the downstream server using the ORIGINAL tool name
        // Use requestedToolName here
        console.error(`[CallTool Proxy] Calling original tool '${originalName}' on server ${serverUuid} for prefixed name '${requestedToolName}'`);
        const result = await session.client.request(
            { method: "tools/call", params: { name: originalName, arguments: args, _meta: meta } },
            // Assuming downstream server returns CompatibilityCallToolResultSchema or similar
            // Use a broad schema or 'any' if unsure, but CompatibilityCallToolResultSchema is safer
             CompatibilityCallToolResultSchema
        );

        // Return the result directly, casting to any to satisfy the handler's complex return type
        return result as any;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Use requestedToolName here, which is in scope
      console.error(`[CallTool Handler Error] Tool: ${requestedToolName}, Error: ${errorMessage}`);

      // Re-throw the error for the SDK to format and send back to the client
      if (error instanceof Error) {
         throw error;
      } else {
         throw new Error(errorMessage || "An unknown error occurred during tool execution");
      }
    }
  });

  // Removed Get Prompt Handler
  // Removed List Prompts Handler

  // List Resources Handler - Fetches aggregated list from Pluggedin App API
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    try {
      const apiKey = getPluggedinMCPApiKey();
      const baseUrl = getPluggedinMCPApiBaseUrl();
      if (!apiKey || !baseUrl) {
        throw new Error("Pluggedin API Key or Base URL is not configured.");
      }

      const apiUrl = `${baseUrl}/api/resources`; // Assuming this is the correct endpoint

      // console.error(`[Proxy - ListResources] Fetching from ${apiUrl}`); // Debug log

      const response = await axios.get<z.infer<typeof ListResourcesResultSchema>["resources"]>(apiUrl, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 10000, // Add a timeout for the API call (e.g., 10 seconds)
      });

      // The API currently returns just the array, wrap it in the expected structure
      const resources = response.data || [];

      // console.error(`[Proxy - ListResources] Received ${resources.length} resources from API.`); // Debug log

      // Note: Pagination across servers via the API is not implemented here.
      // The API would need to support cursor-based pagination for this to work fully.
      return { resources: resources, nextCursor: undefined };

    } catch (error: any) {
      const errorMessage = axios.isAxiosError(error)
        ? `API Error (${error.response?.status}): ${error.message}`
        : error instanceof Error
        ? error.message
        : "Unknown error fetching resources from API";
      console.error("[ListResources Handler Error]", errorMessage);
      // Let SDK handle error formatting
      throw new Error(`Failed to list resources: ${errorMessage}`);
    }
  });

  // Read Resource Handler - Simplified to only proxy
  // WARNING: This handler will likely fail now because resourceToClient is no longer populated.
  // It needs to be refactored to proxy the read request to the correct downstream server,
  // potentially by calling a new API endpoint on pluggedin-app or by re-establishing a session.
  // Leaving it as is for now to focus on ListResources.
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    console.error(`[ReadResource Handler] Received request for URI: ${uri}. This handler needs refactoring as resourceToClient is no longer populated.`);
    // Handle regular resources by finding the client mapped during ListResources
    // const clientForResource = resourceToClient[uri]; // This map is no longer populated
    // if (!clientForResource) {
    //    throw new Error(`Unknown resource or mapping not found: ${uri}`); // Throw error for SDK
    // }
    // try {
    //   // Ensure the proxied request uses the original URI
    //   // Consider adding a timeout here as well if reading can be slow
    //   return await clientForResource.client.request(
    //     { method: "resources/read", params: { uri, _meta: request.params?._meta } },
    //     ReadResourceResultSchema
    //   );
    // } catch (error) {
    //   throw error; // Re-throw for SDK
    // }
    throw new Error(`ReadResource handler needs refactoring to work without resourceToClient mapping. Cannot read URI: ${uri}`);
  });

  // List Resource Templates Handler - Returns empty list as proxy doesn't handle them directly
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    // console.error("[ListResourceTemplates Handler] Returning empty list."); // Keep console logs out
    return { resourceTemplates: [], nextCursor: undefined };
  });

  const cleanup = async () => {
    await cleanupAllSessions();
  };

  return { server, cleanup };
};
