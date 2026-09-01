/**
 * REST API-key scope enforcement (#1019).
 *
 * Verifies the shared scope contract end-to-end through HTTP:
 *   - legacy keys (NULL/missing scopes) remain unrestricted
 *   - restricted keys are denied 403 (with reason.requiredScope) on
 *     operations outside their granted scopes
 *   - restricted keys succeed when the scope matches
 *   - subscription reads require read:subscription for restricted keys
 *   - JWT-authenticated requests are never scope-gated
 *   - issuance accepts/validates explicit scope lists
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { generateApiKey } from '../../src/controllers/apiKeyController';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Mocks (same shape as tests/routes/apiKeys.test.ts + scout routes) ───────

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn().mockReturnValue({
    player_id: 'b8e1a1d3',
    wallet: 'GDUP7WH3BJ3S3RGDQO5T2D3B4QN6P2ZJ3F5D6K7L8M9N0P1Q2R3S4T5U6V',
    position: 'Forward',
    region: 'West Africa',
    metadata_uri: null,
    progress_level: 1,
    created_at: 1700000000,
    registered_at: 1700000000,
    is_active: 1,
  }),
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
  getApiKeyByHash: jest.fn().mockReturnValue(null),
  getActiveApiKeyByLookupHash: jest.fn().mockReturnValue(null),
  getActiveApiKeysAwaitingLookupHash: jest.fn().mockReturnValue([]),
  setApiKeyLookupHash: jest.fn(),
  touchApiKeyLastUsed: jest.fn(),
  // bookmarks
  insertBookmark: jest.fn(),
  deleteBookmark: jest.fn(),
  getBookmarksByScout: jest.fn().mockReturnValue([]),
  // webhook subscriptions
  createWebhookSubscription: jest.fn(),
  getWebhookSubscriptionsByScout: jest.fn().mockReturnValue([]),
  getWebhookSubscriptionById: jest.fn(),
  deleteWebhookSubscription: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  submitContactPayment: jest.fn(),
  purchaseSubscription: jest.fn().mockResolvedValue({ transactionId: 'tx-1', expiresAt: 9999999999 }),
  renewSubscription: jest.fn().mockResolvedValue({ transactionId: 'tx-2', expiresAt: 9999999999 }),
  cancelSubscriptionOnChain: jest.fn().mockResolvedValue({ transactionId: 'tx-3' }),
  logTrialOffer: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) { super(message); }
  },
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

import {
  getActiveApiKeyByLookupHash,
  insertApiKey,
  revokeApiKeyById,
  createWebhookSubscription,
  insertContactUnlock,
  insertSubscription,
  dbCancelSubscription,
  getLatestSubscription,
} from '../../src/db';
import { submitContactPayment } from '../../src/services/stellar';

const mockGetByLookup = getActiveApiKeyByLookupHash as jest.Mock;
const mockInsertApiKey = insertApiKey as jest.Mock;
const mockRevokeApiKey = revokeApiKeyById as jest.Mock;
const mockCreateWebhook = createWebhookSubscription as jest.Mock;
const mockInsertContactUnlock = insertContactUnlock as jest.Mock;
const mockInsertSubscription = insertSubscription as jest.Mock;
const mockCancelSubscription = dbCancelSubscription as jest.Mock;
const mockGetLatestSubscription = getLatestSubscription as jest.Mock;
const mockSubmitContactPayment = submitContactPayment as jest.Mock;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCOUT = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';
const PLAYER_ID = 'b8e1a1d3';

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

/**
 * Seed the indexed lookup (#1033) with one key for `scopes` and return its raw
 * key. Mirrors the UNIQUE idx_api_keys_lookup_hash: the row is returned only
 * for its own derived lookup hash, never for an arbitrary one.
 */
function seedKey(scopes: string[] | null): { id: number; key: string } {
  const { key, keyHash, lookupHash } = generateApiKey();
  const row = {
    id: 77,
    key_hash: keyHash,
    scout_wallet: SCOUT,
    label: 'fixture',
    created_at: 0,
    last_used_at: null,
    revoked_at: null,
    scopes: scopes === null ? null : JSON.stringify(scopes),
    rate_limit_per_minute: null,
    lookup_hash: lookupHash,
  };
  mockGetByLookup.mockImplementation((candidate: string) =>
    candidate === lookupHash ? row : null,
  );
  return { id: 77, key };
}

beforeEach(() => jest.clearAllMocks());

// ─── Legacy (unrestricted) keys ───────────────────────────────────────────────

