import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  Tool,
  ListToolsResultSchema,
  CompatibilityCallToolResultSchema, // Import the correct result type
} from "@modelcontextprotocol/sdk/types.js";
import { getMcpServers } from "../fetch-pluggedinmcp.js";
import { getSessionKey, sanitizeName, getPluggedinMCPApiKey } from "../utils.js"; // Import getPluggedinMCPApiKey
import { getSession } from "../sessions.js";
import { reportToolsToPluggedinMCP } from "../report-tools.js";
import { getInactiveTools, ToolParameters } from "../fetch-tools.js";
import {
  getProfileCapabilities,
  ProfileCapability,
} from "../fetch-capabilities.js";

// Define a base tool class or interface if needed, or directly implement
// For simplicity, we'll define the structure here directly

const toolName = "get_tools"; // Renamed to match veyrax-mcp convention
const toolDescription = `
Retrieves the list of currently active and available proxied MCP tools managed by PluggedinMCP.
Use this tool first to discover which tools (like 'github__create_issue', 'google_calendar__list_events', etc.) are available before attempting to call them with 'tool_call'.
Requires a valid PluggedinMCP API key configured in the environment.
`;

const GetPluggedinToolsSchema = z.object({
  // Add any potential input parameters here if needed in the future, e.g., filters
  // forceRefresh: z.boolean().optional().describe("Force refresh of the tool list from the backend."),
});

export class GetPluggedinToolsTool {
  static toolName = toolName;
  static description = toolDescription;
  static inputSchema = GetPluggedinToolsSchema;

  // This method will be called by the MCP server when the tool is invoked
  static async execute(
    // args: z.infer<typeof GetPluggedinToolsSchema>, // Use if input schema has properties
    requestMeta: any // Contains metadata like progress tokens
   // Change return type to CallToolResult format
  ): Promise<z.infer<typeof CompatibilityCallToolResultSchema>> {
    // This logic is adapted from the original ListToolsRequestSchema handler
    // It fetches servers, gets sessions, lists tools from each, filters inactive, prefixes names, etc.
    // Note: This execution logic *itself* doesn't return the static tool list,
    // but the list of *proxied* tools. The static list is returned by the main
    // ListTools handler in mcp-proxy.ts.

    // We need a way to pass the client mapping back or handle it globally/contextually
    // For now, let's focus on returning the list. The client mapping needs refinement.
    // A simple global map might work for a single-user server, but consider concurrency.
    const toolToClientMapping: Record<string, any> = {}; // Temporary store for client mapping

    // Check if API key is available before proceeding
    const apiKey = getPluggedinMCPApiKey(); // Assuming this util exists and checks env/args
    if (!apiKey) {
      console.warn("PLUGGEDIN_API_KEY is missing during get_tools execution. Returning empty list.");
      // Return success, but with empty content, to satisfy Smithery's probe
      return {
        content: [{ type: "text", text: "[]" }], // Empty JSON array string
      };
    }

    const profileCapabilities = await getProfileCapabilities(true);
    const serverParams = await getMcpServers(true); // Force refresh now that we know key exists (or try to)

    // Handle case where getMcpServers might still fail or return empty due to backend issues
    if (Object.keys(serverParams).length === 0) {
       console.warn("No downstream MCP servers found or fetched.");
       // Return empty list in CallToolResult format
       return { content: [{ type: "text", text: "[]" }] };
    }

    let inactiveTools: Record<string, ToolParameters> = {};
    if (profileCapabilities.includes(ProfileCapability.TOOLS_MANAGEMENT)) {
      inactiveTools = await getInactiveTools(true);
    }

    const allProxiedTools: Tool[] = [];

    await Promise.allSettled(
      Object.entries(serverParams).map(async ([uuid, params]) => {
        const sessionKey = getSessionKey(uuid, params);
        const session = await getSession(sessionKey, uuid, params);
        if (!session) return;

        const capabilities = session.client.getServerCapabilities();
        if (!capabilities?.tools) return;

        const serverName = session.client.getServerVersion()?.name || "";
        try {
          const result = await session.client.request(
            {
              method: "tools/list",
              params: { _meta: requestMeta }, // Pass meta if needed
            },
            ListToolsResultSchema
          );

          const toolsWithSource =
            result.tools
              ?.filter((tool) => {
                if (
                  profileCapabilities.includes(
                    ProfileCapability.TOOLS_MANAGEMENT
                  )
                ) {
                  return !inactiveTools[`${uuid}:${tool.name}`];
                }
                return true;
              })
              .map((tool) => {
                const prefixedToolName = `${sanitizeName(serverName)}__${
                  tool.name
                }`;
                // Store the session (client) associated with this prefixed name
                toolToClientMapping[prefixedToolName] = session;
                return {
                  ...tool,
                  name: prefixedToolName,
                  description: `[${serverName}] ${tool.description || ""}`,
                };
              }) || [];

          // Optionally report tools back to PluggedinMCP if needed here
          // (Consider if this should happen on discovery or elsewhere)
          if (
            profileCapabilities.includes(ProfileCapability.TOOLS_MANAGEMENT) &&
            result.tools
          ) {
            reportToolsToPluggedinMCP(
              result.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                toolSchema: tool.inputSchema,
                mcp_server_uuid: uuid,
              }))
            ).catch((err) =>
              console.error("Error reporting tools during get_pluggedin_tools:", err)
            );
          }

          allProxiedTools.push(...toolsWithSource);
        } catch (error) {
          console.error(
            `Error fetching tools from: ${serverName} during get_pluggedin_tools`,
            error
          );
        }
      })
    );

    // How to handle toolToClientMapping?
    // Option 1: Return it somehow (not standard MCP)
    // Option 2: Store it globally/contextually (needs careful implementation)
    // Option 3: Re-fetch/re-map during the 'call_pluggedin_tool' execution (potentially slower)
    // For now, we just return the tools. The mapping needs to be addressed in the tool_call tool.
    console.log(`Discovered ${allProxiedTools.length} active proxied tools.`);

    // Return the list of tools formatted as CallToolResult content
    return {
      content: [
        { type: "text", text: JSON.stringify(allProxiedTools, null, 2) },
      ],
    };
  }

  // Registration will be handled in the main server setup (mcp-proxy.ts)
  // by modifying the ListTools and CallTool handlers.
}
