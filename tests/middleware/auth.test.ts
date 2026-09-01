import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, requireRole } from '../../src/middleware/auth';
import * as auditService from '../../src/services/audit';
import * as tokenBlocklist from '../../src/services/tokenBlocklist';

const SECRET = 'test-secret';
const PREV_SECRET = 'old-test-secret';
process.env.JWT_SECRET = SECRET;
process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

function makeReqRes(token?: string, path = '/test') {
  const req = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    path,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

function sign(payload: object, secret = SECRET, expiresIn: string | number = '1h') {
  return jwt.sign(payload, secret, { expiresIn } as jwt.SignOptions);
}

/** Wait for the async revocation-check promise to settle inside the middleware */
function flushPromises() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('requireAuth', () => {
  it('calls next() for a valid JWT', async () => {
    const token = sign({ sub: 'GTEST', role: 'player' });
    const { req, res, next } = makeReqRes(token);
    requireAuth(req, res, next);
    await flushPromises();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.account).toBe('GTEST');
  });

  it('returns 401 when Authorization header is missing', async () => {
    const { req, res, next } = makeReqRes();
    requireAuth(req, res, next);
    await flushPromises();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid token', async () => {
    const { req, res, next } = makeReqRes('not.a.valid.token');
    requireAuth(req, res, next);
    await flushPromises();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an expired token', async () => {
    const token = sign({ sub: 'GTEST' }, SECRET, -1); // already expired
    const { req, res, next } = makeReqRes(token);
    requireAuth(req, res, next);
    await flushPromises();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('creates an audit event with action:auth_failed on missing token', async () => {
    const spy = jest.spyOn(auditService, 'logAuditEvent');
    const { req, res, next } = makeReqRes(undefined, '/api/scouts/wallet/subscription');
    requireAuth(req, res, next);
    await flushPromises();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth_failed',
        path: '/api/scouts/wallet/subscription',
        reason: 'Missing auth token',
      })
    );
    spy.mockRestore();
  });

  it('creates an audit event with action:auth_failed on invalid token', async () => {
    const spy = jest.spyOn(auditService, 'logAuditEvent');
    const { req, res, next } = makeReqRes('bad.token.here');
    requireAuth(req, res, next);
    await flushPromises();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth_failed', reason: 'Invalid or expired token' })
    );
    spy.mockRestore();
  });

  it('does not include raw JWT in the audit event', async () => {
    const spy = jest.spyOn(auditService, 'logAuditEvent');
    const { req, res, next } = makeReqRes('bad.token.here');
    requireAuth(req, res, next);
    await flushPromises();
    const call = spy.mock.calls[0][0];
    expect(JSON.stringify(call)).not.toContain('bad.token.here');
    spy.mockRestore();
  });

  // ── Revocation checks ──────────────────────────────────────────────────────

  it('returns 401 when the token JTI has been revoked', async () => {
    const jti = 'test-jti-revoked';
    const token = jwt.sign({ sub: 'GTEST', role: 'player', jti }, SECRET, { expiresIn: '1h' });
    const { req, res, next } = makeReqRes(token);

    jest.spyOn(tokenBlocklist, 'isTokenRevoked').mockResolvedValueOnce(true);

    requireAuth(req, res, next);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when the token JTI is NOT revoked', async () => {
    const jti = 'test-jti-valid';
    const token = jwt.sign({ sub: 'GTEST', role: 'player', jti }, SECRET, { expiresIn: '1h' });
    const { req, res, next } = makeReqRes(token);

    jest.spyOn(tokenBlocklist, 'isTokenRevoked').mockResolvedValueOnce(false);

    requireAuth(req, res, next);
    await flushPromises();

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.account).toBe('GTEST');
  });

  it('fails open (calls next) when the revocation check itself throws (Redis + DB down)', async () => {
    const jti = 'test-jti-error';
    const token = jwt.sign({ sub: 'GTEST', role: 'player', jti }, SECRET, { expiresIn: '1h' });
    const { req, res, next } = makeReqRes(token);

    jest.spyOn(tokenBlocklist, 'isTokenRevoked').mockRejectedValueOnce(new Error('store unavailable'));

    requireAuth(req, res, next);
    await flushPromises();

    // Fail-open: legitimate traffic must not be blocked when the store is down
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalledWith(401);
  });
});

