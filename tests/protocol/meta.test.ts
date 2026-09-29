import { describe, expect, it } from 'vitest';
import {
  META_KEYS,
  readProtocolVersion,
  readClientInfo,
  readLogLevel,
  readTraceContext,
  writeServerInfo,
} from '../../src/protocol/meta.js';

describe('reserved _meta keys', () => {
  it('uses the exact spec key strings', () => {
    expect(META_KEYS.protocolVersion).toBe('io.modelcontextprotocol/protocolVersion');
    expect(META_KEYS.clientCapabilities).toBe('io.modelcontextprotocol/clientCapabilities');
    expect(META_KEYS.clientInfo).toBe('io.modelcontextprotocol/clientInfo');
    expect(META_KEYS.serverInfo).toBe('io.modelcontextprotocol/serverInfo');
    expect(META_KEYS.logLevel).toBe('io.modelcontextprotocol/logLevel');
    expect(META_KEYS.subscriptionId).toBe('io.modelcontextprotocol/subscriptionId');
    expect(META_KEYS.traceparent).toBe('traceparent');
  });

  it('reads a valid protocol version and rejects an invalid one', () => {
    expect(readProtocolVersion({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }))
      .toBe('2026-07-28');
    expect(readProtocolVersion({ 'io.modelcontextprotocol/protocolVersion': '2030-01-01' }))
      .toBeUndefined();
    expect(readProtocolVersion(undefined)).toBeUndefined();
    expect(readProtocolVersion('not an object')).toBeUndefined();
  });

  it('reads clientInfo only when name and version are strings', () => {
    expect(readClientInfo({ 'io.modelcontextprotocol/clientInfo': { name: 'claude', version: '1.2' } }))
      .toEqual({ name: 'claude', version: '1.2' });
    expect(readClientInfo({ 'io.modelcontextprotocol/clientInfo': { name: 'claude' } }))
      .toBeUndefined();
  });

  it('reads the per-request log level', () => {
    expect(readLogLevel({ 'io.modelcontextprotocol/logLevel': 'debug' })).toBe('debug');
    expect(readLogLevel({})).toBeUndefined();
  });

  it('extracts only the OpenTelemetry keys that are present', () => {
    expect(readTraceContext({ traceparent: '00-abc-def-01', baggage: 'k=v' }))
      .toEqual({ traceparent: '00-abc-def-01', baggage: 'k=v' });
    expect(readTraceContext({})).toEqual({});
  });

  it('writes serverInfo into a result without clobbering existing _meta', () => {
    const result = { resultType: 'complete', _meta: { existing: 1 } } as Record<string, any>;
    const out = writeServerInfo(result, { name: 'pluggedin-mcp', version: '2.3.0' });
    expect(out._meta.existing).toBe(1);
    expect(out._meta['io.modelcontextprotocol/serverInfo'])
      .toEqual({ name: 'pluggedin-mcp', version: '2.3.0' });
  });
});
