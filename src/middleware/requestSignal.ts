/**
 * Access the request's abort signal from the request context.
 * When a request times out (via timeout middleware) or the client disconnects,
 * this signal is aborted so that expensive operations (RPC calls, IPFS fetches,
 * DB queries) can check it and bail out early.
 *
 * Usage in a service:
 *   const signal = getRequestSignal();
 *   if (signal?.aborted) throw new Error('Request cancelled');
 *
 * Or when making a fetch:
 *   const response = await fetch(url, { signal });
 */

import { requestContext } from '../utils/requestContext';

/**
 * Get the current request's AbortSignal, if one is active.
 * Returns undefined if no request context is active (e.g., in background jobs).
 */
export function getRequestSignal(): AbortSignal | undefined {
  const store = requestContext.getStore();
  return store?.signal;
}

/**
 * Check whether the current request has been cancelled/aborted.
 * Useful for long-running loops that need to bail out mid-operation.
 *
 * @returns true if the signal exists and is aborted, false otherwise
 */
export function isRequestCancelled(): boolean {
  const signal = getRequestSignal();
  return signal?.aborted ?? false;
}

/**
 * Throw an error if the request has been cancelled.
 * Call this in tight loops or batch operations to stop early.
 */
export function checkRequestCancelled(): void {
  if (isRequestCancelled()) {
    throw new Error('Request cancelled');
  }
}
