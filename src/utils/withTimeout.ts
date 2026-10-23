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

/**
 * Execute a promise with an external abort signal combined with a timeout.
 * Useful for operations that support cancellation and need both:
 * - A request-scoped signal (from req.signal via AbortController)
 * - A local timeout specific to this operation
 *
 * If either the external signal or the timeout fires, the operation is aborted.
 * The first to fire wins.
 *
 * @param promise A promise to wrap
 * @param timeoutMs Timeout in milliseconds (0 = no timeout)
 * @param externalSignal Optional AbortSignal from the request context
 * @returns The promise wrapped with timeout/cancellation
 */
export async function withTimeoutAndSignal<T>(
  promise: Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  // If no timeout and no external signal, return unwrapped
  if (timeoutMs === 0 && !externalSignal) {
    return promise;
  }

  // Combine signals
  const signals: AbortSignal[] = [];
  if (externalSignal) {
    signals.push(externalSignal);
  }

  let timeoutController: AbortController | undefined;
  if (timeoutMs > 0) {
    timeoutController = new AbortController();
    signals.push(timeoutController.signal);
  }

  if (signals.length === 0) {
    return promise;
  }

  // Use AbortSignal.any() to race multiple signals (available in Node 20.3+)
  // For older Node versions, fall back to manual race
  const anySignal = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  const combinedSignal = anySignal ? anySignal(signals) : signals[0];

  const timeoutId = timeoutMs > 0 ? setTimeout(() => timeoutController?.abort(), timeoutMs) : undefined;

  try {
    // Throw if the combined signal is already aborted
    if (combinedSignal.aborted) {
      throw combinedSignal.reason || new Error('Aborted');
    }

    // Race the promise against abort
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        combinedSignal.addEventListener('abort', () => {
          reject(combinedSignal.reason || new Error('Aborted'));
        }, { once: true });
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
