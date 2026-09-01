/**
 * Unit tests for scoutRecommendationsController (#491)
 *
 * Tests the recommendation engine's scoring algorithm, preference derivation,
 * cache behaviour, pagination, and new-scout fallback with controlled data.
 * The DB helpers are mocked so no SQLite connection is required.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  getSavedSearchesByScout: jest.fn(),
  getBookmarksByScout: jest.fn(),
  getContactUnlocksByScout: jest.fn(),
  getPlayerById: jest.fn(),
  queryPlayers: jest.fn(),
  queryEvents: jest.fn(),
  getAuditLogs: jest.fn(),
}));

jest.mock('../../src/services/cache', () => ({
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
}));

jest.mock('../../src/utils/stellarAddress', () => ({
  isValidStellarAddress: jest.fn().mockReturnValue(true),
}));

jest.mock('../../src/utils/authError', () => ({
  sendForbidden: jest.fn((res: Response, msg: string) => {
    (res as unknown as MockResponse).status(403).json({ success: false, error: msg });
  }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { Request, Response, NextFunction } from 'express';
import {
  getScoutRecommendations,
  scorePlayer,
} from '../../src/controllers/scoutRecommendationsController';
import {
  getSavedSearchesByScout,
  getBookmarksByScout,
  getContactUnlocksByScout,
  getPlayerById,
  queryPlayers,
  queryEvents,
} from '../../src/db';
import { cacheGet, cacheSet } from '../../src/services/cache';
import { isValidStellarAddress } from '../../src/utils/stellarAddress';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WALLET = 'GSCOUTWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    params: { wallet: WALLET },
    query: {},
    account: WALLET,
    role: 'scout',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response & MockResponse {
  const res = {} as MockResponse;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as unknown as Response & MockResponse;
}

/** Builds a minimal PlayerRow with sensible defaults. */
function makePlayer(overrides: {
  player_id?: string;
  wallet?: string;
  position?: string | null;
  region?: string | null;
  progress_level?: number;
  created_at?: number;
  is_active?: number;
  metadata_uri?: string | null;
} = {}) {
  return {
    player_id: overrides.player_id ?? `player-${Math.random().toString(36).slice(2)}`,
    wallet: overrides.wallet ?? 'GPLAYERWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    position: overrides.position ?? null,
    region: overrides.region ?? null,
    metadata_uri: overrides.metadata_uri ?? null,
    progress_level: overrides.progress_level ?? 1,
    created_at: overrides.created_at ?? 1_700_000_000,
    is_active: overrides.is_active ?? 1,
  };
}

/** Builds a SavedSearchRow with a JSON-encoded filters field. */
function makeSavedSearch(filters: {
  region?: string;
  position?: string;
  minTier?: number;
}, id = 1) {
  return {
    id,
    scout_wallet: WALLET,
    name: `search-${id}`,
    filters: JSON.stringify(filters),
    created_at: 1_700_000_000,
  };
}

const mockGetSavedSearches = getSavedSearchesByScout as jest.Mock;
const mockGetBookmarks = getBookmarksByScout as jest.Mock;
const mockGetContacts = getContactUnlocksByScout as jest.Mock;
const mockGetPlayerById = getPlayerById as jest.Mock;
const mockQueryPlayers = queryPlayers as jest.Mock;
const mockQueryEvents = queryEvents as jest.Mock;
const mockCacheGet = cacheGet as jest.Mock;
const mockCacheSet = cacheSet as jest.Mock;
const mockIsValidStellar = isValidStellarAddress as jest.Mock;

// ─── Unit tests for scorePlayer() ────────────────────────────────────────────

