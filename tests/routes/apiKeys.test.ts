/**
 * Tests for API key issuance and rotation (#490)
 *
 * Verifies:
 *  - Scouts can issue, list, and revoke API keys
 *  - Only a salted hash is persisted (plaintext returned once at issuance)
 *  - auth.ts accepts X-API-Key header for authenticated requests
 *  - Revoked/unknown keys are rejected
 *  - Cross-wallet operations are denied
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { generateApiKey, verifyApiKey, resolveApiKey } from '../../src/controllers/apiKeyController';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  // shared scout router dependencies
  queryEvents: jest.fn(),
  getPlayerById: jest.fn(),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn(),
  dbRenewSubscription: jest.fn(),
  dbCancelSubscription: jest.fn(),
  insertContactUnlock: jest.fn(),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  // notes
  upsertScoutNote: jest.fn(),
  getScoutNote: jest.fn(),
  getScoutNotes: jest.fn().mockReturnValue([]),
  // api keys
  insertApiKey: jest.fn(),
  listApiKeysByWallet: jest.fn().mockReturnValue([]),
  revokeApiKeyById: jest.fn(),
  getApiKeyById: jest.fn(),
  scheduleApiKeyRevocation: jest.fn(),
  getApiKeyByHash: jest.fn().mockReturnValue(null),
  getAllActiveApiKeys: jest.fn().mockReturnValue([]),
  getActiveApiKeyByLookupHash: jest.fn().mockReturnValue(null),
  getActiveApiKeysAwaitingLookupHash: jest.fn().mockReturnValue([]),
  setApiKeyLookupHash: jest.fn(),
  touchApiKeyLastUsed: jest.fn().mockResolvedValue(undefined),
  // bookmarks
  insertBookmark: jest.fn(),
  deleteBookmark: jest.fn(),
  getBookmarksByScout: jest.fn().mockReturnValue([]),
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
  insertApiKey,
  listApiKeysByWallet,
  revokeApiKeyById,
  getApiKeyById,
  scheduleApiKeyRevocation,
  getActiveApiKeyByLookupHash,
  getActiveApiKeysAwaitingLookupHash,
  setApiKeyLookupHash,
  touchApiKeyLastUsed,
} from '../../src/db';

const mockInsertApiKey    = insertApiKey    as jest.Mock;
const mockListApiKeys     = listApiKeysByWallet as jest.Mock;
const mockRevokeApiKey    = revokeApiKeyById as jest.Mock;
const mockGetApiKeyById   = getApiKeyById as jest.Mock;
const mockScheduleRevoke  = scheduleApiKeyRevocation as jest.Mock;
const mockGetByLookup     = getActiveApiKeyByLookupHash as jest.Mock;
const mockGetPending      = getActiveApiKeysAwaitingLookupHash as jest.Mock;
const mockSetLookupHash   = setApiKeyLookupHash as jest.Mock;
const mockTouchLastUsed   = touchApiKeyLastUsed as jest.Mock;

/**
 * Seed the indexed lookup so that only the row's own lookup_hash resolves it —
 * mirroring the UNIQUE index in db/024_api_key_lookup_hash.sql rather than
 * returning the same row for any input.
 */
