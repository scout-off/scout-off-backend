/**
 * Tests for GET /api/admin/events keyset cursor pagination (#1140).
 *
 * Verifies that:
 *  - Requesting with ?cursor= returns a nextCursor token when more rows exist
 *  - The nextCursor can be used to fetch the subsequent page
 *  - Date-range filters work alongside cursor pagination
 *  - An invalid cursor value returns 400
 *  - OFFSET-based pagination still works (backwards compatibility)
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { encodeEventsCursor } from '../../src/db';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const adminToken = jwt.sign({ sub: 'GADMIN', role: 'admin' }, SECRET, { expiresIn: '1h' });

// ── DB mock ────────────────────────────────────────────────────────────────────
jest.mock('../../src/db', () => {
  const actual = jest.requireActual('../../src/db') as typeof import('../../src/db');

  // Five synthetic events with descending (ledger, id) values
  const EVENTS = [
    { id: 5, type: 'player_registered', ledger: 500, created_at: 5000, payload: JSON.stringify({ player_id: 'p5' }) },
    { id: 4, type: 'milestone_approved', ledger: 400, created_at: 4000, payload: JSON.stringify({ player_id: 'p4' }) },
    { id: 3, type: 'player_registered', ledger: 300, created_at: 3000, payload: JSON.stringify({ player_id: 'p3' }) },
    { id: 2, type: 'milestone_submitted', ledger: 200, created_at: 2000, payload: JSON.stringify({ player_id: 'p2' }) },
    { id: 1, type: 'scout_subscribed', ledger: 100, created_at: 1000, payload: JSON.stringify({ scout: 's1' }) },
  ];

  return {
    ...actual,
    // Keyset implementation (new)
    getEventsPageKeyset: jest.fn((filter: { type?: string; startDate?: Date; endDate?: Date }, limit: number, afterCursor: { ledger: number; id: number } | null) => {
      let rows = [...EVENTS];
      if (filter.type) rows = rows.filter((r) => r.type === filter.type);
      if (filter.startDate) rows = rows.filter((r) => r.created_at >= filter.startDate!.getTime());
      if (filter.endDate) rows = rows.filter((r) => r.created_at <= filter.endDate!.getTime());
      if (afterCursor) {
        rows = rows.filter(
          (r) => r.ledger < afterCursor.ledger || (r.ledger === afterCursor.ledger && r.id < afterCursor.id),
        );
      }
      // Already sorted DESC in the mock array
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const lastRow = pageRows[pageRows.length - 1];
      const nextCursor = hasMore && lastRow ? { ledger: lastRow.ledger, id: lastRow.id } : null;
      return {
        rows: pageRows.map((r) => ({
          type: r.type,
          ledger: r.ledger,
          createdAt: r.created_at,
          payload: JSON.parse(r.payload),
        })),
        nextCursor,
      };
    }),
    // Legacy offset (existing)
    getEventsPage: jest.fn(() => []),
    countEventsFiltered: jest.fn(() => 0),
    queryEvents: jest.fn().mockReturnValue([]),
    getPlayerById: jest.fn(),
    queryPlayers: jest.fn().mockReturnValue([]),
    countPlayers: jest.fn().mockReturnValue(0),
    insertOrUpdatePlayer: jest.fn(),
    insertPlayerProfileHistory: jest.fn(),
    getPlayerProfileHistory: jest.fn().mockReturnValue([]),
    countTrialOffersByPlayer: jest.fn().mockReturnValue(0),
    fetchLastIndexedLedger: jest.fn().mockReturnValue(0),
    persistLastIndexedLedger: jest.fn(),
    getValidatorStats: jest.fn().mockReturnValue({ total: 0, active: 0 }),
    getAuditLogs: jest.fn().mockReturnValue([]),
    getAuditLogsCount: jest.fn().mockReturnValue(0),
    getNewPlayersTimeSeries: jest.fn().mockReturnValue([]),
    getMilestonesApprovedTimeSeries: jest.fn().mockReturnValue([]),
    getContactUnlocksTimeSeries: jest.fn().mockReturnValue([]),
    getSubscriptionsStartedTimeSeries: jest.fn().mockReturnValue([]),
    getNewPlayersByRegionTimeSeries: jest.fn().mockReturnValue([]),
    insertFeeWithdrawal: jest.fn(),
  };
});

jest.mock('../../src/services/indexer', () => ({ indexEvents: jest.fn(), normalizeEventId: jest.fn(), getAllValidators: jest.fn().mockReturnValue([]), insertValidator: jest.fn(), revokeValidatorRow: jest.fn(), getValidatorByWallet: jest.fn() }));
jest.mock('../../src/services/stellar', () => ({ queryMilestones: jest.fn().mockResolvedValue([]), pauseContractOnChain: jest.fn(), unpauseContractOnChain: jest.fn(), registerValidatorOnChain: jest.fn(), revokeValidatorOnChain: jest.fn(), withdrawFees: jest.fn(), getFeeBalance: jest.fn().mockResolvedValue(0) }));
jest.mock('../../src/services/ipfs', () => ({ pinJson: jest.fn(), checkHealth: jest.fn().mockResolvedValue(undefined), gatewayUrl: jest.fn() }));
jest.mock('../../src/services/webhooks', () => ({ dispatchEventWebhook: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/services/tokenBlocklist', () => ({ revokeToken: jest.fn(), isTokenRevoked: jest.fn().mockReturnValue(false) }));
jest.mock('../../src/services/cache', () => ({ cacheGet: jest.fn().mockResolvedValue(null), cacheSet: jest.fn().mockResolvedValue(undefined), invalidatePlayerCache: jest.fn().mockResolvedValue(undefined) }));

describe('GET /api/admin/events — keyset cursor pagination (#1140)', () => {
  it('returns first page with nextCursor when more rows exist', async () => {
    const res = await request(app)
      .get('/api/admin/events?cursor=&pageSize=2')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.nextCursor).toBeDefined();
    expect(typeof res.body.nextCursor).toBe('string');
  });

  it('uses nextCursor to fetch the subsequent stable page', async () => {
    // First page
    const first = await request(app)
      .get('/api/admin/events?cursor=&pageSize=2')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(first.status).toBe(200);
    const nextCursor = first.body.nextCursor as string;
    expect(nextCursor).toBeDefined();

    // Second page
    const second = await request(app)
      .get(`/api/admin/events?cursor=${encodeURIComponent(nextCursor)}&pageSize=2`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(second.status).toBe(200);
    expect(second.body.data.length).toBeGreaterThan(0);

    // No overlap between first and second page
    const firstIds = (first.body.data as Array<{ payload: { player_id?: string } }>).map((e) => e.payload.player_id);
    const secondIds = (second.body.data as Array<{ payload: { player_id?: string } }>).map((e) => e.payload.player_id);
    const overlap = firstIds.filter((id) => secondIds.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it('returns no nextCursor on the last page', async () => {
    // Request all 5 rows in one page
    const res = await request(app)
      .get('/api/admin/events?cursor=&pageSize=10')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeUndefined();
  });

  it('filters by eventType alongside cursor', async () => {
    const res = await request(app)
      .get('/api/admin/events?cursor=&eventType=player_registered&pageSize=10')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const types = (res.body.data as Array<{ type: string }>).map((e) => e.type);
    expect(types.every((t) => t === 'player_registered')).toBe(true);
  });

  it('returns 400 for a malformed cursor', async () => {
    const res = await request(app)
      .get('/api/admin/events?cursor=not-valid-base64!!!')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('falls back to OFFSET pagination when no cursor param is present', async () => {
    const res = await request(app)
      .get('/api/admin/events?page=1&pageSize=5')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Legacy offset response includes these fields
    expect(res.body).toHaveProperty('limit');
    expect(res.body).toHaveProperty('offset');
  });
});
