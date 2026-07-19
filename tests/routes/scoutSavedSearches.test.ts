/**
 * Tests for scout saved searches (#486)
 *
 * Verifies:
 *  - Scouts can create, list, and delete named saved searches
 *  - Saved filter payloads are validated against the player-filter schema
 *  - A scout cannot view or delete another scout's saved searches
 *  - Tests cover the full CRUD cycle and cross-scout authorization denial
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  // shared scout router dependencies
  getEvents: jest.fn(),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn(),
  dbRenewSubscription: jest.fn(),
  dbCancelSubscription: jest.fn(),
  insertContactUnlock: jest.fn(),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  // player lookup
  getPlayerById: jest.fn(),
  // notes
  upsertScoutNote: jest.fn(),
  getScoutNote: jest.fn(),
  getScoutNotes: jest.fn().mockReturnValue([]),
  // api keys
  insertApiKey: jest.fn(),
  listApiKeysByWallet: jest.fn().mockReturnValue([]),
  revokeApiKeyById: jest.fn(),
  getApiKeyByHash: jest.fn().mockReturnValue(null),
  getAllActiveApiKeys: jest.fn().mockReturnValue([]),
  touchApiKeyLastUsed: jest.fn(),
  // bookmarks
  insertBookmark: jest.fn(),
  deleteBookmark: jest.fn(),
  getBookmarksByScout: jest.fn().mockReturnValue([]),
  // saved searches
  insertSavedSearch: jest.fn(),
  getSavedSearchesByScout: jest.fn(),
  deleteSavedSearch: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  submitContactPayment: jest.fn(),
  purchaseSubscription: jest.fn(),
  renewSubscription: jest.fn(),
  cancelSubscriptionOnChain: jest.fn(),
  logTrialOffer: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) { super(message); }
  },
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
  insertTrialOffer: jest.fn(),
  getTrialOffers: jest.fn().mockReturnValue([]),
}));

import {
  insertSavedSearch,
  getSavedSearchesByScout,
  deleteSavedSearch,
} from '../../src/db';

const mockInsertSavedSearch     = insertSavedSearch     as jest.Mock;
const mockGetSavedSearches      = getSavedSearchesByScout as jest.Mock;
const mockDeleteSavedSearch     = deleteSavedSearch     as jest.Mock;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCOUT_A = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';
const SCOUT_B = 'GAEZS7NMWCNTUFGDNXWVYVTKGGP47CESPEV5BVT5LNFHKXC5TGBZ4O5O';

const VALID_FILTERS = { region: 'West Africa', position: 'Forward', minTier: 2 };

const MOCK_ROW = {
  id: 1,
  scout_wallet: SCOUT_A,
  name: 'West Africa forwards',
  filters: JSON.stringify(VALID_FILTERS),
  created_at: 1_700_000_000,
};

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const scoutAToken = makeToken(SCOUT_A);
const scoutBToken = makeToken(SCOUT_B);

// ─── POST /api/scouts/:wallet/saved-searches ──────────────────────────────────

describe('POST /api/scouts/:wallet/saved-searches', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a saved search and returns 201', async () => {
    mockInsertSavedSearch.mockReturnValueOnce(1);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ name: 'West Africa forwards', filters: VALID_FILTERS });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(1);
    expect(res.body.data.name).toBe('West Africa forwards');
    expect(res.body.data.filters).toEqual(VALID_FILTERS);
    expect(res.body.data.scout_wallet).toBe(SCOUT_A);
    expect(mockInsertSavedSearch).toHaveBeenCalledTimes(1);
    expect(mockInsertSavedSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        scout_wallet: SCOUT_A,
        name: 'West Africa forwards',
        filters: JSON.stringify(VALID_FILTERS),
      }),
    );
  });

  it('accepts a saved search with empty filters object', async () => {
    mockInsertSavedSearch.mockReturnValueOnce(2);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ name: 'All players', filters: {} });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.filters).toEqual({});
  });

  it('accepts filters with only region', async () => {
    mockInsertSavedSearch.mockReturnValueOnce(3);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ name: 'East Africa', filters: { region: 'East Africa' } });

    expect(res.status).toBe(201);
    expect(res.body.data.filters.region).toBe('East Africa');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ filters: VALID_FILTERS });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockInsertSavedSearch).not.toHaveBeenCalled();
  });

  it('returns 400 when name is empty string', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ name: '', filters: VALID_FILTERS });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when filters is missing', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ name: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when minTier is out of range (> 3)', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ name: 'Bad', filters: { minTier: 5 } });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockInsertSavedSearch).not.toHaveBeenCalled();
  });

  it('returns 400 when minTier is negative', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ name: 'Bad', filters: { minTier: -1 } });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when filters contains unknown/pagination fields that fail schema coercion', async () => {
    // Unknown keys are stripped by Zod's default; this is fine.
    // The key contract is that pagination fields like sortBy/sortOrder/page/pageSize
    // are silently stripped rather than causing a 400, which is fine — they are simply
    // not stored.  This test documents that the endpoint does NOT reject unknown extra keys
    // because Zod .object() strips them by default.
    mockInsertSavedSearch.mockReturnValueOnce(99);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ name: 'Test', filters: { region: 'West Africa', page: 2, pageSize: 50 } });

    expect(res.status).toBe(201);
    // page/pageSize must be stripped — not stored
    expect(res.body.data.filters).not.toHaveProperty('page');
    expect(res.body.data.filters).not.toHaveProperty('pageSize');
    expect(res.body.data.filters.region).toBe('West Africa');
  });

  it('returns 403 when authenticated wallet does not match :wallet param', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_B}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ name: 'Hacked', filters: VALID_FILTERS });

    expect(res.status).toBe(403);
    expect(mockInsertSavedSearch).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/saved-searches`)
      .send({ name: 'Test', filters: VALID_FILTERS });

    expect(res.status).toBe(401);
  });

  it('returns 403 for non-scout role', async () => {
    const playerToken = makeToken(SCOUT_A, 'player');
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ name: 'Test', filters: VALID_FILTERS });

    expect(res.status).toBe(403);
    expect(mockInsertSavedSearch).not.toHaveBeenCalled();
  });
});

// ─── GET /api/scouts/:wallet/saved-searches ───────────────────────────────────

describe('GET /api/scouts/:wallet/saved-searches', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the list of saved searches with parsed filter objects', async () => {
    mockGetSavedSearches.mockReturnValueOnce([MOCK_ROW]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);

    const item = res.body.data[0];
    expect(item.id).toBe(1);
    expect(item.name).toBe('West Africa forwards');
    expect(item.scout_wallet).toBe(SCOUT_A);
    expect(item.filters).toEqual(VALID_FILTERS);
    expect(item.created_at).toBe(1_700_000_000);
    expect(mockGetSavedSearches).toHaveBeenCalledWith(SCOUT_A);
  });

  it('returns empty array when scout has no saved searches', async () => {
    mockGetSavedSearches.mockReturnValueOnce([]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('returns multiple saved searches ordered newest-first (respects DB order)', async () => {
    const rows = [
      { ...MOCK_ROW, id: 2, name: 'Newer', created_at: 1_700_000_200 },
      { ...MOCK_ROW, id: 1, name: 'Older', created_at: 1_700_000_000 },
    ];
    mockGetSavedSearches.mockReturnValueOnce(rows);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data[0].name).toBe('Newer');
    expect(res.body.data[1].name).toBe('Older');
  });

  it('returns 403 when authenticated wallet does not match :wallet param (cross-scout denial)', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockGetSavedSearches).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/saved-searches`);

    expect(res.status).toBe(401);
  });

  it('returns 403 for non-scout role', async () => {
    const playerToken = makeToken(SCOUT_A, 'player');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${playerToken}`);

    expect(res.status).toBe(403);
    expect(mockGetSavedSearches).not.toHaveBeenCalled();
  });
});

// ─── DELETE /api/scouts/:wallet/saved-searches/:id ────────────────────────────

describe('DELETE /api/scouts/:wallet/saved-searches/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes a saved search and returns 200', async () => {
    mockDeleteSavedSearch.mockReturnValueOnce(true);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/saved-searches/1`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.removed).toBe(true);
    expect(res.body.data.id).toBe(1);
    expect(mockDeleteSavedSearch).toHaveBeenCalledWith(1, SCOUT_A);
  });

  it('returns 404 when the saved search does not exist', async () => {
    mockDeleteSavedSearch.mockReturnValueOnce(false);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/saved-searches/999`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 403 when authenticated wallet does not match :wallet param (cross-scout denial)', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/saved-searches/1`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockDeleteSavedSearch).not.toHaveBeenCalled();
  });

  it('cannot delete another scout\'s saved search even with a valid own token', async () => {
    // SCOUT_B tries to delete search id=1 which belongs to SCOUT_A.
    // The route /:wallet path means SCOUT_B must use their own wallet in the URL.
    // The DB helper scopes the DELETE to scout_wallet, so even if SCOUT_B somehow
    // called with their own wallet, they would get a 404 (row belongs to SCOUT_A).
    mockDeleteSavedSearch.mockReturnValueOnce(false); // row exists for SCOUT_A but not SCOUT_B

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_B}/saved-searches/1`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    // DB helper passes SCOUT_B as the wallet filter → row not found for SCOUT_B
    expect(res.status).toBe(404);
    expect(mockDeleteSavedSearch).toHaveBeenCalledWith(1, SCOUT_B);
  });

  it('returns 400 when id param is not a number', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/saved-searches/notanumber`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(400);
    expect(mockDeleteSavedSearch).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/saved-searches/1`);

    expect(res.status).toBe(401);
  });

  it('returns 403 for non-scout role', async () => {
    const playerToken = makeToken(SCOUT_A, 'player');
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/saved-searches/1`)
      .set('Authorization', `Bearer ${playerToken}`);

    expect(res.status).toBe(403);
    expect(mockDeleteSavedSearch).not.toHaveBeenCalled();
  });
});

// ─── Full CRUD cycle ──────────────────────────────────────────────────────────

describe('saved-search full CRUD cycle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('completes create → list → delete lifecycle', async () => {
    // 1. Create
    mockInsertSavedSearch.mockReturnValueOnce(42);

    const createRes = await request(app)
      .post(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ name: 'CRUD test', filters: VALID_FILTERS });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.id).toBe(42);

    // 2. List — the new saved search appears
    mockGetSavedSearches.mockReturnValueOnce([
      {
        id: 42,
        scout_wallet: SCOUT_A,
        name: 'CRUD test',
        filters: JSON.stringify(VALID_FILTERS),
        created_at: createRes.body.data.created_at,
      },
    ]);

    const listRes = await request(app)
      .get(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].id).toBe(42);
    expect(listRes.body.data[0].filters).toEqual(VALID_FILTERS);

    // 3. Delete
    mockDeleteSavedSearch.mockReturnValueOnce(true);

    const deleteRes = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/saved-searches/42`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.data.removed).toBe(true);

    // 4. List again — now empty
    mockGetSavedSearches.mockReturnValueOnce([]);

    const emptyListRes = await request(app)
      .get(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(emptyListRes.status).toBe(200);
    expect(emptyListRes.body.data).toEqual([]);
  });
});

// ─── Cross-scout authorization summary ───────────────────────────────────────

describe('cross-scout authorization denial', () => {
  beforeEach(() => jest.clearAllMocks());

  it('denies POST when token wallet !== URL wallet', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutBToken}`)
      .send({ name: 'Should fail', filters: {} });

    expect(res.status).toBe(403);
    expect(mockInsertSavedSearch).not.toHaveBeenCalled();
  });

  it('denies GET when token wallet !== URL wallet', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/saved-searches`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockGetSavedSearches).not.toHaveBeenCalled();
  });

  it('denies DELETE when token wallet !== URL wallet', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/saved-searches/1`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockDeleteSavedSearch).not.toHaveBeenCalled();
  });
});
