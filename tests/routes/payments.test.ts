import request from 'supertest';
import app from '../../src/index';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';

async function getToken(role = 'scout'): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app).post('/auth/token').send({ transaction: tx.toXDR(), role });
  return tokenRes.body.token;
}

const WALLET = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

describe('GET /api/scouts/:wallet/payments', () => {
  it('returns 401 without auth token', async () => {
    const res = await request(app).get(`/api/scouts/${WALLET}/payments`);
    expect(res.status).toBe(401);
  });

  it('returns 200 with empty array for wallet with no history', async () => {
    const token = await getToken('scout');
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/payments`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('accepts date filter query params without error', async () => {
    const token = await getToken('scout');
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/payments?from=2024-01-01&to=2024-12-31`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
