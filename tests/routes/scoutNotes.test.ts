/**
 * Tests for private scout notes (#488)
 *
 * Verifies:
 *  - Scouts can create, update, and read private notes on players
 *  - Notes are private per-scout (cross-scout reads are denied)
 *  - Players and validators cannot read another scout's notes
 *  - Upserting twice updates in place
 *  - Notes do NOT leak through admin events / export endpoints
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  // existing mocks required by scout router
  queryEvents: jest.fn(),
  getEventsPage: jest.fn().mockReturnValue([]),
  countEventsFiltered: jest.fn().mockReturnValue(0),
  getPlayerById: jest.fn(),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn(),
  dbRenewSubscription: jest.fn(),
  dbCancelSubscription: jest.fn(),
  insertContactUnlock: jest.fn(),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  // notes helpers (legacy upsert)
  upsertScoutNote: jest.fn(),
  getScoutNote: jest.fn(),
  getScoutNotes: jest.fn(),
  // notes helpers (multi-note CRUD)
  insertScoutPlayerNote: jest.fn(),
  getScoutPlayerNotes: jest.fn(),
  updateScoutPlayerNote: jest.fn(),
  deleteScoutPlayerNote: jest.fn(),
  // api key helpers (needed by scout router import)
  insertApiKey: jest.fn(),
  listApiKeysByWallet: jest.fn().mockReturnValue([]),
  revokeApiKeyById: jest.fn(),
  getApiKeyByHash: jest.fn().mockReturnValue(null),
  touchApiKeyLastUsed: jest.fn(),
  // bookmarks helpers (needed by scout router import)
  insertBookmark: jest.fn(),
  deleteBookmark: jest.fn(),
  getBookmarksByScout: jest.fn().mockReturnValue([]),
  // events export (needed by GET /api/admin/events/export)
  getEventsIterable: jest.fn(function* () {}),
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
  upsertScoutNote,
  getScoutNote,
  getScoutNotes,
  insertScoutPlayerNote,
  getScoutPlayerNotes,
  updateScoutPlayerNote,
  deleteScoutPlayerNote,
} from '../../src/db';

const mockUpsertScoutNote = upsertScoutNote as jest.Mock;
const mockGetScoutNote = getScoutNote as jest.Mock;
const mockGetScoutNotes = getScoutNotes as jest.Mock;
const mockInsertScoutPlayerNote = insertScoutPlayerNote as jest.Mock;
const mockGetScoutPlayerNotes = getScoutPlayerNotes as jest.Mock;
const mockUpdateScoutPlayerNote = updateScoutPlayerNote as jest.Mock;
const mockDeleteScoutPlayerNote = deleteScoutPlayerNote as jest.Mock;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCOUT_A = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';
const SCOUT_B = 'GAEZS7NMWCNTUFGDNXWVYVTKGGP47CESPEV5BVT5LNFHKXC5TGBZ4O5O';
const PLAYER  = 'GBXDL7VCREKVMQWV3ZL4BK3OFZZUVRKUTPHKCDPUMOVMCUFLZGKQMXWY';
const PLAYER_ID = 'player-abc-123';

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const scoutAToken = makeToken(SCOUT_A);
const scoutBToken = makeToken(SCOUT_B);
const playerToken = makeToken(PLAYER, 'player');
const validatorToken = makeToken(PLAYER, 'validator');

// ─── PUT /api/scouts/:wallet/notes/:playerId ──────────────────────────────────

describe('PUT /api/scouts/:wallet/notes/:playerId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a note and returns 200', async () => {
    mockUpsertScoutNote.mockReturnValueOnce(undefined);

    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ note: 'Good pace, strong left foot' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.note).toBe('Good pace, strong left foot');
    expect(res.body.data.player_id).toBe(PLAYER_ID);
    expect(mockUpsertScoutNote).toHaveBeenCalledTimes(1);
  });

  it('upserts (updates in place) when called twice for same player', async () => {
    mockUpsertScoutNote.mockReturnValue(undefined);

    await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ note: 'First impression' });

    await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ note: 'Updated impression after second viewing' });

    // Both calls must reach the upsert helper (deduplication is handled by SQL)
    expect(mockUpsertScoutNote).toHaveBeenCalledTimes(2);
  });

  it('sanitizes note text before storing', async () => {
    mockUpsertScoutNote.mockReturnValueOnce(undefined);

    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ note: 'Fast player\x00\x1f' }); // control chars stripped by sanitizer

    expect(res.status).toBe(200);
    expect(res.body.data.note).not.toContain('\x00');
  });

  it('returns 403 when scout tries to write to a different wallet', async () => {
    const res = await request(app)
      .put(`/api/scouts/${SCOUT_B}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ note: 'Should not be allowed' });

    expect(res.status).toBe(403);
    expect(mockUpsertScoutNote).not.toHaveBeenCalled();
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .send({ note: 'No auth' });

    expect(res.status).toBe(401);
  });

  it('returns 403 when a player token is used', async () => {
    const res = await request(app)
      .put(`/api/scouts/${PLAYER}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ note: 'Player trying to set scout note' });

    expect(res.status).toBe(403);
  });

  it('returns 400 when note is empty', async () => {
    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ note: '' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when note field is missing', async () => {
    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/scouts/:wallet/notes/:playerId ──────────────────────────────────

describe('GET /api/scouts/:wallet/notes/:playerId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the note for the authoring scout', async () => {
    mockGetScoutNote.mockReturnValueOnce({
      id: 1,
      scout_wallet: SCOUT_A,
      player_id: PLAYER_ID,
      note_text: 'Strong defender',
      updated_at: 1_700_000_000,
    });

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.note).toBe('Strong defender');
  });

  it('returns 404 when no note exists', async () => {
    mockGetScoutNote.mockReturnValueOnce(null);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 403 when scout B tries to read scout A notes', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockGetScoutNote).not.toHaveBeenCalled();
  });

  it('returns 403 when a player token is used', async () => {
    const res = await request(app)
      .get(`/api/scouts/${PLAYER}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${playerToken}`);

    expect(res.status).toBe(403);
  });

  it('returns 403 when a validator token is used', async () => {
    const res = await request(app)
      .get(`/api/scouts/${PLAYER}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${validatorToken}`);

    expect(res.status).toBe(403);
  });

  it('returns 401 when no token provided', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`);

    expect(res.status).toBe(401);
  });
});

// ─── GET /api/scouts/:wallet/notes ───────────────────────────────────────────

describe('GET /api/scouts/:wallet/notes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns all notes for the authoring scout', async () => {
    mockGetScoutNotes.mockReturnValueOnce([
      { id: 1, scout_wallet: SCOUT_A, player_id: 'p1', note_text: 'Fast', updated_at: 2 },
      { id: 2, scout_wallet: SCOUT_A, player_id: 'p2', note_text: 'Tall', updated_at: 1 },
    ]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].note).toBe('Fast');
  });

  it('returns empty array when scout has no notes', async () => {
    mockGetScoutNotes.mockReturnValueOnce([]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns 403 when scout B tries to list scout A notes', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockGetScoutNotes).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes`);

    expect(res.status).toBe(401);
  });
});

// ─── Notes must not leak through admin endpoints ──────────────────────────────

describe('Admin endpoints must not expose scout notes', () => {
  const ADMIN_TOKEN = jwt.sign(
    { sub: 'GADMIN', role: 'admin' },
    SECRET,
    { expiresIn: '1h' },
  );

  it('GET /api/admin/events does not contain scout_player_notes data', async () => {
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    // The response body should never reference note_text or scout_player_notes
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('note_text');
    expect(bodyStr).not.toContain('scout_player_notes');
  });

  it('GET /api/admin/events/export does not contain scout note data', async () => {
    const res = await request(app)
      .get('/api/admin/events/export')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    const bodyStr = typeof res.text === 'string' ? res.text : JSON.stringify(res.body);
    expect(bodyStr).not.toContain('note_text');
    expect(bodyStr).not.toContain('scout_player_notes');
  });
});

// ─── POST /api/scouts/:wallet/players/:playerId/notes ─────────────────────────

describe('POST /api/scouts/:wallet/players/:playerId/notes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a note and returns 201', async () => {
    mockInsertScoutPlayerNote.mockReturnValueOnce(42);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: 'Impressive left foot' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(42);
    expect(res.body.data.content).toBe('Impressive left foot');
    expect(res.body.data.player_id).toBe(PLAYER_ID);
    expect(res.body.data.scout_wallet).toBe(SCOUT_A);
    expect(mockInsertScoutPlayerNote).toHaveBeenCalledTimes(1);
  });

  it('sanitizes HTML before storing', async () => {
    mockInsertScoutPlayerNote.mockReturnValueOnce(1);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: '<script>alert(1)</script>Follow up' });

    expect(res.status).toBe(201);
    expect(res.body.data.content).not.toContain('<script>');
    expect(res.body.data.content).not.toContain('</script>');
  });

  it('strips control characters before storing', async () => {
    mockInsertScoutPlayerNote.mockReturnValueOnce(1);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: 'Fast player\x00\x1f' });

    expect(res.status).toBe(201);
    expect(res.body.data.content).not.toContain('\x00');
  });

  it('returns 400 when content is empty', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: '' });

    expect(res.status).toBe(400);
    expect(mockInsertScoutPlayerNote).not.toHaveBeenCalled();
  });

  it('returns 400 when content field is missing', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(mockInsertScoutPlayerNote).not.toHaveBeenCalled();
  });

  it('returns 400 when content exceeds 2000 characters', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: 'a'.repeat(2001) });

    expect(res.status).toBe(400);
    expect(mockInsertScoutPlayerNote).not.toHaveBeenCalled();
  });

  it('accepts content of exactly 2000 characters', async () => {
    mockInsertScoutPlayerNote.mockReturnValueOnce(1);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: 'a'.repeat(2000) });

    expect(res.status).toBe(201);
  });

  it('returns 403 when scout tries to post under a different wallet', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_B}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: 'Should not be stored' });

    expect(res.status).toBe(403);
    expect(mockInsertScoutPlayerNote).not.toHaveBeenCalled();
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`)
      .send({ content: 'No auth' });

    expect(res.status).toBe(401);
  });

  it('returns 403 when a player token is used', async () => {
    const res = await request(app)
      .post(`/api/scouts/${PLAYER}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ content: 'Wrong role' });

    expect(res.status).toBe(403);
  });
});

// ─── GET /api/scouts/:wallet/players/:playerId/notes ──────────────────────────

describe('GET /api/scouts/:wallet/players/:playerId/notes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns all notes for the scout-player pair, newest first', async () => {
    mockGetScoutPlayerNotes.mockReturnValueOnce([
      { id: 2, scout_wallet: SCOUT_A, player_id: PLAYER_ID, content: 'Follow up after cup final', created_at: 2_000_000, updated_at: 2_000_000 },
      { id: 1, scout_wallet: SCOUT_A, player_id: PLAYER_ID, content: 'Impressive left foot',      created_at: 1_000_000, updated_at: 1_000_000 },
    ]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].content).toBe('Follow up after cup final');
    expect(res.body.data[0].id).toBe(2);
    expect(mockGetScoutPlayerNotes).toHaveBeenCalledWith(SCOUT_A, PLAYER_ID);
  });

  it('returns empty array when no notes exist', async () => {
    mockGetScoutPlayerNotes.mockReturnValueOnce([]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns 403 when scout B tries to read scout A notes', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockGetScoutPlayerNotes).not.toHaveBeenCalled();
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`);

    expect(res.status).toBe(401);
  });

  it('returns 403 when a player token is used', async () => {
    const res = await request(app)
      .get(`/api/scouts/${PLAYER}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${playerToken}`);

    expect(res.status).toBe(403);
  });

  it('returns 403 when a validator token is used', async () => {
    const res = await request(app)
      .get(`/api/scouts/${PLAYER}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${validatorToken}`);

    expect(res.status).toBe(403);
  });
});

// ─── PUT /api/scouts/:wallet/players/:playerId/notes/:noteId ──────────────────

describe('PUT /api/scouts/:wallet/players/:playerId/notes/:noteId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates a note and returns 200', async () => {
    mockUpdateScoutPlayerNote.mockReturnValueOnce(true);

    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes/7`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: 'Updated — strong in the air too' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(7);
    expect(res.body.data.content).toBe('Updated — strong in the air too');
    expect(res.body.data.player_id).toBe(PLAYER_ID);
    expect(mockUpdateScoutPlayerNote).toHaveBeenCalledTimes(1);
    expect(mockUpdateScoutPlayerNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, scout_wallet: SCOUT_A }),
    );
  });

  it('sanitizes content before storing', async () => {
    mockUpdateScoutPlayerNote.mockReturnValueOnce(true);

    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes/1`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: '<b>Bold claim</b>' });

    expect(res.status).toBe(200);
    expect(res.body.data.content).not.toContain('<b>');
  });

  it('returns 404 when the note does not exist or belongs to another scout', async () => {
    mockUpdateScoutPlayerNote.mockReturnValueOnce(false);

    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes/999`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: 'Ghost note' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when content is empty', async () => {
    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes/1`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: '' });

    expect(res.status).toBe(400);
    expect(mockUpdateScoutPlayerNote).not.toHaveBeenCalled();
  });

  it('returns 400 when content exceeds 2000 characters', async () => {
    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes/1`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: 'x'.repeat(2001) });

    expect(res.status).toBe(400);
    expect(mockUpdateScoutPlayerNote).not.toHaveBeenCalled();
  });

  it('returns 403 when scout B tries to update scout A note', async () => {
    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes/1`)
      .set('Authorization', `Bearer ${scoutBToken}`)
      .send({ content: 'Tampering attempt' });

    expect(res.status).toBe(403);
    expect(mockUpdateScoutPlayerNote).not.toHaveBeenCalled();
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes/1`)
      .send({ content: 'No auth' });

    expect(res.status).toBe(401);
  });

  it('returns 403 when a player token is used', async () => {
    const res = await request(app)
      .put(`/api/scouts/${PLAYER}/players/${PLAYER_ID}/notes/1`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ content: 'Wrong role' });

    expect(res.status).toBe(403);
  });
});

// ─── DELETE /api/scouts/:wallet/players/:playerId/notes/:noteId ───────────────

describe('DELETE /api/scouts/:wallet/players/:playerId/notes/:noteId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes a note and returns 200', async () => {
    mockDeleteScoutPlayerNote.mockReturnValueOnce(true);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes/5`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.removed).toBe(true);
    expect(res.body.data.id).toBe(5);
    expect(mockDeleteScoutPlayerNote).toHaveBeenCalledWith(5, SCOUT_A);
  });

  it('returns 404 when the note does not exist', async () => {
    mockDeleteScoutPlayerNote.mockReturnValueOnce(false);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes/999`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 403 when scout B tries to delete scout A note', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes/1`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockDeleteScoutPlayerNote).not.toHaveBeenCalled();
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes/1`);

    expect(res.status).toBe(401);
  });

  it('returns 403 when a player token is used', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${PLAYER}/players/${PLAYER_ID}/notes/1`)
      .set('Authorization', `Bearer ${playerToken}`);

    expect(res.status).toBe(403);
  });
});

// ─── Full CRUD lifecycle ──────────────────────────────────────────────────────

describe('full CRUD lifecycle for player notes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('create → list → update → delete', async () => {
    // 1. Create
    mockInsertScoutPlayerNote.mockReturnValueOnce(10);
    const createRes = await request(app)
      .post(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: 'Initial observation' });
    expect(createRes.status).toBe(201);
    const noteId = createRes.body.data.id;

    // 2. List
    mockGetScoutPlayerNotes.mockReturnValueOnce([
      { id: noteId, scout_wallet: SCOUT_A, player_id: PLAYER_ID, content: 'Initial observation', created_at: 1, updated_at: 1 },
    ]);
    const listRes = await request(app)
      .get(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].content).toBe('Initial observation');

    // 3. Update
    mockUpdateScoutPlayerNote.mockReturnValueOnce(true);
    const updateRes = await request(app)
      .put(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes/${noteId}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ content: 'Revised after second match' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.content).toBe('Revised after second match');

    // 4. Delete
    mockDeleteScoutPlayerNote.mockReturnValueOnce(true);
    const deleteRes = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/players/${PLAYER_ID}/notes/${noteId}`)
      .set('Authorization', `Bearer ${scoutAToken}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.data.removed).toBe(true);
  });
});
