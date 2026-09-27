/**
 * Streamable HTTP Server Transport for MCP Proxy
 *
 * MCP Protocol Compliance:
 * - Headers use Title-Case per MCP spec (Mcp-Session-Id, Mcp-Protocol-Version)
 * - CORS headers expose custom headers to clients
 * - Protocol version validation (negotiated against the bundled SDK's supported set)
 * - JSON-RPC 2.0 compliant error codes
 *
 * JSON-RPC Error Codes Used:
 * - -32600: Invalid Request (malformed request, unsupported protocol version)
 * - -32601: Method not found (HTTP method not allowed)
 * - -32603: Internal error (server-side exception)
 * - -32001: Server error - Unauthorized (auth failure)
 * - -32000: Server error - Generic application error (session not found, etc.)
 */

import express from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { debugLog, debugError } from './debug-log.js';
import {
  MCP_SESSION_ID_HEADER,
  JSON_RPC_ERROR_CODES,
  SESSION_TTL_MS,
  SESSION_CLEANUP_INTERVAL_MS,
  MAX_SESSIONS,
} from './constants.js';
import {
  corsMiddleware,
  createOriginAllowlist,
  createOriginMiddleware,
  versionMiddleware,
  acceptMiddleware,
  createAuthMiddleware,
  createWellKnownHandler,
  resolveTransport,
  closeSession,
  type ServerFactory,
  type SessionMetadata,
} from './middleware.js';

// Map to store active sessions with metadata (for stateful mode)
const sessions = new Map<string, SessionMetadata>();

/**
 * Clean up expired sessions based on TTL
 * @returns Number of sessions cleaned up
 */
