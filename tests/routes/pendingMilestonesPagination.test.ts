/**
 * Tests for issue #1135:
 * Pagination and filtering on GET /api/validators/milestones/pending.
 *
 * The controller delegates filtering + pagination to db.getPendingMilestones
 * (a SQL query joining pending_milestones + players), so this suite mocks that
 * helper and asserts the query options are forwarded and the response envelope
 * (total / page / pageSize / hasMore) is shaped correctly. The SQL itself is
 * covered by tests/db integration tests.
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmTestCid123'),
}));

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn(),
  getPendingMilestones: jest.fn(),
  getDriver: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(undefined) }),
  insertAuditLog: jest.fn().mockResolvedValue({
    id: 1,
    action: 'pending_milestones_viewed',
    admin_wallet: '',
    query_params: '{}',
    created_at: new Date().toISOString(),
    prev_hash: '0'.repeat(64),
    hash: 'mock-hash-1',
    event_source: 'app_event',
  }),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/cache', () => ({
  getPlayerListLastModified: jest.fn(() => 0),
  __setPlayerListLastModifiedForTests: jest.fn(),
  invalidateMilestoneCache: jest.fn(),
}));

import { getPendingMilestones } from '../../src/db';
const mockGetPendingMilestones = getPendingMilestones as jest.Mock;

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const VALIDATOR_TOKEN = makeToken(
  'GVALIDATOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'validator',
);

function row(overrides: Record<string, unknown> = {}) {
  return {
    milestone_id: `m-${Math.random()}`,
    player_id: 'player-1',
    validator_wallet: 'GVALIDATOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    milestone_type: 'performance',
    evidence_uri: 'QmEvidence',
    submitted_at: 1700000000,
    ...overrides,
  };
}

/** Emulate the SQL helper: slice `all` by the requested page/pageSize. */
function paginated(all: ReturnType<typeof row>[], page = 1, pageSize = 20) {
  const offset = (page - 1) * pageSize;
  return { data: all.slice(offset, offset + pageSize), total: all.length };
}

beforeEach(() => {
  mockGetPendingMilestones.mockReset();
});

describe('GET /api/validators/milestones/pending — pagination', () => {
  it('returns paginated results with total and hasMore', async () => {
    const all = Array.from({ length: 25 }, (_, i) => row({ milestone_id: `m${i}` }));
    mockGetPendingMilestones.mockImplementation((opts) =>
      paginated(all, opts.page, opts.pageSize),
    );

    const res = await request(app)
      .get('/api/validators/milestones/pending?page=1&pageSize=10')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.total).toBe(25);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(10);
    expect(res.body.hasMore).toBe(true);
    expect(mockGetPendingMilestones).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 10 }),
    );
  });

  it('returns hasMore=false on last page', async () => {
    const all = Array.from({ length: 5 }, (_, i) => row({ milestone_id: `m${i}` }));
    mockGetPendingMilestones.mockImplementation((opts) =>
      paginated(all, opts.page, opts.pageSize),
    );

    const res = await request(app)
      .get('/api/validators/milestones/pending?page=1&pageSize=20')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.hasMore).toBe(false);
  });

  it('returns empty data on out-of-range page', async () => {
    const all = [row()];
    mockGetPendingMilestones.mockImplementation((opts) =>
      paginated(all, opts.page, opts.pageSize),
    );

    const res = await request(app)
      .get('/api/validators/milestones/pending?page=99&pageSize=20')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(1);
    expect(res.body.hasMore).toBe(false);
  });

  it('rejects pageSize above max (100)', async () => {
    mockGetPendingMilestones.mockResolvedValue({ data: [], total: 0 });
    const res = await request(app)
      .get('/api/validators/milestones/pending?pageSize=101')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(400);
    expect(mockGetPendingMilestones).not.toHaveBeenCalled();
  });
});

describe('GET /api/validators/milestones/pending — filters', () => {
  beforeEach(() => {
    mockGetPendingMilestones.mockResolvedValue({ data: [row()], total: 1 });
  });

  it('forwards the region filter', async () => {
    const res = await request(app)
      .get('/api/validators/milestones/pending?region=EU')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(mockGetPendingMilestones).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'EU' }),
    );
  });

  it('forwards the position filter', async () => {
    const res = await request(app)
      .get('/api/validators/milestones/pending?position=Striker')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(mockGetPendingMilestones).toHaveBeenCalledWith(
      expect.objectContaining({ position: 'Striker' }),
    );
  });

  it('forwards submittedAfter as a number', async () => {
    const res = await request(app)
      .get('/api/validators/milestones/pending?submittedAfter=1700000050')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(mockGetPendingMilestones).toHaveBeenCalledWith(
      expect.objectContaining({ submittedAfter: 1700000050 }),
    );
  });

  it('forwards submittedBefore as a number', async () => {
    const res = await request(app)
      .get('/api/validators/milestones/pending?submittedBefore=1700000150')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(mockGetPendingMilestones).toHaveBeenCalledWith(
      expect.objectContaining({ submittedBefore: 1700000150 }),
    );
  });

  it('combines region and position filters', async () => {
    const res = await request(app)
      .get('/api/validators/milestones/pending?region=EU&position=Midfielder')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(mockGetPendingMilestones).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'EU', position: 'Midfielder' }),
    );
  });

  it('default (no params) returns first page of 20', async () => {
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
    expect(res.body.total).toBe(1);
  });
});
