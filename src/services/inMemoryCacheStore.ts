import { CacheStore } from './cacheStore';
import { recordCacheEviction } from '../middleware/metrics';

interface Entry {
  value: unknown;
  expiresAt?: number;
}

const DEFAULT_MAX_SIZE = 1000;

function resolveMaxSize(explicit?: number): number {
  if (explicit !== undefined && explicit > 0) return explicit;
  const fromEnv = Number(process.env.CACHE_MAX_ENTRIES);
  return fromEnv > 0 ? fromEnv : DEFAULT_MAX_SIZE;
}

export class InMemoryCacheStore implements CacheStore {
  private store = new Map<string, Entry>();
  private readonly maxSize: number;

  constructor(maxSize?: number) {
    this.maxSize = resolveMaxSize(maxSize);
  }

  private isExpired(entry: Entry): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
  }

  private evictIfNeeded(): void {
    if (this.store.size > this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
        recordCacheEviction();
      }
    }
  }

  private touch(key: string): void {
    const entry = this.store.get(key);
    if (entry) {
      this.store.delete(key);
      this.store.set(key, entry);
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      recordCacheEviction();
      return undefined;
    }
    this.touch(key);
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const entry: Entry = {
      value,
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined,
    };
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, entry);
    this.evictIfNeeded();
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return false;
    }
    this.touch(key);
    return true;
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}
