import request from 'supertest';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import app from '../../src/app';
import { API_PREFIX, API_V1_PREFIX } from '../../src/config';

async function getAdminToken(): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXdr(), role: 'admin' });
  return tokenRes.body.token;
}

describe('API versioning (#40)', () => {
  let token: string;

  beforeAll(async () => {
    token = await getAdminToken();
  });

  it('API_PREFIX constant is /api', () => {
    expect(API_PREFIX).toBe('/api');
  });

  it('API_V1_PREFIX constant is /api/v1', () => {
    expect(API_V1_PREFIX).toBe('/api/v1');
  });

  it('/api/admin/stats and /api/v1/admin/stats return identical status', async () => {
    const [r1, r2] = await Promise.all([
      request(app).get('/api/admin/stats').set('Authorization', `Bearer ${token}`),
      request(app).get('/api/v1/admin/stats').set('Authorization', `Bearer ${token}`),
    ]);
    expect(r1.status).toBe(r2.status);
    expect(r1.body.success).toBe(r2.body.success);
  });

  it('/api/players and /api/v1/players return identical status', async () => {
    const [r1, r2] = await Promise.all([
      request(app).get('/api/players'),
      request(app).get('/api/v1/players'),
    ]);
    expect(r1.status).toBe(r2.status);
  });

  it('/api/admin/events and /api/v1/admin/events return identical status', async () => {
    const [r1, r2] = await Promise.all([
      request(app).get('/api/admin/events').set('Authorization', `Bearer ${token}`),
      request(app).get('/api/v1/admin/events').set('Authorization', `Bearer ${token}`),
    ]);
    expect(r1.status).toBe(r2.status);
  });
});
