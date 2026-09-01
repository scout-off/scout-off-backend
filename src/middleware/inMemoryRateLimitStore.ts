import { RateLimitStore } from './rateLimitStore';

export class InMemoryRateLimitStore implements RateLimitStore {
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
}
