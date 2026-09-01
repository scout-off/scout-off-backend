import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
  getPlayerById: jest.fn(),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  purchaseSubscription: jest.fn(),
  renewSubscription: jest.fn(),
  cancelSubscriptionOnChain: jest.fn(),
  submitContactPayment: jest.fn(),
  logTrialOffer: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) {
      super(message);
    }
  },
}));

import { purchaseSubscription } from '../../src/services/stellar';

const mockPurchaseSubscription = purchaseSubscription as jest.Mock;

const WALLET = 'GSCOUTWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'GOTHERWALLET2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const VALID_BODY = { tier: 'basic', duration: 30 };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/scouts/:wallet/subscribe', () => {
  it('returns 201 on valid subscription', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    mockPurchaseSubscription.mockResolvedValue({
      transactionId: 'tx-sub-1',
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
    expect(res.body.data.transactionId).toBe('tx-sub-1');
    expect(res.body.data.tier).toBe('basic');
    expect(res.body.data.expiresAt).toBe(expiresAt);
    expect(res.body.data.status).toBe('active');
    expect(mockPurchaseSubscription).toHaveBeenCalledWith(WALLET, 'basic', 30);
  });

  it('returns 400 when tier is missing', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ duration: 30 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for invalid tier value', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'gold', duration: 30 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when duration exceeds 365', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'basic', duration: 400 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when duration is 0', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'basic', duration: 0 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when JWT wallet does not match path wallet', async () => {
    const token = makeToken(OTHER);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/wallet/i);
  });

  it('returns 402 when purchaseSubscription throws INSUFFICIENT_FUNDS', async () => {
    const { PaymentError } = jest.requireMock('../../src/services/stellar');
    mockPurchaseSubscription.mockRejectedValue(
      new PaymentError('Insufficient XLM balance', 'INSUFFICIENT_FUNDS'),
    );
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(402);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .send(VALID_BODY);
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

  it('accepts premium tier', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 90 * 86400;
    mockPurchaseSubscription.mockResolvedValue({
      transactionId: 'tx-prem',
      tier: 'premium',
      expiresAt,
      status: 'active',
    });
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'premium', duration: 90 });
    expect(res.status).toBe(201);
    expect(res.body.data.tier).toBe('premium');
    expect(mockPurchaseSubscription).toHaveBeenCalledWith(WALLET, 'premium', 90);
  });
});
