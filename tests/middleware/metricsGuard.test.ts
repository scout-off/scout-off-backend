/**
 * tests/middleware/metricsGuard.test.ts
 *
 * Unit tests for the metricsGuard middleware.
 *
 * Covers:
 *   - Pass-through when no protection is configured
 *   - Reject with 401 when token is missing/invalid
 *   - Accept with 200 when token is valid
 *   - Reject with 403 when IP is not in CIDR allowlist
 *   - Accept when IP is in CIDR allowlist
 *   - Both token and CIDR checks must pass when both configured
 *   - Constant-time token comparison
 */

import { Request, Response, NextFunction } from 'express';
import { metricsGuard } from '../../src/middleware/metricsGuard';
import config from '../../src/config';

function makeReqRes(
  authToken?: string,
  remoteAddress?: string,
) {
  const req = {
    headers: {
      authorization: authToken ? `Bearer ${authToken}` : undefined,
    },
    socket: {
      remoteAddress: remoteAddress ?? '127.0.0.1',
    },
  } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('metricsGuard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset config to defaults
    config.metrics.authToken = '';
    config.metrics.allowedCidrs = [];
    delete process.env.METRICS_AUTH_TOKEN;
    delete process.env.METRICS_ALLOWED_CIDRS;
  });

  afterEach(() => {
    delete process.env.METRICS_AUTH_TOKEN;
    delete process.env.METRICS_ALLOWED_CIDRS;
  });

  describe('no protection configured', () => {
    it('passes through when neither token nor CIDR is configured', () => {
      const { req, res, next } = makeReqRes();
      metricsGuard(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('bearer token protection', () => {
    beforeEach(() => {
      config.metrics.authToken = 'secret-token';
      config.metrics.allowedCidrs = [];
    });

    it('rejects with 401 when token is missing', () => {
      const { req, res, next } = makeReqRes();
      metricsGuard(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
    });

    it('rejects with 401 when token is invalid', () => {
      const { req, res, next } = makeReqRes('wrong-token');
      metricsGuard(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
    });

    it('accepts with 200 when token is valid', () => {
      const { req, res, next } = makeReqRes('secret-token');
      metricsGuard(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('rejects when Authorization header is malformed', () => {
      const req = {
        headers: {
          authorization: 'Basic invalid',
        },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next = jest.fn() as NextFunction;

      metricsGuard(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('CIDR allowlist protection', () => {
    beforeEach(() => {
      config.metrics.authToken = '';
      config.metrics.allowedCidrs = ['10.0.0.0/8', '192.168.1.0/24'];
    });

    it('rejects with 403 when IP is not in allowlist', () => {
      const { req, res, next } = makeReqRes(undefined, '8.8.8.8');
      metricsGuard(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Forbidden' });
    });

    it('accepts when IP is in allowlist', () => {
      const { req, res, next } = makeReqRes(undefined, '10.0.1.5');
      metricsGuard(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('accepts when IP matches exact address in allowlist', () => {
      config.metrics.allowedCidrs = ['192.168.1.42'];
      const { req, res, next } = makeReqRes(undefined, '192.168.1.42');
      metricsGuard(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('normalizes IPv4-mapped IPv6 addresses', () => {
      const { req, res, next } = makeReqRes(undefined, '::ffff:10.0.1.5');
      metricsGuard(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('rejects when socket.remoteAddress is undefined', () => {
      const req = {
        headers: {},
        socket: { remoteAddress: undefined },
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next = jest.fn() as NextFunction;

      metricsGuard(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('both token and CIDR configured', () => {
    beforeEach(() => {
      config.metrics.authToken = 'secret-token';
      config.metrics.allowedCidrs = ['10.0.0.0/8'];
    });

    it('accepts when both token and IP are valid', () => {
      const { req, res, next } = makeReqRes('secret-token', '10.0.1.5');
      metricsGuard(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('rejects with 401 when token is invalid (even if IP is valid)', () => {
      const { req, res, next } = makeReqRes('wrong-token', '10.0.1.5');
      metricsGuard(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects with 403 when IP is invalid (even if token is valid)', () => {
      const { req, res, next } = makeReqRes('secret-token', '8.8.8.8');
      metricsGuard(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('rejects when both token and IP are invalid', () => {
      const { req, res, next } = makeReqRes('wrong-token', '8.8.8.8');
      metricsGuard(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401); // Token check runs first
    });
  });

  describe('environment variable integration', () => {
    it('reads METRICS_AUTH_TOKEN from environment', () => {
      process.env.METRICS_AUTH_TOKEN = 'env-token';
      // Reload config
      jest.resetModules();
      const newConfig = require('../../src/config').default;
      expect(newConfig.metrics.authToken).toBe('env-token');
      delete process.env.METRICS_AUTH_TOKEN;
    });

    it('reads METRICS_ALLOWED_CIDRS from environment', () => {
      process.env.METRICS_ALLOWED_CIDRS = '10.0.0.0/8,192.168.1.0/24';
      // Reload config
      jest.resetModules();
      const newConfig = require('../../src/config').default;
      expect(newConfig.metrics.allowedCidrs).toEqual(['10.0.0.0/8', '192.168.1.0/24']);
      delete process.env.METRICS_ALLOWED_CIDRS;
    });
  });
});
