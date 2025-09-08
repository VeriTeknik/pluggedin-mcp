import axios from "axios";
import { ToolExecutionResult } from "../types.js";
import { 
  getPluggedinMCPApiKey, 
  getPluggedinMCPApiBaseUrl, 
  sanitizeName, 
  isDebugEnabled 
} from "../utils.js";
import { logMcpActivity, createExecutionTimer } from "../notification-logger.js";
import { debugLog, debugError } from "../debug-log.js";
import { getApiKeySetupMessage } from "./static-handlers-helpers.js";
import {
  DiscoverToolsInputSchema,
  AskKnowledgeBaseInputSchema,
  SendNotificationInputSchema,
  ListNotificationsInputSchema,
  MarkNotificationDoneInputSchema,
  DeleteNotificationInputSchema,
  CreateDocumentInputSchema,
  ListDocumentsInputSchema,
  SearchDocumentsInputSchema,
  GetDocumentInputSchema,
  UpdateDocumentInputSchema
} from '../schemas/index.js';
import { getMcpServers } from "../fetch-pluggedinmcp.js";
import { getSession, initSessions } from "../sessions.js";
import { getSessionKey } from "../utils.js";
import { 
  buildServerContextsMap, 
  extractCustomInstructions,
  ProcessedServerContext,
  ServerContext,
  toLegacyServerContext,
  formatServerInstructionsForDiscovery,
  Constraints,
  buildConstraintMap
} from '../utils/custom-instructions.js';
import {
  setupStaticTool,
  discoverToolsStaticTool,
  askKnowledgeBaseStaticTool,
  sendNotificationStaticTool,
  listNotificationsStaticTool,
  markNotificationDoneStaticTool,
  deleteNotificationStaticTool,
  createDocumentStaticTool,
  listDocumentsStaticTool,
  searchDocumentsStaticTool,
  getDocumentStaticTool,
  updateDocumentStaticTool
} from '../tools/static-tools.js';

// Type for tool to server mapping
export type ToolToServerMap = Record<string, { originalName: string; serverUuid: string; }>;

// Interface for instruction data from API
interface InstructionData {
  description?: string;
  instruction?: string | any; // Can be string (JSON) or parsed object
  serverUuid?: string;
  _serverUuid?: string;
}

/**
 * Handles execution of static tools that are built into the Plugged.in MCP proxy.
 * These tools provide core functionality like discovery, RAG queries, notifications, and document management.
 */
export class StaticToolHandlers {
  private serverContexts: Map<string, ProcessedServerContext> = new Map();
  private constraintMap: Map<string, Constraints> = new Map();
  
  constructor(
    private toolToServerMap: ToolToServerMap,
    private instructionToServerMap: Record<string, InstructionData>
  ) {}

  getServerContext(serverName: string): ServerContext | undefined {
    // Find by server name (backwards compatibility)
    for (const context of this.serverContexts.values()) {
      if (context.serverName === serverName) {
        return toLegacyServerContext(context);
      }
    }
    return undefined;
  }

  getServerContextByUuid(serverUuid: string): ProcessedServerContext | undefined {
    // Direct UUID lookup - O(1) instead of O(n)
    return this.serverContexts.get(serverUuid);
  }

  getConstraints(serverUuid: string): Constraints | undefined {
    return this.constraintMap.get(serverUuid);
  }

