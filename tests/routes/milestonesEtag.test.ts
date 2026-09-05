/**
 * Tests for ETag / conditional GET on GET /api/players/:playerId/milestones (#1139).
 *
 * Verifies:
 *  - 200 response carries an ETag header
 *  - If-None-Match with matching ETag returns 304 (no body)
 *  - ETag changes when a milestone is added (list changes → new ETag → 200)
 *  - Cache-Control header is set
 *  - 404 for non-existent player has no ETag
 */
import request from 'supertest';
import app from '../../src/app';

// ── DB & service mocks ─────────────────────────────────────────────────────────
const PLAYER = {
  player_id: 'milestone-etag-player-1',
  wallet: 'GMILESTONE1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  position: 'midfielder',
  region: 'EU',
  metadata_uri: 'QmTestCID',
  progress_level: 1,
  created_at: 1000,
  is_active: 1,
};

const MILESTONE_A = {
  milestone_id: 'm1',
  player_id: PLAYER.player_id,
  milestone_type: 'performance',
  evidence_uri: 'ipfs://QmA',
  approved: true,
  submittedAt: 1000,
  approvedAt: 2000,
  status: 'approved',
};

// Mutable so tests can swap it out
let mockMilestones: typeof MILESTONE_A[] = [MILESTONE_A];
let mockPlayer: typeof PLAYER | null = PLAYER;

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn((type?: string) => {
    if (!type) return mockMilestones.map((m) => ({ payload: m }));
    if (type === 'milestone_approved') return mockMilestones.map((m) => ({ payload: m }));
    if (type === 'milestone_submitted') return [];
    if (type === 'milestone_rejected') return [];
    return [];
  }),
  getPlayerById: jest.fn(() => mockPlayer),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  insertOrUpdatePlayer: jest.fn(),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  countTrialOffersByPlayer: jest.fn().mockReturnValue(0),
}));

jest.mock('../../src/services/stellar', () => ({
  queryMilestones: jest.fn().mockResolvedValue([]),
  updateProfile: jest.fn(),
}));
jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  checkHealth: jest.fn().mockResolvedValue(undefined),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
}));
jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));
jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/cache', () => ({
  getPlayerListLastModified: jest.fn(() => 0),
  __setPlayerListLastModifiedForTests: jest.fn(),
  cacheGet: jest.fn().mockResolvedValue(null),
  cacheSet: jest.fn().mockResolvedValue(undefined),
  invalidatePlayerCache: jest.fn().mockResolvedValue(undefined),
}));

const ENDPOINT = `/api/players/${PLAYER.player_id}/milestones`;

describe('GET /api/players/:playerId/milestones — ETag / 304 support (#1139)', () => {
  beforeEach(() => {
    mockPlayer = PLAYER;
    mockMilestones = [MILESTONE_A];
  });

  it('returns an ETag header on a 200 response', async () => {
    const res = await request(app).get(ENDPOINT);
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
    expect(typeof res.headers.etag).toBe('string');
  });

  it('returns Cache-Control: no-cache on a 200 response', async () => {
    const res = await request(app).get(ENDPOINT);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
  });

  it('returns 304 when If-None-Match matches the current ETag', async () => {
    const first = await request(app).get(ENDPOINT);
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;

    const second = await request(app)
      .get(ENDPOINT)
      .set('If-None-Match', etag);
    expect(second.status).toBe(304);
    // 304 must have an empty body
    expect(second.text).toBe('');
  });

  it('returns 200 with a new ETag when milestones change', async () => {
    const first = await request(app).get(ENDPOINT);
    expect(first.status).toBe(200);
    const firstEtag = first.headers.etag as string;

    // Add a new milestone to simulate a submission/approval
    const MILESTONE_B = {
      ...MILESTONE_A,
      milestone_id: 'm2',
      evidence_uri: 'ipfs://QmB',
      approvedAt: 3000,
    };
    mockMilestones = [MILESTONE_A, MILESTONE_B];

    const second = await request(app)
      .get(ENDPOINT)
      .set('If-None-Match', firstEtag);
    // List changed → ETag changed → 200, not 304
    expect(second.status).toBe(200);
    expect(second.headers.etag).toBeDefined();
    expect(second.headers.etag).not.toBe(firstEtag);
  });

  it('does not return an ETag for a non-existent player', async () => {
    mockPlayer = null;
    const res = await request(app).get('/api/players/nonexistent-player/milestones');
    expect(res.status).toBe(404);
    expect(res.headers.etag).toBeUndefined();
  });
});
