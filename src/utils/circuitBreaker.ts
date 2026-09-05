/**
 * Circuit breakers for outbound dependency calls.
 *
 * Two implementations live here because the two call sites have genuinely
 * different needs:
 *
 *   • {@link CircuitBreaker} — a plain breaker (closed / open / half-open) with
 *     no retry logic. Used for IPFS / Pinata (issue #1142): a single failing
 *     call counts as one failure, and once the breaker is open every call
 *     fast-fails with {@link CircuitBreakerOpenError} until the reset timeout
 *     elapses and a single probe is allowed through.
 *
 *   • {@link RetryingCircuitBreaker} — wraps each call in bounded exponential
 *     backoff retries before counting a failure. Used for the Stellar RPC
 *     client (see src/services/stellar.ts), where transient RPC errors are
 *     common and worth retrying in-line.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Plain breaker (IPFS / Pinata) — issue #1142
// ─────────────────────────────────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening. Default: 5 */
  failureThreshold?: number;
  /** Milliseconds to wait before moving from open → half-open. Default: 30000 */
  resetTimeoutMs?: number;
  /** Human-readable name used in error messages and logs. */
  name?: string;
}

export class CircuitBreakerOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker open: ${name} is temporarily unavailable`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastOpenedAt: number | null = null;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  readonly name: string;

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name ?? 'unknown';
    this.failureThreshold =
      options.failureThreshold ??
      parseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD ?? '5', 10);
    this.resetTimeoutMs =
      options.resetTimeoutMs ??
      parseInt(process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS ?? '30000', 10);
  }

  getState(): CircuitState {
    if (this.state === 'open' && this.lastOpenedAt !== null) {
      if (Date.now() - this.lastOpenedAt >= this.resetTimeoutMs) {
        this.state = 'half-open';
      }
    }
    return this.state;
  }

  /** Execute fn through the breaker. Throws CircuitBreakerOpenError when open. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();

    if (state === 'open') {
      throw new CircuitBreakerOpenError(this.name);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  isOpen(): boolean {
    return this.getState() === 'open';
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
    this.lastOpenedAt = null;
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.lastOpenedAt = Date.now();
    }
  }

  /** Reset for testing purposes. */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.lastOpenedAt = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Retrying breaker (Stellar RPC)
// ─────────────────────────────────────────────────────────────────────────────

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

export class RetryingCircuitBreaker {
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

export const stellarBreaker = new RetryingCircuitBreaker();