  async handleSetup(args: any): Promise<ToolExecutionResult> {
    const topic = args?.topic || 'getting_started';
    
    let content = '';
    
    switch (topic) {
      case 'getting_started':
        content = `# Welcome to Plugged.in MCP! 🚀

## What is Plugged.in?
Plugged.in is a unified interface for Model Context Protocol (MCP) servers, allowing you to:
- Connect multiple MCP servers through a single proxy
- Manage AI-generated documents
- Use RAG capabilities for semantic search
- Send notifications and track activities

## Getting Started
1. **Get your API key**: Visit https://plugged.in/settings to create an account and get your API key
2. **Configure your environment**: Set the PLUGGEDIN_API_KEY environment variable
3. **Discover tools**: Run \`pluggedin_discover_tools\` to see available MCP servers
4. **Start using tools**: Access any tool from connected servers

## Available Commands
- \`pluggedin_setup\` - This help system (no API key required)
- \`pluggedin_discover_tools\` - List available MCP servers
- Other tools require an API key - see descriptions for details

For more help, try: \`pluggedin_setup\` with topic: "api_key", "configuration", or "troubleshooting"`;
        break;
        
      case 'api_key':
        content = `# Setting up your Plugged.in API Key 🔑

## Getting an API Key
1. Visit https://plugged.in
2. Sign up or log in to your account
3. Navigate to Settings → API Keys
4. Create a new API key
5. Copy the key (starts with \`pg_in_\`)

## Configuring the API Key
Set the environment variable before running your MCP client:

### macOS/Linux:
\`\`\`bash
export PLUGGEDIN_API_KEY="pg_in_your_key_here"
export PLUGGEDIN_API_BASE_URL="https://plugged.in" # Optional, defaults to this
\`\`\`

### Windows:
\`\`\`cmd
set PLUGGEDIN_API_KEY=pg_in_your_key_here
set PLUGGEDIN_API_BASE_URL=https://plugged.in
\`\`\`

### In your application:
Add to your \`.env\` file or configuration.

## Verifying Setup
Run \`pluggedin_discover_tools\` - if configured correctly, you'll see your connected MCP servers.`;
        break;
        
      case 'configuration':
        content = `# Plugged.in Configuration Guide ⚙️

## Environment Variables
- **PLUGGEDIN_API_KEY** (required): Your API key from https://plugged.in/settings
- **PLUGGEDIN_API_BASE_URL** (optional): API endpoint (defaults to https://plugged.in)
- **PLUGGEDIN_DEBUG** (optional): Set to "true" for verbose logging

## MCP Server Configuration
1. Log in to https://plugged.in
2. Navigate to MCP Servers
3. Add your MCP servers with their connection details
4. Servers are automatically available through the proxy

## Docker Configuration
If using Docker, pass environment variables:
\`\`\`bash
docker run -e PLUGGEDIN_API_KEY="your_key" pluggedin-mcp
\`\`\`

## Testing Configuration
- \`pluggedin_discover_tools\` - Lists connected servers
- \`pluggedin_ask_knowledge_base\` - Tests RAG functionality
- \`pluggedin_list_documents\` - Tests document access`;
        break;
        
      case 'troubleshooting':
        content = `# Troubleshooting Guide 🔧

## Common Issues

### "API Key not configured"
- Check if PLUGGEDIN_API_KEY environment variable is set
- Verify the key starts with \`pg_in_\`
- Ensure no extra spaces or quotes in the key

### No servers found with discover_tools
- Verify your API key is valid
- Check if you have MCP servers configured at https://plugged.in
- Try with \`force_refresh: true\` parameter

### Connection timeouts
- Check your internet connection
- Verify PLUGGEDIN_API_BASE_URL if using custom endpoint
- Check if behind a firewall or proxy

### Tools not working
- Most tools require an API key (check tool descriptions)
- Ensure your account has appropriate permissions
- Check server logs for detailed error messages

## Debug Mode
Enable debug logging:
\`\`\`bash
export PLUGGEDIN_DEBUG=true
\`\`\`

## Getting Help
- Documentation: https://plugged.in/docs
- Support: support@plugged.in
- GitHub: https://github.com/pluggedin/mcp-proxy

## Platform-Specific Notes

### Claude Desktop
Add to your Claude Desktop config:
\`\`\`json
{
  "mcpServers": {
    "pluggedin": {
      "command": "npx",
      "args": ["@pluggedin/mcp-proxy"],
      "env": {
        "PLUGGEDIN_API_KEY": "pg_in_your_key_here"
      }
    }
  }
}
\`\`\`

### VS Code / Cursor
Set environment variables in your terminal before launching the editor.

### Common Error Codes
- 401: Invalid API key
- 403: Permission denied (check account status)
- 429: Rate limit exceeded
- 500: Server error (try again later)`;
        break;
    }
    
    return {
      content: [{ type: "text", text: content }],
      isError: false,
    };
  }

  async handleDiscoverTools(args: any): Promise<ToolExecutionResult> {
    debugError(`[CallTool Handler] Executing static tool: ${discoverToolsStaticTool.name}`);
    const validatedArgs = DiscoverToolsInputSchema.parse(args ?? {});

    const timer = createExecutionTimer();
    try {
      // Log discovery attempt
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Pluggedin Discovery',
        serverUuid: 'pluggedin_discovery',
        itemName: discoverToolsStaticTool.name,
        success: true,
        executionTime: 0, // Will update after
      }).catch(() => {}); // Ignore notification errors
      
      // Wipe stored servers and instructions maps
      Object.keys(this.toolToServerMap).forEach(key => delete this.toolToServerMap[key]);
      Object.keys(this.instructionToServerMap).forEach(key => delete this.instructionToServerMap[key]);