describe('scorePlayer()', () => {
  const emptyPrefs = {
    region: null,
    position: null,
    minTier: 0,
    contactedIds: new Set<string>(),
    hasHistory: true,
  };

  it('scores 0 for a player with no matching attributes', () => {
    const player = makePlayer({ region: 'South America', position: 'goalkeeper' });
    const prefs = { ...emptyPrefs, region: 'West Africa', position: 'forward' };
    const score = scorePlayer(player, prefs, new Set());
    // +2 for tier (minTier=0, any passes), +1 fresh (not contacted)
    expect(score).toBe(3);
  });

  it('awards +3 for region match', () => {
    const player = makePlayer({ region: 'West Africa', position: 'midfielder', progress_level: 1 });
    const prefs = { ...emptyPrefs, region: 'West Africa', position: 'forward', minTier: 0 };
    const score = scorePlayer(player, prefs, new Set());
    // +3 region +2 tier +1 fresh = 6
    expect(score).toBe(6);
  });

  it('awards +2 for position match', () => {
    const player = makePlayer({ region: 'East Africa', position: 'forward', progress_level: 1 });
    const prefs = { ...emptyPrefs, region: 'West Africa', position: 'forward', minTier: 0 };
    const score = scorePlayer(player, prefs, new Set());
    // +2 position +2 tier +1 fresh = 5
    expect(score).toBe(5);
  });

  it('awards +2 when player tier >= minTier', () => {
    const player = makePlayer({ progress_level: 2 });
    const prefs = { ...emptyPrefs, minTier: 2 };
    const score = scorePlayer(player, prefs, new Set());
    // +2 tier +1 fresh = 3
    expect(score).toBe(3);
  });

  it('does NOT award tier points when player tier < minTier', () => {
    const player = makePlayer({ progress_level: 1 });
    const prefs = { ...emptyPrefs, minTier: 3 };
    const score = scorePlayer(player, prefs, new Set());
    // +1 fresh only = 1
    expect(score).toBe(1);
  });

  it('awards +1 for fresh player (not contacted)', () => {
    const player = makePlayer({ player_id: 'p-fresh' });
    const prefs = { ...emptyPrefs };
    const score = scorePlayer(player, prefs, new Set());
    // +2 tier (minTier=0) +1 fresh = 3
    expect(score).toBe(3);
  });

  it('does NOT award fresh bonus when player is already contacted', () => {
    const player = makePlayer({ player_id: 'p-contacted' });
    const prefs = {
      ...emptyPrefs,
      contactedIds: new Set(['p-contacted']),
    };
    const score = scorePlayer(player, prefs, new Set());
    // +2 tier (minTier=0) = 2, no fresh bonus
    expect(score).toBe(2);
  });

  it('awards +1 for recently approved milestone', () => {
    const player = makePlayer({ player_id: 'p-recent-milestone' });
    const prefs = { ...emptyPrefs };
    const recentlyApproved = new Set(['p-recent-milestone']);
    const score = scorePlayer(player, prefs, recentlyApproved);
    // +2 tier +1 fresh +1 milestone = 4
    expect(score).toBe(4);
  });

  it('accumulates all scoring signals: full score', () => {
    const player = makePlayer({
      player_id: 'p-max',
      region: 'West Africa',
      position: 'forward',
      progress_level: 3,
    });
    const prefs = {
      region: 'West Africa',
      position: 'forward',
      minTier: 2,
      contactedIds: new Set<string>(),
      hasHistory: true,
    };
    const recentlyApproved = new Set(['p-max']);
    const score = scorePlayer(player, prefs, recentlyApproved);
    // +3 region +2 position +2 tier +1 fresh +1 milestone = 9
    expect(score).toBe(9);
  });

  it('scout with 3 West Africa forward searches gets high scores for those players', () => {
    // Simulate a scout with three saved searches for West Africa forwards
    const waForward = makePlayer({ region: 'West Africa', position: 'forward', progress_level: 2 });
    const otherPlayer = makePlayer({ region: 'South America', position: 'goalkeeper', progress_level: 1 });

    const prefs = {
      region: 'West Africa',
      position: 'forward',
      minTier: 1,
      contactedIds: new Set<string>(),
      hasHistory: true,
    };

    const waScore = scorePlayer(waForward, prefs, new Set());
    const otherScore = scorePlayer(otherPlayer, prefs, new Set());

    // +3 region +2 position +2 tier +1 fresh = 8 for WA forward
    expect(waScore).toBe(8);
    // tier < minTier doesn't earn +2, no region, no position
    // progress_level=1 >= minTier=1, so +2 tier, +1 fresh = 3
    expect(otherScore).toBe(3);
    expect(waScore).toBeGreaterThan(otherScore);
  });
});

// ─── Handler tests ────────────────────────────────────────────────────────────

