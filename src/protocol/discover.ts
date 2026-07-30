/**
 * server/discover — mandatory under MCP 2026-07-28.
 *
 * Clients MAY call this before any other request to pick a protocol version up
 * front, and use it as a backward-compatibility probe on STDIO. It therefore
 * must answer with no handshake, no session and no authentication.
 */

import { LATEST_REVISION, REVISIONS, type Revision } from './versions.js';
import type { Implementation } from './meta.js';

export interface DiscoverResult {
  resultType: 'complete';
  protocolVersions: readonly Revision[];
  capabilities: Record<string, unknown>;
  serverInfo: Implementation;
  extensions?: Record<string, unknown>;
}

export function isDiscoverRequest(body: unknown): boolean {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>).method === 'server/discover'
  );
}

export function buildDiscoverResult(
  info: Implementation,
  extensions?: Record<string, unknown>,
): DiscoverResult {
  // Newest first: clients pick the first entry they recognise.
  const protocolVersions = [...REVISIONS].reverse() as Revision[];
  if (protocolVersions[0] !== LATEST_REVISION) {
    throw new Error('Revision registry is not ordered oldest-first');
  }

  return {
    resultType: 'complete',
    protocolVersions,
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
      prompts: { listChanged: true },
    },
    serverInfo: info,
    ...(extensions ? { extensions } : {}),
  };
}
