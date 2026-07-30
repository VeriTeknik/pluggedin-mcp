import { describe, expect, it } from 'vitest';
import {
  extractPassthroughHeaders,
  validateMcpHeaders,
} from '../../src/protocol/headers.js';
import { ProtocolError } from '../../src/protocol/errors.js';

const callBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'github_search' },
};

describe('Mcp-Method / Mcp-Name validation', () => {
  it('accepts headers that agree with the body', () => {
    expect(() =>
      validateMcpHeaders(
        callBody,
        { 'mcp-method': 'tools/call', 'mcp-name': 'github_search' },
        '2026-07-28',
      ),
    ).not.toThrow();
  });

  it('rejects a header that disagrees with the body method', () => {
    expect(() =>
      validateMcpHeaders(callBody, { 'mcp-method': 'tools/list' }, '2026-07-28'),
    ).toThrow(ProtocolError);
    try {
      validateMcpHeaders(callBody, { 'mcp-method': 'tools/list' }, '2026-07-28');
    } catch (e) {
      expect((e as ProtocolError).code).toBe(-32020);
    }
  });

  it('rejects a header that disagrees with the body name', () => {
    expect(() =>
      validateMcpHeaders(
        callBody,
        { 'mcp-method': 'tools/call', 'mcp-name': 'gitlab_search' },
        '2026-07-28',
      ),
    ).toThrow(ProtocolError);
  });

  it('tolerates absent headers rather than failing the request', () => {
    expect(() => validateMcpHeaders(callBody, {}, '2026-07-28')).not.toThrow();
  });

  it('is a no-op for pre-2026 revisions even on mismatch', () => {
    expect(() =>
      validateMcpHeaders(callBody, { 'mcp-method': 'tools/list' }, '2025-11-25'),
    ).not.toThrow();
  });
});

describe('x-mcp-header passthrough', () => {
  it('extracts prefixed arguments and strips the prefix', () => {
    expect(
      extractPassthroughHeaders({
        name: 'search',
        arguments: { 'x-mcp-header-X-Tenant': 'acme', query: 'q' },
      }),
    ).toEqual({ 'X-Tenant': 'acme' });
  });

  it('ignores non-string values', () => {
    expect(
      extractPassthroughHeaders({ arguments: { 'x-mcp-header-X-Count': 5 } }),
    ).toEqual({});
  });

  it('returns an empty object when there is nothing to extract', () => {
    expect(extractPassthroughHeaders({ arguments: { query: 'q' } })).toEqual({});
    expect(extractPassthroughHeaders(undefined)).toEqual({});
  });

  it('refuses to smuggle hop-by-hop or auth headers through tool arguments', () => {
    expect(
      extractPassthroughHeaders({
        arguments: {
          'x-mcp-header-Authorization': 'Bearer stolen',
          'x-mcp-header-Host': 'evil.example',
          'x-mcp-header-X-Safe': 'ok',
        },
      }),
    ).toEqual({ 'X-Safe': 'ok' });
  });
});
