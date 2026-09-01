/**
 * Race a thunk's result against a timeout, resolving 'error' (never
 * rejecting, never throwing) on a synchronous throw, an async rejection, or
 * a timeout. Takes a thunk rather than an already-created promise so a
 * synchronous throw from evaluating the call itself (e.g. getDriver()
 * throwing "Database not initialised") is also caught — an already-created
 * promise argument can't protect against a throw that happens before the
 * promise even exists.
 */
export function withTimeout(fn: () => Promise<unknown>, timeoutMs: number): Promise<'ok' | 'error'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('error'), timeoutMs);
    try {
      Promise.resolve(fn()).then(
        () => {
          clearTimeout(timer);
          resolve('ok');
        },
        () => {
          clearTimeout(timer);
          resolve('error');
        },
      );
    } catch {
      clearTimeout(timer);
      resolve('error');
    }
  });
}
