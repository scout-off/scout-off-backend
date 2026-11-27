import type { Request, Response, NextFunction } from 'express';
import { InMemoryRateLimitStore } from '../../src/middleware/inMemoryRateLimitStore';
import {
  _setLockoutStore,
  AUTH_FAIL_THRESHOLD,
  AUTH_FAIL_WINDOW_MS,
  AUTH_LOCKOUT_BASE_MS,
  AUTH_LOCKOUT_MAX_MS,
  checkAuthLockout,
  computeLockoutMs,
  enforceAuthLockout,
  isAccountLocked,
  recordAuthFailure,
  resetAuthFailures,
} from '../../src/middleware/authFailureLockout';
import { extractAccount } from '../../src/services/sep10';
import { insertAuditLog } from '../../src/db';

jest.mock('../../src/config', () => ({
  __esModule: true,
  default: {
    rateLimit: { enabled: true },
    authLockout: { threshold: 5, windowMs: 15 * 60 * 1000, baseMs: 30_000, maxMs: 15 * 60 * 1000 },
  },
}));
jest.mock('../../src/services/sep10', () => ({ extractAccount: jest.fn() }));
jest.mock('../../src/services/redis', () => ({ getRedisClient: jest.fn(() => null) }));
jest.mock('../../src/db', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));

const wallet = 'G' + 'A'.repeat(55);
const extract = extractAccount as jest.Mock;
const audit = insertAuditLog as jest.Mock;
function response() {
  const res = {
    set: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}
function request(transaction?: unknown): Request {
  return { body: { transaction } } as unknown as Request;
}
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-23T12:00:00Z'));
  _setLockoutStore(new InMemoryRateLimitStore());
  extract.mockReset().mockReturnValue(wallet);
  audit.mockReset().mockResolvedValue(undefined);
});
afterEach(() => jest.useRealTimers());