describe('API-key scopes — legacy/unrestricted keys', () => {
  it('legacy key (NULL scopes) can mutate subscriptions', async () => {
    const f = seedKey(null);
    mockInsertSubscription.mockReturnValue(1);
    mockGetLatestSubscription.mockReturnValue(null);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/subscribe`)
      .set('X-API-Key', f.key)
      .send({ tier: 'basic', duration: 30 });

    expect(res.status).toBe(201);
    expect(mockInsertSubscription).toHaveBeenCalled();
  });

  it('legacy key can unlock contacts', async () => {
    const f = seedKey(null);
    mockSubmitContactPayment.mockResolvedValue({ transactionHash: 'tx-unlock' });

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/contacts/${PLAYER_ID}/unlock`)
      .set('X-API-Key', f.key)
      .send({});

    expect(res.status).toBe(200);
    expect(mockInsertContactUnlock).toHaveBeenCalled();
  });

  it('legacy key can issue and revoke API keys', async () => {
    const f = seedKey(null);
    mockInsertApiKey.mockReturnValue(9);

    let res = await request(app)
      .post(`/api/scouts/${SCOUT}/api-keys`)
      .set('X-API-Key', f.key)
      .send({ label: 'bot' });
    expect(res.status).toBe(201);

    mockRevokeApiKey.mockReturnValue(true);
    res = await request(app)
      .delete(`/api/scouts/${SCOUT}/api-keys/9`)
      .set('X-API-Key', f.key);
    expect(res.status).toBe(200);
    expect(mockRevokeApiKey).toHaveBeenCalledWith(9, SCOUT);
  });

  it('legacy key can register webhooks', async () => {
    const f = seedKey(null);
    mockCreateWebhook.mockReturnValue({ id: 1 });

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/webhooks`)
      .set('X-API-Key', f.key)
      .send({ url: 'https://example.com/hook', eventTypes: ['milestone_approved'] });

    expect(res.status).toBe(201);
    expect(mockCreateWebhook).toHaveBeenCalled();
  });

  it('key whose scopes equal the migration default is unrestricted', async () => {
    const f = seedKey(['read:players', 'read:milestones', 'write:contacts', 'read:subscription']);
    mockSubmitContactPayment.mockResolvedValue({ transactionHash: 'tx-unlock' });

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/contacts/${PLAYER_ID}/unlock`)
      .set('X-API-Key', f.key)
      .send({});

    expect(res.status).toBe(200);
  });
});

// ─── Restricted keys — denied ─────────────────────────────────────────────────

describe('API-key scopes — restricted keys denied on missing scope', () => {
  it('403 on subscribe without write:subscriptions', async () => {
    const f = seedKey(['read:milestones']);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/subscribe`)
      .set('X-API-Key', f.key)
      .send({ tier: 'basic', duration: 30 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body.reason?.requiredScope).toBe('write:subscriptions');
    expect(mockInsertSubscription).not.toHaveBeenCalled();
  });

  it('403 on contact unlock without write:contacts', async () => {
    const f = seedKey(['read:milestones']);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/contacts/${PLAYER_ID}/unlock`)
      .set('X-API-Key', f.key)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.reason?.requiredScope).toBe('write:contacts');
    expect(mockSubmitContactPayment).not.toHaveBeenCalled();
  });

  it('403 on API-key issuance without write:api_keys', async () => {
    const f = seedKey(['read:milestones']);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/api-keys`)
      .set('X-API-Key', f.key)
      .send({ label: 'bot' });

    expect(res.status).toBe(403);
    expect(res.body.reason?.requiredScope).toBe('write:api_keys');
    expect(mockInsertApiKey).not.toHaveBeenCalled();
  });

  it('403 on API-key revocation without write:api_keys', async () => {
    const f = seedKey(['read:milestones']);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT}/api-keys/3`)
      .set('X-API-Key', f.key);

    expect(res.status).toBe(403);
    expect(res.body.reason?.requiredScope).toBe('write:api_keys');
    expect(mockRevokeApiKey).not.toHaveBeenCalled();
  });

  it('403 on webhook registration without write:webhooks', async () => {
    const f = seedKey(['read:milestones']);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/webhooks`)
      .set('X-API-Key', f.key)
      .send({ url: 'https://example.com/hook' });

    expect(res.status).toBe(403);
    expect(res.body.reason?.requiredScope).toBe('write:webhooks');
    expect(mockCreateWebhook).not.toHaveBeenCalled();
  });

  it('403 on subscription read without read:subscription', async () => {
    const f = seedKey(['read:milestones']);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT}/subscription`)
      .set('X-API-Key', f.key);

    expect(res.status).toBe(403);
    expect(res.body.reason?.requiredScope).toBe('read:subscription');
  });
});