      const { data, success, error } = await getMcpServers();
      if (!success || !data || !Array.isArray(data)) {
        const errorMsg = `Could not fetch MCP servers: ${error}. Please ensure your Pluggedin API key and URL are correctly configured.`;
        throw new Error(errorMsg);
      }

      let dataContent = '# Available MCP Servers\n\n';
      
      // Build server contexts from custom instructions (UUID-keyed map)
      const serverContexts = buildServerContextsMap(data);
      
      // Store server contexts for use in tool invocations
      this.serverContexts = serverContexts;
      
      // Build constraint map for efficient validation
      this.constraintMap = buildConstraintMap(serverContexts);
      
      data.forEach((server: any) => {
        dataContent += `## ${server.name} (${server.uuid})\n`;
        
        // Process and register tools
        if (server.capabilities?.tools?.length > 0) {
          dataContent += `### Tools (${server.capabilities.tools.length}):\n`;
          server.capabilities.tools.forEach((tool: any) => {
            const prefixedName = sanitizeName(`${server.name}_${tool.name}`);
            this.toolToServerMap[prefixedName] = { originalName: tool.name, serverUuid: server.uuid };
            dataContent += `- **${prefixedName}**: ${tool.description}\n`;
          });
          dataContent += '\n';
        }

        // Show custom instructions as context, not as prompts
        if (server.customInstructions?.length > 0) {
          const context = serverContexts.get(server.uuid);
          if (context) {
            dataContent += `### Custom Context:\n`;
            // Just show the formatted context which already includes constraints
            const lines = context.formattedContext.split('\n');
            // Skip the header line if it's redundant
            const startIdx = lines[0].startsWith('### Server Context:') ? 1 : 0;
            dataContent += lines.slice(startIdx).join('\n');
            dataContent += '\n';
          }
        }
      });

      if (isDebugEnabled()) {
        dataContent += '\n## Static Tools\n';
        dataContent += '1. **pluggedin_discover_tools** - Triggers discovery of tools for configured MCP servers\n';
        dataContent += '2. **pluggedin_ask_knowledge_base** - Performs a RAG query against documents\n';
        dataContent += '3. **pluggedin_send_notification** - Send custom notifications\n';
        dataContent += '4. **pluggedin_list_notifications** - List notifications with filters\n';
        dataContent += '5. **pluggedin_mark_notification_done** - Mark a notification as done\n';
        dataContent += '6. **pluggedin_delete_notification** - Delete a notification\n';
        dataContent += '7. **pluggedin_create_document** - Create and save AI-generated documents to the user\'s library\n';
        dataContent += '8. **pluggedin_list_documents** - List documents with filtering options\n';
        dataContent += '9. **pluggedin_search_documents** - Search documents semantically\n';
        dataContent += '10. **pluggedin_get_document** - Retrieve a specific document by ID\n';
        dataContent += '11. **pluggedin_update_document** - Update or append to an existing document\n';
      }

      // Update activity log with success
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Pluggedin Discovery',
        serverUuid: 'pluggedin_discovery',
        itemName: discoverToolsStaticTool.name,
        success: true,
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors

      // Add server contexts to the discovery information
      if (serverContexts.size > 0) {
        dataContent += '\n## Server Contexts (Auto-Injected)\n';
        dataContent += 'The following custom instructions are automatically provided to AI assistants:\n\n';
        dataContent += formatServerInstructionsForDiscovery(serverContexts);
      }

