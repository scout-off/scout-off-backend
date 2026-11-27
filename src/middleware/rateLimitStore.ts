export interface RateLimitStore {
  /**
   * Increment the counter for the given key and return the new count and reset time.
   * @param key The key to increment
   * @param windowMs The time window in milliseconds
   * @returns An object with the current count and the reset timestamp (in milliseconds since epoch)
   */
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

/**
 * A store that can also read and clear a counter without mutating it. Needed
 * by the auth-failure lockout, which must check state without incrementing.
 */
export interface ReadableRateLimitStore extends RateLimitStore {
  /** Current count and reset time, or null when the key is absent or expired. */
  get(key: string): Promise<{ count: number; resetAt: number } | null>;
  /** Remove the counter so the next increment starts a fresh window. */
  reset(key: string): Promise<void>;
}
