/**
 * Express Middleware for MCP Streamable HTTP Server
 *
 * This module contains reusable middleware functions for:
 * - CORS headers and Origin validation
 * - Protocol version validation
 * - Accept header normalization
 * - Authentication
 * - Static file serving for .well-known endpoints
 */

import express, { RequestHandler } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID, timingSafeEqual } from 'crypto';
import { debugLog } from './debug-log.js';
import { getPluggedinMCPApiKey } from './utils.js';
import {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  MCP_SESSION_ID_HEADER,
  MCP_PROTOCOL_VERSION_HEADER,
  JSON_RPC_ERROR_CODES,
  MAX_SESSIONS,
  SESSION_TTL_MS,
} from './constants.js';

function setCorsHeaders(res: any): void {
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    `Content-Type, Authorization, ${MCP_SESSION_ID_HEADER}, ${MCP_PROTOCOL_VERSION_HEADER}`
  );
  // MCP spec: Expose custom headers so clients can read them
  res.header(
    'Access-Control-Expose-Headers',
    `${MCP_SESSION_ID_HEADER}, ${MCP_PROTOCOL_VERSION_HEADER}`
  );
}

/**
 * CORS middleware for the public discovery endpoints (/.well-known, /health) only.
 *
 * The wildcard (*) is fine there: the responses are public and carry no credentials.
 * It must never be mounted on the MCP routes, which act with the owner's Plugged.in
 * key; those use createOriginMiddleware instead.
 */
export const corsMiddleware: RequestHandler = (req: any, res: any, next: any) => {
  res.header('Access-Control-Allow-Origin', '*');
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
};

const LOOPBACK_ORIGIN_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Builds the Origin allowlist for the MCP routes from MCP_ALLOWED_ORIGINS
 * (comma-separated origins, e.g. "https://app.example.com,http://localhost:6274").
 * Unset or empty allows loopback origins only (local tools such as the MCP Inspector);
 * a list replaces that default; "*" allows every origin.
 */
export function createOriginAllowlist(envValue?: string): (origin: string) => boolean {
  const entries = (envValue ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.includes('*')) {
    return () => true;
  }
  if (entries.length === 0) {
    return (origin) => {
      const url = parseOrigin(origin);
      return !!url && LOOPBACK_ORIGIN_HOSTNAMES.has(url.hostname);
    };
  }
  // Unparseable entries are dropped, so a typo fails closed
  const allowed = new Set(entries.map((entry) => parseOrigin(entry)?.origin).filter(Boolean));
  return (origin) => {
    const url = parseOrigin(origin);
    return !!url && allowed.has(url.origin);
  };
}

/**
 * Origin check and CORS for the MCP routes. The MCP Streamable HTTP spec requires
 * validating Origin: without it any website, or a DNS-rebinding page, could drive a
 * loopback proxy (auth is off there by default) with the owner's key. A request with
 * no Origin is not from a browser and passes on to auth; a browser request from an
 * origin outside the allowlist, preflight included, gets 403. Allowed origins are
 * echoed back, never "*".
 */
export function createOriginMiddleware(isAllowedOrigin: (origin: string) => boolean): RequestHandler {
  return (req: any, res: any, next: any) => {
    const origin = req.headers.origin;
    res.vary('Origin');

    if (origin !== undefined) {
      if (!isAllowedOrigin(origin)) {
        return res.status(403).json({
          jsonrpc: '2.0',
          error: {
            code: JSON_RPC_ERROR_CODES.APPLICATION_ERROR,
            message: 'Forbidden: Origin not allowed (see MCP_ALLOWED_ORIGINS)'
          },
          id: null
        });
      }
      res.header('Access-Control-Allow-Origin', origin);
    }
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  };
}

/**
 * Protocol version validation middleware
 * Validates and sets MCP protocol version headers
 * Supports multiple protocol versions for backward compatibility
 */
