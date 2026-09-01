export interface RateLimitStore {
  /**
   * Increment the counter for the given key and return the new count and reset time.
   * @param key The key to increment
   * @param windowMs The time window in milliseconds
   * @returns An object with the current count and the reset timestamp (in milliseconds since epoch)
   */
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}