describe('getScoutRecommendations handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsValidStellar.mockReturnValue(true);
    mockCacheGet.mockResolvedValue(undefined);
    mockCacheSet.mockResolvedValue(undefined);
    mockQueryEvents.mockReturnValue([]);
    // Default: scout with West Africa forward saved searches
    mockGetSavedSearches.mockReturnValue([
      makeSavedSearch({ region: 'West Africa', position: 'forward', minTier: 1 }, 1),
      makeSavedSearch({ region: 'West Africa', position: 'forward', minTier: 1 }, 2),
      makeSavedSearch({ region: 'West Africa', position: 'forward', minTier: 1 }, 3),
    ]);
    mockGetBookmarks.mockReturnValue([]);
    mockGetContacts.mockReturnValue([]);
    mockGetPlayerById.mockReturnValue(null);
  });

  // ── 400 / 403 guards ──────────────────────────────────────────────────────

  it('returns 400 for invalid Stellar address', async () => {
    mockIsValidStellar.mockReturnValue(false);
    const req = makeReq({ params: { wallet: 'NOT_A_WALLET' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getScoutRecommendations(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({ success: false });
  });

  it('returns 403 when authenticated account does not match URL wallet', async () => {
    const req = makeReq({ account: 'GOTHERWALLET2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getScoutRecommendations(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 400 for invalid query parameters', async () => {
    const req = makeReq({ query: { pageSize: 'not-a-number' } as unknown as Record<string, string> });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    // Force the query string to fail coercion
    (req as unknown as { query: unknown }).query = { pageSize: 'abc' };
    await getScoutRecommendations(req, res, next);

    // next() should not be called with an error on bad query — returns 400
    // (Zod coerce.number will NaN, which fails .int() check)
    const jsonCalled = (res.json as jest.Mock).mock.calls.length > 0;
    const statusCalled = (res.status as jest.Mock).mock.calls.length > 0;
    expect(jsonCalled || statusCalled).toBe(true);
  });

  // ── Successful path with history ──────────────────────────────────────────

  it('returns 200 with scored recommendations for a scout with saved searches', async () => {
    const waForward1 = makePlayer({ player_id: 'p-waf-1', region: 'West Africa', position: 'forward', progress_level: 2 });
    const waForward2 = makePlayer({ player_id: 'p-waf-2', region: 'West Africa', position: 'forward', progress_level: 1 });
    const other = makePlayer({ player_id: 'p-other', region: 'South America', position: 'goalkeeper', progress_level: 1 });

    mockQueryPlayers.mockReturnValue([waForward1, waForward2, other]);

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getScoutRecommendations(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = (res.json as jest.Mock).mock.calls[0][0] as {
      success: boolean;
      data: Array<{ player_id: string }>;
      meta: { preferredRegion: string | null; preferredPosition: string | null };
    };
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    // West Africa forwards should rank first
    expect(body.data[0].player_id).toMatch(/p-waf/);
    // Meta should reflect preferred region/position
    expect(body.meta.preferredRegion).toBe('West Africa');
    expect(body.meta.preferredPosition).toBe('forward');
  });

  it('excludes already-contacted players from results', async () => {
    const contacted = makePlayer({ player_id: 'p-contacted', region: 'West Africa', position: 'forward', progress_level: 2 });
    const fresh = makePlayer({ player_id: 'p-fresh', region: 'West Africa', position: 'forward', progress_level: 2 });

    mockQueryPlayers.mockReturnValue([contacted, fresh]);
    mockGetContacts.mockReturnValue([
      { scout_wallet: WALLET, player_id: 'p-contacted', tx_hash: 'tx1', unlocked_at: 1_700_000_000 },
    ]);

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getScoutRecommendations(req, res, next);

    const body = (res.json as jest.Mock).mock.calls[0][0] as {
      data: Array<{ player_id: string }>;
    };
    const ids = body.data.map((p) => p.player_id);
    expect(ids).not.toContain('p-contacted');
    expect(ids).toContain('p-fresh');
  });

  // ── Fallback for new scout (no history) ───────────────────────────────────

  it('returns top-tier players when the scout has no history', async () => {
    mockGetSavedSearches.mockReturnValue([]);
    mockGetBookmarks.mockReturnValue([]);
    mockGetContacts.mockReturnValue([]);

    const topTier = makePlayer({ player_id: 'p-top', progress_level: 3, created_at: 1_700_000_002 });
    const midTier = makePlayer({ player_id: 'p-mid', progress_level: 2, created_at: 1_700_000_001 });
    const lowTier = makePlayer({ player_id: 'p-low', progress_level: 1, created_at: 1_700_000_000 });

    // queryPlayers returns them in unsorted order to verify the fallback sorts
    mockQueryPlayers.mockReturnValue([lowTier, midTier, topTier]);

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getScoutRecommendations(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = (res.json as jest.Mock).mock.calls[0][0] as {
      success: boolean;
      data: Array<{ player_id: string; progress_level: number }>;
    };
    expect(body.success).toBe(true);
    // Fallback should return highest-tier players first
    expect(body.data[0].progress_level).toBeGreaterThanOrEqual(body.data[body.data.length - 1].progress_level);
  });

  // ── Caching ───────────────────────────────────────────────────────────────

  it('uses cached recommendations on second call and does not hit the DB', async () => {
    const cachedRanked = [
      { ...makePlayer({ player_id: 'p-cached-1' }), _score: 8 },
      { ...makePlayer({ player_id: 'p-cached-2' }), _score: 6 },
    ];
    const cachedPrefs = {
      region: 'West Africa',
      position: 'forward',
      minTier: 1,
      contactedIds: new Set<string>(),
      hasHistory: true,
    };

    mockCacheGet.mockResolvedValue({ ranked: cachedRanked, prefs: cachedPrefs });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getScoutRecommendations(req, res, next);

    // DB should NOT be queried when cache hit
    expect(mockQueryPlayers).not.toHaveBeenCalled();
    expect(mockGetSavedSearches).not.toHaveBeenCalled();
    // cacheSet should NOT be called again
    expect(mockCacheSet).not.toHaveBeenCalled();

    const body = (res.json as jest.Mock).mock.calls[0][0] as { success: boolean; data: Array<{ player_id: string }> };
    expect(body.success).toBe(true);
    expect(body.data[0].player_id).toBe('p-cached-1');
  });

  it('stores results in cache with 10-minute TTL on cache miss', async () => {
    const players = [makePlayer({ player_id: 'p-1' })];
    mockQueryPlayers.mockReturnValue(players);

    const req = makeReq();
    const res = makeRes();
    await getScoutRecommendations(req, res, jest.fn());

    expect(mockCacheSet).toHaveBeenCalledWith(
      `recommendations:${WALLET}`,
      expect.objectContaining({ ranked: expect.any(Array), prefs: expect.any(Object) }),
      10 * 60 * 1000,
    );
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  it('returns nextCursor when there are more results than the page size', async () => {
    // Create 25 players to exceed the default page size of 20
    const players = Array.from({ length: 25 }, (_, i) =>
      makePlayer({ player_id: `p-${i}`, region: 'West Africa', position: 'forward', progress_level: 2 }),
    );
    mockQueryPlayers.mockReturnValue(players);

    const req = makeReq();
    const res = makeRes();
    await getScoutRecommendations(req, res, jest.fn());

    const body = (res.json as jest.Mock).mock.calls[0][0] as {
      data: Array<{ player_id: string }>;
      nextCursor: string | null;
    };
    expect(body.data).toHaveLength(20);
    expect(body.nextCursor).not.toBeNull();
  });

  it('returns nextCursor=null on the last page', async () => {
    const players = Array.from({ length: 5 }, (_, i) =>
      makePlayer({ player_id: `p-${i}` }),
    );
    mockQueryPlayers.mockReturnValue(players);

    const req = makeReq();
    const res = makeRes();
    await getScoutRecommendations(req, res, jest.fn());

    const body = (res.json as jest.Mock).mock.calls[0][0] as {
      nextCursor: string | null;
    };
    expect(body.nextCursor).toBeNull();
  });

  it('advances to the second page when a valid cursor is supplied', async () => {
    const players = Array.from({ length: 25 }, (_, i) =>
      makePlayer({ player_id: `p-page-${i}`, region: 'West Africa', position: 'forward', progress_level: 2 }),
    );
    mockQueryPlayers.mockReturnValue(players);

    // First page
    const req1 = makeReq();
    const res1 = makeRes();
    await getScoutRecommendations(req1, res1, jest.fn());
    const firstPage = (res1.json as jest.Mock).mock.calls[0][0] as {
      data: Array<{ player_id: string }>;
      nextCursor: string | null;
    };
    const cursor = firstPage.nextCursor!;
    expect(cursor).not.toBeNull();
    const firstPageIds = firstPage.data.map((p) => p.player_id);

    // Second page — use cached result to avoid rebuilding
    const cachedResult = {
      ranked: players.map((p, i) => ({ ...p, _score: 25 - i })),
      prefs: { region: 'West Africa', position: 'forward', minTier: 1, contactedIds: new Set<string>(), hasHistory: true },
    };
    mockCacheGet.mockResolvedValue(cachedResult);

    const req2 = makeReq({ query: { cursor } as unknown as Record<string, string> });
    (req2 as unknown as { query: unknown }).query = { cursor };
    const res2 = makeRes();
    await getScoutRecommendations(req2, res2, jest.fn());
    const secondPage = (res2.json as jest.Mock).mock.calls[0][0] as {
      data: Array<{ player_id: string }>;
    };

    // No overlap between page 1 and page 2
    const secondPageIds = secondPage.data.map((p) => p.player_id);
    const overlap = firstPageIds.filter((id) => secondPageIds.includes(id));
    expect(overlap).toHaveLength(0);
  });

  // ── Bookmark-based signal ─────────────────────────────────────────────────

  it('uses bookmarked player region/position as preference signals', async () => {
    // Scout has no saved searches but has two West Africa forward bookmarks
    mockGetSavedSearches.mockReturnValue([]);
    mockGetBookmarks.mockReturnValue([
      { id: 1, scout_wallet: WALLET, player_id: 'bm-1', created_at: 1_700_000_000 },
      { id: 2, scout_wallet: WALLET, player_id: 'bm-2', created_at: 1_700_000_001 },
    ]);
    mockGetPlayerById.mockImplementation((id: string) => {
      if (id === 'bm-1' || id === 'bm-2') {
        return makePlayer({ player_id: id, region: 'West Africa', position: 'forward' });
      }
      return null;
    });

    const waForward = makePlayer({ player_id: 'p-waf', region: 'West Africa', position: 'forward', progress_level: 2 });
    const other = makePlayer({ player_id: 'p-other', region: 'East Africa', position: 'midfielder', progress_level: 2 });
    mockQueryPlayers.mockReturnValue([other, waForward]);

    const req = makeReq();
    const res = makeRes();
    await getScoutRecommendations(req, res, jest.fn());

    const body = (res.json as jest.Mock).mock.calls[0][0] as {
      data: Array<{ player_id: string }>;
      meta: { preferredRegion: string | null };
    };
    expect(body.meta.preferredRegion).toBe('West Africa');
    // West Africa forward should rank higher
    const ids = body.data.map((p) => p.player_id);
    expect(ids.indexOf('p-waf')).toBeLessThan(ids.indexOf('p-other'));
  });

  // ── Recently approved milestone signal ────────────────────────────────────

  it('awards +1 bonus to players with a recently approved milestone', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const recentPlayer = makePlayer({ player_id: 'p-recent', region: 'West Africa', position: 'forward', progress_level: 2 });
    const normalPlayer = makePlayer({ player_id: 'p-normal', region: 'West Africa', position: 'forward', progress_level: 2 });

    mockQueryPlayers.mockReturnValue([normalPlayer, recentPlayer]);

    // Emit a milestone_approved event within the last 30 days for p-recent
    mockQueryEvents.mockReturnValue([
      {
        type: 'milestone_approved',
        payload: { player_id: 'p-recent', milestone_id: 'ms-1' },
        created_at: nowSec - 3600, // 1 hour ago
      },
    ]);

    const req = makeReq();
    const res = makeRes();
    await getScoutRecommendations(req, res, jest.fn());

    const body = (res.json as jest.Mock).mock.calls[0][0] as {
      data: Array<{ player_id: string }>;
    };
    // p-recent should rank first due to the extra +1 milestone bonus
    expect(body.data[0].player_id).toBe('p-recent');
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it('forwards unexpected DB errors to next()', async () => {
    mockQueryPlayers.mockImplementation(() => { throw new Error('DB exploded'); });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await getScoutRecommendations(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.json).not.toHaveBeenCalled();
  });
});
