import { Request, Response, NextFunction } from 'express';

// Must come before importing the middleware so the config is mocked at load time.
jest.mock('../../src/config', () => ({
  __esModule: true,
  default: { requestTimeoutMs: 100 },
}));

import { requestTimeout, createTimeout } from '../../src/middleware/timeout';

function makeReqRes() {
  const listeners: Record<string, (() => void)[]> = {};
  let statusCode = 0;
  let body: unknown;
  let _headersSent = false;

  const res = {
    get headersSent() { return _headersSent; },
    on(event: string, cb: () => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
    },
    status(code: number) { statusCode = code; return this; },
    json(data: unknown) { body = data; _headersSent = true; return this; },
    emit(event: string) { (listeners[event] ?? []).forEach(cb => cb()); },
    markSent() { _headersSent = true; },
    _getStatus: () => statusCode,
    _getBody: () => body,
  } as unknown as Response & {
    emit: (e: string) => void;
    markSent: () => void;
    _getStatus: () => number;
    _getBody: () => unknown;
  };

  const req = {} as Request;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

// ─── Legacy requestTimeout (global default) ───────────────────────────────────

describe('requestTimeout middleware', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('calls next()', () => {
    const { req, res, next } = makeReqRes();
    requestTimeout(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('responds 503 after the configured timeout elapses', () => {
    const { req, res, next } = makeReqRes();
    requestTimeout(req, res, next);
    jest.advanceTimersByTime(200);
    expect(res._getStatus()).toBe(503);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res._getBody() as any).code).toBe('REQUEST_TIMEOUT');
  });

  it('does not fire before the timeout', () => {
    const { req, res, next } = makeReqRes();
    requestTimeout(req, res, next);
    jest.advanceTimersByTime(50);
    expect(res._getStatus()).toBe(0);
  });

  it('does not send 503 after finish fires before the timeout', () => {
    const { req, res, next } = makeReqRes();
    requestTimeout(req, res, next);
    res.emit('finish');
    jest.advanceTimersByTime(200);
    // Timer was cleared on finish, so no 503
    expect(res._getStatus()).toBe(0);
  });

  it('does not send 503 if headers were already sent', () => {
    const { req, res, next } = makeReqRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).markSent();
    requestTimeout(req, res, next);
    jest.advanceTimersByTime(200);
    // headersSent=true prevents the json() call inside the timer
    expect(res._getBody()).toBeUndefined();
  });
});

// ─── createTimeout — per-route overrides ─────────────────────────────────────

describe('createTimeout(ms)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('returns a middleware function', () => {
    const mw = createTimeout(500);
    expect(typeof mw).toBe('function');
    expect(mw.length).toBe(3); // (req, res, next)
  });

  it('calls next() immediately', () => {
    const { req, res, next } = makeReqRes();
    createTimeout(500)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('fires 503 after the specified ms', () => {
    const { req, res, next } = makeReqRes();
    createTimeout(200)(req, res, next);
    jest.advanceTimersByTime(199);
    expect(res._getStatus()).toBe(0); // not yet
    jest.advanceTimersByTime(1);
    expect(res._getStatus()).toBe(503);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res._getBody() as any).code).toBe('REQUEST_TIMEOUT');
  });

  it('does not fire before the specified ms', () => {
    const { req, res, next } = makeReqRes();
    createTimeout(300)(req, res, next);
    jest.advanceTimersByTime(299);
    expect(res._getStatus()).toBe(0);
  });

  it('clears the timer on finish', () => {
    const { req, res, next } = makeReqRes();
    createTimeout(200)(req, res, next);
    res.emit('finish');
    jest.advanceTimersByTime(300);
    expect(res._getStatus()).toBe(0);
  });

  it('clears the timer on close', () => {
    const { req, res, next } = makeReqRes();
    createTimeout(200)(req, res, next);
    res.emit('close');
    jest.advanceTimersByTime(300);
    expect(res._getStatus()).toBe(0);
  });

  it('does not send 503 when headers are already sent at fire time', () => {
    const { req, res, next } = makeReqRes();
    createTimeout(200)(req, res, next);
    res.markSent();
    jest.advanceTimersByTime(300);
    expect(res._getBody()).toBeUndefined();
  });

  // ── Per-route override values ───────────────────────────────────────────────

  it('createTimeout(0) never fires — models POST /api/admin/reindex (no timeout)', () => {
    const { req, res, next } = makeReqRes();
    createTimeout(0)(req, res, next);
    // Advance far past any real timeout — nothing should fire
    jest.advanceTimersByTime(9_999_999);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res._getStatus()).toBe(0);
  });

  it('createTimeout(120_000) fires after 120 s — models GET /api/admin/events/export', () => {
    const { req, res, next } = makeReqRes();
    createTimeout(120_000)(req, res, next);
    jest.advanceTimersByTime(119_999);
    expect(res._getStatus()).toBe(0); // not yet
    jest.advanceTimersByTime(1);
    expect(res._getStatus()).toBe(503);
  });

  it('createTimeout(5_000) fires after 5 s — models GET /health/liveness and /health/readiness', () => {
    const { req, res, next } = makeReqRes();
    createTimeout(5_000)(req, res, next);
    jest.advanceTimersByTime(4_999);
    expect(res._getStatus()).toBe(0); // not yet
    jest.advanceTimersByTime(1);
    expect(res._getStatus()).toBe(503);
  });

  it('different instances are independent — one firing does not affect the other', () => {
    const r1 = makeReqRes();
    const r2 = makeReqRes();

    createTimeout(100)(r1.req, r1.res, r1.next);
    createTimeout(300)(r2.req, r2.res, r2.next);

    jest.advanceTimersByTime(150);
    expect(r1.res._getStatus()).toBe(503); // short timeout fired
    expect(r2.res._getStatus()).toBe(0);   // long timeout not yet

    jest.advanceTimersByTime(200);
    expect(r2.res._getStatus()).toBe(503); // long timeout now fired
  });
});
