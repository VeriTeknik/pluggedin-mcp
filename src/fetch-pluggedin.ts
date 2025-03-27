import axios from "axios";
import {
  getDefaultEnvironment,
  getPluggedinApiBaseUrl,
  getPluggedinApiKey,
} from "./utils.js";

// Define a new interface for server parameters that can be either STDIO or SSE
export interface ServerParameters {
  uuid: string;
  name: string;
  description: string;
  type?: "STDIO" | "SSE"; // Optional field, defaults to "STDIO" when undefined
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  url?: string | null;
  created_at: string;
  profile_uuid: string;
  status: string;
}

let _mcpServersCache: Record<string, ServerParameters> | null = null;
let _mcpServersCacheTimestamp: number = 0;
const CACHE_TTL_MS = 1000; // 1 second cache TTL

export async function getMcpServers(
  forceRefresh: boolean = false
): Promise<Record<string, ServerParameters>> {
  const currentTime = Date.now();
  const cacheAge = currentTime - _mcpServersCacheTimestamp;

  // Use cache if it exists, is not null, and either:
  // 1. forceRefresh is false, or
  // 2. forceRefresh is true but cache is less than 1 second old
  if (_mcpServersCache !== null && (!forceRefresh || cacheAge < CACHE_TTL_MS)) {
    return _mcpServersCache;
  }

  try {
    const apiKey = getPluggedinApiKey();
    const apiBaseUrl = getPluggedinApiBaseUrl();

    if (!apiKey) {
      console.error(
        "PLUGGEDIN_API_KEY is not set. Please set it via environment variable or command line argument."
      );
      return _mcpServersCache || {};
    }

    const headers = { Authorization: `Bearer ${apiKey}` };
    const response = await axios.get(`${apiBaseUrl}/mcp-servers`, {
      headers,
    });
    const data = response.data;

    const serverDict: Record<string, ServerParameters> = {};
    for (const serverParams of data) {
      const params: ServerParameters = {
        ...serverParams,
        type: serverParams.type || "STDIO",
      };

      // Process based on server type
      if (params.type === "STDIO") {
        if ("args" in params && !params.args) {
          params.args = undefined;
        }

        params.env = {
          ...getDefaultEnvironment(),
          ...(params.env || {}),
        };
      } else if (params.type === "SSE") {
        // For SSE servers, ensure url is present
        if (!params.url) {
          console.warn(
            `SSE server ${params.uuid} is missing url field, skipping`
          );
          continue;
        }
      }

      const uuid = params.uuid;
      if (uuid) {
        serverDict[uuid] = params;
      }
    }

    _mcpServersCache = serverDict;
    _mcpServersCacheTimestamp = currentTime;
    return serverDict;
  } catch (error) {
    if (_mcpServersCache !== null) {
      return _mcpServersCache;
    }
    return {};
  }
}
