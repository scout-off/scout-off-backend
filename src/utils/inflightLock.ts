import config from '../config';

interface InFlightRequest<T> {
  promise: Promise<T>;
  timestamp: number;
}

/**
 * In-memory per-wallet lock to prevent concurrent subscription requests.
 * 
 * When multiple requests arrive for the same wallet simultaneously,
 * the second request waits for the first to complete and returns its result.
 * 
 * The lock automatically expires after REQUEST_TIMEOUT_MS to prevent
 * permanent locks in case of errors or crashes.
 */
class InFlightLock {
  private locks = new Map<string, InFlightRequest<unknown>>();

  /**
   * Execute a function with an in-flight lock for the given key.
   * If another request with the same key is already in progress,
   * this will wait for it to complete and return its result.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const timeoutMs = config.requestTimeoutMs;

    // Clean up expired locks
    this.cleanupExpiredLocks(now, timeoutMs);

    // Check if there's already a request in progress for this key
    const existing = this.locks.get(key);
    if (existing) {
      // Wait for the existing request to complete
      try {
        return await existing.promise as Promise<T>;
      } catch (error) {
        // If the existing request failed, remove the lock and retry
        this.locks.delete(key);
        return this.withLock(key, fn);
      }
    }

    // Create a new promise for this request
    const promise = (async () => {
      try {
        // Execute the function
        return await fn();
      } finally {
        // Always remove the lock when done
        this.locks.delete(key);
      }
    })();

    // Store the promise in the lock map
    this.locks.set(key, { promise, timestamp: now });

    // Wait for the promise to complete
    return await promise;
  }

  /**
   * Remove locks that have exceeded the timeout.
   */
  private cleanupExpiredLocks(now: number, timeoutMs: number): void {
    for (const [key, request] of this.locks.entries()) {
      if (now - request.timestamp > timeoutMs) {
        this.locks.delete(key);
      }
    }
  }

  /**
   * Clear all locks (useful for testing).
   */
  clear(): void {
    this.locks.clear();
  }

  /**
   * Get the number of active locks (useful for testing).
   */
  size(): number {
    return this.locks.size;
  }
}

// Singleton instance
export const inFlightLock = new InFlightLock();
