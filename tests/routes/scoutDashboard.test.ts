/**
 * Tests for GET /api/scouts/:wallet/dashboard (#1141)
 *
 * Verifies:
 * - Single call returns subscription + contacts + bookmarks + saved searches
 * - Each section is bounded to 10 items and includes hasMore + _links
 * - Auth: own wallet or admin; other wallets are rejected
 * - Each section is fetched via existing service functions (no duplicated queries)
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn(),
  getLatestSubscription: jest.fn().mockResolvedValue(null),
  getSubscriptionsByScout: jest.fn().mockResolvedValue([]),
  insertSubscription: jest.fn(),
  dbRenewSubscription: jest.fn(),
  dbCancelSubscription: jest.fn(),
  insertContactUnlock: jest.fn(),
  getContactUnlocksByScout: jest.fn().mockResolvedValue([]),
  hasContactUnlock: jest.fn().mockResolvedValue(false),
  updatePlayerProgress: jest.fn(),
  getBookmarksByScout: jest.fn().mockResolvedValue([]),
  getSavedSearchesByScout: jest.fn().mockResolvedValue([]),
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
  SubscriptionError: class SubscriptionError extends Error {
    constructor(public message: string, public code: string) { super(message); }
  },
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
  insertTrialOffer: jest.fn(),
  getTrialOffers: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/cache', () => ({
  invalidatePlayerCache: jest.fn(),
  invalidateMilestoneCache: jest.fn(),
}));

import {
  getContactUnlocksByScout,
  getBookmarksByScout,
  getSavedSearchesByScout,
  getLatestSubscription,
} from '../../src/db';
import { isSubscribed } from '../../src/services/stellar';

const mockGetContactUnlocksByScout = getContactUnlocksByScout as jest.Mock;
const mockGetBookmarksByScout = getBookmarksByScout as jest.Mock;
const mockGetSavedSearchesByScout = getSavedSearchesByScout as jest.Mock;
const mockGetLatestSubscription = getLatestSubscription as jest.Mock;
const mockIsSubscribed = isSubscribed as jest.Mock;

// ─── Token helpers ─────────────────────────────────────────────────────────────

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCOUT_WALLET = 'GSCOUT1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_WALLET = 'GSCOUT2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ADMIN_WALLET = 'GADMIN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const nowSeconds = Math.floor(Date.now() / 1000);

function makeContacts(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    scout_wallet: SCOUT_WALLET,
    player_id: `player-${i}`,
    tx_hash: `tx-${i}`,
    unlocked_at: nowSeconds - i * 100,
  }));
}

function makeBookmarks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    scout_wallet: SCOUT_WALLET,
    player_id: `player-bm-${i}`,
    folder_id: null,
    note: null,
    created_at: nowSeconds - i * 100,
  }));
}

function makeSavedSearches(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    scout_wallet: SCOUT_WALLET,
    name: `Search ${i}`,
    filters: JSON.stringify({ region: 'West Africa' }),
    created_at: nowSeconds - i * 100,
    notify_enabled: 0,
  }));
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetContactUnlocksByScout.mockReset().mockResolvedValue([]);
  mockGetBookmarksByScout.mockReset().mockResolvedValue([]);
  mockGetSavedSearchesByScout.mockReset().mockResolvedValue([]);
  mockGetLatestSubscription.mockReset().mockResolvedValue(null);
  mockIsSubscribed.mockReset().mockResolvedValue({ active: false, expiresAt: null });
});

// ─── Auth checks ─────────────────────────────────────────────────────────────

describe('GET /api/scouts/:wallet/dashboard — auth', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get(`/api/scouts/${SCOUT_WALLET}/dashboard`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when authenticated as a validator (wrong role)', async () => {
    const token = makeToken(SCOUT_WALLET, 'validator');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/dashboard`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when a scout queries another wallet', async () => {
    const token = makeToken(OTHER_WALLET, 'scout');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/dashboard`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('allows a scout to query their own wallet', async () => {
    const token = makeToken(SCOUT_WALLET, 'scout');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/dashboard`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('allows an admin to query any scout wallet', async () => {
    const token = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/dashboard`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─── Response shape ───────────────────────────────────────────────────────────

describe('GET /api/scouts/:wallet/dashboard — response shape', () => {
  it('returns all four sections with zero data', async () => {
    const token = makeToken(SCOUT_WALLET, 'scout');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/dashboard`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { data } = res.body;
    expect(data.wallet).toBe(SCOUT_WALLET);

    // subscription section
    expect(data.subscription).toMatchObject({
      active: false,
      tier: null,
      expiresAt: null,
      gracePeriodActive: false,
    });

    // contacts section
    expect(data.contacts).toMatchObject({
      items: [],
      total: 0,
      hasMore: false,
      _links: { full: `/api/scouts/${SCOUT_WALLET}/contacts` },
    });

    // bookmarks section
    expect(data.bookmarks).toMatchObject({
      items: [],
      total: 0,
      hasMore: false,
      _links: { full: `/api/scouts/${SCOUT_WALLET}/bookmarks` },
    });

    // savedSearches section
    expect(data.savedSearches).toMatchObject({
      items: [],
      total: 0,
      hasMore: false,
      _links: { full: `/api/scouts/${SCOUT_WALLET}/saved-searches` },
    });
  });

  it('returns subscription active when local subscription is present', async () => {
    const futureExpiry = nowSeconds + 30 * 86400;
    mockGetLatestSubscription.mockResolvedValue({
      scout_wallet: SCOUT_WALLET,
      tier: 'premium',
      expires_at: futureExpiry,
      created_at: nowSeconds,
    });

    const token = makeToken(SCOUT_WALLET, 'scout');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/dashboard`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.subscription.active).toBe(true);
    expect(res.body.data.subscription.tier).toBe('premium');
    expect(res.body.data.subscription.expiresAt).toBe(futureExpiry);
  });

  it('bounds contacts to 10 items and sets hasMore when total exceeds limit', async () => {
    mockGetContactUnlocksByScout.mockResolvedValue(makeContacts(15));

    const token = makeToken(SCOUT_WALLET, 'scout');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/dashboard`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.contacts.items).toHaveLength(10);
    expect(res.body.data.contacts.total).toBe(15);
    expect(res.body.data.contacts.hasMore).toBe(true);
  });

  it('sets hasMore false when contacts fit within limit', async () => {
    mockGetContactUnlocksByScout.mockResolvedValue(makeContacts(5));

    const token = makeToken(SCOUT_WALLET, 'scout');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/dashboard`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.contacts.items).toHaveLength(5);
    expect(res.body.data.contacts.hasMore).toBe(false);
  });

  it('bounds bookmarks to 10 items and sets hasMore', async () => {
    mockGetBookmarksByScout.mockResolvedValue(makeBookmarks(12));

    const token = makeToken(SCOUT_WALLET, 'scout');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/dashboard`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.bookmarks.items).toHaveLength(10);
    expect(res.body.data.bookmarks.total).toBe(12);
    expect(res.body.data.bookmarks.hasMore).toBe(true);
  });

  it('bounds savedSearches to 10 items and sets hasMore', async () => {
    mockGetSavedSearchesByScout.mockResolvedValue(makeSavedSearches(11));

    const token = makeToken(SCOUT_WALLET, 'scout');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/dashboard`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.savedSearches.items).toHaveLength(10);
    expect(res.body.data.savedSearches.total).toBe(11);
    expect(res.body.data.savedSearches.hasMore).toBe(true);
  });

  it('parses savedSearch filters from JSON string', async () => {
    mockGetSavedSearchesByScout.mockResolvedValue([
      {
        id: 1,
        scout_wallet: SCOUT_WALLET,
        name: 'My Search',
        filters: JSON.stringify({ region: 'South America', minTier: 2 }),
        created_at: nowSeconds,
        notify_enabled: 0,
      },
    ]);

    const token = makeToken(SCOUT_WALLET, 'scout');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/dashboard`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const search = res.body.data.savedSearches.items[0];
    expect(search.filters).toEqual({ region: 'South America', minTier: 2 });
  });

  it('includes _links pointing to full paginated endpoints', async () => {
    const token = makeToken(SCOUT_WALLET, 'scout');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/dashboard`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.data.contacts._links.full).toBe(`/api/scouts/${SCOUT_WALLET}/contacts`);
    expect(res.body.data.bookmarks._links.full).toBe(`/api/scouts/${SCOUT_WALLET}/bookmarks`);
    expect(res.body.data.savedSearches._links.full).toBe(`/api/scouts/${SCOUT_WALLET}/saved-searches`);
  });

  it('uses existing service functions (getContactUnlocksByScout is called with wallet)', async () => {
    const token = makeToken(SCOUT_WALLET, 'scout');
    await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/dashboard`)
      .set('Authorization', `Bearer ${token}`);

    expect(mockGetContactUnlocksByScout).toHaveBeenCalledWith(SCOUT_WALLET);
    expect(mockGetBookmarksByScout).toHaveBeenCalledWith(SCOUT_WALLET);
    expect(mockGetSavedSearchesByScout).toHaveBeenCalledWith(SCOUT_WALLET);
  });
});
