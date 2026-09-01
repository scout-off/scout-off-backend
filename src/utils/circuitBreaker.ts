export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  maxRetries: number;
  baseBackoffMs: number;
}

export class CircuitBreaker {
  public state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private nextAttemptAt = 0;
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: 3,
      resetTimeoutMs: 10000,
      maxRetries: 3,
      baseBackoffMs: 1000,
      ...config,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() >= this.nextAttemptAt) {
        this.state = 'HALF_OPEN';
      } else {
        throw new CircuitBreakerError('ServiceUnavailable: Circuit breaker is OPEN');
      }
    }

    try {
      const result = await this.executeWithRetry(fn);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (attempt <= this.config.maxRetries) {
      try {
        return await fn();
      } catch (error: any) {
        if (!this.isRetryable(error) || attempt === this.config.maxRetries) {
          throw error;
        }
        attempt++;
        // Exponential backoff with jitter
        const backoff = this.config.baseBackoffMs * Math.pow(2, attempt - 1) + Math.random() * 100;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw new Error('Unreachable');
  }

  private isRetryable(error: any): boolean {
    const status = error?.response?.status;
    if (typeof status === 'number') {
      // 408 Request Timeout and 429 Too Many Requests are retryable
      if (status === 408 || status === 429) return true;
      // 4xx errors are generally validation/client errors -> fail fast
      if (status >= 400 && status < 500) return false;
    }
    // Network errors (no response, timeouts) or 5xx server errors are retryable
    return true;
  }

  private onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  private onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttemptAt = Date.now() + this.config.resetTimeoutMs;
    }
  }
}

export const stellarBreaker = new CircuitBreaker();
