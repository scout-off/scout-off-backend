import { withTimeout } from '../../src/utils/withTimeout';

describe('withTimeout', () => {
  it("resolves 'ok' when the thunk resolves before the timeout", async () => {
    await expect(withTimeout(() => Promise.resolve('anything'), 1_000)).resolves.toBe('ok');
  });

  it("resolves 'error' when the thunk rejects", async () => {
    await expect(withTimeout(() => Promise.reject(new Error('boom')), 1_000)).resolves.toBe('error');
  });

  it("resolves 'error' when the thunk throws synchronously", async () => {
    await expect(
      withTimeout(() => {
        throw new Error('sync boom');
      }, 1_000),
    ).resolves.toBe('error');
  });

  it("resolves 'error' after timeoutMs when the thunk never settles", async () => {
    jest.useFakeTimers();
    try {
      const result = withTimeout(() => new Promise(() => {}), 2_000);
      jest.advanceTimersByTime(2_000);
      await expect(result).resolves.toBe('error');
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the timer on an early settle (no dangling timer)', async () => {
    jest.useFakeTimers();
    try {
      const clearSpy = jest.spyOn(global, 'clearTimeout');
      await withTimeout(() => Promise.resolve(), 2_000);
      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });
});
