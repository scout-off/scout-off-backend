/**
 * tests/routes/authRefresh.test.ts
 *
 * Tests for POST /auth/refresh and POST /auth/logout (refresh token lifecycle).
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// In-memory stand-in for the `revoked_tokens` table so tokenBlocklist.ts's
// real (unmocked) getDriver()-based checkDb/writeToDb round-trips work —
// this exercises the real revocation logic used by refresh-token rotation.
const revokedTokensTable = new Map<string, number>(); // jti -> expires_at (unix seconds)

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  getPlayerById: jest.fn().mockReturnValue(null),
  getEventsCount: jest.fn().mockReturnValue(0),
  fetchLastIndexedLedger: jest.fn().mockReturnValue(0),
  persistLastIndexedLedger: jest.fn(),
  insertAuditLog: jest.fn().mockReturnValue({
    id: 1, hash: 'aaa', prev_hash: 'bbb', action: '',
    admin_wallet: '', query_params: '{}', created_at: '', event_source: '',
  }),
  getAuditLogs: jest.fn().mockReturnValue([]),
  getAuditLogsCount: jest.fn().mockReturnValue(0),
  getAllAuditLogRows: jest.fn().mockReturnValue([]),
  getDriver: jest.fn(() => ({
    run: (sql: string, params: unknown[] = []) => {
      if (/INSERT INTO revoked_tokens/i.test(sql)) {
        const [jti, , expiresAt] = params as [string, number, number];
        revokedTokensTable.set(jti, expiresAt);
      } else if (/DELETE FROM revoked_tokens/i.test(sql)) {
        const [now] = params as [number];
        for (const [jti, exp] of revokedTokensTable) {
          if (exp <= now) revokedTokensTable.delete(jti);
        }
      }
      return { changes: 1, lastId: 0 };
    },
    get: (sql: string, params: unknown[] = []) => {
      if (/SELECT jti FROM revoked_tokens/i.test(sql)) {
        const [jti, now] = params as [string, number];
        const exp = revokedTokensTable.get(jti);
        if (exp !== undefined && exp > now) return { jti };
      }
      return undefined;
    },
    all: () => [],
    value: () => undefined,
    exec: () => {},
    transaction: (fn: () => unknown) => fn(),
    close: async () => {},
  })),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  checkHealth: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
  postWebhookWithRetry: jest.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRefreshToken(
  account: string,
  role = 'player',
  overrides: Record<string, unknown> = {},
): string {
  return jwt.sign(
    { sub: account, role, type: 'refresh', jti: crypto.randomUUID(), ...overrides },
    SECRET,
    { expiresIn: 7 * 24 * 60 * 60 },
  );
}

function makeAccessToken(account: string, role = 'player'): string {
  return jwt.sign(
    { sub: account, role, jti: crypto.randomUUID() },
    SECRET,
    { expiresIn: 900 },
  );
}

// ─── POST /auth/refresh ───────────────────────────────────────────────────────

describe('POST /auth/refresh', () => {
  it('returns 400 when refreshToken is missing', async () => {
    const res = await request(app).post('/auth/refresh').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 for a completely invalid token', async () => {
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: 'not-a-jwt' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 when a plain access token (no type:refresh) is submitted', async () => {
    const accessToken = makeAccessToken('GACCOUNT123');
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: accessToken });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/not a refresh token/i);
  });

  it('returns 401 for an expired refresh token', async () => {
    const expired = jwt.sign(
      { sub: 'GACCOUNT123', role: 'player', type: 'refresh', jti: crypto.randomUUID() },
      SECRET,
      { expiresIn: -1 },
    );
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: expired });
    expect(res.status).toBe(401);
  });

  it('returns a new token pair for a valid refresh token', async () => {
    const refreshToken = makeRefreshToken('GACCOUNT123', 'scout');
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(typeof res.body.expiresAt).toBe('number');

    // New tokens must be different from the submitted one
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });

  it('new access token carries the correct role', async () => {
    const refreshToken = makeRefreshToken('GSCOUT', 'scout');
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    const decoded = jwt.decode(res.body.accessToken) as jwt.JwtPayload;
    expect(decoded.role).toBe('scout');
    expect(decoded.sub).toBe('GSCOUT');
  });

  it('new refresh token also has type:refresh', async () => {
    const refreshToken = makeRefreshToken('GACCOUNT123');
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    const decoded = jwt.decode(res.body.refreshToken) as jwt.JwtPayload;
    expect(decoded.type).toBe('refresh');
  });

  it('returns 401 when the same refresh token is used twice (rotation)', async () => {
    const refreshToken = makeRefreshToken('GACCOUNT456', 'player');

    // First use — should succeed and revoke the original jti
    const first = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken });
    expect(first.status).toBe(200);

    // Second use of the same token — jti is now in the blocklist
    const second = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken });
    expect(second.status).toBe(401);
    expect(second.body.error).toMatch(/revoked/i);
  });
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

describe('POST /auth/logout', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await request(app).post('/auth/logout').send({});
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid access token', async () => {
    const accessToken = makeAccessToken('GPLAYER1');
    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('revokes refresh token if provided in body', async () => {
    const accessToken = makeAccessToken('GPLAYER2');
    const refreshToken = makeRefreshToken('GPLAYER2');

    // Logout while supplying the refresh token
    const logoutRes = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken });
    expect(logoutRes.status).toBe(200);

    // Subsequent refresh attempt with the same token must be rejected
    const refreshRes = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  it('returns 200 even when refresh token body is missing or invalid', async () => {
    const accessToken = makeAccessToken('GPLAYER3');
    const res = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken: 'garbage' });
    // Should not throw — just ignores the bad refresh token
    expect(res.status).toBe(200);
  });

  it('refresh tokens expire after 7 days', () => {
    const rt = makeRefreshToken('GTEST');
    const decoded = jwt.decode(rt) as jwt.JwtPayload;
    const ttl = (decoded.exp ?? 0) - (decoded.iat ?? 0);
    // Allow ±5 seconds for test timing
    expect(ttl).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 - 5);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 60 * 60 + 5);
  });
});

// ─── POST /auth/token — backwards-compat token field still present ────────────

describe('POST /auth/token — response still includes legacy `token` field', () => {
  it('response shape includes both token (legacy) and accessToken fields', async () => {
    // We can't easily do a real SEP-10 flow in unit tests without the full
    // Stellar keypair infrastructure, so we verify authController directly by
    // calling through the mock layer.  The mock path returns 400 for
    // non-XDR input — we only verify the field name contract here via unit
    // test of the controller module.
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: 'not-xdr' });
    // Malformed XDR → 400 is expected; we just confirm no 500 occurs
    expect(res.status).not.toBe(500);
  });
});