function cleanupExpiredSessions(): number {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [sessionId, metadata] of sessions.entries()) {
    if (now - metadata.lastAccess > SESSION_TTL_MS) {
      closeSession(metadata).catch(error => {
        debugError(`Error closing expired session ${sessionId}:`, error);
      });
      sessions.delete(sessionId);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    debugLog(`Cleaned up ${cleanedCount} expired sessions`);
  }

  return cleanedCount;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(normalized) || normalized.startsWith('127.');
}

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/** Host-header form of a host name: lowercased, port dropped, IPv6 in brackets */
function toHostname(host: string): string | undefined {
  const trimmed = host.trim().toLowerCase();
  const bracketed = trimmed.includes(':') && !trimmed.startsWith('[') && trimmed.split(':').length > 2
    ? `[${trimmed}]`
    : trimmed;
  try {
    return new URL(`http://${bracketed}`).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Host names the MCP routes answer to, for DNS-rebinding protection (the SDK's
 * hostHeaderValidation middleware). A rebinding page reaches the port under the
 * attacker's hostname, so on a loopback bind only loopback names, the bind host and
 * MCP_ALLOWED_HOSTS (comma-separated, e.g. a local reverse proxy's public name) are
 * accepted. On other binds the public name is unknown, so the check is applied only
 * when MCP_ALLOWED_HOSTS is set.
 * @returns the allowed host names, or undefined when the check is off
 */
export function resolveAllowedHostnames(bindHost: string | undefined, allowedHostsEnv?: string): string[] | undefined {
  const host = bindHost?.trim() || 'localhost';
  const extra = (allowedHostsEnv ?? '')
    .split(',')
    .map(toHostname)
    .filter((name): name is string => Boolean(name));

  if (!isLoopbackHost(host) && extra.length === 0) {
    return undefined;
  }
  const bound = isLoopbackHost(host) ? toHostname(host) : undefined;
  return [...new Set([...LOOPBACK_HOSTNAMES, ...(bound ? [bound] : []), ...extra])];
}

export interface RequireApiAuthInput {
  /** --require-api-auth CLI flag (true when passed) */
  cliFlag?: boolean;
  /** REQUIRE_API_AUTH environment value */
  envValue?: string;
  /** BIND_HOST; unset means localhost, as in startStreamableHTTPServer */
  bindHost?: string;
  /** Whether an owner API key is configured (env var or credentials/settings files) */
  hasApiKey: boolean;
}

export interface RequireApiAuthDecision {
  requireApiAuth: boolean;
  /** Explanation for stderr when auth was turned on by default, or explicitly left off while exposed */
  notice?: string;
}

/**
 * Decide whether the Streamable HTTP transport requires the API key.
 * Precedence: --require-api-auth flag > REQUIRE_API_AUTH ('true'/'false') > default.
 *
 * The default fails closed: listening on a non-loopback host while an owner API key
 * is configured requires auth, since anyone who can reach the port would otherwise
 * act with the owner's Plugged.in credentials. An unrecognized REQUIRE_API_AUTH value
 * also requires auth, so a typo can never switch it off.
 */
export function resolveRequireApiAuth(input: RequireApiAuthInput): RequireApiAuthDecision {
  const host = input.bindHost?.trim() || 'localhost';
  const exposed = input.hasApiKey && !isLoopbackHost(host);

  if (input.cliFlag) {
    return { requireApiAuth: true };
  }

  const envValue = input.envValue?.trim().toLowerCase();
  if (envValue === 'true') {
    return { requireApiAuth: true };
  }
  if (envValue === 'false') {
    return exposed
      ? {
          requireApiAuth: false,
          notice: `WARNING: REQUIRE_API_AUTH=false while listening on ${host} with a Plugged.in API key configured. ` +
            'Anyone who can reach this port can use that key.'
        }
      : { requireApiAuth: false };
  }
  if (envValue) {
    return {
      requireApiAuth: true,
      notice: `Unrecognized REQUIRE_API_AUTH value ${JSON.stringify(input.envValue)} (expected "true" or "false"); ` +
        'requiring API authentication.'
    };
  }

  if (exposed) {
    return {
      requireApiAuth: true,
      notice: `API authentication enabled: listening on ${host} with a Plugged.in API key configured, ` +
        'so clients must send "Authorization: Bearer <key>". Set REQUIRE_API_AUTH=false to turn this off.'
    };
  }
  return { requireApiAuth: false };
}

export interface StreamableHTTPOptions {
  port: number;
  requireApiAuth?: boolean;
  stateless?: boolean;
}

/**
 * Start a Streamable HTTP server for the MCP proxy
 * @param createServer Builds a fresh MCP Server for each session (stateful) or request
 *   (stateless); the SDK connects a Server to only one transport at a time
 * @param options Configuration options
 * @returns Cleanup function to stop the HTTP server
 */
export async function startStreamableHTTPServer(
  createServer: ServerFactory,
  options: StreamableHTTPOptions
): Promise<() => Promise<void>> {
  const app = express();
  const { port, requireApiAuth = false, stateless = false } = options;

  // Permissive CORS only for the public discovery endpoints; the MCP routes get the
  // Origin check below instead
  app.use(['/.well-known', '/mcp/.well-known', '/health'], corsMiddleware);

  // Apply middleware in order: version validation, accept normalization
  app.use(versionMiddleware);
  app.use(acceptMiddleware);

  // Serve static files from .well-known directory (MCP server discovery)
  // This must come AFTER CORS but BEFORE authentication
  const wellKnownHandler = createWellKnownHandler();
  app.use('/.well-known', wellKnownHandler);
  app.use('/mcp/.well-known', wellKnownHandler);

  // Middleware to parse JSON bodies
  app.use(express.json());

  // Default to localhost for security, but allow override via BIND_HOST
  // In Docker, the Dockerfile sets BIND_HOST=0.0.0.0 to accept external connections
  const host = process.env.BIND_HOST || 'localhost';

  // Guards mounted on every MCP route below, not by path comparison, so '/', '/mcp' and
  // the case/trailing-slash variants Express routes to them are all covered:
  // DNS-rebinding protection (Host), Origin validation with CORS, then authentication
  const mcpGuards: express.RequestHandler[] = [];
  const allowedHostnames = resolveAllowedHostnames(host, process.env.MCP_ALLOWED_HOSTS);
  if (allowedHostnames) {
    mcpGuards.push(hostHeaderValidation(allowedHostnames));
  }
  mcpGuards.push(createOriginMiddleware(createOriginAllowlist(process.env.MCP_ALLOWED_ORIGINS)));
  mcpGuards.push(createAuthMiddleware(requireApiAuth));

  // Shared MCP handler used for both /mcp and / routes
  const mcpHandler = async (req: any, res: any) => {
    try {
      // Termination and unsupported methods never need a transport; answer them
      // before resolveTransport so they cannot allocate a session
      if (req.method === 'DELETE') {
        const sessionId = stateless ? undefined : (req.headers['mcp-session-id'] as string);
        if (stateless) {
          // In stateless mode, always return success
          res.status(200).json({ success: true, message: 'Stateless mode - no session to terminate' });
        } else if (sessionId && sessions.has(sessionId)) {
          // Session exists, delete it
          const metadata = sessions.get(sessionId)!;
          await closeSession(metadata);
          sessions.delete(sessionId);
          res.status(200).json({ success: true, message: 'Session terminated' });
        } else {
          // Session ID not provided or doesn't exist - return success as nothing to delete
          res.status(200).json({ success: true, message: 'Session not found' });
        }
        return;
      }

      if (req.method !== 'POST' && req.method !== 'GET') {
        res.status(405).json({
          jsonrpc: '2.0',
          error: {
            code: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
            message: `HTTP method ${req.method} not allowed`
          }
        });
        return;
      }

      const session = await resolveTransport(req, res, createServer, stateless, sessions);
      if (!session) {
        // resolveTransport already sent the error response (unknown session, no session, pool full)
        return;
      }

      // POST requests have req.body parsed by express.json() middleware; pass it to avoid
      // "stream is not readable". GET requests (SSE) have no body, so pass undefined explicitly.
      await session.transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);

      // Clean up the per-request transport and Server in stateless mode
      if (stateless && req.method !== 'GET') {
        await closeSession(session);
      }
    } catch (error) {
      debugError('Error handling request:', error);
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          message: 'Internal server error',
          // Only expose error details in development to prevent information disclosure
          ...(process.env.NODE_ENV === 'development' && {
            data: error instanceof Error ? error.message : String(error)
          })
        }
      });
    }
  };

  // MCP endpoint handler (preferred path)
  app.all('/mcp', ...mcpGuards, mcpHandler);

  // Fallback root path handler for clients that POST to base URL
  app.all('/', ...mcpGuards, mcpHandler);

  // Health check endpoint
  app.get('/health', (_req: any, res: any) => {
    res.json({
      status: 'ok',
      transport: 'streamable-http',
      sessions: stateless ? 0 : sessions.size,
      maxSessions: stateless ? 0 : MAX_SESSIONS
    });
  });

  // Set up periodic session cleanup (only in stateful mode)
  let cleanupInterval: NodeJS.Timeout | null = null;
  if (!stateless) {
    cleanupInterval = setInterval(() => {
      cleanupExpiredSessions();
    }, SESSION_CLEANUP_INTERVAL_MS);
    debugLog(`Session cleanup interval started (every ${SESSION_CLEANUP_INTERVAL_MS / 1000}s)`);
  }

  // Start the Express server on the host resolved above
  // Await the `listening` event so callers (and the returned cleanup function)
  // only see a fully bound server. Resolving before the socket is bound caused
  // ECONNREFUSED races for any code that connects immediately after awaiting.
  const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const onStartupError = (err: Error) => reject(err);
    const srv = app.listen(port, host, () => {
      // Bind succeeded: drop the startup-error listener so later runtime errors
      // aren't swallowed by this already-settled promise's reject handler.
      srv.removeListener('error', onStartupError);
      debugLog(`Streamable HTTP server listening on ${host}:${port}`);
      if (stateless) {
        debugLog('Running in stateless mode');
      } else {
        debugLog('Running in stateful mode (session-based)');
      }
      if (requireApiAuth) {
        debugLog('API authentication required');
      }
      resolve(srv);
    });
    srv.once('error', onStartupError);
  });

  // Return cleanup function
  return async () => {
    // Clear cleanup interval
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      debugLog('Session cleanup interval stopped');
    }

    // Close all active sessions
    for (const [sessionId, metadata] of sessions) {
      try {
        await closeSession(metadata);
      } catch (error) {
        debugError(`Error closing transport for session ${sessionId}:`, error);
      }
    }
    sessions.clear();

    // Close the HTTP server
    return new Promise((resolve) => {
      httpServer.close(() => {
        debugLog('Streamable HTTP server stopped');
        resolve();
      });
    });
  };
}
