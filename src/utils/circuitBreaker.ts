/**
 * Generic circuit breaker.
 *
 * States:
 *   closed   — normal operation, calls pass through
 *   open     — fast-fail, calls rejected immediately
 *   half-open — one probe call allowed; success closes, failure re-opens
 *
 * Configuration via constructor options or environment variables:
 *   CIRCUIT_BREAKER_FAILURE_THRESHOLD  (default: 5)
 *   CIRCUIT_BREAKER_RESET_TIMEOUT_MS   (default: 30000)
 */

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
