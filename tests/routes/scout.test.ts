import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn(),
  getPlayerById: jest.fn(),
  getLatestSubscription: jest.fn(),
  insertSubscription: jest.fn(),
  dbRenewSubscription: jest.fn(),
  dbCancelSubscription: jest.fn(),
  insertContactUnlock: jest.fn(),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  hasContactUnlock: jest.fn().mockReturnValue(false),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  submitContactPayment: jest.fn(),
  purchaseSubscription: jest.fn(),
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  renewSubscription: jest.fn(),
  cancelSubscriptionOnChain: jest.fn(),
  logTrialOffer: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) { super(message); }
  },
}));

import { queryEvents, getPlayerById, getContactUnlocksByScout, hasContactUnlock } from '../../src/db';
import { submitContactPayment, purchaseSubscription, isSubscribed } from '../../src/services/stellar';
const mockGetEvents = queryEvents as jest.Mock;
const mockGetPlayerById = getPlayerById as jest.Mock;
const mockGetContactUnlocksByScout = getContactUnlocksByScout as jest.Mock;
const mockHasContactUnlock = hasContactUnlock as jest.Mock;
const mockSubmitContactPayment = submitContactPayment as jest.Mock;
const mockPurchaseSubscription = purchaseSubscription as jest.Mock;
const mockIsSubscribed = isSubscribed as jest.Mock;

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

function makePlayerToken(wallet: string): string {
  return makeToken(wallet, 'player');
}
function makeValidatorToken(wallet: string): string {
  return makeToken(wallet, 'validator');
}

const WALLET = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';
const OTHER  = 'GAEZS7NMWCNTUFGDNXWVYVTKGGP47CESPEV5BVT5LNFHKXC5TGBZ4O5O';

beforeEach(() => {
  mockGetEvents.mockReset();
  mockGetPlayerById.mockReset();
  mockGetContactUnlocksByScout.mockReset().mockReturnValue([]);
  mockHasContactUnlock.mockReset().mockReturnValue(false);
  mockIsSubscribed.mockReset().mockResolvedValue({ active: false, expiresAt: null });
  // Ensure getLatestSubscription returns null by default
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getLatestSubscription } = require('../../src/db');
  (getLatestSubscription as jest.Mock).mockReset().mockReturnValue(null);
});

// ─── Wallet address validation ─────────────────────────────────────────────────

