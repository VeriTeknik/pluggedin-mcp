import { describe, expect, it } from 'vitest';
import {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
} from '../../src/constants.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

describe('protocol negotiation surface', () => {
  it('advertises 2026-07-28 regardless of what the bundled SDK tops out at', () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2026-07-28');
  });

  // TRIPWIRE — deliberately fails when a future SDK ships 2026-07-28. That is
  // the signal to re-evaluate whether the hand-rolled protocol layer can defer
  // to the SDK. Replace it then; do not delete it now.
  it('is decoupled from the SDK, which still lags the spec', () => {
    expect(LATEST_PROTOCOL_VERSION).not.toBe(MCP_PROTOCOL_VERSION);
  });

  it('still accepts every legacy revision the SDK can speak', () => {
    for (const legacy of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
      expect(SUPPORTED_MCP_PROTOCOL_VERSIONS).toContain(legacy);
    }
  });
});
