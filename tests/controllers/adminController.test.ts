import { Keypair } from '@stellar/stellar-sdk';
import {
  getStats,
  withdrawFeesV2Controller,
  resetWithdrawalLock,
} from '../../src/controllers/adminController';
import * as db from '../../src/db';
import * as stellar from '../../src/services/stellar';
import { logAuditEvent } from '../../src/services/audit';
import { cacheGet, cacheSet } from '../../src/services/cache';

// The v2 fee-withdrawal controller performs an on-chain balance check
// (getFeeBalance) and an on-chain withdrawal (withdrawFees). Mock only those
// two functions; everything else keeps its real implementation.
jest.mock('../../src/services/stellar', () => ({
  ...jest.requireActual('../../src/services/stellar'),
  withdrawFees: jest.fn(),
  getFeeBalance: jest.fn(),
}));

describe('Admin Controller - Time-series Stats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/admin/stats with time-series', () => {
    it('should return 400 for invalid window parameter', async () => {
      const req = { query: { window: 'invalid' } } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getStats(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.any(String),
        })
      );
    });

    it('should return time-series data for 7d window', async () => {
      const mockTimeSeries = [
        { date: '2026-07-22', count: 5 },
        { date: '2026-07-23', count: 3 },
        { date: '2026-07-24', count: 8 },
        { date: '2026-07-25', count: 2 },
        { date: '2026-07-26', count: 4 },
        { date: '2026-07-27', count: 6 },
        { date: '2026-07-28', count: 7 },
      ];

      jest.spyOn(db, 'getNewPlayersTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getMilestonesApprovedTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getContactUnlocksTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getSubscriptionsStartedTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(require('../../src/services/cache'), 'cacheGet').mockResolvedValue(undefined);
      jest.spyOn(require('../../src/services/cache'), 'cacheSet').mockResolvedValue(undefined);

      const req = { query: { window: '7d' } } as any;
      const res = {
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getStats(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          window: '7d',
          newPlayers: mockTimeSeries,
          milestonesApproved: mockTimeSeries,
          contactUnlocks: mockTimeSeries,
          subscriptionsStarted: mockTimeSeries,
        }),
      });

      expect(db.getNewPlayersTimeSeries).toHaveBeenCalled();
      expect(require('../../src/services/cache').cacheSet).toHaveBeenCalledWith(
        'admin:stats:7d:none',
        expect.any(Object),
        300000
      );
    });

    it('should return time-series data for 30d window', async () => {
      const mockTimeSeries = Array.from({ length: 30 }, (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, '0')}`,
        count: Math.floor(Math.random() * 10) + 1,
      }));

      jest.spyOn(db, 'getNewPlayersTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getMilestonesApprovedTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getContactUnlocksTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getSubscriptionsStartedTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(require('../../src/services/cache'), 'cacheGet').mockResolvedValue(undefined);
      jest.spyOn(require('../../src/services/cache'), 'cacheSet').mockResolvedValue(undefined);

      const req = { query: { window: '30d' } } as any;
      const res = {
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getStats(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          window: '30d',
          newPlayers: mockTimeSeries,
          milestonesApproved: mockTimeSeries,
          contactUnlocks: mockTimeSeries,
          subscriptionsStarted: mockTimeSeries,
        }),
      });
    });

    it('should return cached data when available', async () => {
      const cachedData = {
        window: '7d',
        startDate: '2026-07-22',
        endDate: '2026-07-28',
        newPlayers: [{ date: '2026-07-22', count: 5 }],
        milestonesApproved: [{ date: '2026-07-22', count: 3 }],
        contactUnlocks: [{ date: '2026-07-22', count: 2 }],
        subscriptionsStarted: [{ date: '2026-07-22', count: 1 }],
      };

      jest.spyOn(require('../../src/services/cache'), 'cacheGet').mockResolvedValue({ data: cachedData });
      jest.spyOn(db, 'getNewPlayersTimeSeries').mockReturnValue([]);

      const req = { query: { window: '7d' } } as any;
      const res = {
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getStats(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: cachedData,
      });

      expect(db.getNewPlayersTimeSeries).not.toHaveBeenCalled();
    });

    it('should include region breakdown when requested', async () => {
      const mockTimeSeries = [
        { date: '2026-07-22', count: 5 },
        { date: '2026-07-23', count: 3 },
      ];

      const mockRegionBreakdown = [
        { date: '2026-07-22', region: 'NA', count: 3 },
        { date: '2026-07-22', region: 'EU', count: 2 },
        { date: '2026-07-23', region: 'NA', count: 2 },
        { date: '2026-07-23', region: 'EU', count: 1 },
      ];

      jest.spyOn(db, 'getNewPlayersTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getMilestonesApprovedTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getContactUnlocksTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getSubscriptionsStartedTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getNewPlayersByRegionTimeSeries').mockReturnValue(mockRegionBreakdown);
      jest.spyOn(require('../../src/services/cache'), 'cacheGet').mockResolvedValue(undefined);
      jest.spyOn(require('../../src/services/cache'), 'cacheSet').mockResolvedValue(undefined);

      const req = { query: { window: '7d', breakdown: 'region' } } as any;
      const res = {
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getStats(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          window: '7d',
          newPlayers: mockTimeSeries,
          newPlayersByRegion: mockRegionBreakdown,
        }),
      });

      expect(db.getNewPlayersByRegionTimeSeries).toHaveBeenCalled();
    });

    it('should return basic stats when no window or breakdown requested (backward compatible)', async () => {
      jest.spyOn(db, 'queryEvents').mockImplementation((type?: string) => {
        if (type === 'player_registered') return [{}, {}, {}] as any;
        if (type === 'milestone_approved') return [{}, {}] as any;
        if (type === 'scout_subscribed') return [{}] as any;
        return [{}, {}, {}, {}, {}] as any;
      });

      const req = { query: {} } as any;
      const res = {
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getStats(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          players: 3,
          milestones: 2,
          subscriptions: 1,
          events: 5,
        },
      });
    });
  });
});

// ─── POST /api/admin/fees/withdraw (withdrawFeesV2Controller) ─────────────────
// The v2 endpoint validates amountStroops against the on-chain balance and must
// thread that exact amount into the on-chain withdraw_fees call — this is the
// regression suite for #1045 (the amount was previously validated but then
// silently discarded in favour of the contract's zero-argument withdraw-all).

describe('Admin Controller - Fee Withdrawal v2 (#1045)', () => {
  const ADMIN_WALLET =
    process.env.ADMIN_WALLET ?? 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';
  // Checksum-valid Stellar public key (isValidStellarAddress requires it).
  const TREASURY = Keypair.random().publicKey();

  const mockWithdrawFees = stellar.withdrawFees as jest.Mock;
  const mockGetFeeBalance = stellar.getFeeBalance as jest.Mock;

  function makeReq(body: Record<string, unknown>): any {
    return { role: 'admin', account: ADMIN_WALLET, body, headers: {} };
  }

  function makeRes(): any {
    return { status: jest.fn().mockReturnThis(), json: jest.fn() };
  }

  beforeEach(() => {
    resetWithdrawalLock();
    mockWithdrawFees.mockReset();
    mockGetFeeBalance.mockReset();
    jest.spyOn(require('../../src/services/audit'), 'logAuditEvent').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('threads the validated amountStroops through to the on-chain withdraw_fees call', async () => {
    mockGetFeeBalance.mockResolvedValue(1000n);
    mockWithdrawFees.mockResolvedValue({
      transactionId: 'tx-1',
      recipient: TREASURY,
      amount: '100',
      token: 'XLM',
    });
    const insertSpy = jest.spyOn(db, 'insertFeeWithdrawal').mockReturnValue(1);

    const req = makeReq({ treasuryAddress: TREASURY, amountStroops: '100' });
    const res = makeRes();
    await withdrawFeesV2Controller(req, res, { } as any);

    // The amount must reach the on-chain call — the core #1045 regression.
    expect(mockWithdrawFees).toHaveBeenCalledWith(TREASURY, '100');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ transactionId: 'tx-1', amountStroops: '100', amount: '100' }),
      }),
    );
    // The balance was checked first.
    expect(mockGetFeeBalance).toHaveBeenCalled();
    // DB record stores the on-chain-confirmed amount.
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ treasuryAddress: TREASURY, amountStroops: '100', txHash: 'tx-1' }),
    );
  });

  it('stores the actual on-chain-confirmed amount in the DB when it differs from the requested amount', async () => {
    mockGetFeeBalance.mockResolvedValue(1000n);
    // Race: between validation and execution the balance dropped, so the
    // contract enforced a lower amount than requested.
    mockWithdrawFees.mockResolvedValue({
      transactionId: 'tx-2',
      recipient: TREASURY,
      amount: '99',
      token: 'XLM',
    });
    const insertSpy = jest.spyOn(db, 'insertFeeWithdrawal').mockReturnValue(1);

    await withdrawFeesV2Controller(makeReq({ treasuryAddress: TREASURY, amountStroops: '100' }), makeRes(), { } as any);

    // The DB row reflects what actually left the contract, not the request.
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ amountStroops: '99' }));
    // The audit trail preserves BOTH requested and actual for reconciliation.
    const call = (logAuditEvent as jest.Mock).mock.calls.at(-1)[0];
    expect(call.queryParams.amountStroops).toBe('100');
    expect(call.queryParams.amount).toBe('99');
  });

  it('returns 422 when amountStroops exceeds the on-chain fee balance', async () => {
    mockGetFeeBalance.mockResolvedValue(50n);

    const res = makeRes();
    await withdrawFeesV2Controller(makeReq({ treasuryAddress: TREASURY, amountStroops: '100' }), res, { } as any);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.stringContaining('exceeds') }),
    );
    // The on-chain call must not be attempted for an over-balance request.
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-positive amountStroops', async () => {
    const res = makeRes();
    await withdrawFeesV2Controller(makeReq({ treasuryAddress: TREASURY, amountStroops: '0' }), res, { } as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid treasuryAddress', async () => {
    const res = makeRes();
    await withdrawFeesV2Controller(makeReq({ treasuryAddress: 'not-an-address', amountStroops: '100' }), res, { } as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not an admin', async () => {
    const req = { role: 'scout', account: ADMIN_WALLET, body: { treasuryAddress: TREASURY, amountStroops: '100' }, headers: {} } as any;
    const res = makeRes();
    await withdrawFeesV2Controller(req, res, { } as any);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('maps an on-chain INSUFFICIENT_FEES rejection to a 422', async () => {
    mockGetFeeBalance.mockResolvedValue(1000n);
    mockWithdrawFees.mockRejectedValue(
      new stellar.FeeWithdrawalError(
        'Requested withdrawal amount exceeds the available fee balance',
        'INSUFFICIENT_FEES',
      ),
    );

    const res = makeRes();
    await withdrawFeesV2Controller(makeReq({ treasuryAddress: TREASURY, amountStroops: '100' }), res, { } as any);

    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('maps a network failure to a 503', async () => {
    mockGetFeeBalance.mockResolvedValue(1000n);
    mockWithdrawFees.mockRejectedValue(
      new stellar.FeeWithdrawalError('RPC timeout', 'NETWORK_ERROR'),
    );

    const res = makeRes();
    await withdrawFeesV2Controller(makeReq({ treasuryAddress: TREASURY, amountStroops: '100' }), res, { } as any);

    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('rejects with 409 when another withdrawal is already in flight', async () => {
    // Simulate an in-flight withdrawal via the exported test hook.
    const { setWithdrawalLockForTesting } = require('../../src/controllers/adminController');
    setWithdrawalLockForTesting();

    const res = makeRes();
    await withdrawFeesV2Controller(makeReq({ treasuryAddress: TREASURY, amountStroops: '100' }), res, { } as any);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });
});