// ─── Restricted keys — allowed with the matching scope ────────────────────────

describe('API-key scopes — restricted keys allowed when scope matches', () => {
  it('allows subscribe with write:subscriptions', async () => {
    const f = seedKey(['write:subscriptions']);
    mockGetLatestSubscription.mockReturnValue(null);
    mockInsertSubscription.mockReturnValue(1);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/subscribe`)
      .set('X-API-Key', f.key)
      .send({ tier: 'basic', duration: 30 });

    expect(res.status).toBe(201);
    expect(mockInsertSubscription).toHaveBeenCalled();
  });

  it('allows contact unlock with write:contacts', async () => {
    const f = seedKey(['write:contacts']);
    mockSubmitContactPayment.mockResolvedValue({ transactionHash: 'tx-unlock' });

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/contacts/${PLAYER_ID}/unlock`)
      .set('X-API-Key', f.key)
      .send({});

    expect(res.status).toBe(200);
    expect(mockInsertContactUnlock).toHaveBeenCalled();
  });

  it('allows subscription read with read:subscription', async () => {
    const f = seedKey(['read:subscription']);
    mockGetLatestSubscription.mockReturnValue(null);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT}/subscription`)
      .set('X-API-Key', f.key);

    expect(res.status).toBe(200);
  });

  it('allows webhook registration with write:webhooks', async () => {
    const f = seedKey(['write:webhooks']);
    mockCreateWebhook.mockReturnValue({ id: 5 });

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/webhooks`)
      .set('X-API-Key', f.key)
      .send({ url: 'https://example.com/hook', eventTypes: ['milestone_approved'] });

    expect(res.status).toBe(201);
    expect(mockCreateWebhook).toHaveBeenCalled();
  });
});

// ─── JWT-auth is never scope-gated ────────────────────────────────────────────

describe('API-key scopes — JWT-authenticated requests are never gated', () => {
  it('a scout JWT can unlock contacts regardless of scopes', async () => {
    mockSubmitContactPayment.mockResolvedValue({ transactionHash: 'tx-unlock' });

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/contacts/${PLAYER_ID}/unlock`)
      .set('Authorization', `Bearer ${makeToken(SCOUT)}`)
      .send({});

    expect(res.status).toBe(200);
  });

  it('a scout JWT can cancel a subscription regardless of scopes', async () => {
    mockCancelSubscription.mockReturnValue(true);
    mockGetLatestSubscription.mockReturnValue({
      id: 1,
      scout_wallet: SCOUT,
      tier: 'basic',
      expires_at: 9999999999,
      cancelled_at: null,
      created_at: 0,
    });

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT}/subscribe`)
      .set('Authorization', `Bearer ${makeToken(SCOUT)}`);

    expect(res.status).toBe(200);
    expect(mockCancelSubscription).toHaveBeenCalled();
  });
});

// ─── Issuance with explicit scopes ────────────────────────────────────────────

describe('API-key scopes — issuance with explicit scopes', () => {
  it('persists the granted scope list when provided', async () => {
    mockInsertApiKey.mockReturnValue(11);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/api-keys`)
      .set('Authorization', `Bearer ${makeToken(SCOUT)}`)
      .send({ label: 'restricted', scopes: ['read:milestones', 'write:contacts'] });

    expect(res.status).toBe(201);
    expect(res.body.data.scopes).toEqual(['read:milestones', 'write:contacts']);
    const callArg = mockInsertApiKey.mock.calls[0][0];
    expect(callArg.scopes).toEqual(['read:milestones', 'write:contacts']);
  });

  it('omits scopes (legacy/unrestricted) when not provided', async () => {
    mockInsertApiKey.mockReturnValue(12);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/api-keys`)
      .set('Authorization', `Bearer ${makeToken(SCOUT)}`)
      .send({ label: 'legacy' });

    expect(res.status).toBe(201);
    expect(res.body.data.scopes).toEqual([]);
    const callArg = mockInsertApiKey.mock.calls[0][0];
    expect(callArg.scopes).toBeUndefined(); // → NULL row → unrestricted
  });

  it('rejects an unknown scope string at issuance', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT}/api-keys`)
      .set('Authorization', `Bearer ${makeToken(SCOUT)}`)
      .send({ label: 'bad', scopes: ['admin:*'] });

    expect(res.status).toBe(400);
    expect(mockInsertApiKey).not.toHaveBeenCalled();
  });
});