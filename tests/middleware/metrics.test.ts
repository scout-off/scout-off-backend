import { Request, Response, NextFunction } from 'express';
import { metricsMiddleware, metricsStore, errorCountsStore, getMetrics, getErrorMetrics, isMetricsEnabled } from '../../src/middleware/metrics';

function makeReqRes(path = '/test', method = 'GET', statusCode = 200) {
  const listeners: Record<string, () => void> = {};
  const req = { method, path, route: undefined } as unknown as Request;
  const res = {
    statusCode,
    on: (event: string, cb: () => void) => { listeners[event] = cb; },
    emit: (event: string) => listeners[event]?.(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next, emit: (e: string) => listeners[e]?.() };
}

beforeEach(() => {
  Object.keys(metricsStore).forEach((k) => delete metricsStore[k]);
  errorCountsStore['4xx'] = 0;
  errorCountsStore['5xx'] = 0;
  delete process.env.METRICS_ENABLED;
});

describe('metricsMiddleware', () => {
  it('increments count after response finish', () => {
    const { req, res, next, emit } = makeReqRes('/api/players');
    metricsMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    emit('finish');
    const metrics = getMetrics();
    const key = Object.keys(metrics)[0];
    expect(metrics[key].count).toBe(1);
  });

  it('accumulates latency across multiple requests', () => {
    for (let i = 0; i < 3; i++) {
      const { req, res, next, emit } = makeReqRes('/api/scouts');
      metricsMiddleware(req, res, next);
      emit('finish');
    }
    const metrics = getMetrics();
    const key = Object.keys(metrics)[0];
    expect(metrics[key].count).toBe(3);
    expect(metrics[key].totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('skips collection when METRICS_ENABLED=false', () => {
    process.env.METRICS_ENABLED = 'false';
    const { req, res, next, emit } = makeReqRes('/api/players');
    metricsMiddleware(req, res, next);
    emit('finish');
    expect(Object.keys(metricsStore)).toHaveLength(0);
    expect(next).toHaveBeenCalled();
  });

  it('tracks different routes separately', () => {
    // req.route.path must be set to simulate an Express-matched route —
    // otherwise both requests collapse into the shared UNMATCHED_ROUTE_LABEL
    // bucket by design (see the cardinality guard below).
    const a = makeReqRes('/api/players');
    (a.req as Record<string, unknown>).route = { path: '/api/players' };
    const b = makeReqRes('/api/scouts');
    (b.req as Record<string, unknown>).route = { path: '/api/scouts' };
    metricsMiddleware(a.req, a.res, a.next);
    metricsMiddleware(b.req, b.res, b.next);
    a.emit('finish');
    b.emit('finish');
    const metrics = getMetrics();
    expect(Object.keys(metrics)).toHaveLength(2);
  });
});

describe('isMetricsEnabled', () => {
  it('returns true by default', () => {
    expect(isMetricsEnabled()).toBe(true);
  });

  it('returns false when METRICS_ENABLED=false', () => {
    process.env.METRICS_ENABLED = 'false';
    expect(isMetricsEnabled()).toBe(false);
  });
});

describe('http_errors_total counter', () => {
  it('increments 4xx counter on a 404 response', () => {
    const { req, res, next, emit } = makeReqRes('/api/players', 'GET', 404);
    metricsMiddleware(req, res, next);
    emit('finish');
    expect(getErrorMetrics()['4xx']).toBe(1);
    expect(getErrorMetrics()['5xx']).toBe(0);
  });

  it('increments 5xx counter on a 500 response', () => {
    const { req, res, next, emit } = makeReqRes('/api/players', 'GET', 500);
    metricsMiddleware(req, res, next);
    emit('finish');
    expect(getErrorMetrics()['5xx']).toBe(1);
    expect(getErrorMetrics()['4xx']).toBe(0);
  });

  it('does not increment error counters on 2xx responses', () => {
    const { req, res, next, emit } = makeReqRes('/api/players', 'GET', 200);
    metricsMiddleware(req, res, next);
    emit('finish');
    expect(getErrorMetrics()['4xx']).toBe(0);
    expect(getErrorMetrics()['5xx']).toBe(0);
  });

  it('does not increment error counters on 3xx responses', () => {
    const { req, res, next, emit } = makeReqRes('/api/players', 'GET', 301);
    metricsMiddleware(req, res, next);
    emit('finish');
    expect(getErrorMetrics()['4xx']).toBe(0);
    expect(getErrorMetrics()['5xx']).toBe(0);
  });

  it('accumulates error counts across multiple requests', () => {
    makeReqRes('/api/a', 'GET', 400).emit('finish');
    const r1 = makeReqRes('/api/b', 'GET', 400);
    metricsMiddleware(r1.req, r1.res, r1.next);
    r1.emit('finish');
    const r2 = makeReqRes('/api/c', 'GET', 503);
    metricsMiddleware(r2.req, r2.res, r2.next);
    r2.emit('finish');
    expect(getErrorMetrics()['4xx']).toBe(1);
    expect(getErrorMetrics()['5xx']).toBe(1);
  });
});

// ─── Unbounded cardinality guard ─────────────────────────────────────────────

describe('metricsMiddleware — unmatched route bucketing', () => {
  beforeEach(() => {
    Object.keys(metricsStore).forEach((k) => delete metricsStore[k]);
    delete process.env.METRICS_ENABLED;
  });

  it('aggregates distinct unmatched paths under a single key', () => {
    const paths = [
      '/api/v1/nonexistent',
      '/api/v2/unknown',
      '/admin/hack',
      '/.env',
      '/wp-admin/login.php',
      '/random/path/12345',
    ];
    for (const p of paths) {
      const { req, res, next, emit } = makeReqRes(p);
      // req.route is undefined for unmatched requests — already the case in makeReqRes
      metricsMiddleware(req, res, next);
      emit('finish');
    }
    // All distinct unmatched paths must collapse to a single key
    const keys = Object.keys(metricsStore);
    expect(keys).toHaveLength(1);
  });

  it('the single unmatched key uses the UNMATCHED_ROUTE_LABEL constant', () => {
    const { UNMATCHED_ROUTE_LABEL } = require('../../src/middleware/metrics');
    const { req, res, next, emit } = makeReqRes('/whatever/path');
    metricsMiddleware(req, res, next);
    emit('finish');
    const keys = Object.keys(metricsStore);
    expect(keys[0]).toContain(UNMATCHED_ROUTE_LABEL);
  });

  it('accumulates count across many distinct unmatched paths (not one entry per path)', () => {
    for (let i = 0; i < 100; i++) {
      const { req, res, next, emit } = makeReqRes(`/scanner/path/${i}`);
      metricsMiddleware(req, res, next);
      emit('finish');
    }
    // Should have exactly 1 key, not 100
    expect(Object.keys(metricsStore)).toHaveLength(1);
    const key = Object.keys(metricsStore)[0];
    expect(metricsStore[key].count).toBe(100);
  });

  it('keeps matched routes separate from unmatched routes', () => {
    // Matched route (req.route.path set)
    const matched = makeReqRes('/api/players');
    (matched.req as Record<string, unknown>).route = { path: '/api/players' };
    metricsMiddleware(matched.req, matched.res, matched.next);
    matched.emit('finish');

    // Unmatched route (req.route undefined, which is the default in makeReqRes)
    const unmatched = makeReqRes('/some/nonexistent/path');
    metricsMiddleware(unmatched.req, unmatched.res, unmatched.next);
    unmatched.emit('finish');

    expect(Object.keys(metricsStore)).toHaveLength(2);
    const matchedKey = Object.keys(metricsStore).find((k) => k.includes('/api/players'));
    expect(matchedKey).toBeDefined();
  });

  it('legitimate defined-route metrics still report per-route granularity', () => {
    const routes = ['/api/players', '/api/scouts', '/auth/token'];
    for (const path of routes) {
      const { req, res, next, emit } = makeReqRes(path);
      (req as Record<string, unknown>).route = { path };
      metricsMiddleware(req, res, next);
      emit('finish');
    }
    // Each distinct matched route gets its own key
    expect(Object.keys(metricsStore)).toHaveLength(3);
  });
});
