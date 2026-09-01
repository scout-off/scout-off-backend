/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the new subscription endpoints:
 *   PUT  /api/scouts/:wallet/subscribe  — renewal + new-via-PUT
 *   DELETE /api/scouts/:wallet/subscribe — cancellation
 *
 * And grace-period behaviour in GET /api/scouts/:wallet/subscription.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/db', () => {
  // In-memory subscription store
  const subscriptions: any[] = [];
  let idSeq = 1;

  return {
    queryEvents: jest.fn().mockReturnValue([]),
    getLatestSubscription: jest.fn().mockImplementation((wallet: string) => {
      const rows = subscriptions
        .filter((s) => s.scout_wallet === wallet && s.cancelled_at === null)
        .sort((a: any, b: any) => b.expires_at - a.expires_at);
      return rows[0] ?? null;
    }),
    insertSubscription: jest.fn().mockImplementation((p: any) => {
      const id = idSeq++;
      subscriptions.push({ id, ...p, cancelled_at: null });
      return id;
    }),
    dbRenewSubscription: jest.fn().mockImplementation((p: any) => {
      const idx = subscriptions.findIndex((s) => s.id === p.id);
      if (idx >= 0) {
        subscriptions[idx].tier = p.tier;
        subscriptions[idx].expires_at = p.expires_at;
      }
    }),
    dbCancelSubscription: jest.fn().mockImplementation((p: any) => {
      const idx = subscriptions.findIndex((s) => s.id === p.id);
      if (idx >= 0) subscriptions[idx].cancelled_at = p.cancelled_at;
    }),
    // expose for test cleanup
    __resetSubscriptions: () => {
      subscriptions.length = 0;
      idSeq = 1;
    },
  };
});

jest.mock('../../src/services/stellar', () => ({
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  purchaseSubscription: jest.fn(),
  renewSubscription: jest.fn(),
  cancelSubscriptionOnChain: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) { super(message); this.name = 'PaymentError'; }
  },
  SubscriptionError: class SubscriptionError extends Error {
    constructor(public message: string, public code: string) { super(message); this.name = 'SubscriptionError'; }
  },
}));

import {
  getLatestSubscription,
  insertSubscription,
  dbRenewSubscription as dbRenew,
  dbCancelSubscription as dbCancel,
} from '../../src/db';
import {
  purchaseSubscription,
  renewSubscription as stellarRenew,
  cancelSubscriptionOnChain,
  isSubscribed,
  SubscriptionError,
} from '../../src/services/stellar';

const mockGetLatest = getLatestSubscription as jest.Mock;
const mockInsert = insertSubscription as jest.Mock;
const mockDbRenew = dbRenew as jest.Mock;
const mockDbCancel = dbCancel as jest.Mock;
const mockPurchase = purchaseSubscription as jest.Mock;
const mockStellarRenew = stellarRenew as jest.Mock;
const mockCancelOnChain = cancelSubscriptionOnChain as jest.Mock;
const mockIsSubscribed = isSubscribed as jest.Mock;

const WALLET = 'GDKSHEL5SMPOFACYRWBN7R5ONIF34MSBJWBVAFFTW6OB3B4WPEUYNQC5';
const OTHER  = 'GAKDJUDRDDNTQFJAXI7T5HQ6ZFBRC2ICLEQHSCQJYU46UFC26GVQO52Q';

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const VALID_BODY = { tier: 'basic', duration: 30 };

beforeEach(() => {
  // Reset mocks
  mockGetLatest.mockReset();
  mockInsert.mockReset();
  mockDbRenew.mockReset();
  mockDbCancel.mockReset();
  mockPurchase.mockReset();
  mockStellarRenew.mockReset();
  mockCancelOnChain.mockReset();
  mockIsSubscribed.mockReset().mockResolvedValue({ active: false, expiresAt: null });
  mockGetLatest.mockReturnValue(null);
});

// ─── PUT /api/scouts/:wallet/subscribe ────────────────────────────────────────

