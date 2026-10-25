/**
 * EXAMPLE: Updated safeFetch to accept and propagate abort signal.
 * 
 * This shows how to integrate request signal propagation into the existing
 * safeFetch utility. Apply similar changes to your actual implementation.
 */

import axios, { AxiosRequestConfig } from 'axios';
import { getRequestSignal } from '../middleware/requestSignal';

interface SafeFetchOptions extends AxiosRequestConfig {
  /**
   * Optional external abort signal (from request context).
   * If provided and combined with the local timeout to abort early.
   */
  signal?: AbortSignal;

  /**
   * Timeout in milliseconds for this fetch (default: STELLAR_RPC_TIMEOUT_MS).
   * Combined with the external signal via AbortSignal.any().
   */
  timeoutMs?: number;
}

/**
 * Fetch with combined timeout + request signal + automatic error handling.
 *
 * @param url Target URL
 * @param options Fetch options including optional signal and timeoutMs
 * @returns Parsed response body
 * @throws On network error, timeout, cancellation, or non-2xx status
 */
export async function safeFetch<T>(url: string, options: SafeFetchOptions = {}): Promise<T> {
  const {
    signal: externalSignal,
    timeoutMs = 15000, // Default timeout
    ...axiosConfig
  } = options;

  // Combine external signal (from request) with local timeout
  const signals: AbortSignal[] = [];
  if (externalSignal) {
    signals.push(externalSignal);
  }

  let localController: AbortController | undefined;
  if (timeoutMs > 0) {
    localController = new AbortController();
    signals.push(localController.signal);
  }

  let timeoutId: NodeJS.Timeout | undefined;

  try {
    // Use AbortSignal.any() if available (Node 20.3+)
    // Fallback to just external signal or create a combined one manually
    let combinedSignal: AbortSignal | undefined;
    if (signals.length > 1 && AbortSignal.any) {
      combinedSignal = AbortSignal.any(signals);
    } else if (signals.length > 0) {
      combinedSignal = signals[0];
    }

    if (timeoutMs > 0 && localController) {
      timeoutId = setTimeout(() => localController!.abort(), timeoutMs);
    }

    const response = await axios.get<T>(url, {
      ...axiosConfig,
      signal: combinedSignal,
    });

    return response.data;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * EXAMPLE: Using safeFetch in a service
 * 
 * In src/services/stellar.ts or similar:
 */
export async function exampleServiceCall(url: string): Promise<any> {
  // Option 1: Auto-detect signal from request context
  const signal = getRequestSignal();
  
  return safeFetch(url, {
    signal,
    timeoutMs: 15000,
  });
}

/**
 * EXAMPLE: Using in a loop with explicit cancellation check
 */
export async function exampleBatchProcess(items: any[]): Promise<void> {
  const { checkRequestCancelled } = await import('../middleware/requestSignal');
  
  for (const item of items) {
    checkRequestCancelled(); // Throws if request was cancelled
    
    // Do work
    await safeFetch(`https://api.example.com/item/${item.id}`, {
      signal: getRequestSignal(),
    });
  }
}
