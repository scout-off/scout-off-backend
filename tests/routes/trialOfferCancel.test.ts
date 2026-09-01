/**
 * Tests for:
 *   DELETE /api/scouts/:wallet/trial-offers/:offerId
 *
 * Verifies that a scout can cancel (withdraw) a pending trial offer they
 * submitted, and that expired / already-responded / already-cancelled offers
 * cannot be cancelled a second time.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

const SCOUT_WALLET  = 'GSCOUTWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_SCOUT   = 'GOTHERSSCOUT2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PLAYER_ID     = 'player-abc-123';
const OFFER_ID      = 'offer-xyz-789';

const CANCEL_URL = `/api/scouts/${SCOUT_WALLET}/trial-offers/${OFFER_ID}`;

jest.mock('../../src/db', () => ({
  // scout router shared deps
  queryEvents: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn(),
  dbRenewSubscription: jest.fn(),
  dbCancelSubscription: jest.fn(),
  insertContactUnlock: jest.fn(),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  getPlayerById: jest.fn().mockReturnValue(null),
  upsertScoutNote: jest.fn(),
  getScoutNote: jest.fn(),
  getScoutNotes: jest.fn().mockReturnValue([]),
  insertApiKey: jest.fn(),
  listApiKeysByWallet: jest.fn().mockReturnValue([]),
  revokeApiKeyById: jest.fn(),
  getApiKeyByHash: jest.fn().mockReturnValue(null),
  getAllActiveApiKeys: jest.fn().mockReturnValue([]),
  touchApiKeyLastUsed: jest.fn().mockResolvedValue(undefined),
  insertBookmark: jest.fn(),
  deleteBookmark: jest.fn(),
  getBookmarksByScout: jest.fn().mockReturnValue([]),
  getBookmarkedPlayersWithDetails: jest.fn().mockReturnValue([]),
  insertBookmarkFolder: jest.fn(),
  getBookmarkFoldersByScout: jest.fn().mockReturnValue([]),
  getBookmarkFolderById: jest.fn(),
  deleteBookmarkFolder: jest.fn(),
  moveBookmarksToRoot: jest.fn(),
  countBookmarksInFolder: jest.fn().mockReturnValue(0),
  // trial offer specific
  getTrialOfferById: jest.fn(),
  cancelTrialOffer: jest.fn(),
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

import { getTrialOfferById, cancelTrialOffer } from '../../src/db';

const mockGetOffer    = getTrialOfferById as jest.Mock;
const mockCancelOffer = cancelTrialOffer  as jest.Mock;

function makeScoutToken(wallet = SCOUT_WALLET): string {
  return jwt.sign({ sub: wallet, role: 'scout' }, SECRET, { expiresIn: '1h' });
}

const pendingOffer = {
  id: 1,
  offer_id: OFFER_ID,
  scout_wallet: SCOUT_WALLET,
  player_id: PLAYER_ID,
  details_uri: 'ipfs://details',
  status: 'pending',
  reject_reason: null,
  responded_at: null,
  created_at: Math.floor(Date.now() / 1000) - 3600,
  expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
  cancelled_at: null,
};

beforeEach(() => {
  mockGetOffer.mockReset();
  mockCancelOffer.mockReset();
});

// ─── Auth guards ──────────────────────────────────────────────────────────────

it('returns 401 when no token is provided', async () => {
  const res = await request(app).delete(CANCEL_URL);
  expect(res.status).toBe(401);
});

it('returns 403 when a player JWT tries to cancel', async () => {
  const token = jwt.sign({ sub: SCOUT_WALLET, role: 'player' }, SECRET, { expiresIn: '1h' });
  const res = await request(app).delete(CANCEL_URL).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(403);
});

it('returns 403 when a different scout tries to cancel', async () => {
  const token = makeScoutToken(OTHER_SCOUT);
  const res = await request(app)
    .delete(`/api/scouts/${OTHER_SCOUT}/trial-offers/${OFFER_ID}`)
    .set('Authorization', `Bearer ${makeScoutToken(SCOUT_WALLET)}`);
  // wallet mismatch — requireWalletOwner rejects before handler
  expect(res.status).toBe(403);
  expect(mockGetOffer).not.toHaveBeenCalled();
});

// ─── Cancel happy path ────────────────────────────────────────────────────────

it('cancels a pending offer and returns 200', async () => {
  mockGetOffer.mockReturnValue(pendingOffer);
  mockCancelOffer.mockReturnValue(true);

  const res = await request(app)
    .delete(CANCEL_URL)
    .set('Authorization', `Bearer ${makeScoutToken()}`);

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.data.offerId).toBe(OFFER_ID);
  expect(res.body.data.status).toBe('cancelled');
  expect(res.body.data.cancelledAt).toBeGreaterThan(0);

  expect(mockCancelOffer).toHaveBeenCalledWith(OFFER_ID, SCOUT_WALLET);
});

// ─── Error cases ──────────────────────────────────────────────────────────────

it('returns 404 when offer does not exist', async () => {
  mockGetOffer.mockReturnValue(null);

  const res = await request(app)
    .delete(CANCEL_URL)
    .set('Authorization', `Bearer ${makeScoutToken()}`);

  expect(res.status).toBe(404);
  expect(mockCancelOffer).not.toHaveBeenCalled();
});

it('returns 403 when offer belongs to another scout', async () => {
  mockGetOffer.mockReturnValue({ ...pendingOffer, scout_wallet: OTHER_SCOUT });

  const res = await request(app)
    .delete(CANCEL_URL)
    .set('Authorization', `Bearer ${makeScoutToken()}`);

  expect(res.status).toBe(403);
  expect(mockCancelOffer).not.toHaveBeenCalled();
});

it('returns 409 when offer is already accepted', async () => {
  mockGetOffer.mockReturnValue({ ...pendingOffer, status: 'accepted', responded_at: 12345 });

  const res = await request(app)
    .delete(CANCEL_URL)
    .set('Authorization', `Bearer ${makeScoutToken()}`);

  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/already accepted/i);
  expect(mockCancelOffer).not.toHaveBeenCalled();
});

it('returns 409 when offer is already rejected', async () => {
  mockGetOffer.mockReturnValue({ ...pendingOffer, status: 'rejected', responded_at: 12345 });

  const res = await request(app)
    .delete(CANCEL_URL)
    .set('Authorization', `Bearer ${makeScoutToken()}`);

  expect(res.status).toBe(409);
  expect(mockCancelOffer).not.toHaveBeenCalled();
});

it('returns 409 when offer is already cancelled', async () => {
  mockGetOffer.mockReturnValue({
    ...pendingOffer,
    cancelled_at: Math.floor(Date.now() / 1000) - 60,
  });

  const res = await request(app)
    .delete(CANCEL_URL)
    .set('Authorization', `Bearer ${makeScoutToken()}`);

  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/already been cancelled/i);
  expect(mockCancelOffer).not.toHaveBeenCalled();
});

it('returns 409 when DB update finds no row (race condition)', async () => {
  mockGetOffer.mockReturnValue(pendingOffer);
  mockCancelOffer.mockReturnValue(false); // row was accepted/rejected concurrently

  const res = await request(app)
    .delete(CANCEL_URL)
    .set('Authorization', `Bearer ${makeScoutToken()}`);

  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/could not be cancelled/i);
});
