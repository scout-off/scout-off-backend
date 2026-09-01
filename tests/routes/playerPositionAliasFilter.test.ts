import request from 'supertest';
import app from '../../src/app';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn(),
  searchPlayers: jest.fn(),
  getPlayerById: jest.fn().mockReturnValue(null),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
  insertOrUpdatePlayer: jest.fn(),
  insertAuditLog: jest.fn().mockReturnValue({
    id: 1,
    action: 'player_search',
    admin_wallet: '',
    query_params: '{}',
    created_at: new Date().toISOString(),
    prev_hash: '0'.repeat(64),
    hash: 'mock-hash-1',
    event_source: 'app_event',
  }),
  deactivatePlayer: jest.fn(),
  reactivatePlayer: jest.fn(),
  countTrialOffersByPlayer: jest.fn().mockReturnValue(0),
}));

jest.mock('../../src/services/cache', () => ({
  cacheGet: jest.fn().mockResolvedValue(null),
  cacheSet: jest.fn().mockResolvedValue(undefined),
  invalidatePlayerCache: jest.fn(),
}));

// ─── GET /api/players?position=ALIAS ─────────────────────────────────────

describe('GET /api/players?position= — position alias normalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Test helper: seeds the mock DB with players at canonical positions,
   * queries the endpoint, and asserts the returned players match expected position.
   */
  async function testPositionAlias(
    aliasInput: string,
    canonicalExpected: string,
    expectedPlayers: Array<{ player_id: string; position: string }>,
  ) {
    const { searchPlayers, countPlayers } = require('../../src/db');

    // Seed mock with test players
    searchPlayers.mockResolvedValue({
      data: expectedPlayers,
      nextCursor: null,
    });
    countPlayers.mockResolvedValue(expectedPlayers.length);

    const res = await request(app).get(`/api/players?position=${encodeURIComponent(aliasInput)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(expectedPlayers.length);

    // Verify searchPlayers was called with the normalized (canonical) position
    expect(searchPlayers).toHaveBeenCalledWith(
      expect.objectContaining({
        position: canonicalExpected,
      }),
    );

    // Verify the response includes the players
    for (let i = 0; i < expectedPlayers.length; i++) {
      expect(res.body.data[i].player_id).toBe(expectedPlayers[i].player_id);
      expect(res.body.data[i].position).toBe(expectedPlayers[i].position);
    }
  }

  // ── Goalkeeper aliases ──────────────────────────────────────────────────

  it('?position=GK normalizes to goalkeeper and returns goalkeeper players', async () => {
    const players = [
      { player_id: 'player-gk-1', position: 'goalkeeper' },
      { player_id: 'player-gk-2', position: 'goalkeeper' },
    ];
    await testPositionAlias('GK', 'goalkeeper', players);
  });

  it('?position=gk (lowercase) normalizes to goalkeeper', async () => {
    const players = [{ player_id: 'player-gk-1', position: 'goalkeeper' }];
    await testPositionAlias('gk', 'goalkeeper', players);
  });

  it('?position=goalkeeper (canonical) returns goalkeeper players', async () => {
    const players = [{ player_id: 'player-gk-1', position: 'goalkeeper' }];
    await testPositionAlias('goalkeeper', 'goalkeeper', players);
  });

  it('?position=goalie (alias) normalizes to goalkeeper', async () => {
    const players = [{ player_id: 'player-gk-1', position: 'goalkeeper' }];
    await testPositionAlias('goalie', 'goalkeeper', players);
  });

  // ── Defender aliases ────────────────────────────────────────────────────

  it('?position=CB normalizes to defender and returns defender players', async () => {
    const players = [
      { player_id: 'player-def-1', position: 'defender' },
      { player_id: 'player-def-2', position: 'defender' },
    ];
    await testPositionAlias('CB', 'defender', players);
  });

  it('?position=centre-back normalizes to defender', async () => {
    const players = [{ player_id: 'player-def-1', position: 'defender' }];
    await testPositionAlias('centre-back', 'defender', players);
  });

  it('?position=center-back (US spelling) normalizes to defender', async () => {
    const players = [{ player_id: 'player-def-1', position: 'defender' }];
    await testPositionAlias('center-back', 'defender', players);
  });

  it('?position=LB normalizes to defender', async () => {
    const players = [
      { player_id: 'player-def-1', position: 'defender' },
      { player_id: 'player-def-2', position: 'defender' },
    ];
    await testPositionAlias('LB', 'defender', players);
  });

  it('?position=RB normalizes to defender', async () => {
    const players = [{ player_id: 'player-def-1', position: 'defender' }];
    await testPositionAlias('RB', 'defender', players);
  });

  // ── Midfielder aliases ──────────────────────────────────────────────────

  it('?position=CM normalizes to midfielder and returns midfielder players', async () => {
    const players = [
      { player_id: 'player-mid-1', position: 'midfielder' },
      { player_id: 'player-mid-2', position: 'midfielder' },
    ];
    await testPositionAlias('CM', 'midfielder', players);
  });

  it('?position=midfielder (canonical) returns midfielder players', async () => {
    const players = [{ player_id: 'player-mid-1', position: 'midfielder' }];
    await testPositionAlias('midfielder', 'midfielder', players);
  });

  it('?position=DM (defensive midfielder) normalizes to midfielder', async () => {
    const players = [{ player_id: 'player-mid-1', position: 'midfielder' }];
    await testPositionAlias('DM', 'midfielder', players);
  });

  it('?position=CAM (attacking midfielder) normalizes to midfielder', async () => {
    const players = [{ player_id: 'player-mid-1', position: 'midfielder' }];
    await testPositionAlias('CAM', 'midfielder', players);
  });

  // ── Forward aliases ─────────────────────────────────────────────────────

  it('?position=ST (striker) normalizes to forward and returns forward players', async () => {
    const players = [
      { player_id: 'player-fwd-1', position: 'forward' },
      { player_id: 'player-fwd-2', position: 'forward' },
    ];
    await testPositionAlias('ST', 'forward', players);
  });

  it('?position=CB (centre-back) and ?position=defender return same players', async () => {
    const { searchPlayers, countPlayers } = require('../../src/db');
    const players = [{ player_id: 'player-def-1', position: 'defender' }];

    searchPlayers.mockResolvedValue({ data: players, nextCursor: null });
    countPlayers.mockResolvedValue(1);

    // Query with CB alias
    const res1 = await request(app).get('/api/players?position=CB');
    expect(res1.status).toBe(200);
    expect(res1.body.data).toHaveLength(1);

    // Verify CB normalized to defender
    expect(searchPlayers).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: 'defender' }),
    );

    // Query with canonical defender
    const res2 = await request(app).get('/api/players?position=defender');
    expect(res2.status).toBe(200);
    expect(res2.body.data).toHaveLength(1);

    // Verify defender also normalized to defender
    expect(searchPlayers).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: 'defender' }),
    );
  });

  it('?position=winger normalizes to forward', async () => {
    const players = [
      { player_id: 'player-fwd-1', position: 'forward' },
      { player_id: 'player-fwd-2', position: 'forward' },
    ];
    await testPositionAlias('winger', 'forward', players);
  });

  it('?position=RW (right winger) normalizes to forward', async () => {
    const players = [{ player_id: 'player-fwd-1', position: 'forward' }];
    await testPositionAlias('RW', 'forward', players);
  });

  it('?position=LW (left winger) normalizes to forward', async () => {
    const players = [{ player_id: 'player-fwd-1', position: 'forward' }];
    await testPositionAlias('LW', 'forward', players);
  });

  it('?position=forward (canonical) returns forward players', async () => {
    const players = [{ player_id: 'player-fwd-1', position: 'forward' }];
    await testPositionAlias('forward', 'forward', players);
  });

  // ── Unrecognized positions ──────────────────────────────────────────────

  it('?position=quarterback (unrecognized) matches only exact stored value', async () => {
    const { searchPlayers, countPlayers } = require('../../src/db');

    searchPlayers.mockResolvedValue({ data: [], nextCursor: null });
    countPlayers.mockResolvedValue(0);

    const res = await request(app).get('/api/players?position=quarterback');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(0);

    // Verify searchPlayers was called with the trimmed but unrecognized position
    expect(searchPlayers).toHaveBeenCalledWith(
      expect.objectContaining({
        position: 'quarterback',
      }),
    );
  });

  // ── Whitespace handling ─────────────────────────────────────────────────

  it('?position= with leading/trailing whitespace is trimmed before normalization', async () => {
    const { searchPlayers, countPlayers } = require('../../src/db');
    const players = [{ player_id: 'player-gk-1', position: 'goalkeeper' }];

    searchPlayers.mockResolvedValue({ data: players, nextCursor: null });
    countPlayers.mockResolvedValue(1);

    const res = await request(app).get('/api/players?position=%20%20GK%20%20'); // "  GK  "
    expect(res.status).toBe(200);

    // Verify whitespace was trimmed and GK normalized to goalkeeper
    expect(searchPlayers).toHaveBeenCalledWith(
      expect.objectContaining({
        position: 'goalkeeper',
      }),
    );
  });

  // ── Case-insensitivity ──────────────────────────────────────────────────

  it('?position=Defender (mixed case) normalizes to defender', async () => {
    const players = [{ player_id: 'player-def-1', position: 'defender' }];
    await testPositionAlias('Defender', 'defender', players);
  });

  it('?position=MIDFIELDER (uppercase) normalizes to midfielder', async () => {
    const players = [{ player_id: 'player-mid-1', position: 'midfielder' }];
    await testPositionAlias('MIDFIELDER', 'midfielder', players);
  });

  // ── Empty and missing position ──────────────────────────────────────────

  it('GET /api/players without position param returns all players', async () => {
    const { searchPlayers, countPlayers } = require('../../src/db');
    const players = [
      { player_id: 'player-1', position: 'forward' },
      { player_id: 'player-2', position: 'defender' },
    ];

    searchPlayers.mockResolvedValue({ data: players, nextCursor: null });
    countPlayers.mockResolvedValue(2);

    const res = await request(app).get('/api/players');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);

    // Verify position is undefined (no filter applied)
    expect(searchPlayers).toHaveBeenCalledWith(
      expect.objectContaining({
        position: undefined,
      }),
    );
  });

  // ── Pagination preserved with position filter ──────────────────────────

  it('pagination works correctly with position alias filter', async () => {
    const { searchPlayers, countPlayers } = require('../../src/db');
    const players = [
      { player_id: 'player-mid-1', position: 'midfielder' },
      { player_id: 'player-mid-2', position: 'midfielder' },
    ];

    searchPlayers.mockResolvedValue({ data: players, nextCursor: null });
    countPlayers.mockResolvedValue(50); // Simulate 50 total midfielders

    const res = await request(app).get('/api/players?position=CM&page=1&pageSize=2');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(50);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(2);

    // Verify position was normalized
    expect(searchPlayers).toHaveBeenCalledWith(
      expect.objectContaining({
        position: 'midfielder',
      }),
    );
  });
});