      return {
        content: [{ 
          type: "text", 
          text: dataContent,
          metadata: {
            serverContexts: serverContexts
          }
        }],
        isError: false,
      };
    } catch (toolError: any) {
      // Log discovery failure
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Pluggedin Discovery',
        serverUuid: 'pluggedin_discovery',
        itemName: discoverToolsStaticTool.name,
        success: false,
        errorMessage: toolError instanceof Error ? toolError.message : String(toolError),
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors
      
      throw toolError;
    }
  }

  async handleAskKnowledgeBase(args: any): Promise<ToolExecutionResult> {
    debugError(`[CallTool Handler] Executing static tool: ${askKnowledgeBaseStaticTool.name}`);
    const validatedArgs = AskKnowledgeBaseInputSchema.parse(args ?? {});

    const apiKey = getPluggedinMCPApiKey();
    const baseUrl = getPluggedinMCPApiBaseUrl();
    if (!apiKey || !baseUrl) {
      return {
        content: [{
          type: "text",
          text: getApiKeySetupMessage("pluggedin_ask_knowledge_base")
        }],
        isError: false
      };
    }

    const ragApiUrl = `${baseUrl}/api/rag/query`;

    const timer = createExecutionTimer();
    try {
      const response = await axios.post(
        ragApiUrl,
        { query: validatedArgs.query },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Log successful RAG query
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Pluggedin RAG',
        serverUuid: 'pluggedin_rag',
        itemName: askKnowledgeBaseStaticTool.name,
        success: true,
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors

      // The API returns plain text, so response.data is the text itself
      const ragResponse = response.data || "No response received from RAG service.";
      return {
        content: [{ type: "text", text: ragResponse }],
        isError: false,
      };

    } catch (apiError: any) {
      // Log failed RAG query
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Pluggedin RAG',
        serverUuid: 'pluggedin_rag',
        itemName: askKnowledgeBaseStaticTool.name,
        success: false,
        errorMessage: apiError instanceof Error ? apiError.message : String(apiError),
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors
      
      let errorMsg = "Failed to perform RAG query";
      if (axios.isAxiosError(apiError)) {
        if (apiError.response?.status === 404) {
          errorMsg = "RAG service not available. Please ensure RAG is enabled in your Pluggedin configuration.";
        } else if (apiError.response?.status === 400) {
          errorMsg = "Invalid query provided to RAG service.";
        } else if (apiError.response?.status) {
          errorMsg = `RAG service error (${apiError.response.status})`;
        }
      }
      throw new Error(errorMsg);
    }
  }

  async handleSendNotification(args: any): Promise<ToolExecutionResult> {
    debugError(`[CallTool Handler] Executing static tool: ${sendNotificationStaticTool.name}`);
    const validatedArgs = SendNotificationInputSchema.parse(args ?? {});

    const apiKey = getPluggedinMCPApiKey();
    const baseUrl = getPluggedinMCPApiBaseUrl();
    if (!apiKey || !baseUrl) {
      return {
        content: [{
          type: "text",
          text: getApiKeySetupMessage("pluggedin_send_notification")
        }],
        isError: false
      };
    }

    const notificationApiUrl = `${baseUrl}/api/notifications`;

    const timer = createExecutionTimer();
    try {
      const response = await axios.post(
        notificationApiUrl,
        validatedArgs,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Log successful notification send
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Notification System',
        serverUuid: 'pluggedin_notifications',
        itemName: sendNotificationStaticTool.name,
        success: true,
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors

      const notificationId = response.data.notificationId;
      const emailSent = response.data.emailSent || false;
      
      let responseText = `Notification sent successfully! (ID: ${notificationId})`;
      if (emailSent) {
        responseText += '\nEmail notification was also sent.';
      }

      return {
        content: [{ type: "text", text: responseText }],
        isError: false,
      };

    } catch (apiError: any) {
      // Log failed notification send
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Notification System',
        serverUuid: 'pluggedin_notifications',
        itemName: sendNotificationStaticTool.name,
        success: false,
        errorMessage: apiError instanceof Error ? apiError.message : String(apiError),
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors
      
      let errorMsg = "Failed to send notification";
      if (axios.isAxiosError(apiError)) {
        if (apiError.response?.status === 400) {
          errorMsg = "Invalid notification data provided";
        } else if (apiError.response?.status === 413) {
          errorMsg = "Notification message too large";
        } else if (apiError.response?.status) {
          errorMsg = `Notification service error (${apiError.response.status})`;
        }
      }
      throw new Error(errorMsg);
    }
  }

  async handleListNotifications(args: any): Promise<ToolExecutionResult> {
    debugError(`[CallTool Handler] Executing static tool: ${listNotificationsStaticTool.name}`);
    const validatedArgs = ListNotificationsInputSchema.parse(args ?? {});

    const apiKey = getPluggedinMCPApiKey();
    const baseUrl = getPluggedinMCPApiBaseUrl();
    if (!apiKey || !baseUrl) {
      return {
        content: [{
          type: "text",
          text: getApiKeySetupMessage("pluggedin_list_notifications")
        }],
        isError: false
      };
    }

    // Build query parameters
    const queryParams = new URLSearchParams();
    queryParams.append('limit', validatedArgs.limit.toString());
    queryParams.append('unreadOnly', validatedArgs.unreadOnly.toString());
    if (validatedArgs.severity) {
      queryParams.append('severity', validatedArgs.severity);
    }

    const notificationApiUrl = `${baseUrl}/api/notifications?${queryParams.toString()}`;

    const timer = createExecutionTimer();
    try {
      const response = await axios.get(
        notificationApiUrl,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
        }
      );

      // Log successful notification list
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Notification System',
        serverUuid: 'pluggedin_notifications',
        itemName: listNotificationsStaticTool.name,
        success: true,
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors

      const notifications = response.data.notifications || [];
      
      let responseText = `Found ${notifications.length} notification(s)\n\n`;
      
      notifications.forEach((notif: any, index: number) => {
        responseText += `${index + 1}. **${notif.title}**\n`;
        responseText += `   ID: ${notif.id}\n`;
        responseText += `   Status: ${notif.read_at ? 'Read' : 'Unread'}\n`;
        responseText += `   Severity: ${notif.severity}\n`;
        responseText += `   Created: ${new Date(notif.created_at).toLocaleString()}\n`;
        responseText += `   Message: ${notif.message}\n`;
        if (notif.link) {
          responseText += `   Link: ${notif.link}\n`;
        }
        responseText += '\n';
      });

      return {
        content: [{ type: "text", text: responseText }],
        isError: false,
      };

    } catch (apiError: any) {
      // Log failed notification list
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Notification System',
        serverUuid: 'pluggedin_notifications',
        itemName: listNotificationsStaticTool.name,
        success: false,
        errorMessage: apiError instanceof Error ? apiError.message : String(apiError),
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors
      
      throw new Error("Failed to list notifications");
    }
  }

  async handleMarkNotificationDone(args: any): Promise<ToolExecutionResult> {
    debugError(`[CallTool Handler] Executing static tool: ${markNotificationDoneStaticTool.name}`);
    const validatedArgs = MarkNotificationDoneInputSchema.parse(args ?? {});

    const apiKey = getPluggedinMCPApiKey();
    const baseUrl = getPluggedinMCPApiBaseUrl();
    if (!apiKey || !baseUrl) {
      return {
        content: [{
          type: "text",
          text: getApiKeySetupMessage("pluggedin_mark_notification_done")
        }],
        isError: false
      };
    }

    const notificationApiUrl = `${baseUrl}/api/notifications/${validatedArgs.notificationId}/completed`;

    const timer = createExecutionTimer();
    try {
      await axios.patch(
        notificationApiUrl,
        {},
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
        }
      );

      // Log successful toggle completed
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Notification System',
        serverUuid: 'pluggedin_notifications',
        itemName: markNotificationDoneStaticTool.name,
        success: true,
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors

      return {
        content: [{ type: "text", text: "Notification marked as done successfully!" }],
        isError: false,
      };

    } catch (apiError: any) {
      // Log failed toggle completed
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Notification System',
        serverUuid: 'pluggedin_notifications',
        itemName: markNotificationDoneStaticTool.name,
        success: false,
        errorMessage: apiError instanceof Error ? apiError.message : String(apiError),
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors
      
      let errorMsg = "Failed to mark notification as done";
      if (axios.isAxiosError(apiError)) {
        if (apiError.response?.status === 404) {
          errorMsg = "Notification not found";
        }
      }
      throw new Error(errorMsg);
    }
  }

  async handleDeleteNotification(args: any): Promise<ToolExecutionResult> {
    debugError(`[CallTool Handler] Executing static tool: ${deleteNotificationStaticTool.name}`);
    const validatedArgs = DeleteNotificationInputSchema.parse(args ?? {});

    const apiKey = getPluggedinMCPApiKey();
    const baseUrl = getPluggedinMCPApiBaseUrl();
    if (!apiKey || !baseUrl) {
      return {
        content: [{
          type: "text",
          text: getApiKeySetupMessage("pluggedin_delete_notification")
        }],
        isError: false
      };
    }

    const notificationApiUrl = `${baseUrl}/api/notifications/${validatedArgs.notificationId}`;

    const timer = createExecutionTimer();
    try {
      await axios.delete(
        notificationApiUrl,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
        }
      );

      // Log successful deletion
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Notification System',
        serverUuid: 'pluggedin_notifications',
        itemName: deleteNotificationStaticTool.name,
        success: true,
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors

      return {
        content: [{ type: "text", text: "Notification deleted successfully!" }],
        isError: false,
      };

    } catch (apiError: any) {
      // Log failed deletion
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Notification System',
        serverUuid: 'pluggedin_notifications',
        itemName: deleteNotificationStaticTool.name,
        success: false,
        errorMessage: apiError instanceof Error ? apiError.message : String(apiError),
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors
      
      let errorMsg = "Failed to delete notification";
      if (axios.isAxiosError(apiError)) {
        if (apiError.response?.status === 404) {
          errorMsg = "Notification not found";
        }
      }
      throw new Error(errorMsg);
    }
  }

  async handleCreateDocument(args: any): Promise<ToolExecutionResult> {
    debugError(`[CallTool Handler] Executing static tool: ${createDocumentStaticTool.name}`);
    const validatedArgs = CreateDocumentInputSchema.parse(args ?? {});

    const apiKey = getPluggedinMCPApiKey();
    const baseUrl = getPluggedinMCPApiBaseUrl();
    if (!apiKey || !baseUrl) {
      return {
        content: [{
          type: "text",
          text: getApiKeySetupMessage("pluggedin_create_document")
        }],
        isError: false
      };
    }

    const documentApiUrl = `${baseUrl}/api/documents/ai`;

    const timer = createExecutionTimer();
    try {
      const response = await axios.post(
        documentApiUrl,
        validatedArgs,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Log successful creation
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Document System',
        serverUuid: 'pluggedin_documents',
        itemName: createDocumentStaticTool.name,
        success: true,
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors

      const responseText = `Document created successfully!\nID: ${response.data.documentId}\nTitle: ${validatedArgs.title}\nURL: ${response.data.url}`;

      return {
        content: [{ type: "text", text: responseText }],
        isError: false,
      };

    } catch (apiError: any) {
      // Log failed creation
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Document System',
        serverUuid: 'pluggedin_documents',
        itemName: createDocumentStaticTool.name,
        success: false,
        errorMessage: apiError instanceof Error ? apiError.message : String(apiError),
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors
      
      // Handle specific error cases
      let errorMsg = "Failed to create document";
      if (axios.isAxiosError(apiError)) {
        if (apiError.response?.status === 400) {
          errorMsg = "Invalid document data provided";
        } else if (apiError.response?.status === 413) {
          errorMsg = "Document content too large (max 10MB)";
        } else if (apiError.response?.status) {
          errorMsg = `Document service error (${apiError.response.status})`;
        }
      }
      throw new Error(errorMsg);
    }
  }

  async handleListDocuments(args: any): Promise<ToolExecutionResult> {
    debugError(`[CallTool Handler] Executing static tool: ${listDocumentsStaticTool.name}`);
    const validatedArgs = ListDocumentsInputSchema.parse(args ?? {});

    const apiKey = getPluggedinMCPApiKey();
    const baseUrl = getPluggedinMCPApiBaseUrl();
    if (!apiKey || !baseUrl) {
      return {
        content: [{
          type: "text",
          text: getApiKeySetupMessage("pluggedin_list_documents")
        }],
        isError: false
      };
    }

    // Build query parameters
    const queryParams = new URLSearchParams();
    if (validatedArgs.filters?.source) queryParams.append('source', validatedArgs.filters.source);
    if (validatedArgs.filters?.modelName) queryParams.append('modelName', validatedArgs.filters.modelName);
    if (validatedArgs.filters?.modelProvider) queryParams.append('modelProvider', validatedArgs.filters.modelProvider);
    if (validatedArgs.filters?.dateFrom) queryParams.append('dateFrom', validatedArgs.filters.dateFrom);
    if (validatedArgs.filters?.dateTo) queryParams.append('dateTo', validatedArgs.filters.dateTo);
    if (validatedArgs.filters?.tags) {
      validatedArgs.filters.tags.forEach(tag => queryParams.append('tags', tag));
    }
    if (validatedArgs.filters?.category) queryParams.append('category', validatedArgs.filters.category);
    if (validatedArgs.filters?.searchQuery) queryParams.append('searchQuery', validatedArgs.filters.searchQuery);
    queryParams.append('sort', validatedArgs.sort);
    queryParams.append('limit', validatedArgs.limit.toString());
    queryParams.append('offset', validatedArgs.offset.toString());

    const documentApiUrl = `${baseUrl}/api/documents?${queryParams.toString()}`;

    const timer = createExecutionTimer();
    try {
      const response = await axios.get(
        documentApiUrl,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
        }
      );

      // Log successful list
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Document System',
        serverUuid: 'pluggedin_documents',
        itemName: listDocumentsStaticTool.name,
        success: true,
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors

      const documents = response.data.documents || [];
      const total = response.data.total || 0;
      
      let responseText = `Found ${total} document(s) (showing ${documents.length})\n\n`;
      
      documents.forEach((doc: any, index: number) => {
        responseText += `${index + 1}. **${doc.title}**\n`;
        responseText += `   ID: ${doc.id}\n`;
        responseText += `   Created: ${new Date(doc.createdAt).toLocaleDateString()}\n`;
        responseText += `   Source: ${doc.source}`;
        if (doc.source === 'ai_generated' && doc.aiMetadata?.model) {
          responseText += ` (${doc.aiMetadata.model.name})`;
        }
        responseText += `\n`;
        if (doc.tags && doc.tags.length > 0) {
          responseText += `   Tags: ${doc.tags.join(', ')}\n`;
        }
        if (doc.description) {
          responseText += `   Description: ${doc.description}\n`;
        }
        responseText += '\n';
      });

      return {
        content: [{ type: "text", text: responseText }],
        isError: false,
      };

    } catch (apiError: any) {
      // Log failed list
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Document System',
        serverUuid: 'pluggedin_documents',
        itemName: listDocumentsStaticTool.name,
        success: false,
        errorMessage: apiError instanceof Error ? apiError.message : String(apiError),
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors
      
      throw new Error("Failed to list documents");
    }
  }

  async handleSearchDocuments(args: any): Promise<ToolExecutionResult> {
    debugError(`[CallTool Handler] Executing static tool: ${searchDocumentsStaticTool.name}`);
    const validatedArgs = SearchDocumentsInputSchema.parse(args ?? {});

    const apiKey = getPluggedinMCPApiKey();
    const baseUrl = getPluggedinMCPApiBaseUrl();
    if (!apiKey || !baseUrl) {
      return {
        content: [{
          type: "text",
          text: getApiKeySetupMessage("pluggedin_search_documents")
        }],
        isError: false
      };
    }

    const documentApiUrl = `${baseUrl}/api/documents/search`;

    const timer = createExecutionTimer();
    try {
      const response = await axios.post(
        documentApiUrl,
        validatedArgs,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Log successful search
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Document System',
        serverUuid: 'pluggedin_documents',
        itemName: searchDocumentsStaticTool.name,
        success: true,
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors

      const results = response.data.results || [];
      
      let responseText = `Search results for "${validatedArgs.query}" (${results.length} found):\n\n`;
      
      results.forEach((result: any, index: number) => {
        responseText += `${index + 1}. **${result.title}**\n`;
        responseText += `   ID: ${result.id}\n`;
        responseText += `   Relevance: ${(result.relevanceScore * 100).toFixed(1)}%\n`;
        responseText += `   Snippet: ${result.snippet}\n`;
        responseText += `   Source: ${result.source}`;
        if (result.source === 'ai_generated' && result.aiMetadata?.model) {
          responseText += ` (${result.aiMetadata.model.name})`;
        }
        responseText += `\n\n`;
      });

      return {
        content: [{ type: "text", text: responseText }],
        isError: false,
      };

    } catch (apiError: any) {
      // Log failed search
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Document System',
        serverUuid: 'pluggedin_documents',
        itemName: searchDocumentsStaticTool.name,
        success: false,
        errorMessage: apiError instanceof Error ? apiError.message : String(apiError),
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors
      
      throw new Error("Failed to search documents");
    }
  }

  async handleGetDocument(args: any): Promise<ToolExecutionResult> {
    debugError(`[CallTool Handler] Executing static tool: ${getDocumentStaticTool.name}`);
    const validatedArgs = GetDocumentInputSchema.parse(args ?? {});

    const apiKey = getPluggedinMCPApiKey();
    const baseUrl = getPluggedinMCPApiBaseUrl();
    if (!apiKey || !baseUrl) {
      return {
        content: [{
          type: "text",
          text: getApiKeySetupMessage("pluggedin_get_document")
        }],
        isError: false
      };
    }

    const queryParams = new URLSearchParams();
    queryParams.append('includeContent', validatedArgs.includeContent.toString());
    queryParams.append('includeVersions', validatedArgs.includeVersions.toString());

    const documentApiUrl = `${baseUrl}/api/documents/${validatedArgs.documentId}?${queryParams.toString()}`;

    const timer = createExecutionTimer();
    try {
      const response = await axios.get(
        documentApiUrl,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
        }
      );

      // Log successful retrieval
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Document System',
        serverUuid: 'pluggedin_documents',
        itemName: getDocumentStaticTool.name,
        success: true,
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors

      // Format response
      const doc = response.data;
      let responseText = `**${doc.title}**\n\n`;
      responseText += `ID: ${doc.id}\n`;
      responseText += `Created: ${new Date(doc.createdAt).toLocaleDateString()}\n`;
      responseText += `Source: ${doc.source}`;
      if (doc.source === 'ai_generated' && doc.aiMetadata?.model) {
        responseText += ` (${doc.aiMetadata.model.name})`;
      }
      responseText += `\n`;
      responseText += `Version: ${doc.version}\n`;
      if (doc.tags && doc.tags.length > 0) {
        responseText += `Tags: ${doc.tags.join(', ')}\n`;
      }
      responseText += `\n`;

      if (doc.description) {
        responseText += `Description: ${doc.description}\n\n`;
      }

      if (validatedArgs.includeContent && doc.content) {
        responseText += `--- Content ---\n${doc.content}\n`;
      }

      if (validatedArgs.includeVersions && doc.versions && doc.versions.length > 0) {
        responseText += `\n--- Version History ---\n`;
        doc.versions.forEach((version: any) => {
          responseText += `v${version.versionNumber} - ${new Date(version.createdAt).toLocaleDateString()}`;
          if (version.createdByModel) {
            responseText += ` by ${version.createdByModel.name}`;
          }
          if (version.changeSummary) {
            responseText += ` - ${version.changeSummary}`;
          }
          responseText += `\n`;
        });
      }

      return {
        content: [{ type: "text", text: responseText }],
        isError: false,
      };

    } catch (apiError: any) {
      // Log failed retrieval
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Document System',
        serverUuid: 'pluggedin_documents',
        itemName: getDocumentStaticTool.name,
        success: false,
        errorMessage: apiError instanceof Error ? apiError.message : String(apiError),
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors
      
      // Handle specific error cases
      let errorMsg = "Failed to retrieve document";
      if (axios.isAxiosError(apiError)) {
        if (apiError.response?.status === 404) {
          errorMsg = "Document not found or not accessible";
        }
      }
      throw new Error(errorMsg);
    }
  }

  async handleUpdateDocument(args: any): Promise<ToolExecutionResult> {
    debugError(`[CallTool Handler] Executing static tool: ${updateDocumentStaticTool.name}`);
    const validatedArgs = UpdateDocumentInputSchema.parse(args ?? {});

    const apiKey = getPluggedinMCPApiKey();
    const baseUrl = getPluggedinMCPApiBaseUrl();
    if (!apiKey || !baseUrl) {
      return {
        content: [{
          type: "text",
          text: getApiKeySetupMessage("pluggedin_update_document")
        }],
        isError: false
      };
    }

    const documentApiUrl = `${baseUrl}/api/documents/${validatedArgs.documentId}`;

    const timer = createExecutionTimer();
    try {
      const response = await axios.patch(
        documentApiUrl,
        validatedArgs,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Log successful update
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Document System',
        serverUuid: 'pluggedin_documents',
        itemName: updateDocumentStaticTool.name,
        success: true,
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors

      const responseText = `Document updated successfully!\nID: ${validatedArgs.documentId}\nOperation: ${validatedArgs.operation}\nNew version: ${response.data.version}`;

      return {
        content: [{ type: "text", text: responseText }],
        isError: false,
      };

    } catch (apiError: any) {
      // Log failed update
      logMcpActivity({
        action: 'tool_call',
        serverName: 'Document System',
        serverUuid: 'pluggedin_documents',
        itemName: updateDocumentStaticTool.name,
        success: false,
        errorMessage: apiError instanceof Error ? apiError.message : String(apiError),
        executionTime: timer.stop(),
      }).catch(() => {}); // Ignore notification errors
      
      // Handle specific error cases
      let errorMsg = "Failed to update document";
      if (axios.isAxiosError(apiError)) {
        if (apiError.response?.status === 404) {
          errorMsg = "Document not found or not accessible";
        } else if (apiError.response?.status === 400) {
          errorMsg = "Invalid update data provided";
        } else if (apiError.response?.status === 501) {
          errorMsg = apiError.response.data?.details || "Document updates are not supported at this time";
        }
      }
      throw new Error(errorMsg);
    }
  }

  // Main handler method
  async handleStaticTool(toolName: string, args: any): Promise<ToolExecutionResult | null> {
    switch (toolName) {
      case setupStaticTool.name:
        return this.handleSetup(args);
      case discoverToolsStaticTool.name:
        return this.handleDiscoverTools(args);
      case askKnowledgeBaseStaticTool.name:
        return this.handleAskKnowledgeBase(args);
      case sendNotificationStaticTool.name:
        return this.handleSendNotification(args);
      case listNotificationsStaticTool.name:
        return this.handleListNotifications(args);
      case markNotificationDoneStaticTool.name:
        return this.handleMarkNotificationDone(args);
      case deleteNotificationStaticTool.name:
        return this.handleDeleteNotification(args);
      case createDocumentStaticTool.name:
        return this.handleCreateDocument(args);
      case listDocumentsStaticTool.name:
        return this.handleListDocuments(args);
      case searchDocumentsStaticTool.name:
        return this.handleSearchDocuments(args);
      case getDocumentStaticTool.name:
        return this.handleGetDocument(args);
      case updateDocumentStaticTool.name:
        return this.handleUpdateDocument(args);
      default:
        return null; // Not a static tool
    }
  }
}