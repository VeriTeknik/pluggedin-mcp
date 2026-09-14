import { describe, expect, it } from 'vitest';
import { detectRevision } from '../../src/protocol/detect.js';
import { ProtocolError } from '../../src/protocol/errors.js';

const noHeaders = {};

describe('inbound revision detection', () => {
  it('detects 2026 from body _meta with no handshake and no session', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
    };
    expect(detectRevision(body, noHeaders)).toEqual({
      revision: '2026-07-28',
      source: 'meta',
    });
  });

  it('detects a legacy revision from the initialize handshake', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {} },
    };
    expect(detectRevision(body, noHeaders)).toEqual({
      revision: '2024-11-05',
      source: 'initialize',
    });
  });

  it('prefers body _meta over a stale header', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    };
    const headers = { 'mcp-protocol-version': '2024-11-05' };
    expect(detectRevision(body, headers).revision).toBe('2026-07-28');
  });

  it('falls back to the Mcp-Protocol-Version header', () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect(detectRevision(body, { 'mcp-protocol-version': '2025-06-18' })).toEqual({
      revision: '2025-06-18',
      source: 'header',
    });
  });

  it('treats a bare session header as a legacy client', () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect(detectRevision(body, { 'mcp-session-id': 'abc' })).toEqual({
      revision: '2025-11-25',
      source: 'session',
    });
  });

  it('defaults to the newest SDK-speakable revision when nothing is stated', () => {
    expect(detectRevision({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, noHeaders)).toEqual({
      revision: '2025-11-25',
      source: 'default',
    });
  });

  it('rejects an explicitly stated unknown revision', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2030-01-01' } },
    };
    expect(() => detectRevision(body, noHeaders)).toThrow(ProtocolError);
    try {
      detectRevision(body, noHeaders);
    } catch (e) {
      expect((e as ProtocolError).code).toBe(-32022);
    }
  });

  it('handles a batch body by reading the first element', () => {
    const body = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
      },
    ];
    expect(detectRevision(body, noHeaders).revision).toBe('2026-07-28');
  });
});