function seedIndexedKey(row: Record<string, unknown> & { lookup_hash: string }): void {
  mockGetByLookup.mockImplementation((lookupHash: string) =>
    lookupHash === row.lookup_hash ? row : null,
  );
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCOUT_A = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';
const SCOUT_B = 'GAEZS7NMWCNTUFGDNXWVYVTKGGP47CESPEV5BVT5LNFHKXC5TGBZ4O5O';

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const scoutAToken = makeToken(SCOUT_A);
const scoutBToken = makeToken(SCOUT_B);

// ─── Unit tests for crypto helpers ────────────────────────────────────────────

describe('generateApiKey / verifyApiKey (unit)', () => {
  it('generates a 64-char hex key', () => {
    const { key } = generateApiKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates a different key each call', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(a.keyHash).not.toBe(b.keyHash);
  });

  it('verifyApiKey returns true for matching raw key', () => {
    const { key, keyHash } = generateApiKey();
    expect(verifyApiKey(key, keyHash)).toBe(true);
  });

  it('verifyApiKey returns false for wrong key', () => {
    const { keyHash } = generateApiKey();
    expect(verifyApiKey('completely-wrong-key', keyHash)).toBe(false);
  });

  it('verifyApiKey returns false for tampered hash', () => {
    const { key, keyHash } = generateApiKey();
    const tampered = keyHash.slice(0, -4) + 'aaaa';
    expect(verifyApiKey(key, tampered)).toBe(false);
  });

  it('verifyApiKey returns false for malformed hash (no separator)', () => {
    expect(verifyApiKey('anykey', 'nocolon')).toBe(false);
  });

  it('never stores plaintext — keyHash does not contain the raw key', () => {
    const { key, keyHash } = generateApiKey();
    expect(keyHash).not.toContain(key);
  });
});

describe('resolveApiKey (unit)', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── #1033: the lookup value must not become the authentication proof ───────

  it('locates the candidate with one indexed query — never a full-table scan', async () => {
    const { key, keyHash, lookupHash } = generateApiKey();
    seedIndexedKey({ id: 44, key_hash: keyHash, scout_wallet: SCOUT_A, label: '', created_at: 0, last_used_at: null, revoked_at: null, scopes: null, rate_limit_per_minute: null, lookup_hash: lookupHash });

    expect(await resolveApiKey(key)).not.toBeNull();

    // Exactly one targeted lookup, keyed by the derived lookup hash…
    expect(mockGetByLookup).toHaveBeenCalledTimes(1);
    expect(mockGetByLookup).toHaveBeenCalledWith(lookupHash);
    // …and no scan of the active key set.
    expect(mockGetPending).not.toHaveBeenCalled();
  });

  it('resolves the parsed scope list for a restricted key', async () => {
    const { key, keyHash, lookupHash } = generateApiKey();
    seedIndexedKey({
      id: 43,
      key_hash: keyHash,
      scout_wallet: SCOUT_A,
      label: 'restricted',
      created_at: 0,
      last_used_at: null,
      revoked_at: null,
      scopes: JSON.stringify(['read:milestones', 'write:contacts']),
      rate_limit_per_minute: null,
      lookup_hash: lookupHash,
    });

    const result = await resolveApiKey(key);
    expect(result).toEqual({
      scout_wallet: SCOUT_A,
      id: 43,
      scopes: ['read:milestones', 'write:contacts'],
    });
  });

  it('rejects a key whose lookup hash hits a row but whose raw key fails verification', async () => {
    // Simulates the security-critical case: a caller who somehow presents a
    // value that locates a row must still fail the salted key_hash check.
    const other = generateApiKey();
    const attacker = generateApiKey();
    mockGetByLookup.mockReturnValue({
      id: 45,
      key_hash: other.keyHash,       // belongs to a *different* key
      scout_wallet: SCOUT_A,
      label: '',
      created_at: 0,
      last_used_at: null,
      revoked_at: null,
      scopes: null,
      rate_limit_per_minute: null,
      lookup_hash: attacker.lookupHash,
    });

    expect(await resolveApiKey(attacker.key)).toBeNull();
    // A located-but-unverified row must not fall through to the legacy scan.
    expect(mockGetPending).not.toHaveBeenCalled();
  });

  it('returns null for an empty API key without querying the database', async () => {
    expect(await resolveApiKey('')).toBeNull();
    expect(mockGetByLookup).not.toHaveBeenCalled();
    expect(mockGetPending).not.toHaveBeenCalled();
  });

  it('returns null when no key matches anything', async () => {
    mockGetByLookup.mockReturnValue(null);
    mockGetPending.mockReturnValue([]);
    expect(await resolveApiKey('completely-unknown-key')).toBeNull();
  });

  // ── #1033: pre-migration keys keep working and heal themselves ─────────────

  it('resolves a pre-migration key (lookup_hash NULL) and backfills its lookup hash', async () => {
    const { key, keyHash, lookupHash } = generateApiKey();
    mockGetByLookup.mockReturnValue(null);
    mockGetPending.mockReturnValue([
      { id: 46, key_hash: keyHash, scout_wallet: SCOUT_A, label: 'legacy', created_at: 0, last_used_at: null, revoked_at: null, scopes: null, rate_limit_per_minute: null, lookup_hash: null },
    ]);

    expect(await resolveApiKey(key)).toEqual({ scout_wallet: SCOUT_A, id: 46, scopes: null });
    expect(mockSetLookupHash).toHaveBeenCalledWith(46, lookupHash);
  });

  it('still authenticates a pre-migration key when persisting the backfill fails', async () => {
    const { key, keyHash } = generateApiKey();
    mockGetByLookup.mockReturnValue(null);
    mockGetPending.mockReturnValue([
      { id: 47, key_hash: keyHash, scout_wallet: SCOUT_A, label: 'legacy', created_at: 0, last_used_at: null, revoked_at: null, scopes: null, rate_limit_per_minute: null, lookup_hash: null },
    ]);
    mockSetLookupHash.mockImplementationOnce(() => { throw new Error('db down'); });

    expect(await resolveApiKey(key)).toEqual({ scout_wallet: SCOUT_A, id: 47, scopes: null });
  });
});

