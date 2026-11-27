import { ReadableRateLimitStore } from './rateLimitStore';

export class InMemoryRateLimitStore implements ReadableRateLimitStore {
  private hits = new Map<string, { count: number; resetAt: number }>();

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || now >= entry.resetAt) {
      const newEntry = { count: 1, resetAt: now + windowMs };
      this.hits.set(key, newEntry);
      return { ...newEntry };
    }

    entry.count += 1;
    return { ...entry };
  }

  async get(key: string): Promise<{ count: number; resetAt: number } | null> {
    const entry = this.hits.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.resetAt) {
      this.hits.delete(key);
      return null;
    }
    return { ...entry };
  }

  async reset(key: string): Promise<void> {
    this.hits.delete(key);
  }
}
