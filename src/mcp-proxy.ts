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
import * as eventsource from "eventsource";
import { getMcpServers } from "./fetch-pluggedin.js";
import { getSessionKey, sanitizeName } from "./utils.js";
import { cleanupAllSessions, getSession } from "./sessions.js";
import { ConnectedClient } from "./client.js";

global.EventSource = eventsource.EventSource;

const toolToClient: Record<string, ConnectedClient> = {};
const promptToClient: Record<string, ConnectedClient> = {};
const resourceToClient: Record<string, ConnectedClient> = {};

export const createServer = async () => {
  const server = new Server(
    {
      name: "Pluggedin",
      version: "0.3.0",
    },
    {
      capabilities: {
        prompts: {},
        resources: {},
        tools: {},
      },
    }
  );

  // List Tools Handler
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const serverParams = await getMcpServers(true);

    const allTools: Tool[] = [];

    await Promise.allSettled(
      Object.entries(serverParams).map(async ([uuid, params]) => {
        const sessionKey = getSessionKey(uuid, params);
        const session = await getSession(sessionKey, uuid, params);
        if (!session) {
          console.error(`No session found for server: ${uuid}`);
          return;
        }

        const capabilities = session.client.getServerCapabilities();
        if (!capabilities?.tools) {
          console.error(`No tools capabilities found for server: ${uuid}`);
          return;
        }

        const serverName = session.client.getServerVersion()?.name || "";
        try {
          const result = await session.client.request(
            {
              method: "tools/list",
              params: { _meta: request.params?._meta },
            },
            ListToolsResultSchema
          );

          const toolsWithSource =
            result.tools?.map((tool) => {
              const toolName = `${sanitizeName(serverName)}__${tool.name}`;
              toolToClient[toolName] = session;
              return {
                ...tool,
                name: toolName,
                description: `[${serverName}] ${tool.description || ""}`,
              };
            }) || [];

          allTools.push(...toolsWithSource);
        } catch (error) {
          console.error(`Error fetching tools from: ${serverName}`, error);
        }
      })
    );

    return { tools: allTools };
  });

  // Call Tool Handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const clientForTool = toolToClient[name];

    if (!clientForTool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    try {
      const toolName = name.split("__")[1];

      // Use the correct schema for tool calls
      return await clientForTool.client.request(
        {
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args || {},
            _meta: {
              progressToken: request.params._meta?.progressToken,
            },
          },
        },
        CompatibilityCallToolResultSchema
      );
    } catch (error) {
      console.error(
        `Error calling tool through ${
          clientForTool.client.getServerVersion()?.name
        }:`,
        error
      );
      throw error;
    }
  });

  // Get Prompt Handler
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const clientForPrompt = promptToClient[name];

    if (!clientForPrompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }

    try {
      const promptName = name.split("__")[1];
      return await clientForPrompt.client.request(
        {
          method: "prompts/get",
          params: {
            name: promptName,
            arguments: request.params.arguments || {},
            _meta: request.params._meta,
          },
        },
        GetPromptResultSchema
      );
    } catch (error) {
      console.error(
        `Error getting prompt through ${
          clientForPrompt.client.getServerVersion()?.name
        }:`,
        error
      );
      throw error;
    }
  });

  // List Prompts Handler
  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    const serverParams = await getMcpServers(true);
    const allPrompts: z.infer<typeof ListPromptsResultSchema>["prompts"] = [];

    await Promise.allSettled(
      Object.entries(serverParams).map(async ([uuid, params]) => {
        const sessionKey = getSessionKey(uuid, params);
        const session = await getSession(sessionKey, uuid, params);
        if (!session) {
          console.error(`No session found for server: ${uuid}`);
          return;
        }

        const capabilities = session.client.getServerCapabilities();
        if (!capabilities?.prompts) {
          console.error(`No prompts capabilities found for server: ${uuid}`);
          return;
        }

        const serverName = session.client.getServerVersion()?.name || "";
        try {
          const result = await session.client.request(
            {
              method: "prompts/list",
              params: {
                cursor: request.params?.cursor,
                _meta: request.params?._meta,
              },
            },
            ListPromptsResultSchema
          );

          if (result.prompts) {
            const promptsWithSource = result.prompts.map((prompt) => {
              const promptName = `${sanitizeName(serverName)}__${prompt.name}`;
              promptToClient[promptName] = session;
              return {
                ...prompt,
                name: promptName,
                description: `[${serverName}] ${prompt.description || ""}`,
              };
            });
            allPrompts.push(...promptsWithSource);
          }
        } catch (error) {
          console.error(`Error fetching prompts from: ${serverName}`, error);
        }
      })
    );

    return {
      prompts: allPrompts,
      nextCursor: request.params?.cursor,
    };
  });

  // List Resources Handler
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const serverParams = await getMcpServers(true);
    const allResources: z.infer<typeof ListResourcesResultSchema>["resources"] =
      [];

    await Promise.allSettled(
      Object.entries(serverParams).map(async ([uuid, params]) => {
        const sessionKey = getSessionKey(uuid, params);
        const session = await getSession(sessionKey, uuid, params);
        if (!session) {
          console.error(`No session found for server: ${uuid}`);
          return;
        }

        const capabilities = session.client.getServerCapabilities();
        if (!capabilities?.resources) {
          console.error(`No resources capabilities found for server: ${uuid}`);
          return;
        }

        const serverName = session.client.getServerVersion()?.name || "";
        try {
          const result = await session.client.request(
            {
              method: "resources/list",
              params: {
                cursor: request.params?.cursor,
                _meta: request.params?._meta,
              },
            },
            ListResourcesResultSchema
          );

          if (result.resources) {
            const resourcesWithSource = result.resources.map((resource) => {
              resourceToClient[resource.uri] = session;
              return {
                ...resource,
                name: `[${serverName}] ${resource.name || ""}`,
              };
            });
            allResources.push(...resourcesWithSource);
          }
        } catch (error) {
          console.error(`Error fetching resources from: ${serverName}`, error);
        }
      })
    );

    return {
      resources: allResources,
      nextCursor: request.params?.cursor,
    };
  });

  // Read Resource Handler
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const clientForResource = resourceToClient[uri];

    if (!clientForResource) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    try {
      return await clientForResource.client.request(
        {
          method: "resources/read",
          params: {
            uri,
            _meta: request.params._meta,
          },
        },
        ReadResourceResultSchema
      );
    } catch (error) {
      console.error(
        `Error reading resource through ${
          clientForResource.client.getServerVersion()?.name
        }:`,
        error
      );
      throw error;
    }
  });

  // List Resource Templates Handler
  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (request) => {
      const serverParams = await getMcpServers(true);
      const allTemplates: ResourceTemplate[] = [];

      await Promise.allSettled(
        Object.entries(serverParams).map(async ([uuid, params]) => {
          const sessionKey = getSessionKey(uuid, params);
          const session = await getSession(sessionKey, uuid, params);
          if (!session) {
            console.error(`No session found for server: ${uuid}`);
            return;
          }

          const capabilities = session.client.getServerCapabilities();
          if (!capabilities?.resources) {
            console.error(`No resources capabilities found for server: ${uuid}`);
            return;
          }

          const serverName = session.client.getServerVersion()?.name || "";
          try {
            const result = await session.client.request(
              {
                method: "resources/templates/list",
                params: {
                  cursor: request.params?.cursor,
                  _meta: request.params?._meta,
                },
              },
              ListResourceTemplatesResultSchema
            );

            if (result.resourceTemplates) {
              const templatesWithSource = result.resourceTemplates.map(
                (template) => ({
                  ...template,
                  name: `[${serverName}] ${template.name || ""}`,
                })
              );
              allTemplates.push(...templatesWithSource);
            }
          } catch (error) {
            console.error(
              `Error fetching resource templates from: ${serverName}`,
              error
            );
          }
        })
      );

      return {
        resourceTemplates: allTemplates,
        nextCursor: request.params?.cursor,
      };
    }
  );

  const cleanup = async () => {
    await cleanupAllSessions();
  };

  return { server, cleanup };
};
