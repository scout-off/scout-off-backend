/**
 * Simple semaphore-based concurrency limiter.
 * Limits the number of simultaneously executing asynchronous operations.
 */
export class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.permits = maxConcurrent;
  }

  /**
   * Acquire a permit, waiting if necessary.
   * Returns a promise that resolves when a permit is available.
   */
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise((resolve) => {
      this.waitQueue.push(() => {
        this.permits--;
        resolve();
      });
    });
  }

  /**
   * Release a permit, allowing the next waiting operation to proceed.
   */
  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

/**
 * A simple mutual exclusion lock built on top of Semaphore.
 * Only one caller at a time may hold the lock; others queue and wait.
 */
export class Mutex {
  private readonly semaphore = new Semaphore(1);

  async lock(): Promise<() => void> {
    await this.semaphore.acquire();
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.semaphore.release();
      }
    };
  }

  /**
   * Run `fn` exclusively — acquires the lock before calling fn and
   * releases it when fn resolves or rejects.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const unlock = await this.lock();
    try {
      return await fn();
    } finally {
      unlock();
    }
  }
}

/**
 * Execute an array of async functions with a concurrency limit.
 * Returns an array of results (or errors if rejected) matching the input array order.
 * All operations are attempted regardless of individual failures (allSettled semantics).
 *
 * @param tasks Array of async functions to execute
 * @param maxConcurrent Maximum number of simultaneous operations
 * @returns Promise<Array<T | Error>> Results/errors in same order as input
 */
export async function withConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrent: number,
): Promise<Array<{ status: 'fulfilled' | 'rejected'; value?: T; reason?: unknown }>> {
  const semaphore = new Semaphore(maxConcurrent);
  const results: Array<{ status: 'fulfilled' | 'rejected'; value?: T; reason?: unknown }> = [];

  const promises = tasks.map(async (task, index) => {
    await semaphore.acquire();
    try {
      const value = await task();
      results[index] = { status: 'fulfilled', value };
    } catch (reason) {
      results[index] = { status: 'rejected', reason };
    } finally {
      semaphore.release();
    }
  });

  await Promise.all(promises);
  return results;
}