// ─── POST /api/scouts/:wallet/api-keys ───────────────────────────────────────

describe('POST /api/scouts/:wallet/api-keys', () => {
  beforeEach(() => jest.clearAllMocks());

  it('issues a key and returns 201 with plaintext key', async () => {
    mockInsertApiKey.mockReturnValueOnce(7);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ label: 'CI pipeline' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(7);
    expect(res.body.data.label).toBe('CI pipeline');
    // plaintext key must be a 64-char hex string
    expect(res.body.data.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('applies a default expiry (API_KEY_DEFAULT_TTL_DAYS) when expiresInDays is omitted', async () => {
    mockInsertApiKey.mockReturnValueOnce(20);

    const before = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ label: 'default-ttl' });

    expect(res.status).toBe(201);
    // Default is 90 days.
    const expectedExpiry = before + 90 * 86400;
    expect(res.body.data.expires_at).toBeGreaterThanOrEqual(expectedExpiry);
    expect(res.body.data.expires_at).toBeLessThan(expectedExpiry + 5);
    const insertArg = mockInsertApiKey.mock.calls[0][0];
    expect(insertArg.expires_at).toEqual(res.body.data.expires_at);
  });

  it('accepts expiresInDays=0 to issue a non-expiring key', async () => {
    mockInsertApiKey.mockReturnValueOnce(21);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ label: 'no-expiry', expiresInDays: 0 });

    expect(res.status).toBe(201);
    expect(res.body.data.expires_at).toBeNull();
    const insertArg = mockInsertApiKey.mock.calls[0][0];
    expect(insertArg.expires_at).toBeNull();
  });

  it('accepts a custom expiresInDays value', async () => {
    mockInsertApiKey.mockReturnValueOnce(22);

    const before = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ label: 'short-lived', expiresInDays: 30 });

    expect(res.status).toBe(201);
    const expectedExpiry = before + 30 * 86400;
    expect(res.body.data.expires_at).toBeGreaterThanOrEqual(expectedExpiry);
    expect(res.body.data.expires_at).toBeLessThan(expectedExpiry + 5);
  });

  it('only persists hash (insertApiKey is called with key_hash not plaintext)', async () => {
    mockInsertApiKey.mockReturnValueOnce(1);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ label: 'server' });

    expect(res.status).toBe(201);
    const plaintextKey = res.body.data.key;
    const callArg = mockInsertApiKey.mock.calls[0][0];
    // key_hash must NOT equal or contain the plaintext key
    expect(callArg.key_hash).not.toBe(plaintextKey);
    expect(callArg.key_hash).not.toContain(plaintextKey);
    // key_hash must be in salt:hash format
    expect(callArg.key_hash).toContain(':');
  });

  it('persists an indexed lookup_hash that is neither the raw key nor the verification hash (#1033)', async () => {
    mockInsertApiKey.mockReturnValueOnce(2);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ label: 'indexed' });

    expect(res.status).toBe(201);
    const plaintextKey = res.body.data.key;
    const callArg = mockInsertApiKey.mock.calls[0][0];

    expect(callArg.lookup_hash).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(callArg.lookup_hash).not.toContain(plaintextKey);
    expect(callArg.lookup_hash).not.toBe(callArg.key_hash);
    // The locator must never leak to the client.
    expect(res.body.data.lookup_hash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(callArg.lookup_hash);
  });

  it('returns 403 when scout writes to a different wallet', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_B}/api-keys`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ label: 'bad' });

    expect(res.status).toBe(403);
    expect(mockInsertApiKey).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys`)
      .send({ label: 'nope' });

    expect(res.status).toBe(401);
  });

  it('returns 403 for non-scout role', async () => {
    const playerToken = makeToken(SCOUT_A, 'player');
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ label: 'bad' });

    expect(res.status).toBe(403);
  });
  it('rotation inherits the old key\'s expiry lifetime for the new key', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Old key was created 10 days ago with a 90-day lifetime → 80 days remain
    const oldCreatedAt = now - 10 * 86400;
    const oldExpiresAt = oldCreatedAt + 90 * 86400;
    mockOldKey({ created_at: oldCreatedAt, expires_at: oldExpiresAt });
    mockInsertApiKey.mockReturnValueOnce(13);
    mockScheduleRevoke.mockReturnValueOnce(true);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/3/rotate`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({});

    expect(res.status).toBe(201);
    const newExpiry = res.body.data.newKey.expires_at as number;
    // The new key gets the original 90-day lifetime from now.
    expect(newExpiry).toBeGreaterThanOrEqual(now + 90 * 86400 - 2);
    expect(newExpiry).toBeLessThanOrEqual(now + 90 * 86400 + 2);
    const insertArg = mockInsertApiKey.mock.calls[0][0];
    expect(insertArg.expires_at).toEqual(newExpiry);
  });

  it('rotation preserves null expiry when the old key had no expiry', async () => {
    mockOldKey({ expires_at: null });
    mockInsertApiKey.mockReturnValueOnce(14);
    mockScheduleRevoke.mockReturnValueOnce(true);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/3/rotate`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.data.newKey.expires_at).toBeNull();
    const insertArg = mockInsertApiKey.mock.calls[0][0];
    expect(insertArg.expires_at).toBeNull();
  });
});