describe('PUT /api/scouts/:wallet/subscribe', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).put(`/api/scouts/${WALLET}/subscribe`).send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 403 when token role is not scout', async () => {
    const token = makeToken(WALLET, 'player');
    const res = await request(app)
      .put(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
  });

  it('returns 403 when JWT wallet does not match path wallet', async () => {
    const token = makeToken(OTHER);
    const res = await request(app)
      .put(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid tier', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .put(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'gold', duration: 30 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing duration', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .put(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'basic' });
    expect(res.status).toBe(400);
  });

  it('creates a new subscription (201) when no existing subscription', async () => {
    mockGetLatest.mockReturnValue(null);
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    mockPurchase.mockResolvedValue({ transactionId: 'tx-new', tier: 'basic', expiresAt, status: 'active' });

    const token = makeToken(WALLET);
    const res = await request(app)
      .put(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transactionId).toBe('tx-new');
    expect(mockPurchase).toHaveBeenCalledWith(WALLET, 'basic', 30);
    expect(mockInsert).toHaveBeenCalled();
    expect(mockStellarRenew).not.toHaveBeenCalled();
  });

  it('renews an existing subscription (200) and extends expiry', async () => {
    const oldExpiry = Math.floor(Date.now() / 1000) + 10 * 86400;
    const newExpiry = oldExpiry + 30 * 86400;
    mockGetLatest.mockReturnValue({ id: 7, scout_wallet: WALLET, tier: 'basic', expires_at: oldExpiry, cancelled_at: null, created_at: 0 });
    mockStellarRenew.mockResolvedValue({ transactionId: 'tx-renew', tier: 'basic', expiresAt: newExpiry, status: 'active' });

    const token = makeToken(WALLET);
    const res = await request(app)
      .put(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transactionId).toBe('tx-renew');
    expect(res.body.data.expiresAt).toBe(newExpiry);
    expect(mockStellarRenew).toHaveBeenCalledWith(WALLET, 'basic', 30, oldExpiry);
    expect(mockDbRenew).toHaveBeenCalledWith({ id: 7, tier: 'basic', expires_at: newExpiry });
    expect(mockPurchase).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('renews an expired subscription — base moves from now not old expiry', async () => {
    const oldExpiry = Math.floor(Date.now() / 1000) - 86400; // expired yesterday
    const newExpiry = Math.floor(Date.now() / 1000) + 30 * 86400;
    mockGetLatest.mockReturnValue({ id: 3, scout_wallet: WALLET, tier: 'premium', expires_at: oldExpiry, cancelled_at: null, created_at: 0 });
    mockStellarRenew.mockResolvedValue({ transactionId: 'tx-renew-expired', tier: 'premium', expiresAt: newExpiry, status: 'active' });

    const token = makeToken(WALLET);
    const res = await request(app)
      .put(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'premium', duration: 30 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockStellarRenew).toHaveBeenCalledWith(WALLET, 'premium', 30, oldExpiry);
    expect(mockDbRenew).toHaveBeenCalled();
  });
});

// ─── DELETE /api/scouts/:wallet/subscribe ─────────────────────────────────────

