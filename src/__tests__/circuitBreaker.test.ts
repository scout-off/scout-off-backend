import { CircuitBreaker, CircuitBreakerError } from '../utils/circuitBreaker';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('transient-error retry-then-succeed', async () => {
    const breaker = new CircuitBreaker({ maxRetries: 3, baseBackoffMs: 100 });
    let attempts = 0;
    const fn = jest.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Network timeout');
      }
      return 'success';
    });

    const promise = breaker.execute(fn);
    
    // Fast-forward timers for retries
    for (let i = 0; i < 2; i++) {
      await Promise.resolve(); // flush microtasks
      jest.advanceTimersByTime(1000); // advance past backoff
    }

    const result = await promise;
    expect(result).toBe('success');
    expect(attempts).toBe(3);
    expect(breaker.state).toBe('CLOSED');
  });

  it('breaker opening after threshold failures and fail fast while open', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, maxRetries: 0 });
    const fn = jest.fn().mockRejectedValue(new Error('Persistent error'));

    await expect(breaker.execute(fn)).rejects.toThrow('Persistent error');
    expect(breaker.state).toBe('CLOSED');

    await expect(breaker.execute(fn)).rejects.toThrow('Persistent error');
    expect(breaker.state).toBe('OPEN');

    // Fail fast on open
    await expect(breaker.execute(fn)).rejects.toThrow(CircuitBreakerError);
    await expect(breaker.execute(fn)).rejects.toThrow('Circuit breaker is OPEN');
  });

  it('breaker half-open recovery', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, maxRetries: 0, resetTimeoutMs: 5000 });
    
    const failFn = jest.fn().mockRejectedValue(new Error('Fail'));
    const successFn = jest.fn().mockResolvedValue('OK');

    await expect(breaker.execute(failFn)).rejects.toThrow('Fail');
    expect(breaker.state).toBe('OPEN');

    // Fast-forward past reset timeout
    jest.advanceTimersByTime(5001);

    const result = await breaker.execute(successFn);
    expect(result).toBe('OK');
    expect(breaker.state).toBe('CLOSED');
  });

  it('fails fast without retry on 4xx errors', async () => {
    const breaker = new CircuitBreaker({ maxRetries: 3 });
    const error400: any = new Error('Bad Request');
    error400.response = { status: 400 };
    
    const fn = jest.fn().mockRejectedValue(error400);
    
    await expect(breaker.execute(fn)).rejects.toThrow('Bad Request');
    expect(fn).toHaveBeenCalledTimes(1); // No retries
  });
});