// ─── GET /api/scouts/:wallet/api-keys ────────────────────────────────────────

describe('GET /api/scouts/:wallet/api-keys', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists keys without exposing plaintext or full hash', async () => {
    const { keyHash } = generateApiKey();
    mockListApiKeys.mockReturnValueOnce([
      { id: 1, key_hash: keyHash, scout_wallet: SCOUT_A, label: 'bot', created_at: 1000, last_used_at: null, revoked_at: null, expires_at: 9999, scopes: null, revoke_after: null, rate_limit_per_minute: null, lookup_hash: null },
    ]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const item = res.body.data[0];
    // Must not expose full hash
    expect(item.key_hash).toBeUndefined();
    // Must provide a shortened display hint
    expect(item.key_prefix).toMatch(/…$/);
    expect(item.key_prefix.length).toBeLessThan(20);
    // expires_at must be surfaced (#674)
    expect(item.expires_at).toBe(9999);
  });

  it('returns 403 for cross-wallet access', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
  });
});

// ─── DELETE /api/scouts/:wallet/api-keys/:id ─────────────────────────────────

describe('DELETE /api/scouts/:wallet/api-keys/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('revokes a key and returns 200', async () => {
    mockRevokeApiKey.mockReturnValueOnce(true);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/api-keys/3`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBe(true);
    expect(mockRevokeApiKey).toHaveBeenCalledWith(3, SCOUT_A);
  });

  it('returns 404 when key not found', async () => {
    mockRevokeApiKey.mockReturnValueOnce(false);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/api-keys/999`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 403 for cross-wallet revocation', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/api-keys/3`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockRevokeApiKey).not.toHaveBeenCalled();
  });
});

// ─── POST /api/scouts/:wallet/api-keys/:id/rotate (#676) ────────────────────