describe('requireRole', () => {
  it('calls next() when role matches', async () => {
    const token = sign({ sub: 'GTEST', role: 'validator' });
    const { req, res, next } = makeReqRes(token);
    requireRole('validator')(req, res, next);
    await flushPromises();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 403 when role does not match', async () => {
    const token = sign({ sub: 'GTEST', role: 'player' });
    const { req, res, next } = makeReqRes(token);
    requireRole('validator')(req, res, next);
    await flushPromises();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const { req, res, next } = makeReqRes();
    requireRole('validator')(req, res, next);
    await flushPromises();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an expired token', async () => {
    const token = sign({ sub: 'GTEST', role: 'validator' }, SECRET, -1);
    const { req, res, next } = makeReqRes(token);
    requireRole('validator')(req, res, next);
    await flushPromises();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for a token with a manually set past exp claim', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 7200;
    const token = jwt.sign({ sub: 'GTEST', role: 'validator', exp: pastExp }, SECRET);
    const { req, res, next } = makeReqRes(token);
    requireRole('validator')(req, res, next);
    await flushPromises();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('creates an audit event with action:auth_forbidden on role mismatch', async () => {
    const spy = jest.spyOn(auditService, 'logAuditEvent');
    const token = sign({ sub: 'GWALLET', role: 'player' });
    const { req, res, next } = makeReqRes(token, '/api/admin/stats');
    requireRole('admin')(req, res, next);
    await flushPromises();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth_forbidden',
        path: '/api/admin/stats',
        requiredRole: 'admin',
        reason: 'Insufficient permissions',
      })
    );
    spy.mockRestore();
  });

  it('creates an audit event with action:auth_failed on missing token for requireRole', async () => {
    const spy = jest.spyOn(auditService, 'logAuditEvent');
    const { req, res, next } = makeReqRes(undefined, '/api/admin/stats');
    requireRole('admin')(req, res, next);
    await flushPromises();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth_failed',
        requiredRole: 'admin',
        reason: 'Missing auth token',
      })
    );
    spy.mockRestore();
  });

  it('returns 401 when token JTI is revoked in requireRole', async () => {
    const jti = 'test-jti-role-revoked';
    const token = jwt.sign({ sub: 'GTEST', role: 'validator', jti }, SECRET, { expiresIn: '1h' });
    const { req, res, next } = makeReqRes(token);

    jest.spyOn(tokenBlocklist, 'isTokenRevoked').mockResolvedValueOnce(true);

    requireRole('validator')(req, res, next);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('token rejection matrix (#1220)', () => {
  const revokedJti = 'test-jti-matrix-revoked';
  const revokedToken = jwt.sign({ sub: 'GTEST', role: 'player', jti: revokedJti }, SECRET, { expiresIn: '1h' });

  it.each([
    ['missing token', undefined, 'Missing auth token'],
    ['malformed token', 'not.a.valid.token', 'Invalid or expired token'],
    ['expired token', sign({ sub: 'GTEST' }, SECRET, -1), 'Invalid or expired token'],
    ['wrong-signature token', sign({ sub: 'GTEST' }, 'wrong-secret'), 'Invalid or expired token'],
    ['revoked token', revokedToken, 'Token has been revoked'],
  ])('returns 401 with the documented error for a %s', async (_label, token, expectedError) => {
    if (token === revokedToken) {
      jest.spyOn(tokenBlocklist, 'isTokenRevoked').mockResolvedValueOnce(true);
    }
    const { req, res, next } = makeReqRes(token);
    requireAuth(req, res, next);
    await flushPromises();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expectedError }));
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for a valid, non-revoked token', async () => {
    const token = sign({ sub: 'GTEST', role: 'player' });
    const { req, res, next } = makeReqRes(token);
    requireAuth(req, res, next);
    await flushPromises();
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('JWT key rotation (#273)', () => {
  afterEach(() => {
    delete process.env.JWT_SECRET_PREVIOUS;
    // Reset the config module so jwtSecretPrevious is re-read
    jest.resetModules();
  });

  it('accepts a token signed with the current JWT_SECRET', async () => {
    const token = sign({ sub: 'GTEST', role: 'player' }, SECRET);
    const { req, res, next } = makeReqRes(token);
    requireAuth(req, res, next);
    await flushPromises();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accepts a token signed with JWT_SECRET_PREVIOUS during rotation window', async () => {
    process.env.JWT_SECRET_PREVIOUS = PREV_SECRET;
    // Re-import to pick up the new env value
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireAuth: requireAuthFresh } = require('../../src/middleware/auth');
    const token = jwt.sign({ sub: 'GTEST', role: 'player' }, PREV_SECRET, { expiresIn: '1h' });
    const { req, res, next } = makeReqRes(token);
    requireAuthFresh(req, res, next);
    await flushPromises();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 401 for a token signed with an unknown secret', async () => {
    process.env.JWT_SECRET_PREVIOUS = PREV_SECRET;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireAuth: requireAuthFresh } = require('../../src/middleware/auth');
    const token = jwt.sign({ sub: 'GTEST', role: 'player' }, 'completely-unknown-secret', { expiresIn: '1h' });
    const { req, res, next } = makeReqRes(token);
    requireAuthFresh(req, res, next);
    await flushPromises();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
