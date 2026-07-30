import { describe, expect, it } from 'vitest';
import { HandleStore } from '../../src/protocol/handles.js';

describe('server-minted handles', () => {
  it('mints opaque, unguessable, unique handles', () => {
    const store = new HandleStore<number>();
    const a = store.mint(1);
    const b = store.mint(2);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(store.get(a)).toBe(1);
    expect(store.get(b)).toBe(2);
  });

  it('returns undefined for an unknown handle', () => {
    expect(new HandleStore<number>().get('nope')).toBeUndefined();
  });

  it('expires handles past their TTL', () => {
    let clock = 1_000;
    const store = new HandleStore<string>({ ttlMs: 100, now: () => clock });
    const handle = store.mint('state');
    clock = 1_050;
    expect(store.get(handle)).toBe('state');
    clock = 1_200;
    expect(store.get(handle)).toBeUndefined();
  });

  it('extends the deadline on access', () => {
    let clock = 0;
    const store = new HandleStore<string>({ ttlMs: 100, now: () => clock });
    const handle = store.mint('state');
    clock = 90;
    expect(store.get(handle)).toBe('state');
    clock = 170;
    expect(store.get(handle)).toBe('state');
  });

  it('evicts the least recently used entry at capacity', () => {
    let clock = 0;
    const store = new HandleStore<string>({ maxEntries: 2, now: () => clock });
    const first = store.mint('a');
    clock = 1;
    const second = store.mint('b');
    clock = 2;
    store.get(first);
    clock = 3;
    const third = store.mint('c');
    expect(store.size).toBe(2);
    expect(store.get(second)).toBeUndefined();
    expect(store.get(first)).toBe('a');
    expect(store.get(third)).toBe('c');
  });

  it('sweeps expired entries and reports the count', () => {
    let clock = 0;
    const store = new HandleStore<string>({ ttlMs: 10, now: () => clock });
    store.mint('a');
    store.mint('b');
    clock = 100;
    expect(store.sweep()).toBe(2);
    expect(store.size).toBe(0);
  });

  it('deletes a handle explicitly', () => {
    const store = new HandleStore<string>();
    const handle = store.mint('a');
    expect(store.delete(handle)).toBe(true);
    expect(store.delete(handle)).toBe(false);
    expect(store.get(handle)).toBeUndefined();
  });
});
