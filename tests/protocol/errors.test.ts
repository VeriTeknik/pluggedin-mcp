import { describe, expect, it } from 'vitest';
import { PROTOCOL_ERROR_CODES, ProtocolError } from '../../src/protocol/errors.js';
import { JSON_RPC_ERROR_CODES } from '../../src/constants.js';

describe('2026 error codes', () => {
  it('uses the renumbered spec-reserved codes', () => {
    expect(PROTOCOL_ERROR_CODES.HEADER_MISMATCH).toBe(-32020);
    expect(PROTOCOL_ERROR_CODES.MISSING_REQUIRED_CLIENT_CAPABILITY).toBe(-32021);
    expect(PROTOCOL_ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION).toBe(-32022);
  });

  it('maps resource-not-found onto Invalid Params per JSON-RPC alignment', () => {
    expect(PROTOCOL_ERROR_CODES.INVALID_PARAMS).toBe(-32602);
  });

  it('leaves grandfathered implementation-defined codes untouched', () => {
    expect(JSON_RPC_ERROR_CODES.UNAUTHORIZED).toBe(-32001);
    expect(JSON_RPC_ERROR_CODES.APPLICATION_ERROR).toBe(-32000);
  });

  it('serialises to a JSON-RPC error envelope', () => {
    const err = new ProtocolError(
      PROTOCOL_ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION,
      'Unsupported protocol version: 2030-01-01',
      { supported: ['2026-07-28'] },
    );
    expect(err.toJsonRpc(7)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32022,
        message: 'Unsupported protocol version: 2030-01-01',
        data: { supported: ['2026-07-28'] },
      },
    });
  });

  it('omits data when none was supplied', () => {
    const err = new ProtocolError(PROTOCOL_ERROR_CODES.HEADER_MISMATCH, 'Mcp-Method mismatch');
    expect(err.toJsonRpc(null)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32020, message: 'Mcp-Method mismatch' },
    });
  });
});
