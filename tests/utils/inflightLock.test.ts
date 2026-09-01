import { inFlightLock } from '../../src/utils/inflightLock';
import config from '../../src/config';

describe('inFlightLock', () => {
  afterEach(() => {
    inFlightLock.clear();
    jest.useRealTimers();
  });

  it('shares one execution and result across concurrent same-key calls', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls += 1;
      return 'result';
    });

    const [a, b] = await Promise.all([
      inFlightLock.withLock('wallet-1', fn),
      inFlightLock.withLock('wallet-1', fn),
    ]);

    expect(a).toBe('result');
    expect(b).toBe('result');
    expect(calls).toBe(1);
  });

  it('retries with a fresh fn when the first call rejects', async () => {
    let firstCalled = false;
    const failing = jest.fn(async () => {
      if (!firstCalled) {
        firstCalled = true;
        throw new Error('boom');
      }
      return 'never';
    });
    const succeeding = jest.fn(async () => 'second-result');

    const [first, second] = await Promise.allSettled([
      inFlightLock.withLock('wallet-2', failing),
      inFlightLock.withLock('wallet-2', succeeding),
    ]);

    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
    if (second.status === 'fulfilled') {
      expect(second.value).toBe('second-result');
    }
  });

  it('cleans up locks older than config.requestTimeoutMs', async () => {
    jest.useFakeTimers();
    const first = jest.fn(() => new Promise<string>(() => {}));

    void inFlightLock.withLock('wallet-3', first);
    expect(inFlightLock.size()).toBe(1);

    jest.advanceTimersByTime(config.requestTimeoutMs + 1);

    const second = jest.fn(async () => 'fresh');
    const resultPromise = inFlightLock.withLock('wallet-3', second);
    await jest.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(second).toHaveBeenCalledTimes(1);
    expect(result).toBe('fresh');
  });

  it('clear() and size() behave as documented', async () => {
    expect(inFlightLock.size()).toBe(0);
    const pending = inFlightLock.withLock('wallet-4', () => new Promise<string>(() => {}));
    expect(inFlightLock.size()).toBe(1);
    inFlightLock.clear();
    expect(inFlightLock.size()).toBe(0);
    void pending;
  });
});
