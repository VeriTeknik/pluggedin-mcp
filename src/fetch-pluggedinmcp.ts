import axios from "axios";
import {
  getDefaultEnvironment,
  getPluggedinMCPApiBaseUrl,
  getPluggedinMCPApiKey,
} from "./utils.js";
import { debugLog, debugError } from "./debug-log.js";
import { ServerParameters } from "./types.js";

let _mcpServersCache: Record<string, ServerParameters> | null = null;
let _mcpServersCacheTimestamp: number = 0;
// Fingerprint of the API key and base URL the cache was fetched with
let _mcpServersCacheOwner: string | null = null;
const CACHE_TTL_MS = 1000; // 1 second cache TTL for forced refreshes
const MAX_CACHE_AGE_MS = 60 * 1000; // Non-forced reads refetch once the cache is older than this
const MAX_STALE_FALLBACK_MS = 5 * 60 * 1000; // Transient fetch errors may serve a cache at most this old
const FETCH_TIMEOUT_MS = 30 * 1000; // Every tools/call waits on this fetch, so a hung app must not hang the proxy

const _invalidationListeners = new Set<() => void | Promise<void>>();
// Bumped on every invalidation so responses already in flight are not cached afterwards
let _invalidationEpoch = 0;

/**
 * Registers a callback that runs when cached server configurations are discarded
 * because the app rejected, or no longer has, the credentials they were fetched with.
 * Returns a function that unregisters the callback.
 */
export function onMcpServersInvalidated(
  listener: () => void | Promise<void>
): () => void {
  _invalidationListeners.add(listener);
  return () => {
    _invalidationListeners.delete(listener);
  };
}

async function invalidateMcpServersCache(): Promise<void> {
  _mcpServersCache = null;
  _mcpServersCacheTimestamp = 0;
  _mcpServersCacheOwner = null;
  _invalidationEpoch++;
  await Promise.allSettled(
    [..._invalidationListeners].map(async (listener) => listener())
  );
}

// Compared in memory only (never stored or logged); the process already holds the key
const getCacheOwner = (apiKey: string, apiBaseUrl: string): string =>
  `${apiKey}\n${apiBaseUrl}`;

// Removed logger

export async function getMcpServers(
  forceRefresh: boolean = false
): Promise<Record<string, ServerParameters>> {
  const currentTime = Date.now();
  const apiKey = getPluggedinMCPApiKey();
  const apiBaseUrl = getPluggedinMCPApiBaseUrl();

  if (!apiKey || !apiBaseUrl) { // Also check apiBaseUrl
    // Without credentials, nothing fetched with earlier credentials may be used
    await invalidateMcpServersCache();
    return {};
  }

  const cacheOwner = getCacheOwner(apiKey, apiBaseUrl);
  if (_mcpServersCache !== null && _mcpServersCacheOwner !== cacheOwner) {
    // The cache belongs to other credentials
    await invalidateMcpServersCache();
  }

  // Use cache if it exists and is younger than 1 second (forced refresh)
  // or MAX_CACHE_AGE_MS (ordinary read)
  const cacheAge = currentTime - _mcpServersCacheTimestamp;
  if (_mcpServersCache !== null && cacheAge < (forceRefresh ? CACHE_TTL_MS : MAX_CACHE_AGE_MS)) {
    return _mcpServersCache;
  }

  const epoch = _invalidationEpoch;
  try {
    const headers = { Authorization: `Bearer ${apiKey}` };
    const response = await axios.get(`${apiBaseUrl}/api/mcp-servers`, {
      headers,
      timeout: FETCH_TIMEOUT_MS,
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
        // The app stores SSE credentials in streamableHTTPOptions too; it takes precedence
        const storedHeaders = params.streamableHTTPOptions?.headers;
        if (storedHeaders) {
          params.headers = { ...(params.headers || {}), ...storedHeaders };
        }

        // For SSE servers, ensure url is present
        if (!params.url) {
          // logger.warn( // Removed logging
          //   `SSE server ${params.uuid} (${params.name}) is missing url field, skipping`
          // );
          continue;
        }
      } else if (params.type === "STREAMABLE_HTTP") {
        // Map streamableHTTPOptions to direct fields for backward compatibility
        // Merge headers for backward compatibility, streamableHTTPOptions.headers takes precedence
        params.headers = {
          ...(params.headers || {}),
          ...(params.streamableHTTPOptions?.headers || {}),
        };
        // For sessionId, streamableHTTPOptions.sessionId takes precedence if present
        params.sessionId = params.streamableHTTPOptions?.sessionId || params.sessionId;
        
        // Log if headers or sessionId are present
        if ((params.headers && Object.keys(params.headers).length > 0) || params.sessionId) {
          debugLog(`[MCP] StreamableHTTP server ${params.name}: headers=${Object.keys(params.headers || {}).length}, sessionId=${!!params.sessionId}`);
        }
        
        // Ensure url is present
        if (!params.url) {
          debugError(`StreamableHTTP server ${params.uuid} (${params.name}) is missing url field, skipping`);
          continue;
        }
      }

      const uuid = params.uuid;
      if (uuid) {
        serverDict[uuid] = params;
      }
    }

    if (epoch !== _invalidationEpoch) {
      // The key was rejected (or changed) while this request was in flight
      return {};
    }

    _mcpServersCache = serverDict;
    _mcpServersCacheTimestamp = currentTime;
    _mcpServersCacheOwner = cacheOwner;
    // logger.debug(`Fetched and cached ${Object.keys(serverDict).length} MCP server configurations.`); // Removed logging
    return serverDict;
  } catch (error: any) { // Add type to error
    const status = error?.response?.status;
    if (status === 401 || status === 403) {
      // The app rejected the API key: drop the configurations (and the downstream
      // credentials they carry) fetched with it, and fail closed
      debugError(`[MCP] API rejected the API key (HTTP ${status}); discarding cached server configurations`);
      await invalidateMcpServersCache();
      return {};
    }
    // On transient errors, return the last known cache if it is recent enough, otherwise empty object
    if (
      _mcpServersCache !== null &&
      _mcpServersCacheOwner === cacheOwner &&
      currentTime - _mcpServersCacheTimestamp < MAX_STALE_FALLBACK_MS
    ) {
      // logger.warn("Returning stale MCP server cache due to fetch error."); // Removed logging
      return _mcpServersCache;
    }
    return {};
  }
}
