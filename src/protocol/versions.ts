/**
 * MCP revision registry — the single source of truth for protocol-version
 * behaviour across the proxy.
 *
 * No other module may contain a revision string literal. When a new revision
 * ships, it is added here and nowhere else.
 *
 * Deliberately NOT derived from the SDK's SUPPORTED_PROTOCOL_VERSIONS: as of
 * SDK 1.30.0 the SDK tops out at 2025-11-25, and the proxy needs to speak
 * 2026-07-28 before the SDK does.
 */

export type Revision =
  | '2024-10-07'
  | '2024-11-05'
  | '2025-03-26'
  | '2025-06-18'
  | '2025-11-25'
  | '2026-07-28';

export const REVISIONS: readonly Revision[] = [
  '2024-10-07',
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
  '2026-07-28',
] as const;

export const LATEST_REVISION: Revision = '2026-07-28';

export function isRevision(v: unknown): v is Revision {
  return typeof v === 'string' && (REVISIONS as readonly string[]).includes(v);
}

export function compareRevisions(a: Revision, b: Revision): number {
  return REVISIONS.indexOf(a) - REVISIONS.indexOf(b);
}

export function atLeast(v: Revision, floor: Revision): boolean {
  return compareRevisions(v, floor) >= 0;
}

export interface RevisionCapabilities {
  /** No protocol-level session; every request self-describes. */
  stateless: boolean;
  /** Requires the initialize/notifications/initialized handshake. */
  requiresInitialize: boolean;
  /** Implements the server/discover RPC. */
  hasServerDiscover: boolean;
  /** Results carry a required resultType discriminator. */
  hasResultType: boolean;
  /** Uses Multi Round-Trip Requests instead of server-initiated requests. */
  hasMrtr: boolean;
  /** List/read results carry ttlMs + cacheScope. */
  hasCacheableResult: boolean;
  /** Uses subscriptions/listen rather than HTTP GET + resources/subscribe. */
  hasSubscriptionsListen: boolean;
  /** Uses the Mcp-Session-Id header. */
  sessionHeader: boolean;
  /** Server may originate sampling/elicitation/roots requests. */
  serverInitiatedRequests: boolean;
  /** Supports the ping method. */
  hasPing: boolean;
  /** Supports logging/setLevel (vs per-request _meta logLevel). */
  hasLoggingSetLevel: boolean;
}

const MODERN: RevisionCapabilities = {
  stateless: true,
  requiresInitialize: false,
  hasServerDiscover: true,
  hasResultType: true,
  hasMrtr: true,
  hasCacheableResult: true,
  hasSubscriptionsListen: true,
  sessionHeader: false,
  serverInitiatedRequests: false,
  hasPing: false,
  hasLoggingSetLevel: false,
};

const LEGACY: RevisionCapabilities = {
  stateless: false,
  requiresInitialize: true,
  hasServerDiscover: false,
  hasResultType: false,
  hasMrtr: false,
  hasCacheableResult: false,
  hasSubscriptionsListen: false,
  sessionHeader: true,
  serverInitiatedRequests: true,
  hasPing: true,
  hasLoggingSetLevel: true,
};

export function capabilitiesFor(v: Revision): RevisionCapabilities {
  return v === '2026-07-28' ? { ...MODERN } : { ...LEGACY };
}