describe('lockout duration and store state', () => {
  it('starts at the configured duration and doubles until the cap', () => {
    expect(computeLockoutMs(AUTH_FAIL_THRESHOLD)).toBe(
      Math.min(AUTH_LOCKOUT_BASE_MS, AUTH_LOCKOUT_MAX_MS),
    );
    expect(computeLockoutMs(AUTH_FAIL_THRESHOLD + 1)).toBe(
      Math.min(AUTH_LOCKOUT_BASE_MS * 2, AUTH_LOCKOUT_MAX_MS),
    );
    expect(computeLockoutMs(AUTH_FAIL_THRESHOLD + 100)).toBe(AUTH_LOCKOUT_MAX_MS);
  });

  it('never locks an account that has not had a failure, even after repeated checks', async () => {
    expect(await isAccountLocked(wallet)).toEqual({ locked: false });
    expect(await isAccountLocked(wallet)).toEqual({ locked: false });
    expect(await isAccountLocked('')).toEqual({ locked: false });
  });

  it('does not lock before the threshold and audits only the first lockout', async () => {
    for (let i = 0; i < AUTH_FAIL_THRESHOLD - 1; i++) await recordAuthFailure(wallet, '127.0.0.1');
    expect(await isAccountLocked(wallet)).toEqual({ locked: false });
    expect(audit).not.toHaveBeenCalled();
    await recordAuthFailure(wallet, '127.0.0.1', 'correlation');
    expect((await isAccountLocked(wallet)).locked).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({ action: 'auth_lockout', adminWallet: wallet });
    await recordAuthFailure(wallet, '127.0.0.1');
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('extends actual lock duration on additional failures', async () => {
    for (let i = 0; i < AUTH_FAIL_THRESHOLD; i++) await recordAuthFailure(wallet, 'ip');
    const first = await isAccountLocked(wallet);
    expect(first.locked).toBe(true);
    await recordAuthFailure(wallet, 'ip');
    const second = await isAccountLocked(wallet);
    expect(second.locked).toBe(true);
    if (first.locked && second.locked && AUTH_LOCKOUT_MAX_MS > AUTH_LOCKOUT_BASE_MS) {
      expect(second.retryAfterSec).toBeGreaterThanOrEqual(first.retryAfterSec);
    }
  });

  it('expires the failure window without creating a lockout from stale attempts', async () => {
    for (let i = 0; i < AUTH_FAIL_THRESHOLD - 1; i++) await recordAuthFailure(wallet, 'ip');
    jest.setSystemTime(Date.now() + AUTH_FAIL_WINDOW_MS + 1);
    await recordAuthFailure(wallet, 'ip');
    expect(await isAccountLocked(wallet)).toEqual({ locked: false });
  });

  it('resets both counters after a successful token exchange', async () => {
    for (let i = 0; i < AUTH_FAIL_THRESHOLD; i++) await recordAuthFailure(wallet, 'ip');
    expect((await isAccountLocked(wallet)).locked).toBe(true);
    await resetAuthFailures(wallet);
    expect(await isAccountLocked(wallet)).toEqual({ locked: false });
    await recordAuthFailure(wallet, 'ip');
    if (AUTH_FAIL_THRESHOLD > 1) expect(await isAccountLocked(wallet)).toEqual({ locked: false });
  });

  it('ignores empty account identifiers', async () => {
    await recordAuthFailure('', 'ip');
    await resetAuthFailures('');
    expect(await isAccountLocked('')).toEqual({ locked: false });
    expect(audit).not.toHaveBeenCalled();
  });

  it('keeps the token exchange available on Redis/store failures (fail-open)', async () => {
    _setLockoutStore({ increment: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    expect(await isAccountLocked(wallet)).toEqual({ locked: false });
    await expect(recordAuthFailure(wallet, 'ip')).resolves.toBeUndefined();
    await expect(resetAuthFailures(wallet)).resolves.toBeUndefined();
  });

  it('does not block authentication if audit persistence fails', async () => {
    audit.mockRejectedValueOnce(new Error('db down'));
    for (let i = 0; i < AUTH_FAIL_THRESHOLD; i++) await recordAuthFailure(wallet, 'ip');
    expect((await isAccountLocked(wallet)).locked).toBe(true);
  });
});

describe('enforceAuthLockout and checkAuthLockout middleware', () => {
  it('allows a request without a transaction', () => {
    const next = jest.fn();
    enforceAuthLockout(request(), response() as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a malformed challenge to reach normal validation', () => {
    extract.mockImplementationOnce(() => {
      throw new Error('bad XDR');
    });
    const next = jest.fn();
    enforceAuthLockout(request('bad'), response() as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a challenge whose account cannot be extracted', () => {
    extract.mockReturnValueOnce(null);
    const next = jest.fn();
    enforceAuthLockout(request('xdr'), response() as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a below-threshold exchange', async () => {
    const next = jest.fn();
    const res = response();
    enforceAuthLockout(request('xdr'), res as unknown as Response, next);
    await drain();
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 429 AUTH_LOCKED with Retry-After measured in seconds', async () => {
    for (let i = 0; i < AUTH_FAIL_THRESHOLD; i++) await recordAuthFailure(wallet, 'ip');
    const next = jest.fn();
    const res = response();
    enforceAuthLockout(request('xdr'), res as unknown as Response, next);
    await drain();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.set).toHaveBeenCalledWith('Retry-After', expect.stringMatching(/^\d+$/));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_LOCKED' }));
  });

  it('fails open on store rejection from the middleware', async () => {
    _setLockoutStore({ increment: jest.fn().mockRejectedValue(new Error('redis lost')) });
    const next = jest.fn();
    enforceAuthLockout(request('xdr'), response() as unknown as Response, next);
    await drain();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes a request without a transaction through the older check middleware', () => {
    const next = jest.fn();
    checkAuthLockout(request(), response() as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes malformed XDR through the older check middleware', () => {
    extract.mockImplementationOnce(() => {
      throw new Error('bad XDR');
    });
    const next = jest.fn();
    checkAuthLockout(request('bad'), response() as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes missing account through the older check middleware', () => {
    extract.mockReturnValueOnce(null);
    const next = jest.fn();
    checkAuthLockout(request('xdr'), response() as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('handles store failures in the older check middleware', async () => {
    _setLockoutStore({ increment: jest.fn().mockRejectedValue(new Error('down')) });
    const next = jest.fn();
    checkAuthLockout(request('xdr'), response() as unknown as Response, next);
    await drain();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
