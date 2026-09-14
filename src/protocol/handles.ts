/**
 * Server-minted handles — the 2026-07-28 replacement for protocol sessions.
 *
 * The spec removed Mcp-Session-Id and the per-connection notion of state:
 * "Servers that need cross-call state use explicit, server-minted handles
 * passed as ordinary tool arguments." A handle is opaque to the client, so it
 * carries no routing meaning and any instance can serve any request as long as
 * the store is shared.
 *
 * This in-process implementation matches today's in-memory session Map. Making
 * it durable (Redis/Postgres) is a store swap behind the same interface, not a
 * protocol change — which is precisely the point of handles over sessions.
 */

import { randomBytes } from 'crypto';
import { MAX_SESSIONS, SESSION_TTL_MS } from '../constants.js';

export interface HandleStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Injectable clock; tests use it instead of fake timers. */
  now?: () => number;
}

interface Entry<T> {
  value: T;
  lastAccess: number;
}

export class HandleStore<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: HandleStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS;
    this.maxEntries = options.maxEntries ?? MAX_SESSIONS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  mint(value: T): string {
    if (this.entries.size >= this.maxEntries) {
      this.sweep();
      if (this.entries.size >= this.maxEntries) this.evictOldest();
    }
    // 24 base64url chars of CSPRNG output: opaque and unguessable.
    const handle = randomBytes(18).toString('base64url');
    this.entries.set(handle, { value, lastAccess: this.now() });
    return handle;
  }

  get(handle: string): T | undefined {
    const entry = this.entries.get(handle);
    if (!entry) return undefined;
    if (this.now() - entry.lastAccess > this.ttlMs) {
      this.entries.delete(handle);
      return undefined;
    }
    entry.lastAccess = this.now();
    return entry.value;
  }

  touch(handle: string): boolean {
    return this.get(handle) !== undefined;
  }

  delete(handle: string): boolean {
    return this.entries.delete(handle);
  }

  sweep(): number {
    const deadline = this.now() - this.ttlMs;
    let removed = 0;
    for (const [handle, entry] of this.entries) {
      if (entry.lastAccess < deadline) {
        this.entries.delete(handle);
        removed++;
      }
    }
    return removed;
  }

  private evictOldest(): void {
    let oldestHandle: string | undefined;
    let oldestAccess = Infinity;
    for (const [handle, entry] of this.entries) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestHandle = handle;
      }
    }
    if (oldestHandle) this.entries.delete(oldestHandle);
  }
}
