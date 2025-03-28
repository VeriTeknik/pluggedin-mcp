import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CompatibilityCallToolResultSchema,
  ListToolsResultSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { getMcpServers } from "../fetch-pluggedinmcp.js";
import { getSessionKey, sanitizeName, getPluggedinMCPApiKey } from "../utils.js"; // Import getPluggedinMCPApiKey
import { getSession } from "../sessions.js";
import { ConnectedClient } from "../client.js"; // Assuming ConnectedClient holds the session/client
import {
  getProfileCapabilities,
  ProfileCapability,
} from "../fetch-capabilities.js";
import { getInactiveTools, ToolParameters } from "../fetch-tools.js";

const toolName = "tool_call"; // Renamed to match veyrax-mcp convention
const toolDescription = `
Executes a specific proxied MCP tool managed by PluggedinMCP.
Use 'get_tools' first to find the correct 'tool_name' (e.g., 'github__create_issue').
Requires a valid PluggedinMCP API key configured in the environment. The API key is used implicitly by the server based on its environment configuration.
`;

// Define the input schema for this tool
const CallPluggedinToolSchema = z.object({
  tool_name: z
    .string()
    .describe(
      "The prefixed name of the proxied tool to call (e.g., 'github__create_issue', 'google_calendar__list_events'). Get this from 'get_tools'."
    ),
  arguments: z // Renamed input parameter to match veyrax-mcp
    .record(z.any())
    .optional()
    .default({})
    .describe(
      "The arguments object required by the specific proxied tool being called."
    ),
});

export class CallPluggedinToolTool {
  static toolName = toolName;
  static description = toolDescription;
  static inputSchema = CallPluggedinToolSchema;

  // Helper function to find the client session for a given prefixed tool name
  // Note: This involves re-fetching servers and tools on each call, which might be inefficient.
  // Consider caching or a shared mapping for optimization if performance becomes an issue.
  private static async findClientForTool(
    prefixedToolName: string,
    requestMeta: any
  ): Promise<ConnectedClient | null> {
    // Check for API key before trying to fetch servers
    const apiKey = getPluggedinMCPApiKey();
    if (!apiKey) {
      console.error("PLUGGEDIN_API_KEY is missing. Cannot find client for tool.");
      // Return null, the execute method will handle the error response
      return null;
    }

    const serverParams = await getMcpServers(true); // Force refresh now that we know key exists
    const profileCapabilities = await getProfileCapabilities(true);
    let inactiveTools: Record<string, ToolParameters> = {};
    if (profileCapabilities.includes(ProfileCapability.TOOLS_MANAGEMENT)) {
      inactiveTools = await getInactiveTools(true);
    }

    for (const [uuid, params] of Object.entries(serverParams)) {
      const sessionKey = getSessionKey(uuid, params);
      const session = await getSession(sessionKey, uuid, params);
      if (!session) continue;

      const capabilities = session.client.getServerCapabilities();
      if (!capabilities?.tools) continue;

      const serverName = session.client.getServerVersion()?.name || "";
      try {
        const result = await session.client.request(
          { method: "tools/list", params: { _meta: requestMeta } },
          ListToolsResultSchema
        );

        const foundTool = result.tools?.find((tool) => {
          const currentPrefixedName = `${sanitizeName(serverName)}__${
            tool.name
          }`;
          // Check if it matches the requested name AND is not inactive
          const isInactive =
            profileCapabilities.includes(ProfileCapability.TOOLS_MANAGEMENT) &&
            inactiveTools[`${uuid}:${tool.name}`];
          return currentPrefixedName === prefixedToolName && !isInactive;
        });

        if (foundTool) {
          return session; // Return the session (ConnectedClient) if the tool is found and active
        }
      } catch (error) {
        // Ignore errors fetching from individual servers during mapping
        console.error(
          `Error fetching tools from ${serverName} while mapping for call:`,
          error
        );
      }
    }
    return null; // Tool not found or associated client session couldn't be established
  }

  // This method will be called by the MCP server when the tool is invoked
  static async execute(
    args: z.infer<typeof CallPluggedinToolSchema>,
    requestMeta: any // Contains metadata like progress tokens
  ): Promise<z.infer<typeof CompatibilityCallToolResultSchema>> {
    const { tool_name: prefixedToolName, arguments: toolArgs } = args;

    const clientForTool = await CallPluggedinToolTool.findClientForTool(
      prefixedToolName,
      requestMeta
    );

    if (!clientForTool) {
      // Check if the reason was a missing API key (findClientForTool returns null in that case)
      const apiKey = getPluggedinMCPApiKey();
      if (!apiKey) {
         return {
           isError: true,
           content: [{ type: "text", text: "Configuration Error: PluggedinMCP API Key is missing. Please configure the server." }],
         };
      }

      // Otherwise, the tool was genuinely not found or inactive
      const profileCapabilities = await getProfileCapabilities();
      if (profileCapabilities.includes(ProfileCapability.TOOLS_MANAGEMENT)) {
        // Re-fetch inactive tools to give a specific error if possible
        const inactiveTools = await getInactiveTools();
        const serverParams = await getMcpServers();
        for (const [uuid, params] of Object.entries(serverParams)) {
           const serverName = params.name || uuid; // Use params.name if available
           const originalToolName = prefixedToolName.startsWith(`${sanitizeName(serverName)}__`)
             ? prefixedToolName.substring(sanitizeName(serverName).length + 2)
             : null;
           if (originalToolName && inactiveTools[`${uuid}:${originalToolName}`]) {
             throw new Error(`Tool is inactive: ${prefixedToolName}`);
           }
        }
      }
      throw new Error(`Unknown or inactive tool: ${prefixedToolName}`);
    }

    // Extract the original tool name
    const serverName = clientForTool.client.getServerVersion()?.name || "";
    const originalToolName = prefixedToolName.substring(
      sanitizeName(serverName).length + 2
    );

    if (!originalToolName) {
      throw new Error(
        `Could not extract original tool name from prefixed name: ${prefixedToolName}`
      );
    }

    try {
      console.log(
        `Proxying call to tool '${originalToolName}' on server '${serverName}' with args:`,
        toolArgs
      );
      // Call the actual tool on the downstream client
      return await clientForTool.client.request(
        {
          method: "tools/call",
          params: {
            name: originalToolName,
            arguments: toolArgs || {},
            _meta: {
              progressToken: requestMeta?.progressToken,
            },
          },
        },
        CompatibilityCallToolResultSchema // Use the schema that expects content/isError
      );
    } catch (error) {
      console.error(
        `Error calling tool '${originalToolName}' through ${serverName}:`,
        error
      );
      // Re-throw the error to be handled by the MCP server framework
      throw error;
    }
  }

  // Registration will be handled in the main server setup (mcp-proxy.ts)
}
