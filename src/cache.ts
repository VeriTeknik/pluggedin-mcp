// src/cache.ts
export class Cache<T> {
  private cache: Map<string, {data: T, timestamp: number}> = new Map();
  private ttl: number; // Time-to-live in milliseconds

  constructor(ttlMs: number = 60000) { // Default 1 minute TTL
    this.ttl = ttlMs;
  }

  /**
   * Retrieves an item from the cache. Returns null if the item is not found or has expired.
   * @param key The cache key.
   * @returns The cached data or null.
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null; // Not found
    }

    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(key); // Expired
      return null;
    }

    return entry.data; // Found and valid
  }

  /**
   * Adds or updates an item in the cache.
   * @param key The cache key.
   * @param data The data to cache.
   */
  set(key: string, data: T): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Removes an item from the cache.
   * @param key The cache key to invalidate.
   */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Clears the entire cache.
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Gets the number of items currently in the cache (including potentially expired ones before next get).
   */
  size(): number {
    return this.cache.size;
  }
}
