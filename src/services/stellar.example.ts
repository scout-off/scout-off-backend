/**
 * EXAMPLE: Updated Stellar RPC service to accept and propagate abort signal.
 * 
 * This shows how to integrate request signal propagation into the Stellar SDK.
 * Apply similar changes to your actual stellar.ts implementation.
 */

import { getRequestSignal } from '../middleware/requestSignal';
import { AxiosError } from 'axios';

/**
 * Example: Call a Soroban RPC method with signal support.
 * 
 * Most Stellar SDK methods don't directly accept AbortSignal, but axios
 * (which the SDK likely uses under the hood) does. You may need to:
 * 
 * 1. Intercept axios calls via a hook
 * 2. Pass signal through SDK initialization
 * 3. Wrap SDK calls in Promise.race() with an abort signal
 */
export async function exampleContractCall(contractId: string, fn: string, args: any[]): Promise<any> {
  const signal = getRequestSignal();

  // Option 1: If SDK accepts signal in options
  // return sorobanClient.contracts.simulateInvoke({
  //   contractId,
  //   fn,
  //   args,
  //   signal,  // Pass directly if supported
  // });

  // Option 2: Wrap in Promise.race with signal abort
  if (signal?.aborted) {
    throw new Error('Request cancelled before RPC call');
  }

  // Create a promise that rejects when signal aborts
  const abortPromise = new Promise((_, reject) => {
    if (signal) {
      signal.addEventListener('abort', () => {
        reject(new Error('Request cancelled during RPC call'));
      }, { once: true });
    }
  });

  // Race between the RPC call and abort signal
  return Promise.race([
    sorobanContractCall(contractId, fn, args),
    abortPromise,
  ]);
}

/**
 * Example: Wrap a long-running operation with signal checks.
 */
async function sorobanContractCall(contractId: string, fn: string, args: any[]): Promise<any> {
  // Actual SDK call here
  return new Promise((resolve) => {
    // Simulated async work
    setTimeout(() => resolve({}), 100);
  });
}

/**
 * EXAMPLE: HTTP client interceptor to propagate signal
 * 
 * If using axios for Stellar RPC, add an interceptor:
 */
export function setupSignalInterceptor(axiosInstance: any): void {
  axiosInstance.interceptors.request.use((config: any) => {
    // Attach request signal to every axios call
    const signal = getRequestSignal();
    if (signal) {
      config.signal = signal;
    }
    return config;
  });

  axiosInstance.interceptors.response.use(
    (response: any) => response,
    (error: AxiosError) => {
      // Log cancellations for debugging
      if (error.code === 'ERR_CANCELED') {
        console.debug('[stellar] RPC call cancelled via abort signal');
      }
      throw error;
    },
  );
}
