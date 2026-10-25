import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import * as db from '../../src/db';
import * as indexer from '../../src/services/indexer';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const ADMIN_WALLET =
  process.env.ADMIN_WALLET ?? 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';

function adminToken(): string {
  return jwt.sign({ sub: ADMIN_WALLET, role: 'admin' }, SECRET, { expiresIn: '1h' });
}
function scoutToken(): string {
  return jwt.sign({ sub: 'G_SCOUT', role: 'scout' }, SECRET, { expiresIn: '1h' });
}

function makeRow(overrides: Partial<db.UnprocessedEventRow> = {}): db.UnprocessedEventRow {
  return {
    id: 7,
    type: 'brand_new_event',
    ledger: 123456,
    tx_hash: 'tx-abc',
    event_index: 2,
    contract_id: 'CCONTRACT',
    topic_json: JSON.stringify(['AAAA']),
    value_xdr: 'BBBB',
    reason: 'unknown_type',
    payload: JSON.stringify({ foo: 'bar' }),
    created_at: 1700000000000,
    ...overrides,
  };
}

jest.mock('../../src/db', () => ({
  listUnprocessedEvents: jest.fn(),
  getUnprocessedEventById: jest.fn(),
  deleteUnprocessedEvent: jest.fn(),
  insertUnprocessedEvent: jest.fn(),
  // db exports used by app startup / middleware
  queryEvents: jest.fn().mockReturnValue([]),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  getPlayerById: jest.fn().mockReturnValue(null),
  getEventsCount: jest.fn().mockReturnValue(0),
  fetchLastIndexedLedger: jest.fn().mockReturnValue(0),
  persistLastIndexedLedger: jest.fn(),
  insertAuditLog: jest.fn().mockReturnValue({ id: 1, hash: 'aaa', prev_hash: 'bbb' }),
  getAuditLogs: jest.fn().mockReturnValue([]),
  getAuditLogsCount: jest.fn().mockReturnValue(0),
  getAllAuditLogRows: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  replayUnprocessedEvent: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  checkHealth: jest.fn().mockResolvedValue(undefined),
}));

describe('GET /api/admin/indexer/unprocessed', () => {
  const mockList = db.listUnprocessedEvents as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockList.mockResolvedValue({ data: [], total: 0 });
  });

  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/admin/indexer/unprocessed');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/unprocessed')
      .set('Authorization', `Bearer ${scoutToken()}`);
    expect(res.status).toBe(403);
  });

  it('returns paginated unprocessed events for admin', async () => {
    mockList.mockResolvedValue({ data: [makeRow()], total: 1 });

    const res = await request(app)
      .get('/api/admin/indexer/unprocessed')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: 7,
      type: 'brand_new_event',
      txHash: 'tx-abc',
      eventIndex: 2,
      reason: 'unknown_type',
    });
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
  });

  it('passes reason filter through to the query', async () => {
    mockList.mockResolvedValue({ data: [], total: 0 });

    await request(app)
      .get('/api/admin/indexer/unprocessed?reason=decode_error&pageSize=5&page=2')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(mockList).toHaveBeenCalledWith({ limit: 5, offset: 5, reason: 'decode_error' });
  });

  it('rejects an invalid reason filter', async () => {
    const res = await request(app)
      .get('/api/admin/indexer/unprocessed?reason=bogus')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/indexer/unprocessed/:id/retry', () => {
  const mockReplay = indexer.replayUnprocessedEvent as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/admin/indexer/unprocessed/7/retry');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/unprocessed/7/retry')
      .set('Authorization', `Bearer ${scoutToken()}`);
    expect(res.status).toBe(403);
  });

  it('retries a stored event and reports applied', async () => {
    mockReplay.mockResolvedValue({ status: 'applied' });

    const res = await request(app)
      .post('/api/admin/indexer/unprocessed/7/retry')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 7, status: 'applied', detail: null });
    expect(mockReplay).toHaveBeenCalledWith(7);
  });

  it('reports still_failing with the failure detail', async () => {
    mockReplay.mockResolvedValue({ status: 'still_failing', detail: "type still unknown" });

    const res = await request(app)
      .post('/api/admin/indexer/unprocessed/7/retry')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('still_failing');
    expect(res.body.data.detail).toBe('type still unknown');
  });

  it('returns 404 for an unknown id', async () => {
    mockReplay.mockResolvedValue({ status: 'not_found' });

    const res = await request(app)
      .post('/api/admin/indexer/unprocessed/999999/retry')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric id', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/unprocessed/notanumber/retry')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
  });
});
