import { describe, expect, it } from 'vitest';
import {
  REVISIONS,
  LATEST_REVISION,
  isRevision,
  compareRevisions,
  atLeast,
  capabilitiesFor,
} from '../../src/protocol/versions.js';

describe('revision registry', () => {
  it('lists every published revision oldest-first', () => {
    expect(REVISIONS).toEqual([
      '2024-10-07',
      '2024-11-05',
      '2025-03-26',
      '2025-06-18',
      '2025-11-25',
      '2026-07-28',
    ]);
    expect(LATEST_REVISION).toBe('2026-07-28');
  });

  it('recognises only published revisions', () => {
    expect(isRevision('2026-07-28')).toBe(true);
    expect(isRevision('2027-01-01')).toBe(false);
    expect(isRevision(null)).toBe(false);
  });

  it('orders revisions chronologically', () => {
    expect(compareRevisions('2024-11-05', '2026-07-28')).toBeLessThan(0);
    expect(compareRevisions('2026-07-28', '2024-11-05')).toBeGreaterThan(0);
    expect(compareRevisions('2025-11-25', '2025-11-25')).toBe(0);
    expect(atLeast('2026-07-28', '2025-11-25')).toBe(true);
    expect(atLeast('2025-06-18', '2025-11-25')).toBe(false);
  });

  it('marks 2026-07-28 stateless and handshake-free', () => {
    const caps = capabilitiesFor('2026-07-28');
    expect(caps.stateless).toBe(true);
    expect(caps.requiresInitialize).toBe(false);
    expect(caps.hasServerDiscover).toBe(true);
    expect(caps.hasResultType).toBe(true);
    expect(caps.hasMrtr).toBe(true);
    expect(caps.hasCacheableResult).toBe(true);
    expect(caps.hasSubscriptionsListen).toBe(true);
    expect(caps.sessionHeader).toBe(false);
    expect(caps.serverInitiatedRequests).toBe(false);
    expect(caps.hasPing).toBe(false);
    expect(caps.hasLoggingSetLevel).toBe(false);
  });

  it('marks every pre-2026 revision stateful with server-initiated requests', () => {
    for (const rev of REVISIONS.filter((r) => r !== '2026-07-28')) {
      const caps = capabilitiesFor(rev);
      expect(caps.stateless, rev).toBe(false);
      expect(caps.requiresInitialize, rev).toBe(true);
      expect(caps.hasServerDiscover, rev).toBe(false);
      expect(caps.hasMrtr, rev).toBe(false);
      expect(caps.serverInitiatedRequests, rev).toBe(true);
      expect(caps.sessionHeader, rev).toBe(true);
      expect(caps.hasPing, rev).toBe(true);
    }
  });
});
