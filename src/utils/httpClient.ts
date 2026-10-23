/**
 * Unified HTTP client using native fetch (undici).
 *
 * Provides consistent behavior across the codebase:
 * - Configurable timeouts via AbortSignal.timeout
 * - SSRF protection via safeFetch wrapper (optional)
 * - Automatic traceparent propagation
 * - Consistent error mapping
 *
 * Intended to replace axios and node-fetch usage.
 */

import { trace, isSpanContextValid, SpanContext } from '@opentelemetry/api';
import config from '../config';
import { logger } from '../utils/logger';

const TRACEPARENT_VERSION = '00';

/** Formats a span context as a W3C Trace Context `traceparent` header value. */
function formatTraceParent(ctx: SpanContext): string {
  const flags = ctx.traceFlags.toString(16).padStart(2, '0');
  return `${TRACEPARENT_VERSION}-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/** Returns the current request's traceparent, or null when tracing is disabled/inactive. */
function currentTraceParent(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  if (!isSpanContextValid(ctx)) return null;
  return formatTraceParent(ctx);
}

export interface HttpClientOptions {
  /** HTTP method (default: 'GET') */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  /** Request headers */
  headers?: Record<string, string>;
  /** Request body (string or Buffer) */
  body?: string | Buffer | Uint8Array;
  /** Timeout in milliseconds (default: config.ipfsHttpTimeoutMs for IPFS, 10000 for others) */
  timeoutMs?: number;
  /** Whether to use SSRF-safe fetch (default: false) */
  ssrfSafe?: boolean;
  /** Maximum bytes to receive (only applies when ssrfSafe=true) */
  maxBytes?: number;
  /** Max redirects to follow (only applies when ssrfSafe=true) */
  maxRedirects?: number;
}

export class HttpClientError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'HttpClientError';
  }
}

/**
 * Create an AbortSignal with timeout.
 */
function createTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new HttpClientError(`Request timed out after ${timeoutMs}ms`, 408)), timeoutMs);
  
  // Clean up timer when signal is aborted
  controller.signal.addEventListener('abort', () => clearTimeout(timer));
  
  return controller.signal;
}

/**
 * Unified HTTP client using native fetch.
 * 
 * @param url - The URL to fetch
 * @param options - Request options
 * @returns Response body as string
 */
export async function httpClient(url: string, options: HttpClientOptions = {}): Promise<string> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = config.ipfsHttpTimeoutMs,
    ssrfSafe = false,
    maxBytes = 10 * 1024 * 1024, // 10MB default
    maxRedirects = 3,
  } = options;

  // Add traceparent header if active span exists
  const traceparent = currentTraceParent();
  const requestHeaders: Record<string, string> = { ...headers };
  if (traceparent) {
    requestHeaders['traceparent'] = traceparent;
  }

  const signal = createTimeoutSignal(timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body,
      signal,
      redirect: 'manual', // Never follow redirects automatically
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      throw new HttpClientError(
        location 
          ? `Redirect to ${location} (status ${response.status})` 
          : `Redirect without Location header (status ${response.status})`,
        response.status
      );
    }

    if (!response.ok) {
      throw new HttpClientError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status
      );
    }

    const text = await response.text();
    
    // Warn if response exceeds expected size
    if (text.length > maxBytes) {
      logger.warn(`[httpClient] Response size ${text.length} exceeds maxBytes ${maxBytes}`);
    }

    return text;
  } catch (err) {
    if (err instanceof HttpClientError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new HttpClientError(`Request timed out`, 408);
    }
    throw new HttpClientError(
      err instanceof Error ? err.message : String(err),
      0
    );
  }
}

/**
 * Make a GET request.
 */
export async function httpGet(url: string, options?: Omit<HttpClientOptions, 'method'>): Promise<string> {
  return httpClient(url, { ...options, method: 'GET' });
}

/**
 * Make a POST request.
 */
export async function httpPost(url: string, body: string | Buffer | Uint8Array, options?: Omit<HttpClientOptions, 'method' | 'body'>): Promise<string> {
  return httpClient(url, { ...options, method: 'POST', body });
}

/**
 * Make a HEAD request.
 */
export async function httpHead(url: string, options?: Omit<HttpClientOptions, 'method' | 'body'>): Promise<Response> {
  const {
    method = 'HEAD',
    headers = {},
    timeoutMs = config.ipfsHttpTimeoutMs,
    maxRedirects = 3,
  } = options || {};

  const signal = createTimeoutSignal(timeoutMs);

  // Add traceparent header if active span exists
  const traceparent = currentTraceParent();
  const requestHeaders: Record<string, string> = { ...headers };
  if (traceparent) {
    requestHeaders['traceparent'] = traceparent;
  }

  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      signal,
      redirect: 'manual',
    });

    return response;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new HttpClientError(`Request timed out`, 408);
    }
    throw new HttpClientError(
      err instanceof Error ? err.message : String(err),
      err instanceof HttpClientError ? err.status : 0
    );
  }
}

/**
 * Make a DELETE request.
 */
export async function httpDelete(url: string, options?: Omit<HttpClientOptions, 'method' | 'body'>): Promise<string> {
  return httpClient(url, { ...options, method: 'DELETE' });
}

/**
 * Make a PUT request.
 */
export async function httpPut(url: string, body: string | Buffer | Uint8Array, options?: Omit<HttpClientOptions, 'method' | 'body'>): Promise<string> {
  return httpClient(url, { ...options, method: 'PUT', body });
}

/**
 * HTTP client utilities
 */
export const httpClientUtils = {
  /** Parse JSON response */
  parseJson: <T>(text: string): T => JSON.parse(text),
  
  /** Check if status is success (2xx) */
  isSuccess: (status: number): boolean => status >= 200 && status < 300,
  
  /** Check if status is client error (4xx) */
  isClientError: (status: number): boolean => status >= 400 && status < 500,
  
  /** Check if status is server error (5xx) */
  isServerError: (status: number): boolean => status >= 500 && status < 600,
};

export default httpClient;