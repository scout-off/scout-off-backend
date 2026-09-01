import request from 'supertest';
import app from '../../src/app';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getEventsCount: jest.fn().mockReturnValue(0),
  countEventsFiltered: jest.fn().mockReturnValue(0),
  getEventsPage: jest.fn().mockReturnValue([]),
  fetchLastIndexedLedger: jest.fn().mockReturnValue(0),
  persistLastIndexedLedger: jest.fn(),
  getValidatorStats: jest.fn().mockReturnValue(null),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  getPlayerById: jest.fn().mockReturnValue(null),
  insertPlayerProfileHistory: jest.fn(),
  getAuditLogs: jest.fn().mockReturnValue([]),
  getAuditLogsCount: jest.fn().mockReturnValue(0),
  getAllAuditLogRows: jest.fn().mockReturnValue([]),
  // tokenBlocklist.ts is not mocked here, so requireRole()'s revocation check
  // hits the real checkDb() path via getDriver(); without this, getDriver()
  // is undefined and checkDb()'s fail-safe treats every token as revoked.
  getDriver: jest.fn(() => ({
    run: () => ({ changes: 0, lastId: 0 }),
    get: () => undefined,
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
  getAllValidators: jest.fn().mockReturnValue([]),
  getValidatorByWallet: jest.fn().mockReturnValue(null),
  insertValidator: jest.fn(),
  revokeValidatorRow: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  withdrawFees: jest.fn(),
  stellarHealth: jest.fn().mockResolvedValue('ok'),
  FeeWithdrawalError: class extends Error {},
  pauseContractOnChain: jest.fn(),
  unpauseContractOnChain: jest.fn(),
  registerValidatorOnChain: jest.fn(),
}));

jest.mock('../../src/services/audit', () => ({
  logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/admin/events - pagination', () => {
  it('returns pagination metadata with defaults', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.limit).toBe(20);
    expect(res.body.offset).toBe(0);
  });

  it('respects limit and offset params', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events?limit=5&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.offset).toBe(0);
    expect(res.body.data.length).toBeLessThanOrEqual(5);
  });

  it('returns 400 for limit exceeding max (100)', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events?limit=200')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for negative offset', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events?offset=-1')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for non-numeric limit', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events?limit=abc')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('respects pageSize param (modern pagination)', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(10);
    expect(res.body.page).toBe(1);
  });

  it('returns 400 for pageSize exceeding max (200)', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events?pageSize=201')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns totalPages in response', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.totalPages).toBe('number');
  });
});
