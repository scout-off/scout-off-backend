import request from 'supertest';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import app from '../../src/app';
import * as db from '../../src/db';

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

async function getNonAdminToken(): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXdr(), role: 'scout' });
  return tokenRes.body.token;
}

describe('GET /api/admin/audit (#345)', () => {
  beforeEach(() => {
    // Seed some audit log rows directly via DB helper
    db.insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    db.insertAuditLog({ action: 'contract_state_change', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });
    db.insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN2', queryParams: {}, createdAt: '2025-01-03T00:00:00.000Z' });
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/admin/audit');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const token = await getNonAdminToken();
    const res = await request(app)
      .get('/api/admin/audit')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns paginated audit log for admin', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.total).toBeGreaterThanOrEqual(3);
  });

  it('filters by action', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit?action=fee_history_query')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.every((r: { action: string }) => r.action === 'fee_history_query')).toBe(true);
  });

  it('filters by startDate', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit?startDate=2025-01-02T00:00:00.000Z')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.every((r: { created_at: string }) => r.created_at >= '2025-01-02T00:00:00.000Z')).toBe(true);
  });

  it('respects limit and offset pagination', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(0);
  });

  it('returns 400 for invalid limit', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit?limit=999')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
