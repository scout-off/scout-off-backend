/**
 * Unit tests for HTTP server timeout configuration (#1593).
 *
 * Asserts applyHttpTimeouts() sets the three Node server timeouts, that the
 * config defaults suit ALB alignment, and that headersTimeout <=
 * keepAliveTimeout fails fast at startup. No real server is started.
 */

import http from 'http';
import { applyHttpTimeouts } from '../../src/httpServer';

describe('applyHttpTimeouts', () => {
  it('sets keepAliveTimeout, headersTimeout and requestTimeout on the server', () => {
    const server = http.createServer();
    try {
      applyHttpTimeouts(server, {
        keepAliveTimeoutMs: 65000,
        headersTimeoutMs: 66000,
        requestTimeoutMs: 120000,
      });
      expect(server.keepAliveTimeout).toBe(65000);
      expect(server.headersTimeout).toBe(66000);
      expect(server.requestTimeout).toBe(120000);
    } finally {
      server.close();
    }
  });

  it('config defaults keep keep-alive above the ALB 60s idle timeout', () => {
    jest.resetModules();
    process.env.JWT_SECRET ??= 'test-secret-min-32-chars-for-ci-only';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../../src/config').default;
    expect(config.http.keepAliveTimeoutMs).toBeGreaterThan(60000);
    expect(config.http.headersTimeoutMs).toBeGreaterThan(config.http.keepAliveTimeoutMs);
  });

  it('config rejects headersTimeout <= keepAliveTimeout at startup', () => {
    jest.resetModules();
    process.env.JWT_SECRET ??= 'test-secret-min-32-chars-for-ci-only';
    process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS = '65000';
    process.env.HTTP_HEADERS_TIMEOUT_MS = '5000';
    expect(() => require('../../src/config')).toThrow(/must be greater than/);
    delete process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS;
    delete process.env.HTTP_HEADERS_TIMEOUT_MS;
    jest.resetModules();
  });
});
