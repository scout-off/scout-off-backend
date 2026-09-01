/**
 * Tests for GET /api/admin/audit/trail (#832)
 *
 * Covers: event-type filtering, date-range filtering, pagination,
 * AuditEntry response shape, and validation of unknown eventType values.
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import * as db from '../../src/db';

// Stub out Soroban calls that require a platform keypair in tests.
jest.mock('../../src/services/stellar', () => ({
  ...jest.requireActual('../../src/services/stellar'),
  pauseContractOnChain: jest.fn().mockResolvedValue({ transactionId: 'mock-pause-txid' }),
  unpauseContractOnChain: jest.fn().mockResolvedValue({ transactionId: 'mock-unpause-txid' }),
}));

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
// Must match ADMIN_WALLET default set in tests/setup.ts.
const ADMIN_WALLET = 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';

function getAdminToken(): string {
  return jwt.sign({ sub: ADMIN_WALLET, role: 'admin' }, SECRET, { expiresIn: '1h' });
}

function getNonAdminToken(): string {
  return jwt.sign({ sub: 'GNON_ADMIN_WALLET', role: 'scout' }, SECRET, { expiresIn: '1h' });
}

describe('GET /api/admin/audit/trail (#832)', () => {
  beforeEach(() => {
    // Seed a known set of audit log rows for filtering tests.
    db.insertAuditLog({
      action: 'player_registered',
      adminWallet: 'GWALLET1',
      queryParams: { validatorWallet: 'GTARGET1' },
      createdAt: '2025-03-01T10:00:00.000Z',
      eventSource: 'app_event',
    });
    db.insertAuditLog({
      action: 'validator_registration',
      adminWallet: 'GADMIN1',
      queryParams: { validatorWallet: 'GVAL1' },
      createdAt: '2025-03-02T10:00:00.000Z',
      eventSource: 'admin_action',
    });
    db.insertAuditLog({
      action: 'player_registered',
      adminWallet: 'GWALLET2',
      queryParams: { validatorWallet: 'GTARGET2' },
      createdAt: '2025-03-03T10:00:00.000Z',
      eventSource: 'app_event',
    });
    db.insertAuditLog({
      action: 'contract_state_change',
      adminWallet: 'GADMIN1',
      queryParams: {},
      createdAt: '2025-03-04T10:00:00.000Z',
      eventSource: 'admin_action',
    });
    db.insertAuditLog({
      action: 'fee_withdrawal_attempt',
      adminWallet: 'GADMIN2',
      queryParams: { recipient: 'GRECIPIENT1' },
      createdAt: '2025-03-05T10:00:00.000Z',
      eventSource: 'admin_action',
    });
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/admin/audit/trail');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin role', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail')
      .set('Authorization', `Bearer ${getNonAdminToken()}`);
    expect(res.status).toBe(403);
  });

  // ── Basic response shape ──────────────────────────────────────────────────

  it('returns 200 with correct envelope for admin', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.page).toBe('number');
    expect(typeof res.body.pageSize).toBe('number');
  });

  it('each AuditEntry has the expected shape', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail?pageSize=1')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(200);
    const entry = res.body.data[0];
    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('event_type');
    expect(entry).toHaveProperty('actor_wallet');
    expect(entry).toHaveProperty('target_id');
    expect(entry).toHaveProperty('metadata');
    expect(entry).toHaveProperty('created_at');
    expect(entry).toHaveProperty('hash');
    expect(typeof entry.id).toBe('number');
    expect(typeof entry.event_type).toBe('string');
    expect(typeof entry.actor_wallet).toBe('string');
    expect(typeof entry.created_at).toBe('string');
    expect(typeof entry.hash).toBe('string');
  });

  // ── eventType filtering ───────────────────────────────────────────────────

  it('?eventType=player_registered returns only player_registered entries', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail?eventType=player_registered')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(
      res.body.data.every((e: { event_type: string }) => e.event_type === 'player_registered')
    ).toBe(true);
  });

  it('?eventType=validator_registration returns only validator_registration entries', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail?eventType=validator_registration')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(200);
    expect(
      res.body.data.every((e: { event_type: string }) => e.event_type === 'validator_registration')
    ).toBe(true);
  });

  it('returns 400 for an unknown eventType', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail?eventType=unknown_event_xyz')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe('string');
  });

  // ── Date-range filtering ──────────────────────────────────────────────────

  it('?from= filters out entries before the start date', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail?from=2025-03-03T00:00:00.000Z')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(200);
    expect(
      res.body.data.every(
        (e: { created_at: string }) => e.created_at >= '2025-03-03T00:00:00.000Z'
      )
    ).toBe(true);
  });

  it('?to= filters out entries after the end date', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail?to=2025-03-02T23:59:59.999Z')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(200);
    expect(
      res.body.data.every(
        (e: { created_at: string }) => e.created_at <= '2025-03-02T23:59:59.999Z'
      )
    ).toBe(true);
  });

  it('?from=&to= combined restricts to the given window', async () => {
    const res = await request(app)
      .get(
        '/api/admin/audit/trail?from=2025-03-02T00:00:00.000Z&to=2025-03-03T23:59:59.999Z'
      )
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(200);
    for (const entry of res.body.data as { created_at: string }[]) {
      expect(entry.created_at >= '2025-03-02T00:00:00.000Z').toBe(true);
      expect(entry.created_at <= '2025-03-03T23:59:59.999Z').toBe(true);
    }
  });

  it('returns 400 when from is after to', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail?from=2025-03-10T00:00:00.000Z&to=2025-03-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for an invalid from date', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail?from=not-a-date')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  it('defaults to page=1 and pageSize=50', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(50);
  });

  it('respects a custom pageSize', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail?pageSize=2')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(2);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
  });

  it('page 2 returns a different set of items than page 1', async () => {
    // Seed enough entries so that page 2 is non-empty with pageSize=2.
    db.insertAuditLog({ action: 'player_search', adminWallet: 'GX1', queryParams: {}, createdAt: '2025-04-01T00:00:00.000Z', eventSource: 'app_event' });
    db.insertAuditLog({ action: 'player_search', adminWallet: 'GX2', queryParams: {}, createdAt: '2025-04-02T00:00:00.000Z', eventSource: 'app_event' });
    db.insertAuditLog({ action: 'player_search', adminWallet: 'GX3', queryParams: {}, createdAt: '2025-04-03T00:00:00.000Z', eventSource: 'app_event' });

    const page1 = await request(app)
      .get('/api/admin/audit/trail?eventType=player_search&pageSize=2&page=1')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    const page2 = await request(app)
      .get('/api/admin/audit/trail?eventType=player_search&pageSize=2&page=2')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    expect(page1.body.page).toBe(1);
    expect(page2.body.page).toBe(2);

    // The IDs on page 2 should not overlap with page 1.
    const ids1 = new Set(page1.body.data.map((e: { id: number }) => e.id));
    const ids2 = page2.body.data.map((e: { id: number }) => e.id);
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }
  });

  it('total reflects the full unfiltered count when no eventType is given', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail?pageSize=1')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(5); // at least the 5 seeded rows
  });

  it('returns 400 for pageSize > 100', async () => {
    const res = await request(app)
      .get('/api/admin/audit/trail?pageSize=101')
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ── eventType + date-range combined ──────────────────────────────────────

  it('combines eventType and date-range filters correctly', async () => {
    const res = await request(app)
      .get(
        '/api/admin/audit/trail?eventType=player_registered&from=2025-03-01T00:00:00.000Z&to=2025-03-02T23:59:59.999Z'
      )
      .set('Authorization', `Bearer ${getAdminToken()}`);

    expect(res.status).toBe(200);
    for (const entry of res.body.data as { event_type: string; created_at: string }[]) {
      expect(entry.event_type).toBe('player_registered');
      expect(entry.created_at >= '2025-03-01T00:00:00.000Z').toBe(true);
      expect(entry.created_at <= '2025-03-02T23:59:59.999Z').toBe(true);
    }
  });

  // ── v1 alias ──────────────────────────────────────────────────────────────

  it('is also reachable at /api/v1/admin/audit/trail', async () => {
    const res = await request(app)
      .get('/api/v1/admin/audit/trail')
      .set('Authorization', `Bearer ${getAdminToken()}`);
    expect(res.status).toBe(200);
  });
});
