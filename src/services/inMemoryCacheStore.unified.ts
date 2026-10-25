/**
 * Unified bounded, TTL-aware, LRU in-memory CacheStore implementation.
 *
 * This is the single source of truth for in-memory caching in the application.
 * It consolidates three previous implementations (InMemoryCacheStore in cacheStore.ts,
 * InMemoryCacheStore in inMemoryCacheStore.ts, and BoundedInMemoryCacheStore in cache.ts)
 * into one cohesive design.
 *
 * Features:
 *   - LRU eviction tracking entry access order (Map insertion order)
 *   - TTL-based expiry checked on get/has/set
 *   - Configurable max entry count via CACHE_MAX_ENTRIES (default: 1000)
 *   - Prefix-based deletion (deleteByPrefix) for invalidating cache families
 *   - Async interface for compatibility with Redis backend
 *   - Metrics hooks for eviction tracking
 *
 * Eviction strategy:
 *   When the store exceeds maxSize after a set(), the oldest (least recently used)
 *   entry is removed. Access order is maintained via Map iteration order.
 *
 * TTL semantics:
 *   - Entries are lazily expired on access (get/has)
 *   - set() without ttlMs creates entries that never expire on their own
 *   - Expired entries are removed from memory when accessed
 */

import { CacheStore } from './cacheStore';
import { recordCacheEviction } from '../middleware/metrics';

interface CacheEntry {
  value: unknown;
  expiresAt?: number; // undefined = never expires
}

const DEFAULT_MAX_ENTRIES = 1000;

function resolveMaxEntries(explicit?: number): number {
  if (explicit !== undefined && explicit > 0) return explicit;
  const fromEnv = Number(process.env.CACHE_MAX_ENTRIES);
  return fromEnv > 0 ? fromEnv : DEFAULT_MAX_ENTRIES;
}

export class InMemoryCacheStore implements CacheStore {
  private readonly store = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries?: number) {
    this.maxEntries = resolveMaxEntries(maxEntries);
  }

  /**
   * Check if an entry exists and is not expired.
   */
  private isValidEntry(entry: CacheEntry): boolean {
    if (entry.expiresAt === undefined) return true;
    return entry.expiresAt > Date.now();
  }

  /**
   * Move an entry to the end of the Map (mark as recently used for LRU).
   */
  private touch(key: string): void {
    const entry = this.store.get(key);
    if (entry !== undefined) {
      this.store.delete(key);
      this.store.set(key, entry);
    }
  }

  /**
   * Remove expired entry from storage if it exists.
   */
  private removeExpired(key: string): void {
    const entry = this.store.get(key);
    if (entry && !this.isValidEntry(entry)) {
      this.store.delete(key);
      recordCacheEviction();
    }
  }

  /**
   * Evict the oldest (least recently used) entry if over capacity.
   */
  private evictLRUIfNeeded(): void {
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
      recordCacheEviction();
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    this.removeExpired(key);
    const entry = this.store.get(key);
    if (!entry) return undefined;
    this.touch(key);
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : undefined;
    const entry: CacheEntry = { value, expiresAt };

    // Remove old entry to maintain insert-order Map semantics
    if (this.store.has(key)) {
      this.store.delete(key);
    }

    this.store.set(key, entry);
    this.evictLRUIfNeeded();
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    this.removeExpired(key);
    const exists = this.store.has(key);
    if (exists) {
      this.touch(key);
      return true;
    }
    return false;
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }
}
