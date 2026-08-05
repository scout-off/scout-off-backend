/**
 * tests/routes/adminPlayerDeactivation.test.ts
 *
 * Tests for:
 *   POST /api/admin/players/:playerId/deactivate
 *   POST /api/admin/players/:playerId/reactivate
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import * as db from '../../src/db';
import * as cache from '../../src/services/cache';
import * as broadcaster from '../../src/services/eventBroadcaster';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const ADMIN_WALLET =
  process.env.ADMIN_WALLET ?? 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';

function adminToken(): string {
  return jwt.sign({ sub: ADMIN_WALLET, role: 'admin' }, SECRET, { expiresIn: '1h' });
}
function playerToken(wallet: string): string {
  return jwt.sign({ sub: wallet, role: 'player' }, SECRET, { expiresIn: '1h' });
}

const PLAYER_ID = 'test-player-deactivation-admin';
const PLAYER_WALLET = 'GPLAYERWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function activePlayer() {
  return {
    player_id: PLAYER_ID,
    wallet: PLAYER_WALLET,
    position: 'ST',
    region: 'EU',
    metadata_uri: null,
    progress_level: 1,
    created_at: 1000000,
    is_active: 1,
    deactivation_reason: null,
  };
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  getPlayerById: jest.fn(),
  deactivatePlayerWithReason: jest.fn(),
  reactivatePlayerWithReason: jest.fn(),
  cancelPendingMilestonesForPlayer: jest.fn(),
  getContactUnlocksByPlayer: jest.fn(),
  // stubs for middleware / other db calls
  queryEvents: jest.fn().mockReturnValue([]),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  searchPlayers: jest.fn().mockReturnValue({ data: [], nextCursor: null }),
  getEventsCount: jest.fn().mockReturnValue(0),
  fetchLastIndexedLedger: jest.fn().mockReturnValue(0),
  persistLastIndexedLedger: jest.fn(),
  insertAuditLog: jest.fn().mockReturnValue({
    id: 1, hash: 'h', prev_hash: 'p', action: '', admin_wallet: '',
    query_params: '{}', created_at: '', event_source: '',
  }),
  getAuditLogs: jest.fn().mockReturnValue([]),
  getAuditLogsCount: jest.fn().mockReturnValue(0),
  getAllAuditLogRows: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  checkHealth: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
  postWebhookWithRetry: jest.fn(),
}));

jest.mock('../../src/services/cache', () => ({
  cacheGet: jest.fn().mockResolvedValue(null),
  cacheSet: jest.fn(),
  invalidatePlayerCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/eventBroadcaster', () => ({
  broadcaster: { broadcast: jest.fn() },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/admin/players/:playerId/deactivate', () => {
  const mockGetPlayer = db.getPlayerById as jest.Mock;
  const mockDeactivate = db.deactivatePlayerWithReason as jest.Mock;
  const mockCancelMilestones = db.cancelPendingMilestonesForPlayer as jest.Mock;
  const mockGetUnlocks = db.getContactUnlocksByPlayer as jest.Mock;
  const mockBroadcast = (broadcaster.broadcaster.broadcast) as jest.Mock;
  const mockInvalidate = cache.invalidatePlayerCache as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCancelMilestones.mockReturnValue(0);
    mockGetUnlocks.mockReturnValue([]);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/deactivate`)
      .send({ reason: 'test' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const res = await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/deactivate`)
      .set('Authorization', `Bearer ${playerToken(PLAYER_WALLET)}`)
      .send({ reason: 'test' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when reason is missing', async () => {
    mockGetPlayer.mockReturnValue(activePlayer());
    const res = await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/deactivate`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/i);
  });

  it('returns 400 when reason is empty string', async () => {
    mockGetPlayer.mockReturnValue(activePlayer());
    const res = await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/deactivate`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: '' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when player does not exist', async () => {
    mockGetPlayer.mockReturnValue(null);
    const res = await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/deactivate`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'Violation of terms' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when player is already deactivated', async () => {
    mockGetPlayer.mockReturnValue({ ...activePlayer(), is_active: 0 });
    const res = await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/deactivate`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'Duplicate' });
    expect(res.status).toBe(409);
  });

  it('successfully deactivates player and cancels milestones', async () => {
    mockGetPlayer.mockReturnValue(activePlayer());
    mockCancelMilestones.mockReturnValue(3);
    mockGetUnlocks.mockReturnValue([]);

    const res = await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/deactivate`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'Policy violation' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.cancelledMilestones).toBe(3);
    expect(mockDeactivate).toHaveBeenCalledWith(PLAYER_ID, 'Policy violation');
    expect(mockCancelMilestones).toHaveBeenCalledWith(PLAYER_ID);
    expect(mockInvalidate).toHaveBeenCalledWith(PLAYER_ID);
  });

  it('emits player_deactivated SSE to each scout who unlocked the player', async () => {
    mockGetPlayer.mockReturnValue(activePlayer());
    mockCancelMilestones.mockReturnValue(0);
    mockGetUnlocks.mockReturnValue([
      { scout_wallet: 'GSCOUT1', player_id: PLAYER_ID, tx_hash: 'tx1', unlocked_at: 1 },
      { scout_wallet: 'GSCOUT2', player_id: PLAYER_ID, tx_hash: 'tx2', unlocked_at: 2 },
    ]);

    const res = await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/deactivate`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'Terms violation' });

    expect(res.status).toBe(200);
    expect(res.body.data.notifiedScouts).toBe(2);

    // Called once per scout + once for the player themselves
    const calls = mockBroadcast.mock.calls.filter(
      ([evt]: [{ type: string }]) => evt.type === 'player_deactivated',
    );
    expect(calls.length).toBe(3); // 2 scouts + 1 player

    const scoutPayloads = calls
      .map(([evt]: [{ payload: Record<string, unknown> }]) => evt.payload.scout_wallet)
      .filter(Boolean);
    expect(scoutPayloads).toContain('GSCOUT1');
    expect(scoutPayloads).toContain('GSCOUT2');
  });

  it('deactivated player no longer appears in GET /api/players list', async () => {
    // queryPlayers returns only active players when includeDeactivated is false (default)
    const mockQueryPlayers = db.queryPlayers as jest.Mock;
    const mockCountPlayers = db.countPlayers as jest.Mock;
    mockQueryPlayers.mockReturnValue([]);
    mockCountPlayers.mockReturnValue(0);

    const res = await request(app).get('/api/players');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('POST /api/admin/players/:playerId/reactivate', () => {
  const mockGetPlayer = db.getPlayerById as jest.Mock;
  const mockReactivate = db.reactivatePlayerWithReason as jest.Mock;
  const mockBroadcast = (broadcaster.broadcaster.broadcast) as jest.Mock;
  const mockInvalidate = cache.invalidatePlayerCache as jest.Mock;

  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without a token', async () => {
    const res = await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/reactivate`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const res = await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/reactivate`)
      .set('Authorization', `Bearer ${playerToken(PLAYER_WALLET)}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when player does not exist', async () => {
    mockGetPlayer.mockReturnValue(null);
    const res = await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/reactivate`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(404);
  });

  it('returns 409 when player is already active', async () => {
    mockGetPlayer.mockReturnValue(activePlayer());
    const res = await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/reactivate`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(409);
  });

  it('successfully reactivates a deactivated player', async () => {
    mockGetPlayer.mockReturnValue({ ...activePlayer(), is_active: 0 });

    const res = await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/reactivate`)
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.playerId).toBe(PLAYER_ID);
    expect(mockReactivate).toHaveBeenCalledWith(PLAYER_ID);
    expect(mockInvalidate).toHaveBeenCalledWith(PLAYER_ID);
  });

  it('emits player_reactivated SSE event', async () => {
    mockGetPlayer.mockReturnValue({ ...activePlayer(), is_active: 0 });

    await request(app)
      .post(`/api/admin/players/${PLAYER_ID}/reactivate`)
      .set('Authorization', `Bearer ${adminToken()}`);

    const reactivatedCalls = mockBroadcast.mock.calls.filter(
      ([evt]: [{ type: string }]) => evt.type === 'player_reactivated',
    );
    expect(reactivatedCalls.length).toBe(1);
    expect(reactivatedCalls[0][0].payload.player_id).toBe(PLAYER_ID);
  });
});
