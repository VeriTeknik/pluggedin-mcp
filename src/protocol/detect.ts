/**
 * Infers which MCP revision an inbound request speaks.
 *
 * This is the hinge of the whole bridge. A 2026-07-28 client sends no
 * initialize and no Mcp-Session-Id — it posts a plain method call carrying its
 * revision in params._meta. A pre-2026 client either opens with initialize or
 * carries a session header. Both hit the same endpoint, so detection must be
 * unambiguous and must never upgrade a legacy client by accident.
 */

import { isRevision, REVISIONS, type Revision } from './versions.js';
import { readProtocolVersion } from './meta.js';
import { PROTOCOL_ERROR_CODES, ProtocolError } from './errors.js';

/** Newest revision any released SDK client can actually speak (SDK 1.30.0). */
const LEGACY_DEFAULT: Revision = '2025-11-25';

export interface DetectedRevision {
  revision: Revision;
  source: 'meta' | 'initialize' | 'header' | 'session' | 'default';
}

function firstMessage(body: unknown): Record<string, any> | undefined {
  const message = Array.isArray(body) ? body[0] : body;
  return message && typeof message === 'object' ? (message as Record<string, any>) : undefined;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function unsupported(value: string): ProtocolError {
  return new ProtocolError(
    PROTOCOL_ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION,
    `Unsupported MCP protocol version: ${value}`,
    { supported: REVISIONS },
  );
}

export function detectRevision(
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
): DetectedRevision {
  const message = firstMessage(body);

  // 1. Self-describing 2026-style request.
  const rawMeta = message?.params?._meta;
  if (rawMeta && typeof rawMeta === 'object') {
    const stated = (rawMeta as Record<string, unknown>)[
      'io.modelcontextprotocol/protocolVersion'
    ];
    if (stated !== undefined) {
      const revision = readProtocolVersion(rawMeta);
      if (!revision) throw unsupported(String(stated));
      return { revision, source: 'meta' };
    }
  }

  // 2. Legacy initialize handshake.
  if (message?.method === 'initialize') {
    const stated = message.params?.protocolVersion;
    if (stated !== undefined) {
      if (!isRevision(stated)) throw unsupported(String(stated));
      return { revision: stated, source: 'initialize' };
    }
  }

  // 3. Explicit transport header.
  const headerRevision = headerValue(headers, 'mcp-protocol-version');
  if (headerRevision !== undefined) {
    if (!isRevision(headerRevision)) throw unsupported(headerRevision);
    return { revision: headerRevision, source: 'header' };
  }

  // 4. A session header can only come from a pre-2026 client.
  if (headerValue(headers, 'mcp-session-id') !== undefined) {
    return { revision: LEGACY_DEFAULT, source: 'session' };
  }

  // 5. Nothing stated. Assume the newest revision a released SDK speaks —
  //    never 2026-07-28, which would hand a legacy client stateless semantics.
  return { revision: LEGACY_DEFAULT, source: 'default' };
}
