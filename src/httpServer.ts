import http from 'http';

/** Node HTTP server socket timeouts (all milliseconds). */
export interface HttpTimeouts {
  keepAliveTimeoutMs: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
}

/**
 * Apply configured socket timeouts to the HTTP server (#1593).
 *
 * requestTimeout covers receiving the request (headers + body), not the
 * lifetime of a long-lived response, so SSE streams stay open past it.
 */
export function applyHttpTimeouts(server: http.Server, timeouts: HttpTimeouts): void {
  server.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
  server.headersTimeout = timeouts.headersTimeoutMs;
  server.requestTimeout = timeouts.requestTimeoutMs;
}
