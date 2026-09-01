import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

/** Create a signed JWT with the given sub and role. */
function makeToken(sub: string, role: string): string {
  return jwt.sign({ sub, role }, SECRET, { expiresIn: '1h' });
}

const ADMIN_WALLET = 'GADMINWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_WALLET = 'GOTHER1WALLET2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('POST /api/admin/introspect', () => {
  // ── 401 — no bearer token ───────────────────────────────────────────────────
  it('returns 401 with no auth token', async () => {
    const res = await request(app).post('/api/admin/introspect').send({});
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  // ── 403 — wrong role ────────────────────────────────────────────────────────
  it('returns 403 for non-admin role', async () => {
    const scoutToken = makeToken(OTHER_WALLET, 'scout');
    const res = await request(app)
      .post('/api/admin/introspect')
      .set('Authorization', `Bearer ${scoutToken}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  // ── 200 — admin sees their own claims ───────────────────────────────────────
  it('returns the decoded payload of the caller own bearer token', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .post('/api/admin/introspect')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sub).toBe(ADMIN_WALLET);
    expect(res.body.data.role).toBe('admin');
    expect(res.body.data.iat).toBeDefined();
    expect(res.body.data.exp).toBeDefined();
  });

  // ── body token field is completely ignored ──────────────────────────────────
  it('ignores a token field in the request body and returns the caller own claims', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    // Attempt to inspect another user's token via the request body
    const otherToken = makeToken(OTHER_WALLET, 'scout');

    const res = await request(app)
      .post('/api/admin/introspect')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ token: otherToken }); // body is ignored

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Must reflect the admin's own identity, NOT the other user's
    expect(res.body.data.sub).toBe(ADMIN_WALLET);
    expect(res.body.data.role).toBe('admin');
  });

  // ── admin cannot see another user's claims ──────────────────────────────────
  it('does not expose another user claims even when their token is sent in the body', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    const victimToken = makeToken(OTHER_WALLET, 'player');

    const res = await request(app)
      .post('/api/admin/introspect')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ token: victimToken });

    expect(res.status).toBe(200);
    // The response must NOT contain the other user's sub or role
    expect(res.body.data.sub).not.toBe(OTHER_WALLET);
    expect(res.body.data.role).not.toBe('player');
  });
});
