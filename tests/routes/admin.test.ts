import request from 'supertest';
import app from '../../src/index';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';

async function getToken(role: string): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app).post('/auth/token').send({ transaction: tx.toXDR(), role });
  return tokenRes.body.token;
}

const VALID_WALLET = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

// ─── Security headers ─────────────────────────────────────────────────────────

describe('Security headers', () => {
  it('sets required security headers on all responses', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBeDefined();
  });
});

// ─── Admin validator registry ─────────────────────────────────────────────────

describe('POST /api/admin/validators/register', () => {
  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post('/api/admin/validators/register')
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const token = await getToken('validator');
    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid wallet address', async () => {
    const token = await getToken('admin');
    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: 'NOTAVALIDADDRESS' });
    expect(res.status).toBe(400);
  });

  it('returns 202 for valid admin request', async () => {
    const token = await getToken('admin');
    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/admin/validators/revoke', () => {
  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const token = await getToken('scout');
    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(403);
  });

  it('returns 202 for valid admin request', async () => {
    const token = await getToken('admin');
    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
  });
});
