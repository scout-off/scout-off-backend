/**
 * Tests for requestLogger middleware.
 *
 * Verifies:
 *  - Health/metrics probe paths produce no log output.
 *  - Normal application paths are logged as usual.
 *  - Excluded paths are driven by config.requestLog.skipPaths so they are
 *    configurable (we swap the config reference in tests).
 *  - Sample rate of 0 suppresses all non-skipped paths.
 *  - Sample rate of 1 logs all non-skipped paths.
 */

import { Request, Response, NextFunction } from 'express';

// ─── Mock logger so we can assert on calls without real output ────────────────
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info:  jest.fn(),
    warn:  jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

import { logger } from '../../src/utils/logger';
import { requestLogger } from '../../src/middleware/requestLogger';
import config from '../../src/config';

const mockInfo = logger.info as jest.Mock;

function makeReq(path: string): Request {
  return {
    path,
    method: 'GET',
    headers: {},
    correlationId: undefined,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

const mockRes = {} as Response;
const mockNext: NextFunction = jest.fn();

beforeEach(() => {
  mockInfo.mockClear();
  (mockNext as jest.Mock).mockClear();
});

// ─── Health / metrics probe paths ─────────────────────────────────────────────

describe('requestLogger — skipped paths produce no log output', () => {
  const probePaths = [
    '/health',
    '/health/liveness',
    '/health/readiness',
    '/ready',
    '/metrics',
  ];

  test.each(probePaths)('does not log %s', (path) => {
    // Ensure the path is in the skip list (uses real config defaults).
    expect(config.requestLog.skipPaths).toContain(path);

    requestLogger(makeReq(path), mockRes, mockNext);

    expect(mockInfo).not.toHaveBeenCalled();
    expect(mockNext).toHaveBeenCalledTimes(1);
  });
});

// ─── Normal application paths ─────────────────────────────────────────────────

describe('requestLogger — application paths are logged', () => {
  it('logs a regular API path', () => {
    const originalRate = config.requestLog.sampleRate;
    config.requestLog.sampleRate = 1; // guarantee logging

    requestLogger(makeReq('/api/players'), mockRes, mockNext);

    expect(mockInfo).toHaveBeenCalledTimes(1);
    expect((mockInfo.mock.calls[0] as string[])[0]).toContain('GET /api/players');

    config.requestLog.sampleRate = originalRate;
  });

  it('logs the auth endpoint', () => {
    const originalRate = config.requestLog.sampleRate;
    config.requestLog.sampleRate = 1;

    requestLogger(makeReq('/auth/challenge'), mockRes, mockNext);

    expect(mockInfo).toHaveBeenCalledTimes(1);
    config.requestLog.sampleRate = originalRate;
  });
});

// ─── Configurable skip list ───────────────────────────────────────────────────

describe('requestLogger — skipPaths is configurable', () => {
  it('skips a custom path added to config.requestLog.skipPaths', () => {
    const original = config.requestLog.skipPaths;
    config.requestLog.skipPaths = [...original, '/api/v1/custom-noisy'];

    requestLogger(makeReq('/api/v1/custom-noisy'), mockRes, mockNext);

    expect(mockInfo).not.toHaveBeenCalled();
    config.requestLog.skipPaths = original;
  });

  it('logs the path once removed from skipPaths', () => {
    const original = config.requestLog.skipPaths;
    config.requestLog.skipPaths = original.filter((p) => p !== '/health');
    config.requestLog.sampleRate = 1;

    requestLogger(makeReq('/health'), mockRes, mockNext);

    expect(mockInfo).toHaveBeenCalledTimes(1);
    config.requestLog.skipPaths = original;
  });
});

// ─── Sample rate ──────────────────────────────────────────────────────────────

describe('requestLogger — sample rate', () => {
  it('suppresses all requests when sampleRate is 0', () => {
    const original = config.requestLog.sampleRate;
    config.requestLog.sampleRate = 0;

    for (let i = 0; i < 20; i++) {
      requestLogger(makeReq('/api/scouts/G123/subscription'), mockRes, mockNext);
    }

    expect(mockInfo).not.toHaveBeenCalled();
    config.requestLog.sampleRate = original;
  });

  it('logs all requests when sampleRate is 1', () => {
    const original = config.requestLog.sampleRate;
    config.requestLog.sampleRate = 1;

    for (let i = 0; i < 5; i++) {
      requestLogger(makeReq('/api/players'), mockRes, mockNext);
    }

    expect(mockInfo).toHaveBeenCalledTimes(5);
    config.requestLog.sampleRate = original;
  });
});