export const versionMiddleware: RequestHandler = (req: any, res: any, next: any) => {
  // Only validate on MCP endpoint requests
  if ((req.path === '/mcp' || req.path === '/') && req.method === 'POST') {
    const version = req.headers['mcp-protocol-version'];

    // Protocol version is optional but if provided, validate it against supported versions
    if (version && !SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(version as any)) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          message: `Unsupported MCP protocol version: ${version}. Supported: ${SUPPORTED_MCP_PROTOCOL_VERSIONS.join(', ')}`
        },
        id: null
      });
    }

    // Always send latest protocol version in response to indicate server capabilities
    res.setHeader(MCP_PROTOCOL_VERSION_HEADER, MCP_PROTOCOL_VERSION);
  }
  next();
};

/**
 * Accept header normalization middleware
 * Ensures both application/json and text/event-stream are acceptable
 */
export const acceptMiddleware: RequestHandler = (req: any, _res: any, next: any) => {
  const raw = (req.headers['accept'] as string | undefined)?.trim() || '';
  const parts = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const ensure = (mime: string) => {
    if (!parts.some((p) => p.includes(mime))) parts.push(mime);
  };
  ensure('application/json');
  ensure('text/event-stream');
  req.headers['accept'] = parts.join(', ');
  next();
};

/**
 * JSON-RPC methods that stay public when API auth is required: just enough for a
 * client to complete the MCP handshake and keep it alive. Every other method
 * (tools/*, resources/*, prompts/*, completion/*, logging/*, replies to server
 * requests) runs with the owner's Plugged.in credentials and needs the API key.
 */
const PUBLIC_JSONRPC_METHODS = new Set(['initialize', 'notifications/initialized', 'ping']);

function isPublicMessage(message: any): boolean {
  return !!message && typeof message === 'object' &&
    typeof message.method === 'string' && PUBLIC_JSONRPC_METHODS.has(message.method);
}

/**
 * A request is public only if it is a POST whose parsed body is a public message,
 * or a non-empty batch of public messages. GET/DELETE and unparsed bodies are not.
 */
function isPublicRequest(req: any): boolean {
  if (req.method !== 'POST') return false;
  const body = req.body;
  if (Array.isArray(body)) {
    return body.length > 0 && body.every(isPublicMessage);
  }
  return isPublicMessage(body);
}

function isValidApiKey(provided: string, expected: string): boolean {
  // An unconfigured key must never validate
  if (!provided || !expected) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  // Compare byte lengths: equal string lengths can differ in bytes, which makes timingSafeEqual throw
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Creates authentication middleware factory.
 * Mount it on every route that serves the MCP handler; it does not look at the path.
 * @param requireApiAuth - Whether to require API authentication
 */
export function createAuthMiddleware(requireApiAuth: boolean): RequestHandler {
  return (req: any, res: any, next: any) => {
    if (!requireApiAuth) {
      return next();
    }

    const authHeader = req.headers.authorization;
    const apiKey = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : '';

    // Same key resolution as outbound calls (env, then credentials/settings files);
    // timing-safe comparison to prevent timing attacks
    const expectedKey = getPluggedinMCPApiKey() || '';

    if (isValidApiKey(apiKey, expectedKey)) {
      return next();
    }

    if (isPublicRequest(req)) {
      // The handshake may pass without the key, but must not keep a session alive
      res.locals.unauthenticated = true;
      return next();
    }

    return res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: JSON_RPC_ERROR_CODES.UNAUTHORIZED,
        message: 'Unauthorized: Invalid or missing API key'
      },
      id: (!Array.isArray(req.body) && req.body?.id) || null
    });
  };
}

/**
 * Creates a static file handler for .well-known endpoints
 * Sets proper Content-Type for mcp-config files
 */
export function createWellKnownHandler() {
  return express.static('.well-known', {
    setHeaders: (res, path) => {
      // Set proper Content-Type for mcp-config file
      if (path.endsWith('mcp-config')) {
        res.setHeader('Content-Type', 'application/json');
      }
    }
  });
}

/**
 * Builds the MCP Server for one session (or, in stateless mode, one request).
 * The SDK connects a Server to a single transport at a time, so a shared Server
 * would serve exactly one session and fail every other initialize.
 */
export type ServerFactory = () => Server | Promise<Server>;

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  /** This session's own Server */
  server: Server;
}

export interface SessionMetadata extends McpSession {
  lastAccess: number;
}

