/**
 * MCP Protocol Constants
 *
 * These constants define the MCP protocol version and header names
 * to ensure consistency across the codebase and prevent typos.
 */

import { LATEST_REVISION, REVISIONS } from './protocol/versions.js';

/**
 * Supported MCP protocol revisions.
 *
 * Sourced from ./protocol/versions.ts, NOT from the SDK. As of SDK 1.30.0 the
 * bundled SDK tops out at 2025-11-25 while this proxy also speaks 2026-07-28
 * via the hand-rolled bridge in ./protocol/. Deriving from the SDK would both
 * hide 2026-07-28 today and silently start advertising it — handshake and all —
 * the moment the SDK bumps.
 *
 * Note the previous comment here was right that hardcoding a SUBSET broke
 * clients negotiating 2025-11-25. The registry is a superset of what the SDK
 * speaks, so that regression cannot recur.
 *
 * @see https://modelcontextprotocol.io/specification
 */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = REVISIONS;

/**
 * Newest revision this proxy advertises. Sent in response headers.
 */
export const MCP_PROTOCOL_VERSION = LATEST_REVISION;

/**
 * HTTP header names for MCP protocol
 * Headers use Title-Case per MCP specification
 */
export const MCP_SESSION_ID_HEADER = 'Mcp-Session-Id';
export const MCP_PROTOCOL_VERSION_HEADER = 'Mcp-Protocol-Version';

/**
 * Port configuration constants
 */
export const MIN_PORT = 1;
export const MAX_PORT = 65535;
export const DEFAULT_PORT = 8081; // Match Smithery/Docker port expectations

/**
 * Session management constants
 */
export const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
export const MAX_SESSIONS = 10000; // Maximum concurrent sessions

/**
 * Legacy JSON-RPC error codes. These sit in the implementation-defined
 * -32000..-32019 partition and are grandfathered by the 2026-07-28 error-code
 * allocation policy — do NOT renumber them.
 *
 * Spec-reserved codes (-32020 and below) live in ./protocol/errors.ts.
 *
 * @see https://www.jsonrpc.org/specification
 */
export const JSON_RPC_ERROR_CODES = {
  /** Invalid Request - malformed request, unsupported protocol version */
  INVALID_REQUEST: -32600,
  /** Method not found - HTTP method not allowed */
  METHOD_NOT_FOUND: -32601,
  /** Internal error - server-side exception */
  INTERNAL_ERROR: -32603,
  /** Server error - Unauthorized (auth failure) */
  UNAUTHORIZED: -32001,
  /** Server error - Generic application error (session not found, etc.) */
  APPLICATION_ERROR: -32000,
} as const;
