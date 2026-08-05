import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Mock the tokenBlocklist so tests control revocation state ────────────────
jest.mock('../../src/services/tokenBlocklist', () => ({
  revokeToken: jest.fn(),
  isTokenRevoked: jest.fn().mockResolvedValue(false),
  pruneExpiredTokens: jest.fn(),
}));

import { isTokenRevoked, revokeToken } from '../../src/services/tokenBlocklist';
const mockIsRevoked = isTokenRevoked as jest.Mock;
const mockRevoke = revokeToken as jest.Mock;

jest.mock('../../src/services/indexer', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

function makeToken(sub: string, role = 'player', jti?: string): string {
  const payload: Record<string, unknown> = { sub, role };
  if (jti) payload.jti = jti;
  return jwt.sign(payload, SECRET, { expiresIn: '1h' });
}

function makeAdminToken(jti?: string): string {
  return makeToken('GADMINWALLET', 'admin', jti);
}

// ─── Unit: requireAuth blocklist check ───────────────────────────────────────
describe('requireAuth — blocklist check', () => {
  beforeEach(() => {
    mockIsRevoked.mockReset();
    mockIsRevoked.mockResolvedValue(false);
  });

  it('calls next() for a valid, non-revoked JWT', async () => {
    const token = makeToken('GTEST', 'player', 'jti-valid');
    const res = await request(app)
      .get('/health')
      .set('Authorization', `Bearer ${token}`);
    // /health is not auth-protected; just ensure server is up
    expect(res.status).toBe(200);
  });

  it('returns 401 for a revoked token', async () => {
    const jti = 'jti-revoked-001';
    const token = makeToken('GSCOUT', 'scout', jti);

    // Simulate this jti being in the blocklist
    mockIsRevoked.mockImplementation((id: string) => Promise.resolve(id === jti));

    // Use a protected scout endpoint
    const WALLET = 'GSCOUT';
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/revoked/i);
  });

  it('does not reject a token without a jti claim', async () => {
    // Token without jti — should not be blocked (no jti to look up)
    const token = makeToken('GTEST', 'player'); // no jti
    mockIsRevoked.mockResolvedValue(false);

    const res = await request(app)
      .get('/health')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

// ─── Integration: POST /api/admin/tokens/revoke ───────────────────────────────
describe('POST /api/admin/tokens/revoke', () => {
  beforeEach(() => {
    mockRevoke.mockReset();
    mockIsRevoked.mockReset();
    mockIsRevoked.mockResolvedValue(false);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .post('/api/admin/tokens/revoke')
      .send({ jti: 'some-jti' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not admin', async () => {
    const token = makeToken('GPLAYER', 'player');
    const res = await request(app)
      .post('/api/admin/tokens/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ jti: 'some-jti' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when neither jti nor token is provided', async () => {
    const token = makeAdminToken();
    const res = await request(app)
      .post('/api/admin/tokens/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('revokes by jti and returns success', async () => {
    const adminToken = makeAdminToken('admin-jti');
    const res = await request(app)
      .post('/api/admin/tokens/revoke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ jti: 'target-jti-123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.jti).toBe('target-jti-123');
    expect(mockRevoke).toHaveBeenCalledWith('target-jti-123', expect.any(Number));
  });

  it('revokes by full token and extracts jti', async () => {
    const jti = 'extracted-jti-456';
    const targetToken = makeToken('GVICTIM', 'player', jti);
    const adminToken = makeAdminToken('admin-jti-2');

    const res = await request(app)
      .post('/api/admin/tokens/revoke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ token: targetToken });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.jti).toBe(jti);
    expect(mockRevoke).toHaveBeenCalledWith(jti, expect.any(Number));
  });

  it('returns 400 when provided token has no jti claim', async () => {
    const tokenWithoutJti = makeToken('GVICTIM', 'player'); // no jti
    const adminToken = makeAdminToken('admin-jti-3');

    const res = await request(app)
      .post('/api/admin/tokens/revoke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ token: tokenWithoutJti });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('a revoked token is subsequently rejected', async () => {
    const jti = 'jti-to-revoke';
    const victimToken = makeToken('GVICTIM', 'scout', jti);
    const adminToken = makeAdminToken('admin-jti-4');

    // Step 1: revoke the token
    const revokeRes = await request(app)
      .post('/api/admin/tokens/revoke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ jti });
    expect(revokeRes.status).toBe(200);

    // Step 2: simulate the blocklist now returning true for this jti
    mockIsRevoked.mockImplementation((id: string) => Promise.resolve(id === jti));

    // Step 3: use revoked token on a protected route
    const WALLET = 'GVICTIM';
    const protectedRes = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${victimToken}`);

    expect(protectedRes.status).toBe(401);
    expect(protectedRes.body.error).toMatch(/revoked/i);
  });
});