/**
 * Ends one session: closes its transport and its Server. Process-wide proxy state
 * (downstream connections, rate limiters) is shared with other sessions and stays up.
 */
export async function closeSession(session: McpSession): Promise<void> {
  try {
    await session.transport.close();
  } finally {
    await session.server.close();
  }
}

/**
 * Drop sessions that have been idle longer than the TTL.
 * Live sessions are never evicted to make room for new ones.
 */
function evictExpiredSessions(sessions: Map<string, SessionMetadata>): void {
  const now = Date.now();
  for (const [sessionId, metadata] of sessions.entries()) {
    if (now - metadata.lastAccess > SESSION_TTL_MS) {
      closeSession(metadata).catch(() => {});
      sessions.delete(sessionId);
      debugLog(`Evicted expired session ${sessionId}`);
    }
  }
}

/**
 * Only a single initialize request opens a session; the SDK rejects batches that
 * mix initialize with other messages, so those must not allocate either.
 */
function isInitializationBody(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.length === 1 && isInitializeRequest(messages[0]);
}

function sendJsonRpcError(res: any, status: number, code: number, message: string): null {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
  return null;
}

/**
 * Resolves or creates the transport (and its Server) for the current request
 * Handles both stateful (session-based) and stateless modes
 *
 * Stateful mode follows the MCP Streamable HTTP session rules: the session ID is
 * generated here at initialize, an unknown Mcp-Session-Id gets 404, and nothing
 * but a POST initialize allocates a session. At MAX_SESSIONS, expired sessions are
 * reclaimed; if the pool is still full the request gets 503. Each session, and in
 * stateless mode each request, gets its own Server from createServer.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param createServer - Builds a fresh MCP Server for a new session/request
 * @param stateless - Whether to use stateless mode
 * @param sessions - Map of active sessions with metadata (for stateful mode)
 * @returns The session, or null when an error response has already been sent
 */
export async function resolveTransport(
  req: any,
  res: any,
  createServer: ServerFactory,
  stateless: boolean,
  sessions: Map<string, SessionMetadata>
): Promise<McpSession | null> {
  if (stateless) {
    // Create a new transport and Server for each request in stateless mode
    const server = await createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined // Disable session management in stateless mode
    });
    await server.connect(transport);
    return { transport, server };
  }

  // Use session-based transport management
  const requestedSessionId = req.headers['mcp-session-id'] as string | undefined;

  if (requestedSessionId) {
    const metadata = sessions.get(requestedSessionId);
    if (!metadata) {
      // Never adopt a client-chosen ID; 404 tells the client to re-initialize
      return sendJsonRpcError(res, 404, JSON_RPC_ERROR_CODES.APPLICATION_ERROR, 'Session not found');
    }
    // Only traffic that passed auth keeps a session alive; a public ping without
    // the key must not hold a session (and its Server) open indefinitely
    if (!res.locals?.unauthenticated) {
      metadata.lastAccess = Date.now();
    }
    return metadata;
  }

  if (req.method !== 'POST' || !isInitializationBody(req.body)) {
    return sendJsonRpcError(res, 400, JSON_RPC_ERROR_CODES.APPLICATION_ERROR,
      'Bad Request: No valid session ID provided');
  }

  if (sessions.size >= MAX_SESSIONS) {
    evictExpiredSessions(sessions);
    if (sessions.size >= MAX_SESSIONS) {
      res.setHeader('Retry-After', '60');
      return sendJsonRpcError(res, 503, JSON_RPC_ERROR_CODES.APPLICATION_ERROR,
        'Server is at its session limit, please retry later');
    }
  }

  // Create a new transport with a server-generated session ID
  const sessionId = randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessioninitialized: (id) => {
      debugLog(`Session initialized: ${id}`);
    }
  });

  // Register only after connect succeeds so a failed connect leaves nothing behind
  const server = await createServer();
  await server.connect(transport);
  const session: SessionMetadata = { transport, server, lastAccess: Date.now() };
  sessions.set(sessionId, session);

  // Set session ID in response header (title case per MCP spec)
  res.setHeader(MCP_SESSION_ID_HEADER, sessionId);

  return session;
}
