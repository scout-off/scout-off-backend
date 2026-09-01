import { Request, Response, NextFunction } from 'express';

jest.mock('../../src/utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/services/stellar', () => ({
  submitContactPayment: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) { super(message); }
  },
}));

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn(),
  insertContactUnlock: jest.fn(),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  getPlayerById: jest.fn().mockReturnValue(null),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  getSubscriptionsByScout: jest.fn().mockReturnValue([]),
  insertSubscription: jest.fn(),
  updatePlayerProgress: jest.fn(),
  insertTrialOffer: jest.fn(),
}));

import { unlockContact, paymentErrorStatus } from '../../src/controllers/scoutController';
import { submitContactPayment, PaymentError } from '../../src/services/stellar';
import { logger } from '../../src/utils/logger';
import * as cacheModule from '../../src/services/cache';
import { broadcaster } from '../../src/services/eventBroadcaster';

const mockSubmit = submitContactPayment as jest.Mock;
const mockWarn = (logger.warn as jest.Mock);
const mockInfo = (logger.info as jest.Mock);

function makeRes() {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return { status, json } as unknown as Response;
}

const next = jest.fn() as unknown as NextFunction;

describe('unlockContact', () => {
  const WALLET = 'GAE3BQINZGCGNDDFRJZYAWXDXBFJJALLZ47UCHMWASF56ILDAVUODSOR';
  const OTHER  = 'GD4LQIN4652EY3VSBTQ32PY3GVKZBKRA2PN3LUUC2TL7I53COGFLWYQP';
  const PLAYER = 'player-123';
  const PLAYER_ROW = {
    player_id: PLAYER,
    wallet: 'GPLAYERWALLET000000000000000000000000000000000000000000',
    position: 'Forward',
    region: 'West Africa',
    metadata_uri: 'ipfs://QmPlayerContactMetadata',
    progress_level: 1,
    created_at: 1700000000,
    registered_at: 1700000000,
    is_active: 1,
  };

  let broadcastSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default mocks: valid player, no existing unlock, payment succeeds.
    (require('../../src/db').getPlayerById as jest.Mock).mockReturnValue(PLAYER_ROW);
    (require('../../src/db').hasContactUnlock as jest.Mock).mockReturnValue(false);
    mockSubmit.mockResolvedValue({ transactionId: 'tx-unlock-1', status: 'submitted' });
    broadcastSpy = jest.spyOn(broadcaster, 'broadcast').mockImplementation(() => {});
  });

  afterEach(() => {
    broadcastSpy.mockRestore();
  });

  it('returns 403 when JWT account does not match wallet param', async () => {
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: OTHER } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(403);
    const body = ((res.status as jest.Mock).mock.results[0].value.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/wallet/i);
  });

  it('logs a warning on denied unlock attempt', async () => {
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: OTHER } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('unlock_contact_denied')
    );
  });

  it('returns 400 when wallet param is missing', async () => {
    const req = { params: { wallet: '', playerId: PLAYER }, account: '' } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
  });

  it('returns 404 when the player does not exist', async () => {
    (require('../../src/db').getPlayerById as jest.Mock).mockReturnValue(null);
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(404);
    const body = ((res.status as jest.Mock).mock.results[0].value.json as jest.Mock).mock.calls[0][0];
    expect(body).toMatchObject({ success: false, code: 'PLAYER_NOT_FOUND' });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('rejects a scout unlocking their own profile with 400 and no payment', async () => {
    (require('../../src/db').getPlayerById as jest.Mock).mockReturnValue({
      ...PLAYER_ROW,
      wallet: WALLET,
    });
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
    const body = ((res.status as jest.Mock).mock.results[0].value.json as jest.Mock).mock.calls[0][0];
    expect(body.error).toMatch(/own profile/i);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('calls submitContactPayment when wallet ownership is verified and persists the unlock', async () => {
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect(mockSubmit).toHaveBeenCalledWith(WALLET, PLAYER);
    expect(require('../../src/db').insertContactUnlock).toHaveBeenCalledWith({
      scout_wallet: WALLET,
      player_id: PLAYER,
      tx_hash: 'tx-unlock-1',
      unlocked_at: expect.any(Number),
    });
    expect((res.json as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
  });

  it('returns the player contact metadata and transaction info in the response', async () => {
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.data).toEqual({
      playerId: PLAYER,
      wallet: PLAYER_ROW.wallet,
      metadataUri: PLAYER_ROW.metadata_uri,
      transactionId: 'tx-unlock-1',
      status: 'submitted',
    });
  });

  it('broadcasts a contact_unlocked SSE event after the unlock is persisted', async () => {
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const [event] = broadcastSpy.mock.calls[0];
    expect(event.type).toBe('contact_unlocked');
    expect(event.payload).toMatchObject({
      scout: WALLET,
      player_id: PLAYER,
      tx_hash: 'tx-unlock-1',
    });
  });

  it('broadcast happens only after the unlock row is persisted (confirmed settlement)', async () => {
    const insertMock = require('../../src/db').insertContactUnlock as jest.Mock;
    insertMock.mockImplementation(() => {
      expect(broadcastSpy).not.toHaveBeenCalled();
    });
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast or insert when the payment fails', async () => {
    mockSubmit.mockRejectedValue(new PaymentError('payment failed', 'NETWORK_ERROR'));
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect(require('../../src/db').insertContactUnlock).not.toHaveBeenCalled();
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('returns the cached contact details without a new payment when already unlocked', async () => {
    (require('../../src/db').hasContactUnlock as jest.Mock).mockReturnValue(true);
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect(mockSubmit).not.toHaveBeenCalled();
    expect((res.json as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          alreadyUnlocked: true,
          playerId: PLAYER,
          metadataUri: PLAYER_ROW.metadata_uri,
        }),
      })
    );
  });

  it('logs the unlock attempt with scout wallet when wallet matches', async () => {
    mockSubmit.mockResolvedValue({ transactionId: 'tx', status: 'submitted' });
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining(WALLET)
    );
  });

  // #763 — contact_unlocked is a player-state-changing event: after the unlock
  // row is persisted the player-list cache must be invalidated so list queries
  // reflect the change. Invalidation must NOT happen if the payment/persistence
  // fails.
  describe('cache invalidation on contact_unlocked', () => {
    it('invalidates the player-list cache only after the unlock is persisted', async () => {
      const invalidateSpy = jest
        .spyOn(cacheModule, 'invalidatePlayerCache')
        .mockResolvedValue(undefined);
      mockSubmit.mockResolvedValue({ transactionId: 'abc', status: 'submitted' });

      const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
      const res = makeRes();
      await unlockContact(req, res, next);

      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect((res.json as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      invalidateSpy.mockRestore();
    });

    it('does not invalidate the cache when the unlock payment fails', async () => {
      const invalidateSpy = jest
        .spyOn(cacheModule, 'invalidatePlayerCache')
        .mockResolvedValue(undefined);
      mockSubmit.mockRejectedValue(new PaymentError('payment failed', 'PAYMENT_FAILED'));

      const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
      const res = makeRes();
      await unlockContact(req, res, next);

      expect(invalidateSpy).not.toHaveBeenCalled();
      invalidateSpy.mockRestore();
    });
  });

  // ─── PaymentError → HTTP mapping (#761) ───────────────────────────────────
  describe('PaymentError HTTP mapping', () => {
    const CASES: Array<[string, number]> = [
      ['INSUFFICIENT_FUNDS', 402],
      ['EXPIRED_TRUSTLINE', 402],
      ['CONTRACT_PAUSED', 503],
      ['MISSING_PLAYER', 404],
      ['INVALID_ACCOUNT', 400],
      ['CONTRACT_ERROR', 502],
      ['NETWORK_ERROR', 502],
      ['UNKNOWN', 500],
    ];

    it.each(CASES)('maps PaymentError code %s to HTTP %d', async (code, expectedStatus) => {
      mockSubmit.mockRejectedValue(new PaymentError(`failed: ${code}`, code));
      const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
      const res = makeRes();
      await unlockContact(req, res, next);
      expect((res.status as jest.Mock)).toHaveBeenCalledWith(expectedStatus);
      const body = ((res.status as jest.Mock).mock.results[0].value.json as jest.Mock).mock.calls[0][0];
      expect(body).toMatchObject({ success: false, code });
    });

    it('paymentErrorStatus covers every PaymentError code defined by stellar.ts', () => {
      const codes = [
        'INSUFFICIENT_FUNDS',
        'INVALID_ACCOUNT',
        'NETWORK_ERROR',
        'MISSING_PLAYER',
        'EXPIRED_TRUSTLINE',
        'CONTRACT_PAUSED',
        'CONTRACT_ERROR',
        'UNKNOWN',
      ] as const;
      for (const code of codes) {
        const status = paymentErrorStatus(code);
        expect(Number.isInteger(status)).toBe(true);
        expect(status).toBeGreaterThanOrEqual(400);
        expect(status).toBeLessThan(600);
      }
    });
  });
});
