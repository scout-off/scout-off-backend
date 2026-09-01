/**
 * #302 — getAllEvents date filtering uses created_at
 *
 * Verifies:
 *  - GET /api/admin/events?startDate=X&endDate=Y returns only events in the range
 *  - Events with created_at outside the range are excluded
 */

import request from 'supertest';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import app from '../../src/app';
import { EventRecord } from '../../src/types';
import type { EventsPageFilter, EventExportRow } from '../../src/db';

// Jan 2024 = 1704067200000 ms
const JAN_2024_MS = 1704067200000;
// Jul 2024 = 1719792000000 ms
const JUL_2024_MS = 1719792000000;
// Jan 2025 = 1735689600000 ms
const JAN_2025_MS = 1735689600000;

const ROW_JAN: EventExportRow = {
  type: 'player_registered',
  ledger: 100,
  createdAt: JAN_2024_MS,
  payload: { player_id: 'p-jan' },
};

const ROW_JUL: EventExportRow = {
  type: 'player_registered',
  ledger: 200,
  createdAt: JUL_2024_MS,
  payload: { player_id: 'p-jul' },
};

const ROW_JAN25: EventExportRow = {
  type: 'player_registered',
  ledger: 300,
  createdAt: JAN_2025_MS,
  payload: { player_id: 'p-jan25' },
};

const ALL_ROWS = [ROW_JAN, ROW_JUL, ROW_JAN25];

/** Filter rows as SQL would — used by the mock implementations below. */
function applyFilter(rows: EventExportRow[], filter: EventsPageFilter): EventExportRow[] {
  return rows.filter((r) => {
    if (filter.type && r.type !== filter.type) return false;
    if (filter.startDate && (r.createdAt ?? 0) < filter.startDate.getTime()) return false;
    if (filter.endDate && (r.createdAt ?? 0) > filter.endDate.getTime()) return false;
    return true;
  });
}

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getEventsCount: jest.fn().mockReturnValue(3),
  getEventsPage: jest.fn(),
  countEventsFiltered: jest.fn(),
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

import { getEventsPage, countEventsFiltered } from '../../src/db';
const mockGetEventsPage = getEventsPage as jest.Mock;
const mockCountEventsFiltered = countEventsFiltered as jest.Mock;

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

describe('#302 GET /api/admin/events — date filter uses created_at', () => {
  beforeEach(() => {
    // Mock getEventsPage to filter rows the same way SQL would
    mockGetEventsPage.mockImplementation(
      (filter: EventsPageFilter, limit: number, offset: number) =>
        applyFilter(ALL_ROWS, filter).slice(offset, offset + limit),
    );
    // Mock countEventsFiltered to return the count after filtering
    mockCountEventsFiltered.mockImplementation(
      (filter: EventsPageFilter) => applyFilter(ALL_ROWS, filter).length,
    );
  });

  it('returns only events within startDate–endDate range', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`)
      .query({
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-12-31T23:59:59.999Z',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Only JAN_2024 and JUL_2024 fall within 2024; JAN_2025 is excluded.
    const ids = res.body.data.map((e: EventRecord) => e.payload.player_id);
    expect(ids).toContain('p-jan');
    expect(ids).toContain('p-jul');
    expect(ids).not.toContain('p-jan25');
  });

  it('returns all events when no date filter is applied', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  it('excludes all events when range has no matches', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`)
      .query({
        startDate: '2020-01-01T00:00:00.000Z',
        endDate: '2020-12-31T23:59:59.999Z',
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('total reflects filtered count not full table count', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`)
      .query({
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-12-31T23:59:59.999Z',
      });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2); // JAN + JUL only
  });

  it('accepts ?from and ?to as aliases for startDate/endDate', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`)
      .query({
        from: '2024-01-01T00:00:00.000Z',
        to: '2024-12-31T23:59:59.999Z',
      });

    expect(res.status).toBe(200);
    const ids = res.body.data.map((e: EventRecord) => e.payload.player_id);
    expect(ids).toContain('p-jan');
    expect(ids).toContain('p-jul');
    expect(ids).not.toContain('p-jan25');
  });
});
