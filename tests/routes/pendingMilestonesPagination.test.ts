/**
 * Tests for issue #1135:
 * Pagination and filtering on GET /api/validators/milestones/pending
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmTestCid123'),
}));

jest.mock('../../src/db', () => ({
  getEvents: jest.fn(),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/cache', () => ({
  invalidateMilestoneCache: jest.fn(),
}));

import { getEvents } from '../../src/db';
const mockGetEvents = getEvents as jest.Mock;

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const VALIDATOR_TOKEN = makeToken(
  'GVALIDATOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'validator',
);

function makeSubmitted(overrides: Record<string, unknown> = {}) {
  return {
    payload: {
      milestone_id: `m-${Math.random()}`,
      player_id: 'player-1',
      region: 'EU',
      position: 'Midfielder',
      validator: 'GVALIDATOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      created_at: 1700000000,
      evidence_uri: 'QmEvidence',
      ...overrides,
    },
  };
}

beforeEach(() => {
  mockGetEvents.mockReset();
});

describe('GET /api/validators/milestones/pending — pagination', () => {
  it('returns paginated results with total and hasMore', async () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      makeSubmitted({ milestone_id: `m${i}`, player_id: `player-${i}` })
    );
    mockGetEvents.mockImplementation((type: string) => {
      if (type === 'milestone_submitted') return items;
      if (type === 'milestone_approved') return [];
      return [];
    });

    const res = await request(app)
      .get('/api/validators/milestones/pending?page=1&pageSize=10')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.total).toBe(25);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(10);
    expect(res.body.hasMore).toBe(true);
  });

  it('returns hasMore=false on last page', async () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      makeSubmitted({ milestone_id: `m${i}` })
    );
    mockGetEvents.mockImplementation((type: string) => {
      if (type === 'milestone_submitted') return items;
      if (type === 'milestone_approved') return [];
      return [];
    });

    const res = await request(app)
      .get('/api/validators/milestones/pending?page=1&pageSize=20')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.hasMore).toBe(false);
  });

  it('returns empty data on out-of-range page', async () => {
    mockGetEvents.mockImplementation((type: string) => {
      if (type === 'milestone_submitted') return [makeSubmitted()];
      return [];
    });

    const res = await request(app)
      .get('/api/validators/milestones/pending?page=99&pageSize=20')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(1);
  });

  it('rejects pageSize above max (100)', async () => {
    mockGetEvents.mockReturnValue([]);
    const res = await request(app)
      .get('/api/validators/milestones/pending?pageSize=101')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/validators/milestones/pending — filters', () => {
  const now = 1700000000;
  const items = [
    makeSubmitted({ milestone_id: 'm1', region: 'EU', position: 'Midfielder', created_at: now }),
    makeSubmitted({ milestone_id: 'm2', region: 'NA', position: 'Striker', created_at: now + 100 }),
    makeSubmitted({ milestone_id: 'm3', region: 'EU', position: 'Striker', created_at: now + 200 }),
  ];

  beforeEach(() => {
    mockGetEvents.mockImplementation((type: string) => {
      if (type === 'milestone_submitted') return items;
      if (type === 'milestone_approved') return [];
      return [];
    });
  });

  it('filters by region', async () => {
    const res = await request(app)
      .get('/api/validators/milestones/pending?region=EU')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('filters by position', async () => {
    const res = await request(app)
      .get('/api/validators/milestones/pending?position=Striker')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('filters by submittedAfter', async () => {
    const res = await request(app)
      .get(`/api/validators/milestones/pending?submittedAfter=${now + 50}`)
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('filters by submittedBefore', async () => {
    const res = await request(app)
      .get(`/api/validators/milestones/pending?submittedBefore=${now + 150}`)
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('combines region and position filters', async () => {
    const res = await request(app)
      .get('/api/validators/milestones/pending?region=EU&position=Midfielder')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('default (no params) returns first page', async () => {
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
    expect(res.body.total).toBe(3);
  });
});
