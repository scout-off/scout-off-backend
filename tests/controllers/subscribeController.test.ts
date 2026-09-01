/**
 * Unit tests for the `subscribe` controller (src/controllers/scoutController.ts),
 * exercising the function directly against mocked req/res objects rather than
 * through the full Express app (see tests/routes/subscribe.test.ts for the
 * integration-level route coverage).
 */

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn(),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
  dbRenewSubscription: jest.fn(),
  dbCancelSubscription: jest.fn(),
  insertContactUnlock: jest.fn(),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  getIdempotencyRecord: jest.fn().mockReturnValue(null),
  saveIdempotencyRecord: jest.fn(),
}));

jest.mock('../../src/services/indexer', () => ({
  insertTrialOffer: jest.fn(),
  getTrialOffers: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/stellar', () => ({
  submitContactPayment: jest.fn(),
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  purchaseSubscription: jest.fn(),
  renewSubscription: jest.fn(),
  cancelSubscriptionOnChain: jest.fn(),
  logTrialOffer: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(message: string, public code: string) {
      super(message);
      this.name = 'PaymentError';
    }
  },
  SubscriptionError: class SubscriptionError extends Error {
    constructor(message: string, public code: string) {
      super(message);
      this.name = 'SubscriptionError';
    }
  },
}));

import { Request, Response, NextFunction } from 'express';
import { subscribe } from '../../src/controllers/scoutController';
import { purchaseSubscription, PaymentError } from '../../src/services/stellar';
import { insertSubscription, getIdempotencyRecord } from '../../src/db';

const mockPurchaseSubscription = purchaseSubscription as jest.Mock;
const mockInsertSubscription = insertSubscription as jest.Mock;
const mockGetIdempotencyRecord = getIdempotencyRecord as jest.Mock;

const WALLET = 'GSCOUTWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    params: { wallet: WALLET },
    body: { tier: 'basic', duration: 30 },
    headers: {},
    account: WALLET,
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe('subscribe controller', () => {
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetIdempotencyRecord.mockReturnValue(null);
    next = jest.fn();
  });

  it('returns 201 with the subscription result on success', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    mockPurchaseSubscription.mockResolvedValue({
      transactionId: 'tx-sub-1',
      tier: 'basic',
      expiresAt,
      status: 'active',
    });

    const req = makeReq();
    const res = makeRes();
    await subscribe(req, res, next);

    expect(mockPurchaseSubscription).toHaveBeenCalledWith(WALLET, 'basic', 30);
    expect(mockInsertSubscription).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { transactionId: 'tx-sub-1', tier: 'basic', expiresAt, status: 'active' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when tier is missing', async () => {
    const req = makeReq({ body: { duration: 30 } });
    const res = makeRes();
    await subscribe(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPurchaseSubscription).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid tier value', async () => {
    const req = makeReq({ body: { tier: 'gold', duration: 30 } });
    const res = makeRes();
    await subscribe(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPurchaseSubscription).not.toHaveBeenCalled();
  });

  it('returns 400 when duration is missing', async () => {
    const req = makeReq({ body: { tier: 'basic' } });
    const res = makeRes();
    await subscribe(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPurchaseSubscription).not.toHaveBeenCalled();
  });

  it('returns 400 when duration is not a number', async () => {
    const req = makeReq({ body: { tier: 'basic', duration: 'thirty' } });
    const res = makeRes();
    await subscribe(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPurchaseSubscription).not.toHaveBeenCalled();
  });

  it('returns 403 when the JWT wallet does not match the URL wallet', async () => {
    const req = makeReq({ account: 'GOTHERWALLET2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    const res = makeRes();
    await subscribe(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPurchaseSubscription).not.toHaveBeenCalled();
  });

  it('returns 402 when purchaseSubscription throws PaymentError INSUFFICIENT_FUNDS', async () => {
    mockPurchaseSubscription.mockRejectedValue(new PaymentError('Insufficient balance', 'INSUFFICIENT_FUNDS'));

    const req = makeReq();
    const res = makeRes();
    await subscribe(req, res, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'INSUFFICIENT_FUNDS' }),
    );
    expect(mockInsertSubscription).not.toHaveBeenCalled();
  });

  it('forwards unexpected errors to next()', async () => {
    mockPurchaseSubscription.mockRejectedValue(new Error('boom'));

    const req = makeReq();
    const res = makeRes();
    await subscribe(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.status).not.toHaveBeenCalled();
  });
});