describe('POST /api/scouts/:wallet/api-keys/:id/rotate', () => {
  beforeEach(() => jest.clearAllMocks());

  function mockOldKey(overrides: Partial<{ label: string; scopes: string | null; revoked_at: number | null; expires_at: number | null; created_at: number }> = {}) {
    const createdAt = overrides.created_at ?? 0;
    mockGetApiKeyById.mockReturnValueOnce({
      id: 3,
      key_hash: 'somesalt:somehash',
      scout_wallet: SCOUT_A,
      label: 'CI pipeline',
      created_at: createdAt,
      last_used_at: null,
      revoked_at: null,
      scopes: null,
      rate_limit_per_minute: null,
      lookup_hash: 'v1:deadbeef',
      revoke_after: null,
      expires_at: null,
      ...overrides,
    });
  }

  it('issues a new working key and schedules the old one for revocation with the default 24h grace period', async () => {
    mockOldKey();
    mockInsertApiKey.mockReturnValueOnce(8);
    mockScheduleRevoke.mockReturnValueOnce(true);

    const before = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/3/rotate`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.newKey.id).toBe(8);
    expect(res.body.data.newKey.key).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.data.newKey.label).toBe('CI pipeline');
    expect(res.body.data.oldKey.id).toBe(3);
    // Default grace period is 24h.
    expect(res.body.data.oldKey.revokesAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60);
    expect(mockScheduleRevoke).toHaveBeenCalledWith(3, SCOUT_A, res.body.data.oldKey.revokesAt);
  });

  it('respects a caller-supplied gracePeriodSeconds', async () => {
    mockOldKey();
    mockInsertApiKey.mockReturnValueOnce(9);
    mockScheduleRevoke.mockReturnValueOnce(true);

    const before = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/3/rotate`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ gracePeriodSeconds: 60 });

    expect(res.status).toBe(201);
    expect(res.body.data.oldKey.revokesAt).toBeGreaterThanOrEqual(before + 60);
    expect(res.body.data.oldKey.revokesAt).toBeLessThan(before + 24 * 60 * 60);
    expect(mockScheduleRevoke).toHaveBeenCalledWith(3, SCOUT_A, res.body.data.oldKey.revokesAt);
  });

  it('a gracePeriodSeconds of 0 schedules immediate revocation', async () => {
    mockOldKey();
    mockInsertApiKey.mockReturnValueOnce(11);
    mockScheduleRevoke.mockReturnValueOnce(true);

    const before = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/3/rotate`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ gracePeriodSeconds: 0 });

    expect(res.status).toBe(201);
    expect(res.body.data.oldKey.revokesAt).toBeGreaterThanOrEqual(before);
    expect(res.body.data.oldKey.revokesAt).toBeLessThan(before + 5);
  });

  it('inherits the old key label and scopes onto the replacement', async () => {
    mockOldKey({ scopes: JSON.stringify(['read:milestones', 'write:contacts']) });
    mockInsertApiKey.mockReturnValueOnce(10);
    mockScheduleRevoke.mockReturnValueOnce(true);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/3/rotate`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({});

    expect(res.body.data.newKey.label).toBe('CI pipeline');
    expect(res.body.data.newKey.scopes).toEqual(['read:milestones', 'write:contacts']);
    const insertArg = mockInsertApiKey.mock.calls[0][0];
    expect(insertArg.scopes).toEqual(['read:milestones', 'write:contacts']);
    expect(insertArg.label).toBe('CI pipeline');
  });

  it('only persists the new key hash — never the plaintext', async () => {
    mockOldKey();
    mockInsertApiKey.mockReturnValueOnce(12);
    mockScheduleRevoke.mockReturnValueOnce(true);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/3/rotate`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({});

    const plaintextKey = res.body.data.newKey.key;
    const insertArg = mockInsertApiKey.mock.calls[0][0];
    expect(insertArg.key_hash).not.toBe(plaintextKey);
    expect(insertArg.key_hash).not.toContain(plaintextKey);
    expect(insertArg.lookup_hash).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it('returns 400 for a negative gracePeriodSeconds', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/3/rotate`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ gracePeriodSeconds: -1 });

    expect(res.status).toBe(400);
    expect(mockInsertApiKey).not.toHaveBeenCalled();
  });

  it('returns 400 for a gracePeriodSeconds beyond the 7-day cap', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/3/rotate`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ gracePeriodSeconds: 8 * 24 * 60 * 60 });

    expect(res.status).toBe(400);
    expect(mockInsertApiKey).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid id', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/not-a-number/rotate`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 404 when the key does not exist', async () => {
    mockGetApiKeyById.mockReturnValueOnce(null);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/999/rotate`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({});

    expect(res.status).toBe(404);
    expect(mockInsertApiKey).not.toHaveBeenCalled();
  });

  it('returns 404 when the key is already revoked', async () => {
    mockOldKey({ revoked_at: 12345 });

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/3/rotate`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({});

    expect(res.status).toBe(404);
    expect(mockInsertApiKey).not.toHaveBeenCalled();
  });

  it('returns 403 for cross-wallet rotation', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/3/rotate`)
      .set('Authorization', `Bearer ${scoutBToken}`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockGetApiKeyById).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys/3/rotate`)
      .send({});

    expect(res.status).toBe(401);
  });
});

