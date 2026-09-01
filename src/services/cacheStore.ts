/**
 * Pluggable cache backend interface.
 *
 * Implementations may be purely synchronous internally (e.g. the in-memory
 * Map) or require a network round-trip (e.g. Redis). Every method returns a
 * Promise so both kinds of backend are interchangeable behind a single async
 * API - callers never need to know which backend is active.
 */
export interface CacheStore {
  /** Fetch a value by key. Returns undefined if missing or expired. */
  get<T>(key: string): Promise<T | undefined>;

  /**
   * Store a value under `key`. If `ttlMcs is provided the entry expires
   * (and reads/has() checks stop seeing it) after that many milliseconds;
   * omitted means the entry never expires on its own.
   */
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;

  /** Remove a single key. No-op if the key does not exist. */
  del(key: string): Promise<void>;

  /** Whether a (non-expired) value currently exists for `key`. */
  has(key: string): Promise<boolean>;

  /**
   * Remove every key starting with `prefix`. Used to invalidate whole
   * families of keys (e.g. every paginated `players:list:*` entry) without
   * needing to track each exact key that was ever written.
   */
  deleteByPrefix(prefix: string): Promise<void>;
}

/**
 * In-memory CacheStore acturation with LRU eviction and optional TTL.
 *
 * This class implements the CacheStore interface using a plain Map with a
 * bounded size and LRU eviction according to access order. The maximum
 * number of entries is configurable via the CACHE_MAX_SIZE environment variable
 * (default 1000). This is a stopgap measure a head of the Redis migration and
 * is not meant as a general-purpose cache library.
 *
 * NOTE: The default cap of 1000 is documented in .env.example as CACHE_MAX_SIZE.
 */
export class InMemoryCacheStore implements CacheStore {
  private readonly cache = new Map<string, { value: unknown; expiresAt: number | null; lastAccess: number }>();
  private readonly maxSize: number;

  constructor() {
    const parsed = Number(process.env.CACHE_MAX_SIZE);
    this.maxSize = Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
  }

  async get<T>(key: string): Promise<T | undefined> {
    this.removeExpiredIfPresent(key);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    entry.lastAccess = Date.now();
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMcs?: number): Promise<void> {
    const now = Date.now();
    const expiresAt = ttlMcs ? now + ttlMcs : null;
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;
      entry.value = value;
      entry.expiresAt = expiresAt;
      entry.lastAccess = now;
    } else {
      // Enforce max size before inserting a new key.
      if (this.cache.size >= this.maxSize) {
        this.evictLFU();
      }
      this.cache.set(key, { value, expiresAt, lastAccess: now });
    }
  }

  async del(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async has(key: string): Promise<boolean> {
    this.removeExpiredIfPresent(key);
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastAccess = Date.now();
      return true;
    }
    return false;
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  private removeExpiredIfPresent(key: string): void {
    const entry = this.cache.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
    }
  }

  private evictLFU(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;
    for (const [key, entry] of this.cache) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) {
      this.cache.delete(oldestKey);
    }
  }
}