describe('DELETE /api/scouts/:wallet/subscribe', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).delete(`/api/scouts/${WALLET}/subscribe`);
    expect(res.status).toBe(401);
  });

  it('returns 403 when token role is not scout', async () => {
    const token = makeToken(WALLET, 'player');
    const res = await request(app)
      .delete(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when no active subscription exists', async () => {
    mockGetLatest.mockReturnValue(null);
    const token = makeToken(WALLET);
    const res = await request(app)
      .delete(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/no active subscription/i);
  });

  it('cancels an active subscription and returns 200', async () => {
    const existingSub = { id: 5, scout_wallet: WALLET, tier: 'basic', expires_at: Math.floor(Date.now() / 1000) + 86400, cancelled_at: null, created_at: 0 };
    mockGetLatest.mockReturnValue(existingSub);
    mockCancelOnChain.mockResolvedValue({ transactionId: 'tx-cancel' });

    const token = makeToken(WALLET);
    const res = await request(app)
      .delete(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transactionId).toBe('tx-cancel');
    expect(res.body.data.wallet).toBe(WALLET);
    expect(res.body.data.cancelledAt).toBeGreaterThan(0);
    expect(mockCancelOnChain).toHaveBeenCalledWith(WALLET);
    expect(mockDbCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }));
  });

  it('returns 404 when on-chain cancel throws SubscriptionError NOT_SUBSCRIBED', async () => {
    const existingSub = { id: 6, scout_wallet: WALLET, tier: 'basic', expires_at: Math.floor(Date.now() / 1000) + 86400, cancelled_at: null, created_at: 0 };
    mockGetLatest.mockReturnValue(existingSub);
    mockCancelOnChain.mockRejectedValue(
      new (SubscriptionError as any)('Scout has no active on-chain subscription', 'NOT_SUBSCRIBED'),
    );

    const token = makeToken(WALLET);
    const res = await request(app)
      .delete(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('NOT_SUBSCRIBED');
    // DB must NOT be updated when on-chain call fails
    expect(mockDbCancel).not.toHaveBeenCalled();
  });

  it('returns 403 when on-chain cancel throws SubscriptionError UNAUTHORIZED', async () => {
    const existingSub = { id: 7, scout_wallet: WALLET, tier: 'premium', expires_at: Math.floor(Date.now() / 1000) + 86400, cancelled_at: null, created_at: 0 };
    mockGetLatest.mockReturnValue(existingSub);
    mockCancelOnChain.mockRejectedValue(
      new (SubscriptionError as any)('Unauthorized: wallet is not allowed to cancel', 'UNAUTHORIZED'),
    );

    const token = makeToken(WALLET);
    const res = await request(app)
      .delete(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('UNAUTHORIZED');
    expect(mockDbCancel).not.toHaveBeenCalled();
  });

  it('does not update the DB when the on-chain call throws a PaymentError (RPC failure)', async () => {
    const existingSub = { id: 8, scout_wallet: WALLET, tier: 'basic', expires_at: Math.floor(Date.now() / 1000) + 86400, cancelled_at: null, created_at: 0 };
    mockGetLatest.mockReturnValue(existingSub);

    // PaymentError is imported via the mock factory above
    const { PaymentError: MockPaymentError } = jest.requireMock('../../src/services/stellar');
    mockCancelOnChain.mockRejectedValue(new MockPaymentError('RPC error', 'NETWORK_ERROR'));

    const token = makeToken(WALLET);
    const res = await request(app)
      .delete(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(402);
    expect(res.body.success).toBe(false);
    // The DB must NOT be updated when the on-chain transaction fails
    expect(mockDbCancel).not.toHaveBeenCalled();
  });
});

// ─── Grace period — GET /api/scouts/:wallet/subscription ──────────────────────

describe('GET /api/scouts/:wallet/subscription — grace period', () => {
  it('returns gracePeriodActive: false for a fully active subscription', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400 * 5;
    mockGetLatest.mockReturnValue({ id: 1, scout_wallet: WALLET, tier: 'basic', expires_at: expiresAt, cancelled_at: null, created_at: 0 });

    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(true);
    expect(res.body.data.gracePeriodActive).toBe(false);
  });

  it('returns gracePeriodActive: true and active: true when within grace window', async () => {
    // Expired 12 hours ago, within the default 24-hour grace period
    const expiresAt = Math.floor(Date.now() / 1000) - 12 * 3600;
    mockGetLatest.mockReturnValue({ id: 2, scout_wallet: WALLET, tier: 'premium', expires_at: expiresAt, cancelled_at: null, created_at: 0 });

    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(true);
    expect(res.body.data.gracePeriodActive).toBe(true);
    expect(res.body.data.tier).toBe('premium');
  });

  it('returns active: false when grace period has passed', async () => {
    // Expired 48 hours ago, beyond the 24-hour grace window
    const expiresAt = Math.floor(Date.now() / 1000) - 48 * 3600;
    mockGetLatest.mockReturnValue({ id: 3, scout_wallet: WALLET, tier: 'basic', expires_at: expiresAt, cancelled_at: null, created_at: 0 });

    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);
    expect(res.body.data.gracePeriodActive).toBe(false);
    expect(res.body.data.remainingDays).toBe(0);
  });

  it('returns gracePeriodActive: false when no subscription at all', async () => {
    mockGetLatest.mockReturnValue(null);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);
    expect(res.body.data.gracePeriodActive).toBe(false);
    expect(res.body.data.tier).toBeNull();
  });
});
