/**
 * Tests for the apiVersion middleware.
 *
 * Acceptance criteria:
 *  - Both `API-Version` (canonical) and `X-API-Version` (deprecated alias)
 *    are set on every response.
 *  - Both headers always carry the same value — they can never disagree.
 *  - /api/* and /api/v1/* → version "1"
 *  - /api/v2/* → version "2"
 *  - API-Version: 2 request header on a bare /api/* path → version "2"
 *  - Non-API paths (e.g. /health) still receive both headers (global middleware).
 */

import { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { apiVersion } from '../../src/middleware/apiVersion';
import app from '../../src/app';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    setHeader: jest.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
    _headers: headers,
  } as unknown as Response & { _headers: Record<string, string> };
}

function makeReq(overrides: Partial<{ originalUrl: string; apiVersionOverride: number }>): Request {
  return {
    originalUrl: overrides.originalUrl ?? '/api/players',
    apiVersionOverride: overrides.apiVersionOverride,
  } as unknown as Request;
}

// ─── Unit: header values ──────────────────────────────────────────────────────

describe('apiVersion middleware — unit', () => {
  describe('version "1" paths', () => {
    const v1Paths = [
      '/api/players',
      '/api/v1/players',
      '/api/v1/scouts',
      '/auth/challenge',
      '/health',
    ];

    it.each(v1Paths)('sets both headers to "1" for %s', (path) => {
      const req = makeReq({ originalUrl: path });
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      apiVersion(req, res, next);

      expect((res.setHeader as jest.Mock)).toHaveBeenCalledWith('API-Version', '1');
      expect((res.setHeader as jest.Mock)).toHaveBeenCalledWith('X-API-Version', '1');
    });
  });

  describe('version "2" paths', () => {
    const v2Paths = [
      '/api/v2/players',
      '/api/v2/scouts',
      '/api/v2/versioning/demo',
    ];

    it.each(v2Paths)('sets both headers to "2" for %s', (path) => {
      const req = makeReq({ originalUrl: path });
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      apiVersion(req, res, next);

      expect((res.setHeader as jest.Mock)).toHaveBeenCalledWith('API-Version', '2');
      expect((res.setHeader as jest.Mock)).toHaveBeenCalledWith('X-API-Version', '2');
    });
  });

  describe('apiVersionOverride', () => {
    it('uses override=2 on a bare /api path', () => {
      const req = makeReq({ originalUrl: '/api/players', apiVersionOverride: 2 });
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      apiVersion(req, res, next);

      expect((res.setHeader as jest.Mock)).toHaveBeenCalledWith('API-Version', '2');
      expect((res.setHeader as jest.Mock)).toHaveBeenCalledWith('X-API-Version', '2');
    });

    it('override=1 on /api path still resolves to "1"', () => {
      const req = makeReq({ originalUrl: '/api/players', apiVersionOverride: 1 });
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      apiVersion(req, res, next);

      expect((res.setHeader as jest.Mock)).toHaveBeenCalledWith('API-Version', '1');
      expect((res.setHeader as jest.Mock)).toHaveBeenCalledWith('X-API-Version', '1');
    });
  });

  describe('always-in-sync invariant', () => {
    const paths = [
      '/api/players',
      '/api/v1/players',
      '/api/v2/players',
      '/health',
      '/auth/challenge',
    ];

    it.each(paths)('API-Version and X-API-Version agree on %s', (path) => {
      const req = makeReq({ originalUrl: path });
      const res = makeRes();
      const next = jest.fn() as NextFunction;

      apiVersion(req, res, next);

      const calls = (res.setHeader as jest.Mock).mock.calls as [string, string][];
      const canonical = calls.find(([name]) => name === 'API-Version')?.[1];
      const alias = calls.find(([name]) => name === 'X-API-Version')?.[1];

      expect(canonical).toBeDefined();
      expect(alias).toBeDefined();
      expect(canonical).toBe(alias);
    });
  });

  it('calls next()', () => {
    const req = makeReq({ originalUrl: '/api/players' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    apiVersion(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets exactly two header calls (canonical + alias)', () => {
    const req = makeReq({ originalUrl: '/api/players' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    apiVersion(req, res, next);

    expect((res.setHeader as jest.Mock)).toHaveBeenCalledTimes(2);
  });
});

// ─── Integration: both headers on real HTTP responses ─────────────────────────

describe('apiVersion middleware — integration', () => {
  describe('header presence on every route type', () => {
    it('GET /api/players carries API-Version and X-API-Version', async () => {
      const res = await request(app).get('/api/players');
      expect(res.headers['api-version']).toMatch(/^\d+$/);
      expect(res.headers['x-api-version']).toMatch(/^\d+$/);
    });

    it('GET /api/v1/players carries API-Version and X-API-Version', async () => {
      const res = await request(app).get('/api/v1/players');
      expect(res.headers['api-version']).toMatch(/^\d+$/);
      expect(res.headers['x-api-version']).toMatch(/^\d+$/);
    });

    it('GET /health carries API-Version and X-API-Version', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['api-version']).toMatch(/^\d+$/);
      expect(res.headers['x-api-version']).toMatch(/^\d+$/);
    });

    it('404 responses carry API-Version and X-API-Version', async () => {
      const res = await request(app).get('/api/does-not-exist-at-all');
      expect(res.status).toBe(404);
      expect(res.headers['api-version']).toMatch(/^\d+$/);
      expect(res.headers['x-api-version']).toMatch(/^\d+$/);
    });
  });

  describe('correct version values', () => {
    it('GET /api/players → both headers report "1"', async () => {
      const res = await request(app).get('/api/players');
      expect(res.headers['api-version']).toBe('1');
      expect(res.headers['x-api-version']).toBe('1');
    });

    it('GET /api/v1/players → both headers report "1"', async () => {
      const res = await request(app).get('/api/v1/players');
      expect(res.headers['api-version']).toBe('1');
      expect(res.headers['x-api-version']).toBe('1');
    });

    it('GET /api/v2/players → both headers report "2"', async () => {
      const res = await request(app).get('/api/v2/players');
      expect(res.headers['api-version']).toBe('2');
      expect(res.headers['x-api-version']).toBe('2');
    });
  });

  describe('always-in-sync invariant on real responses', () => {
    const routes = [
      '/api/players',
      '/api/v1/players',
      '/api/v2/players',
      '/health',
    ];

    it.each(routes)('API-Version equals X-API-Version on %s', async (route) => {
      const res = await request(app).get(route);
      expect(res.headers['api-version']).toBe(res.headers['x-api-version']);
    });

    it('API-Version: 2 request header on /api path → both response headers report "2"', async () => {
      const res = await request(app)
        .get('/api/players')
        .set('API-Version', '2');
      expect(res.headers['api-version']).toBe('2');
      expect(res.headers['x-api-version']).toBe('2');
      // Canonical and alias agree
      expect(res.headers['api-version']).toBe(res.headers['x-api-version']);
    });
  });
});
