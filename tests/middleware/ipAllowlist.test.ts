import { Request, Response, NextFunction } from 'express';
import { ipAllowlistMiddleware, parseAllowlist } from '../../src/middleware/ipAllowlist';
import { logger } from '../../src/utils/logger';

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
  const ORIGINAL_ENV = process.env.ADMIN_IP_ALLOWLIST;

  afterEach(() => {
    // Restore env after each test
    if (ORIGINAL_ENV === undefined) {
      delete process.env.ADMIN_IP_ALLOWLIST;
    } else {
      process.env.ADMIN_IP_ALLOWLIST = ORIGINAL_ENV;
    }
  });

  // ------------------------------------------------------------------
  // Test 1: no allowlist configured → all IPs pass through
  // ------------------------------------------------------------------
  it('calls next() for any IP when ADMIN_IP_ALLOWLIST is not set', () => {
    delete process.env.ADMIN_IP_ALLOWLIST;

    const { req, res, next } = makeReqRes('203.0.113.42');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Test 2: allowlist is set and client IP is in the list → pass through
  // ------------------------------------------------------------------
  it('calls next() when client IP is explicitly in the allowlist', () => {
    process.env.ADMIN_IP_ALLOWLIST = '10.0.0.1,192.168.1.100';

    const { req, res, next } = makeReqRes('10.0.0.1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Test 3: allowlist is set and client IP is NOT in the list → 403
  // ------------------------------------------------------------------
  it('returns 403 when client IP is not in the allowlist', () => {
    process.env.ADMIN_IP_ALLOWLIST = '10.0.0.1,192.168.1.100';

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
  // Test 4: CIDR range matching
  // ------------------------------------------------------------------
  it('allows an IP that falls within a CIDR range', () => {
    process.env.ADMIN_IP_ALLOWLIST = '192.168.1.0/24';

    // 192.168.1.55 is inside 192.168.1.0/24
    const allowed = makeReqRes('192.168.1.55');
    ipAllowlistMiddleware(allowed.req, allowed.res, allowed.next);
    expect(allowed.next).toHaveBeenCalledTimes(1);
    expect(allowed.res.status).not.toHaveBeenCalled();
  });

  it('blocks an IP that falls outside the CIDR range', () => {
    process.env.ADMIN_IP_ALLOWLIST = '192.168.1.0/24';

    // 192.168.2.1 is outside 192.168.1.0/24
    const blocked = makeReqRes('192.168.2.1');
    ipAllowlistMiddleware(blocked.req, blocked.res, blocked.next);
    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.res.status).toHaveBeenCalledWith(403);
  });

  // ------------------------------------------------------------------
  // Test 5: X-Forwarded-For header is respected
  // ------------------------------------------------------------------
  it('uses X-Forwarded-For to determine the client IP', () => {
    // TRUSTED_PROXY_COUNT defaults to 1 in ipExtractor.ts.
    // With header "198.51.100.5, 10.10.10.1" (client, proxy) and
    // TRUSTED_PROXY_COUNT=1, the real IP is at index length-1-1 = 0,
    // so the real IP is 198.51.100.5.
    process.env.TRUSTED_PROXY_COUNT = '1';
    process.env.ADMIN_IP_ALLOWLIST = '198.51.100.5';

    const { req, res, next } = makeReqRes('10.10.10.1', '198.51.100.5, 10.10.10.1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();

    // Cleanup TRUSTED_PROXY_COUNT
    delete process.env.TRUSTED_PROXY_COUNT;
  });

  it('blocks a forwarded IP that is not in the allowlist', () => {
    process.env.TRUSTED_PROXY_COUNT = '1';
    process.env.ADMIN_IP_ALLOWLIST = '198.51.100.5';

    // The client IP extracted from X-Forwarded-For will be 203.0.113.7
    const { req, res, next } = makeReqRes('10.10.10.1', '203.0.113.7, 10.10.10.1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);

    delete process.env.TRUSTED_PROXY_COUNT;
  });

  // ------------------------------------------------------------------
  // Test 6: IPv6 client IP must be rejected explicitly, not silently
  // miscomputed to 0.
  // ------------------------------------------------------------------
  it('rejects an IPv6 client IP explicitly instead of silently coercing it to 0', () => {
    // 0.0.0.0/0 would match every IPv4 address (and would also have
    // matched the old NaN|0 -> 0 coercion for an IPv6 client).
    process.env.ADMIN_IP_ALLOWLIST = '0.0.0.0/0';

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
  // Test 7: Invalid CIDR entries log a startup warning but do not crash
  // ------------------------------------------------------------------
  it('logs a warning and skips invalid CIDR entries without crashing', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => false);

    // "999.999.999.999/24" is not a valid CIDR; "10.0.0.1" is valid.
    process.env.ADMIN_IP_ALLOWLIST = '999.999.999.999/24,10.0.0.1';

    const { req, res, next } = makeReqRes('10.0.0.1');
    expect(() => ipAllowlistMiddleware(req, res, next)).not.toThrow();

    // Valid entry still allows the request through
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();

    // A warning was logged for the invalid entry
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ entry: '999.999.999.999/24' })
    );

    warnSpy.mockRestore();
  });

  it('logs a warning for an invalid plain IP entry', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => false);

    process.env.ADMIN_IP_ALLOWLIST = 'not-an-ip,192.168.1.1';

    const { req, res, next } = makeReqRes('192.168.1.1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ entry: 'not-an-ip' })
    );

    warnSpy.mockRestore();
  });

  it('calls next() when all entries are invalid (behaves as if allowlist is unset)', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => false);

    process.env.ADMIN_IP_ALLOWLIST = 'bad-entry,also-bad';

    const { req, res, next } = makeReqRes('1.2.3.4');
    ipAllowlistMiddleware(req, res, next);

    // Falls through to next() because the valid allowlist is empty
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  // ------------------------------------------------------------------
  // Test 8: IPv4-mapped IPv6 addresses are handled transparently
  // ------------------------------------------------------------------
  it('allows an IPv4-mapped IPv6 address that matches a plain IPv4 allowlist entry', () => {
    process.env.ADMIN_IP_ALLOWLIST = '10.0.0.5';

    // ::ffff:10.0.0.5 is the IPv4-mapped IPv6 form of 10.0.0.5
    const { req, res, next } = makeReqRes('::ffff:10.0.0.5');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows an IPv4-mapped IPv6 address that falls within a CIDR range', () => {
    process.env.ADMIN_IP_ALLOWLIST = '10.0.0.0/8';

    const { req, res, next } = makeReqRes('::ffff:10.0.0.5');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks an IPv4-mapped IPv6 address outside the CIDR range', () => {
    process.env.ADMIN_IP_ALLOWLIST = '192.168.1.0/24';

    // ::ffff:10.0.0.5 → 10.0.0.5, which is outside 192.168.1.0/24
    const { req, res, next } = makeReqRes('::ffff:10.0.0.5');
    ipAllowlistMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // ------------------------------------------------------------------
  // Test 9: 10.0.0.5 matches 10.0.0.0/8 (acceptance criteria)
  // ------------------------------------------------------------------
  it('10.0.0.5 matches allowlist entry 10.0.0.0/8', () => {
    process.env.ADMIN_IP_ALLOWLIST = '10.0.0.0/8';

    const { req, res, next } = makeReqRes('10.0.0.5');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('192.168.2.1 does not match 192.168.1.0/24 (acceptance criteria)', () => {
    process.env.ADMIN_IP_ALLOWLIST = '192.168.1.0/24';

    const { req, res, next } = makeReqRes('192.168.2.1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ------------------------------------------------------------------
// parseAllowlist unit tests
// ------------------------------------------------------------------
describe('parseAllowlist', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => false);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns valid exact IPs unchanged', () => {
    const result = parseAllowlist('10.0.0.1,192.168.0.1');
    expect(result).toEqual(['10.0.0.1', '192.168.0.1']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns valid CIDR ranges unchanged', () => {
    const result = parseAllowlist('10.0.0.0/8,192.168.1.0/24');
    expect(result).toEqual(['10.0.0.0/8', '192.168.1.0/24']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('filters out invalid entries and warns about each one', () => {
    const result = parseAllowlist('bad,10.0.0.1,also-bad');
    expect(result).toEqual(['10.0.0.1']);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ entry: 'bad' }));
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ entry: 'also-bad' }));
  });

  it('ignores whitespace-only entries without warning', () => {
    const result = parseAllowlist('  ,10.0.0.1,  ');
    expect(result).toEqual(['10.0.0.1']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns empty array when all entries are invalid', () => {
    const result = parseAllowlist('not-valid,999.0.0.0/99');
    expect(result).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('accepts /0 prefix (match all IPv4)', () => {
    const result = parseAllowlist('0.0.0.0/0');
    expect(result).toEqual(['0.0.0.0/0']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('rejects prefix > 32', () => {
    const result = parseAllowlist('10.0.0.0/33');
    expect(result).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ entry: '10.0.0.0/33' }));
  });
});

