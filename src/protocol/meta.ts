/**
 * Reserved _meta keys for MCP 2026-07-28.
 *
 * With the initialize handshake removed, per-request _meta is the only place
 * identity, version and capability information travels. These key strings are
 * normative — a typo silently degrades a modern client to legacy handling, so
 * they are declared exactly once, here.
 */

import { isRevision, type Revision } from './versions.js';

export const META_KEYS = Object.freeze({
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  logLevel: 'io.modelcontextprotocol/logLevel',
  subscriptionId: 'io.modelcontextprotocol/subscriptionId',
  traceparent: 'traceparent',
  tracestate: 'tracestate',
  baggage: 'baggage',
} as const);

export interface Implementation {
  name: string;
  version: string;
  title?: string;
}

function asRecord(meta: unknown): Record<string, unknown> | undefined {
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined;
}

export function readProtocolVersion(meta: unknown): Revision | undefined {
  const value = asRecord(meta)?.[META_KEYS.protocolVersion];
  return isRevision(value) ? value : undefined;
}

export function readClientInfo(meta: unknown): Implementation | undefined {
  const value = asRecord(asRecord(meta)?.[META_KEYS.clientInfo]);
  if (!value) return undefined;
  const { name, version, title } = value;
  if (typeof name !== 'string' || typeof version !== 'string') return undefined;
  return typeof title === 'string' ? { name, version, title } : { name, version };
}

export function readLogLevel(meta: unknown): string | undefined {
  const value = asRecord(meta)?.[META_KEYS.logLevel];
  return typeof value === 'string' ? value : undefined;
}

export function readTraceContext(meta: unknown): {
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
} {
  const record = asRecord(meta);
  const out: { traceparent?: string; tracestate?: string; baggage?: string } = {};
  if (!record) return out;
  for (const key of ['traceparent', 'tracestate', 'baggage'] as const) {
    const value = record[META_KEYS[key]];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export function writeServerInfo<T extends object>(result: T, info: Implementation): T {
  const target = result as T & { _meta?: Record<string, unknown> };
  target._meta = { ...(target._meta ?? {}), [META_KEYS.serverInfo]: info };
  return target;
}
