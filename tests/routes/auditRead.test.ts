import request from 'supertest';
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import app from '../../src/app';
import config from '../../src/config';
import { getDriver } from '../../src/db';

async function getToken(role: 'admin' | 'scout'): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXdr(), role });
  return tokenRes.body.token;
}

async function findAuditAction(action: string, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await getDriver().get<{ id: number; admin_wallet: string }>(
      'SELECT id, admin_wallet FROM audit_log WHERE action = ?',
      [action],
    );
    if (row) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

describe('sensitive read route wiring (#1531)', () => {
  const originalEnabled = config.auditReads.enabled;

  beforeAll(() => {
    config.auditReads.enabled = true;
  });

  afterAll(() => {
    config.auditReads.enabled = originalEnabled;
  });

  beforeEach(async () => {
    await getDriver().run('DELETE FROM audit_log');
  });

  it('records a successful admin audit-trail read and leaves the chain verifiable', async () => {
    const token = await getToken('admin');

    const res = await request(app)
      .get('/api/admin/audit/trail')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const row = await findAuditAction('read:admin_audit_trail');
    expect(row).toBeDefined();
    expect(row?.admin_wallet).toBeTruthy();

    // Read entries are inserted into the same hash chain as every other event.
    const verify = await request(app)
      .get('/api/admin/audit/verify')
      .set('Authorization', `Bearer ${token}`);
    expect(verify.status).toBe(200);
    expect(verify.body.data.status).toBe('ok');
  });

  it('does not record a forbidden (403) read', async () => {
    const token = await getToken('scout');

    const res = await request(app)
      .get('/api/admin/audit/trail')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);

    // auth_forbidden is logged by the auth middleware; the read is not.
    expect(await findAuditAction('read:admin_audit_trail', 150)).toBeUndefined();
  });

  it('records a failed (4xx) read nowhere in the audit log', async () => {
    const token = await getToken('admin');

    const res = await request(app)
      .get('/api/admin/ip-reputation/not-an-ip')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);

    expect(await findAuditAction('read:ip_reputation', 150)).toBeUndefined();
  });
});
