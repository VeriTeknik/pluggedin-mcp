/**
 * MCP Protocol Constants
 *
 * These constants define the MCP protocol version and header names
 * to ensure consistency across the codebase and prevent typos.
 */

import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Supported MCP protocol versions (for backward compatibility).
 *
 * Derived from the bundled @modelcontextprotocol/sdk so that the proxy always
 * accepts exactly the revisions its SDK can actually speak. Hardcoding a subset
 * caused current clients (e.g. negotiating 2025-11-25) to be rejected with a
 * 400 even though the SDK fully supported them. Bumping the SDK now updates
 * negotiation automatically.
 *
 * @see https://modelcontextprotocol.io/specification
 */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = SUPPORTED_PROTOCOL_VERSIONS;

/**
 * Current MCP protocol version (latest supported by the bundled SDK).
 * Used in response headers to indicate server capabilities.
 * @see https://modelcontextprotocol.io/specification
 */
export const MCP_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;

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