describe('wallet address validation', () => {
  it('returns 400 for an invalid wallet in GET subscription', async () => {
    const res = await request(app)
      .get('/api/scouts/not-a-valid-address/subscription')
      .set('Authorization', `Bearer ${makeToken(WALLET)}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: 'Invalid Stellar address' });
  });

  it('returns 400 for an invalid wallet in GET contacts', async () => {
    const res = await request(app)
      .get('/api/scouts/not-a-valid-address/contacts')
      .set('Authorization', `Bearer ${makeToken(WALLET)}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: 'Invalid Stellar address' });
  });

  it('returns 400 for an invalid wallet in GET payments', async () => {
    mockGetEvents.mockReturnValue([]);
    const res = await request(app)
      .get('/api/scouts/not-a-valid-address/payments')
      .set('Authorization', `Bearer ${makeToken(WALLET)}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: 'Invalid Stellar address' });
  });
});

// ─── GET /api/scouts/:wallet/subscription ─────────────────────────────────────

describe('GET /api/scouts/:wallet/subscription', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get(`/api/scouts/${WALLET}/subscription`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when JWT wallet does not match path wallet', async () => {
    const token = makeToken(OTHER);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns inactive subscription when no events exist', async () => {
    mockGetEvents.mockReturnValue([]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ active: false, tier: null, expiresAt: null, remainingDays: 0, gracePeriodActive: false });
  });

  it('returns active subscription with correct fields', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400 * 10; // 10 days from now
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: expiresAt, tier: 'pro' },
      },
    ]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.active).toBe(true);
    expect(res.body.data.tier).toBe('pro');
    expect(res.body.data.expiresAt).toBe(expiresAt);
    expect(res.body.data.remainingDays).toBeGreaterThan(0);
  });

  it('returns 400 for invalid duration values on subscribe endpoint', async () => {
    const token = makeToken(WALLET);

    let res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ duration: 0 });
    expect(res.status).toBe(400);

    res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ duration: -5 });
    expect(res.status).toBe(400);

    res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ duration: 366 });
    expect(res.status).toBe(400);

    res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ duration: 2.5 });
    expect(res.status).toBe(400);
  });

  it('accepts 1 and 365 duration values for subscribe endpoint', async () => {
    const token = makeToken(WALLET);
    mockPurchaseSubscription.mockResolvedValue({
      transactionId: 'tx-duration',
      tier: 'basic',
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      status: 'active',
    });

    let res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'basic', duration: 1 });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(mockPurchaseSubscription).toHaveBeenCalledWith(WALLET, 'basic', 1);

    res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'basic', duration: 365 });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(mockPurchaseSubscription).toHaveBeenCalledWith(WALLET, 'basic', 365);
  });

  it('returns expired subscription as inactive with 0 remainingDays', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 86400; // expired yesterday
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: expiresAt },
      },
    ]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);
    expect(res.body.data.remainingDays).toBe(0);
  });

  it('defaults tier to "basic" when not present in payload', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: expiresAt },
      },
    ]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.tier).toBe('basic');
  });

  it('returns tier:"premium" for a premium subscriber', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400 * 30;
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: expiresAt, tier: 'premium' },
      },
    ]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(true);
    expect(res.body.data.tier).toBe('premium');
  });

  it('returns tier:"basic" for an explicit basic subscriber', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400 * 7;
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: expiresAt, tier: 'basic' },
      },
    ]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(true);
    expect(res.body.data.tier).toBe('basic');
  });
});

// ─── GET /api/scouts/:wallet/contacts ─────────────────────────────────────────

describe('GET /api/scouts/:wallet/contacts', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get(`/api/scouts/${WALLET}/contacts`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when JWT wallet does not match path wallet', async () => {
    const token = makeToken(OTHER);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/contacts`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns empty array when no contacts exist', async () => {
    mockGetEvents.mockReturnValue([]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/contacts`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('returns contacts with correct shape', async () => {
    const unlockedAt = Math.floor(Date.now() / 1000) - 3600;
    mockGetContactUnlocksByScout.mockReturnValue([
      { scout_wallet: WALLET, player_id: 'player-42', tx_hash: 'tx-1', unlocked_at: unlockedAt },
      { scout_wallet: WALLET, player_id: 'player-99', tx_hash: 'tx-2', unlocked_at: unlockedAt + 100 },
    ]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/contacts`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toEqual({
      playerId: 'player-42',
      contact_status: 'unlocked',
      unlockedAt,
    });
    expect(res.body.data[1].playerId).toBe('player-99');
    expect(res.body.data[1].contact_status).toBe('unlocked');
  });
});

// ─── POST /api/scouts/:wallet/contacts/:playerId/unlock ───────────────────────

describe('POST /api/scouts/:wallet/contacts/:playerId/unlock', () => {
  const PLAYER_ID = 'player-123';

  beforeEach(() => {
    mockGetEvents.mockReset();
    mockSubmitContactPayment.mockReset();
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).post(`/api/scouts/${WALLET}/contacts/${PLAYER_ID}/unlock`);
    expect(res.status).toBe(401);
  });

  it('returns 403 when JWT wallet does not match path wallet', async () => {
    const token = makeToken(OTHER);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/contacts/${PLAYER_ID}/unlock`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/wallet/i);
  });

  it('proceeds with unlock when JWT wallet matches path wallet', async () => {
    mockGetPlayerById.mockReturnValue({
      player_id: PLAYER_ID,
      wallet: 'GPLAYERWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      metadata_uri: 'ipfs://QmContactMetadata',
    });
    mockSubmitContactPayment.mockResolvedValue({ transactionId: 'abc123', status: 'submitted' });
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/contacts/${PLAYER_ID}/unlock`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transactionId).toBe('abc123');
    expect(mockSubmitContactPayment).toHaveBeenCalledWith(WALLET, PLAYER_ID);
  });

  it('returns 404 when the player does not exist', async () => {
    mockGetPlayerById.mockReturnValue(null);
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/contacts/${PLAYER_ID}/unlock`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'PLAYER_NOT_FOUND' });
    expect(mockSubmitContactPayment).not.toHaveBeenCalled();
  });

  it('returns 400 when a scout tries to unlock their own profile', async () => {
    mockGetPlayerById.mockReturnValue({
      player_id: PLAYER_ID,
      wallet: WALLET,
      metadata_uri: 'ipfs://QmContactMetadata',
    });
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/contacts/${PLAYER_ID}/unlock`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own profile/i);
    expect(mockSubmitContactPayment).not.toHaveBeenCalled();
  });
});