// ─── X-API-Key authentication ─────────────────────────────────────────────────

describe('X-API-Key header authentication', () => {
  beforeEach(() => jest.clearAllMocks());

  it('accepts a valid X-API-Key for an authenticated request', async () => {
    const { key, keyHash, lookupHash } = generateApiKey();
    seedIndexedKey({ id: 5, key_hash: keyHash, scout_wallet: SCOUT_A, label: '', created_at: 0, last_used_at: null, revoked_at: null, lookup_hash: lookupHash });
    mockListApiKeys.mockReturnValue([]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('X-API-Key', key);

    expect(res.status).toBe(200);
    expect(mockTouchLastUsed).toHaveBeenCalledWith(5);
  });

  it('updates last_used_at when an API key is used', async () => {
    const { key, keyHash, lookupHash } = generateApiKey();
    seedIndexedKey({ id: 9, key_hash: keyHash, scout_wallet: SCOUT_A, label: '', created_at: 0, last_used_at: null, revoked_at: null, lookup_hash: lookupHash });
    mockListApiKeys.mockReturnValue([]);

    await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('X-API-Key', key);

    expect(mockTouchLastUsed).toHaveBeenCalledWith(9);
  });

  it('rejects an unknown API key with 401', async () => {
    mockGetByLookup.mockReturnValue(null);
    mockGetPending.mockReturnValue([]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('X-API-Key', 'unknown-key-that-does-not-exist');

    expect(res.status).toBe(401);
  });

  it('rejects a revoked key (revoked_at is non-null = excluded by the indexed lookup)', async () => {
    // getActiveApiKeyByLookupHash filters on `revoked_at IS NULL`, so a revoked
    // key's row is never returned even though its lookup_hash still matches.
    mockGetByLookup.mockReturnValue(null);
    mockGetPending.mockReturnValue([]);

    const { key } = generateApiKey();
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('X-API-Key', key);

    expect(res.status).toBe(401);
  });

  it('rejects an expired key (expires_at in the past = excluded by the indexed lookup)', async () => {
    // getActiveApiKeyByLookupHash also filters on `expires_at IS NULL OR expires_at > now`,
    // so an expired key's row is never returned — same 401 as revoked/unknown.
    mockGetByLookup.mockReturnValue(null);
    mockGetPending.mockReturnValue([]);

    const { key } = generateApiKey();
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('X-API-Key', key);

    expect(res.status).toBe(401);
  });

  it('accepts a valid key before its expires_at', async () => {
    const { key, keyHash, lookupHash } = generateApiKey();
    const futureExpiry = Math.floor(Date.now() / 1000) + 9999;
    seedIndexedKey({ id: 15, key_hash: keyHash, scout_wallet: SCOUT_A, label: '', created_at: 0, last_used_at: null, revoked_at: null, expires_at: futureExpiry, lookup_hash: lookupHash });
    mockListApiKeys.mockReturnValue([]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('X-API-Key', key);

    expect(res.status).toBe(200);
  });
});
