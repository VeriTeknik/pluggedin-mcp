import { describe, expect, it } from 'vitest';
import {
  CACHEABLE_METHODS,
  decorateCacheable,
  hubCachePolicy,
  isCacheableMethod,
  mergedCachePolicy,
  narrowestScope,
  shortestTtl,
  sortToolsDeterministically,
} from '../../src/protocol/cache.js';

describe('CacheableResult', () => {
  it('covers exactly the five methods the spec requires', () => {
    expect([...CACHEABLE_METHODS].sort()).toEqual([
      'prompts/list',
      'resources/list',
      'resources/read',
      'resources/templates/list',
      'tools/list',
    ]);
    expect(isCacheableMethod('tools/list')).toBe(true);
    expect(isCacheableMethod('tools/call')).toBe(false);
  });

  it('adds ttlMs and cacheScope without disturbing the payload', () => {
    const decorated = decorateCacheable(
      { tools: [{ name: 'a' }], resultType: 'complete' as const },
      { ttlMs: 60_000, cacheScope: 'public' },
    );
    expect(decorated.ttlMs).toBe(60_000);
    expect(decorated.cacheScope).toBe('public');
    expect(decorated.tools).toEqual([{ name: 'a' }]);
    expect(decorated.resultType).toBe('complete');
  });
});

describe('merged-result guarantees', () => {
  it('degrades to private if any contributor is private', () => {
    expect(narrowestScope(['public', 'public'])).toBe('public');
    expect(narrowestScope(['public', 'private'])).toBe('private');
    expect(narrowestScope([])).toBe('private');
  });

  it('takes the shortest contributing TTL', () => {
    expect(shortestTtl([60_000, 5_000, 30_000])).toBe(5_000);
    expect(shortestTtl([])).toBe(0);
  });

  it('combines both rules for a downstream-merged list', () => {
    expect(
      mergedCachePolicy([
        { ttlMs: 60_000, cacheScope: 'public' },
        { ttlMs: 5_000, cacheScope: 'public' },
      ]),
    ).toEqual({ ttlMs: 5_000, cacheScope: 'public' });

    expect(
      mergedCachePolicy([
        { ttlMs: 60_000, cacheScope: 'public' },
        { ttlMs: 90_000, cacheScope: 'private' },
      ]),
    ).toEqual({ ttlMs: 60_000, cacheScope: 'private' });
  });

  it('treats a merge with no contributors as uncacheable', () => {
    expect(mergedCachePolicy([])).toEqual({ ttlMs: 0, cacheScope: 'private' });
  });
});

describe('hub-generated lists', () => {
  it('is public regardless of downstream scopes, because no downstream content is present', () => {
    expect(hubCachePolicy(600_000)).toEqual({ ttlMs: 600_000, cacheScope: 'public' });
  });

  it('rejects a negative TTL rather than emitting a nonsensical hint', () => {
    expect(() => hubCachePolicy(-1)).toThrow(/ttlMs/i);
  });
});

describe('deterministic tool ordering', () => {
  it('sorts by name so repeated list calls hash identically', () => {
    const tools = [{ name: 'zulu' }, { name: 'alpha' }, { name: 'mike' }];
    expect(sortToolsDeterministically(tools).map((t) => t.name)).toEqual([
      'alpha',
      'mike',
      'zulu',
    ]);
  });

  it('is stable across shuffles of the same set', () => {
    const a = sortToolsDeterministically([{ name: 'b' }, { name: 'a' }, { name: 'c' }]);
    const b = sortToolsDeterministically([{ name: 'c' }, { name: 'b' }, { name: 'a' }]);
    expect(a).toEqual(b);
  });

  it('orders UUID-prefixed aggregated names by codepoint, not locale', () => {
    const tools = [{ name: 'B_tool' }, { name: 'a_tool' }, { name: 'A_tool' }];
    expect(sortToolsDeterministically(tools).map((t) => t.name)).toEqual([
      'A_tool',
      'B_tool',
      'a_tool',
    ]);
  });

  it('does not mutate its input', () => {
    const tools = [{ name: 'b' }, { name: 'a' }];
    sortToolsDeterministically(tools);
    expect(tools.map((t) => t.name)).toEqual(['b', 'a']);
  });
});
