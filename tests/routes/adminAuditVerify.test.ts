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

describe('GET /api/admin/audit/verify (#464)', () => {
  beforeEach(async () => {
    await db.getDriver().run('DELETE FROM audit_log');
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/admin/audit/verify');
    expect(res.status).toBe(401);
    // auth.ts logs this rejection via a deliberately un-awaited
    // logAuditEvent(...).catch(() => {}) (best-effort — a 401 response
    // must not wait on a DB round-trip). Under PostgresDriver's network
    // round-trip that write can still be in flight when this test returns,
    // racing the next test's beforeEach DELETE — this settles it first so
    // later tests that assert exact row counts aren't polluted by a
    // straggling insert.
    await new Promise((r) => setTimeout(r, 100));
  });

  it('returns 403 for non-admin role', async () => {
    const token = await getNonAdminToken();
    const res = await request(app)
      .get('/api/admin/audit/verify')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    // See the 401 test above — same fire-and-forget audit write on the
    // auth_forbidden path.
    await new Promise((r) => setTimeout(r, 100));
  });

  it('reports a valid chain for an admin caller', async () => {
    await db.insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    await db.insertAuditLog({ action: 'contract_state_change', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });

    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // New shape (#764)
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.violations).toEqual([]);
    expect(res.body.data.rows_checked).toBe(2);
    expect(res.body.data.chain_length).toBe(2);
  });

  it('reports the broken row id after a row is tampered with', async () => {
    await db.insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    const second = await db.insertAuditLog({ action: 'contract_state_change', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });

    await db.getDriver().run('UPDATE audit_log SET action = ? WHERE id = ?', ['tampered', second.id]);

    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // New shape (#764)
    expect(res.body.data.status).toBe('tampered');
    expect(res.body.data.violations.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.violations[0].id).toBe(second.id);
  });

  it('reports chain_length 0 and status ok for an empty audit log', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.chain_length).toBe(0);
    expect(res.body.data.violations).toEqual([]);
    expect(res.body.data.rows_checked).toBe(0);
  });

  it('returns chain_length matching number of rows', async () => {
    await db.insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    await db.insertAuditLog({ action: 'contract_state_change', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });
    await db.insertAuditLog({ action: 'validator_registration', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-03T00:00:00.000Z' });

    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.chain_length).toBe(3);
  });
});

describe('GET /api/admin/audit/verify — new response shape (#764)', () => {
  beforeEach(async () => {
    await db.getDriver().run('DELETE FROM audit_log');
  });

  it('returns status ok for untampered chain', async () => {
    await db.insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    await db.insertAuditLog({ action: 'contract_state_change', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });

    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.chain_length).toBeGreaterThan(0);
    expect(res.body.data.rows_checked).toBeGreaterThan(0);
    expect(Array.isArray(res.body.data.violations)).toBe(true);
  });

  it('returns status tampered with violations array when row is corrupted', async () => {
    await db.insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    const second = await db.insertAuditLog({ action: 'contract_state_change', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });

    // Tamper with the second row's action column so its stored hash is wrong
    await db.getDriver().run('UPDATE audit_log SET action = ? WHERE id = ?', ['tampered_action', second.id]);

    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('tampered');
    expect(Array.isArray(res.body.data.violations)).toBe(true);
    expect(res.body.data.violations.length).toBeGreaterThanOrEqual(1);

    const v = res.body.data.violations[0];
    expect(v.id).toBe(second.id);
    expect(typeof v.expected_hash).toBe('string');
    expect(typeof v.stored_hash).toBe('string');
    expect(v.expected_hash).not.toBe(v.stored_hash);
    expect(v.audit_event_type).toBeDefined();
    expect(v.created_at).toBeDefined();
  });

  it('returns empty violations array for ok chain', async () => {
    await db.insertAuditLog({ action: 'validator_registration', adminWallet: 'GADMIN1', queryParams: { wallet: 'GXYZ' }, createdAt: '2025-01-05T00:00:00.000Z' });

    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.violations).toEqual([]);
  });

  it('returns chain_length 0 for empty audit log', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.chain_length).toBe(0);
    expect(res.body.data.violations).toEqual([]);
  });
});

describe('GET /api/admin/audit — includes hash chain columns', () => {
  beforeEach(async () => {
    await db.getDriver().run('DELETE FROM audit_log');
  });

  it('returns hash/prev_hash/event_source alongside each row', async () => {
    await db.insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });

    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(typeof res.body.data[0].hash).toBe('string');
    expect(res.body.data[0].hash).toHaveLength(64);
    expect(res.body.data[0].prev_hash).toBeDefined();
    expect(res.body.data[0].event_source).toBe('admin_action');
  });
});
