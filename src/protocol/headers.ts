/**
 * Standard MCP request headers (SEP-2243).
 *
 * Mcp-Method and Mcp-Name let an L7 load balancer route and rate-limit without
 * parsing the JSON-RPC body — a precondition for treating MCP as an ordinary
 * HTTP workload. Because they duplicate body content they can disagree with it,
 * so a mismatch is a hard error (-32020) rather than a silently-preferred value.
 *
 * x-mcp-header-* tool arguments let a tool author forward a header to the
 * upstream API. That is an SSRF-adjacent capability: the denylist below stops a
 * tool argument from overriding transport identity or borrowing the proxy's
 * credentials.
 */

import { PROTOCOL_ERROR_CODES, ProtocolError } from './errors.js';
import { capabilitiesFor, type Revision } from './versions.js';

const PASSTHROUGH_PREFIX = 'x-mcp-header-';

/**
 * Headers a tool argument may never set: authentication material, transport
 * identity, and hop-by-hop controls.
 */
const FORBIDDEN_PASSTHROUGH = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'host',
  'connection',
  'upgrade',
  'transfer-encoding',
  'content-length',
  'te',
  'trailer',
  'keep-alive',
  'mcp-session-id',
  'mcp-protocol-version',
  'mcp-method',
  'mcp-name',
]);

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function validateMcpHeaders(
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
  revision: Revision,
): void {
  // These headers only exist from 2026-07-28 onward; on a legacy request any
  // value present is noise from an intermediary, not a contract.
  if (!capabilitiesFor(revision).hasResultType) return;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;

  const message = body as Record<string, any>;

  const declaredMethod = headerValue(headers, 'mcp-method');
  if (declaredMethod !== undefined && declaredMethod !== message.method) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODES.HEADER_MISMATCH,
      `Mcp-Method header "${declaredMethod}" does not match body method "${message.method}"`,
    );
  }

  const declaredName = headerValue(headers, 'mcp-name');
  const bodyName = message.params?.name;
  if (declaredName !== undefined && bodyName !== undefined && declaredName !== bodyName) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODES.HEADER_MISMATCH,
      `Mcp-Name header "${declaredName}" does not match body params.name "${bodyName}"`,
    );
  }
}

export function extractPassthroughHeaders(params: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!params || typeof params !== 'object') return out;

  const args = (params as Record<string, any>).arguments;
  if (!args || typeof args !== 'object') return out;

  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (!key.startsWith(PASSTHROUGH_PREFIX)) continue;
    if (typeof value !== 'string') continue;
    const headerName = key.slice(PASSTHROUGH_PREFIX.length);
    if (FORBIDDEN_PASSTHROUGH.has(headerName.toLowerCase())) continue;
    out[headerName] = value;
  }
  return out;
}
