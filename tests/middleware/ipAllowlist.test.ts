import { Request, Response, NextFunction } from 'express';
import { ipAllowlistMiddleware } from '../../src/middleware/ipAllowlist';
import config from '../../src/config';

/**
 * Build minimal mock req / res / next objects.
 *
 * @param remoteIp       - req.socket.remoteAddress value
 * @param xForwardedFor  - optional X-Forwarded-For header value
 */
function makeReqRes(remoteIp: string, xForwardedFor?: string) {
  const req = {
    method: 'GET',
    path: '/api/admin/stats',
    headers: xForwardedFor ? { 'x-forwarded-for': xForwardedFor } : {},
    socket: { remoteAddress: remoteIp },
  } as unknown as Request;

  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;

  const next = jest.fn() as NextFunction;

  return { req, res, next };
}

describe('ipAllowlistMiddleware', () => {
  // The allowlist is sourced from config.admin.ipAllowlist (validated once at
  // startup). Override it per test, then restore the default (empty = disabled).
  const originalAllowlist = config.admin.ipAllowlist;

  afterEach(() => {
    config.admin.ipAllowlist = originalAllowlist;
  });

  // ------------------------------------------------------------------
  // No allowlist configured → all IPs pass through
  // ------------------------------------------------------------------
  it('calls next() for any IP when the allowlist is empty (disabled)', () => {
    config.admin.ipAllowlist = [];

    const { req, res, next } = makeReqRes('203.0.113.42');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Allowlist set and client IP is in the list → pass through
  // ------------------------------------------------------------------
  it('calls next() when the client IP is explicitly in the allowlist', () => {
    config.admin.ipAllowlist = ['10.0.0.1', '192.168.1.100'];

    const { req, res, next } = makeReqRes('10.0.0.1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Allowlist set and client IP is NOT in the list → 403
  // ------------------------------------------------------------------
  it('returns 403 when the client IP is not in the allowlist', () => {
    config.admin.ipAllowlist = ['10.0.0.1', '192.168.1.100'];

    const { req, res, next } = makeReqRes('203.0.113.99');
    ipAllowlistMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Forbidden: IP not in allowlist',
    });
  });

  // ------------------------------------------------------------------
  // CIDR range matching
  // ------------------------------------------------------------------
  it('allows an IP that falls within a CIDR range', () => {
    config.admin.ipAllowlist = ['192.168.1.0/24'];

    const allowed = makeReqRes('192.168.1.55');
    ipAllowlistMiddleware(allowed.req, allowed.res, allowed.next);
    expect(allowed.next).toHaveBeenCalledTimes(1);
    expect(allowed.res.status).not.toHaveBeenCalled();
  });

  it('blocks an IP that falls outside the CIDR range', () => {
    config.admin.ipAllowlist = ['192.168.1.0/24'];

    const blocked = makeReqRes('192.168.2.1');
    ipAllowlistMiddleware(blocked.req, blocked.res, blocked.next);
    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.res.status).toHaveBeenCalledWith(403);
  });

  // ------------------------------------------------------------------
  // X-Forwarded-For is respected (ipExtractor uses TRUSTED_PROXY_COUNT=1,
  // its module-load default on this branch)
  // ------------------------------------------------------------------
  it('uses X-Forwarded-For to determine the client IP', () => {
    // With count=1, header "198.51.100.5, 10.10.10.1" → real IP at index 0.
    config.admin.ipAllowlist = ['198.51.100.5'];

    const { req, res, next } = makeReqRes('10.10.10.1', '198.51.100.5, 10.10.10.1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks a forwarded IP that is not in the allowlist', () => {
    // client IP extracted as 203.0.113.7 (index 0 with count=1)
    config.admin.ipAllowlist = ['198.51.100.5'];

    const { req, res, next } = makeReqRes('10.10.10.1', '203.0.113.7, 10.10.10.1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // ------------------------------------------------------------------
  // IPv6 client IP must be rejected explicitly, not silently coerced to 0
  // ------------------------------------------------------------------
  it('rejects an IPv6 client IP explicitly instead of silently coercing it to 0', () => {
    config.admin.ipAllowlist = ['0.0.0.0/0'];

    const { req, res, next } = makeReqRes('2001:db8::1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Forbidden: IPv6 addresses are not supported by the IP allowlist',
    });
  });

  // ------------------------------------------------------------------
  // IPv4-mapped IPv6 addresses are handled transparently
  // ------------------------------------------------------------------
  it('allows an IPv4-mapped IPv6 address that matches a plain IPv4 allowlist entry', () => {
    config.admin.ipAllowlist = ['10.0.0.5'];

    const { req, res, next } = makeReqRes('::ffff:10.0.0.5');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows an IPv4-mapped IPv6 address that falls within a CIDR range', () => {
    config.admin.ipAllowlist = ['10.0.0.0/8'];

    const { req, res, next } = makeReqRes('::ffff:10.0.0.5');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks an IPv4-mapped IPv6 address outside the CIDR range', () => {
    config.admin.ipAllowlist = ['192.168.1.0/24'];

    const { req, res, next } = makeReqRes('::ffff:10.0.0.5');
    ipAllowlistMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // ------------------------------------------------------------------
  // 10.0.0.5 matches 10.0.0.0/8 (acceptance criteria)
  // ------------------------------------------------------------------
  it('10.0.0.5 matches allowlist entry 10.0.0.0/8', () => {
    config.admin.ipAllowlist = ['10.0.0.0/8'];

    const { req, res, next } = makeReqRes('10.0.0.5');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('192.168.2.1 does not match 192.168.1.0/24 (acceptance criteria)', () => {
    config.admin.ipAllowlist = ['192.168.1.0/24'];

    const { req, res, next } = makeReqRes('192.168.2.1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
