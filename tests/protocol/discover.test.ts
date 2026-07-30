import { describe, expect, it } from 'vitest';
import { buildDiscoverResult, isDiscoverRequest } from '../../src/protocol/discover.js';

const info = { name: 'pluggedin-mcp', version: '2.3.0' };

describe('server/discover', () => {
  it('recognises the discover request', () => {
    expect(isDiscoverRequest({ jsonrpc: '2.0', id: 1, method: 'server/discover' })).toBe(true);
    expect(isDiscoverRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe(false);
    expect(isDiscoverRequest(null)).toBe(false);
  });

  it('advertises every revision the proxy bridges, newest first', () => {
    const result = buildDiscoverResult(info);
    expect(result.protocolVersions[0]).toBe('2026-07-28');
    expect(result.protocolVersions).toContain('2024-11-05');
    expect(result.protocolVersions).toHaveLength(6);
  });

  it('is a complete result carrying server identity', () => {
    const result = buildDiscoverResult(info);
    expect(result.resultType).toBe('complete');
    expect(result.serverInfo).toEqual(info);
  });

  it('declares the aggregation capabilities the hub actually implements', () => {
    const result = buildDiscoverResult(info);
    expect(result.capabilities.tools).toEqual({ listChanged: true });
    expect(result.capabilities.resources).toEqual({ listChanged: true, subscribe: true });
    expect(result.capabilities.prompts).toEqual({ listChanged: true });
  });

  it('passes declared extensions through', () => {
    const result = buildDiscoverResult(info, { 'io.modelcontextprotocol/tasks': {} });
    expect(result.extensions).toEqual({ 'io.modelcontextprotocol/tasks': {} });
  });

  it('omits the extensions field when none are declared', () => {
    expect(buildDiscoverResult(info).extensions).toBeUndefined();
  });
});