// ─── POST /api/scouts/:wallet/subscribe ──────────────────────────────────────

describe('POST /api/scouts/:wallet/subscribe', () => {
  const VALID_BODY = { tier: 'basic', duration: 30 };

  beforeEach(() => {
    mockPurchaseSubscription.mockReset();
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).post(`/api/scouts/${WALLET}/subscribe`).send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 403 when token role is not scout', async () => {
    const token = makeToken(WALLET, 'player');
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
  });

  it('returns 201 with subscription data on success', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    mockPurchaseSubscription.mockResolvedValue({
      transactionId: 'tx-abc123',
      tier: 'basic',
      expiresAt,
      status: 'active',
    });
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transactionId).toBe('tx-abc123');
    expect(res.body.data.tier).toBe('basic');
    expect(res.body.data.expiresAt).toBe(expiresAt);
    expect(res.body.data.status).toBe('active');
    expect(mockPurchaseSubscription).toHaveBeenCalledWith(WALLET, 'basic', 30);
  });

  it('returns 400 for invalid tier', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'gold', duration: 30 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for missing duration', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'basic' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for duration out of range', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'basic', duration: 400 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 402 when purchaseSubscription throws INSUFFICIENT_FUNDS', async () => {
    const { PaymentError } = jest.requireMock('../../src/services/stellar');
    mockPurchaseSubscription.mockRejectedValue(new PaymentError('Insufficient XLM balance', 'INSUFFICIENT_FUNDS'));
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(402);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('INSUFFICIENT_FUNDS');
  });
});
// ─── Role enforcement — non-scout JWTs must be rejected ──────────────────────

describe('Scout route role enforcement', () => {
  it('returns 403 when player JWT calls GET subscription', async () => {
    const token = makePlayerToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when validator JWT calls GET subscription', async () => {
    const token = makeValidatorToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when player JWT calls GET contacts', async () => {
    const token = makePlayerToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/contacts`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when player JWT calls POST unlock', async () => {
    const token = makePlayerToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/contacts/player-1/unlock`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

// ─── GET /api/scouts/:wallet/contacts/:playerId ──────────────────────────────

describe('GET /api/scouts/:wallet/contacts/:playerId', () => {
  const PLAYER_ID = 'player-123';
  const MOCK_PLAYER = {
    player_id: PLAYER_ID,
    wallet: 'GPLAYERWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get(`/api/scouts/${WALLET}/contacts/${PLAYER_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when JWT wallet does not match path wallet', async () => {
    const token = makeToken(OTHER);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/contacts/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 404 when player is not found', async () => {
    mockGetPlayerById.mockReturnValue(null);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/contacts/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Player not found/i);
  });

  it('returns 403 when scout has not unlocked the player contact', async () => {
    mockGetPlayerById.mockReturnValue(MOCK_PLAYER);
    mockGetEvents.mockReturnValue([]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/contacts/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Contact not unlocked/i);
  });

  it('returns player contact details on success', async () => {
    mockGetPlayerById.mockReturnValue({
      ...MOCK_PLAYER,
      metadata_uri: 'ipfs://QmContactMetadata',
    });
    mockHasContactUnlock.mockReturnValue(true);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/contacts/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      playerId: PLAYER_ID,
      wallet: MOCK_PLAYER.wallet,
      metadataUri: 'ipfs://QmContactMetadata',
    });
  });
});

