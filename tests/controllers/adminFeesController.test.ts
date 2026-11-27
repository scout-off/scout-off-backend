/**
 * Controller-level unit tests for src/controllers/adminFeesController.
 *
 * Unlike tests/routes/adminFees.test.ts (which drives the controller through
 * the HTTP stack), these tests invoke the exported handlers directly with the
 * Stellar service and DB layers mocked. This makes every branch assertable in
 * isolation: role/admin-wallet guards, Zod validation, the multi-sig gate, the
 * in-process concurrency mutex, on-chain RPC failures (each FeeWithdrawalError
 * code) and the failure-compensation paths (balance-check failure, DB-insert
 * failure, audit-write failure).
 */
import { Request, Response, NextFunction } from 'express';
import { Keypair } from '@stellar/stellar-sdk';

jest.mock('../../src/services/stellar', () => ({
  ...jest.requireActual('../../src/services/stellar'),
  withdrawFees: jest.fn(),
  getFeeBalance: jest.fn(),
}));

jest.mock('../../src/services/audit', () => ({
  logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/adminMultiSig', () => ({
  proposeAction: jest.fn(),
}));

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn(),
  insertFeeWithdrawal: jest.fn(),
}));

import {
  getFeeSummary,
  withdrawFeesController,
  withdrawFeesV2Controller,
  resetWithdrawalLock,
  setWithdrawalLockForTesting,
} from '../../src/controllers/adminFeesController';
import * as stellar from '../../src/services/stellar';
import * as db from '../../src/db';
import { logAuditEvent } from '../../src/services/audit';
import { proposeAction } from '../../src/services/adminMultiSig';
import config from '../../src/config';
import { logger } from '../../src/utils/logger';
import { ErrorCode } from '../../src/utils/errorCodes';

const ADMIN_WALLET =
  process.env.ADMIN_WALLET ?? 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';
// A checksum-valid wallet that is NOT in config.adminWallets.
const OTHER_WALLET = Keypair.random().publicKey();
const LEGACY_RECIPIENT = Keypair.random().publicKey();
const TREASURY = Keypair.random().publicKey();

const mockWithdrawFees = stellar.withdrawFees as jest.Mock;
const mockGetFeeBalance = stellar.getFeeBalance as jest.Mock;
const mockInsert = db.insertFeeWithdrawal as jest.Mock;
const mockQueryEvents = db.queryEvents as jest.Mock;
const mockAudit = logAuditEvent as jest.Mock;
const mockPropose = proposeAction as jest.Mock;

function makeRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: Record<string, jest.Mock> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

function makeNext(): jest.Mock {
  return jest.fn() as unknown as jest.Mock & NextFunction;
}

function legacyReq(overrides: Record<string, unknown> = {}): Request {
  return {
    role: 'admin',
    account: ADMIN_WALLET,
    body: { recipient: LEGACY_RECIPIENT },
    headers: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

function v2Req(overrides: Record<string, unknown> = {}): Request {
  return {
    role: 'admin',
    account: ADMIN_WALLET,
    body: { treasuryAddress: TREASURY, amountStroops: '100' },
    headers: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

/** Latest audit payload recorded by the mocked audit service. */
function lastAudit(): Record<string, any> {
  return mockAudit.mock.calls.at(-1)![0];
}

beforeEach(() => {
  jest.clearAllMocks();
  resetWithdrawalLock();
  config.adminThreshold = 1;

  mockWithdrawFees.mockReset();
  mockGetFeeBalance.mockReset();
  mockInsert.mockReset();
  mockQueryEvents.mockReset();
  mockPropose.mockReset();
  mockAudit.mockReset();

  mockQueryEvents.mockReturnValue([]);
  mockGetFeeBalance.mockResolvedValue(1_000_000_000n);
  mockInsert.mockResolvedValue({ id: 1 });
  mockAudit.mockResolvedValue(undefined);

  // Silence and observe controller logging.
  jest.spyOn(logger, 'info').mockImplementation(() => {});
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  config.adminThreshold = 1;
});

// ─── getFeeSummary ───────────────────────────────────────────────────────────

describe('getFeeSummary', () => {
  it('returns the fees_withdrawn payloads and audits the query', async () => {
    mockQueryEvents.mockReturnValue([
      { payload: { amount: '10', token: 'XLM' } },
      { payload: { amount: '20', token: 'XLM' } },
    ]);
    const res = makeRes();

    await getFeeSummary({ query: {}, account: ADMIN_WALLET } as unknown as Request, res, makeNext());

    expect(mockQueryEvents).toHaveBeenCalledWith('fees_withdrawn');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [
        { amount: '10', token: 'XLM' },
        { amount: '20', token: 'XLM' },
      ],
    });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'fee_history_query', adminWallet: ADMIN_WALLET }),
    );
  });

  it('falls back to "unknown" as the admin wallet when req.account is absent', async () => {
    const res = makeRes();

    await getFeeSummary({ query: {} } as unknown as Request, res, makeNext());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ adminWallet: 'unknown' }),
    );
  });

  it('returns 400 for an unparseable startDate and does not query events', async () => {
    const res = makeRes();

    await getFeeSummary(
      { query: { startDate: 'not-a-date' }, account: ADMIN_WALLET } as unknown as Request,
      res,
      makeNext(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Validation Error' }),
    );
    expect(mockQueryEvents).not.toHaveBeenCalled();
  });

  it('returns 400 when startDate is after endDate', async () => {
    const res = makeRes();

    await getFeeSummary(
      {
        query: { startDate: '2026-01-02', endDate: '2026-01-01' },
        account: ADMIN_WALLET,
      } as unknown as Request,
      res,
      makeNext(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockQueryEvents).not.toHaveBeenCalled();
  });

  it('still returns 200 when the audit write fails', async () => {
    mockQueryEvents.mockReturnValue([{ payload: { a: 1 } }]);
    mockAudit.mockRejectedValueOnce(new Error('audit store down'));
    const res = makeRes();

    await getFeeSummary({ query: {}, account: ADMIN_WALLET } as unknown as Request, res, makeNext());

    expect(res.json).toHaveBeenCalledWith({ success: true, data: [{ a: 1 }] });
  });
});

// ─── withdrawFeesController (legacy POST /api/admin/fees) ────────────────────

describe('withdrawFeesController (legacy)', () => {
  it('returns 403 with FORBIDDEN when the caller is not an admin', async () => {
    const res = makeRes();

    await withdrawFeesController(legacyReq({ role: 'scout' }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: ErrorCode.FORBIDDEN }),
    );
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('returns 403 when the admin wallet is not allow-listed', async () => {
    const res = makeRes();

    await withdrawFeesController(legacyReq({ account: OTHER_WALLET }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('returns 400 and audits the attempt for an invalid recipient', async () => {
    const res = makeRes();

    await withdrawFeesController(legacyReq({ body: { recipient: 'NOT-A-KEY' } }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
    expect(lastAudit().action).toBe('fee_withdrawal_attempt');
    expect(lastAudit().queryParams.error).toBe('validation_failed');
  });

  it('proposes a multi-sig action and returns 202 when adminThreshold > 1', async () => {
    config.adminThreshold = 2;
    mockPropose.mockResolvedValue({ actionId: 'act-legacy-1', status: 'proposed' });
    const res = makeRes();

    await withdrawFeesController(legacyReq(), res, makeNext());

    expect(mockPropose).toHaveBeenCalledWith(
      'withdraw_fees',
      { recipient: LEGACY_RECIPIENT },
      ADMIN_WALLET,
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          actionId: 'act-legacy-1',
          collectedSignatures: 1,
          requiredSignatures: 2,
        }),
      }),
    );
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('returns 409 and audits when a withdrawal is already in progress', async () => {
    setWithdrawalLockForTesting();
    const res = makeRes();

    await withdrawFeesController(legacyReq(), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: ErrorCode.CONFLICT }));
    expect(mockWithdrawFees).not.toHaveBeenCalled();
    expect(lastAudit().queryParams.error).toBe('concurrent_withdrawal_rejected');
  });

  it('returns 200 with the withdrawal result on success', async () => {
    mockWithdrawFees.mockResolvedValue({
      transactionId: 'tx-legacy-1',
      recipient: LEGACY_RECIPIENT,
      amount: '500',
      token: 'XLM',
    });
    const res = makeRes();

    await withdrawFeesController(legacyReq(), res, makeNext());

    expect(mockWithdrawFees).toHaveBeenCalledWith(LEGACY_RECIPIENT);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        transactionId: 'tx-legacy-1',
        recipient: LEGACY_RECIPIENT,
        amount: '500',
        token: 'XLM',
      },
    });
    expect(lastAudit().queryParams.outcome).toBe('success');
  });

  it.each([
    ['NO_FEES', 409, ErrorCode.NO_FEES],
    // The legacy path withdraws the full balance, so INSUFFICIENT_FEES is
    // reported with the same NO_FEES response as an empty vault.
    ['INSUFFICIENT_FEES', 409, ErrorCode.NO_FEES],
    ['CONTRACT_PAUSED', 409, ErrorCode.CONTRACT_PAUSED],
    ['INVALID_RECIPIENT', 400, ErrorCode.INVALID_RECIPIENT],
    ['NETWORK_ERROR', 503, ErrorCode.NETWORK_ERROR],
  ])('maps FeeWithdrawalError %s to HTTP %i', async (code, status, expectedCode) => {
    mockWithdrawFees.mockRejectedValue(
      new stellar.FeeWithdrawalError('boom', code as stellar.FeeWithdrawalErrorCode),
    );
    const res = makeRes();

    await withdrawFeesController(legacyReq(), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: expectedCode }));
    expect(lastAudit().queryParams.outcome).toBe('failure');
  });

  it('forwards unexpected errors to next() and audits the failure', async () => {
    const boom = new Error('kaboom');
    mockWithdrawFees.mockRejectedValue(boom);
    const next = makeNext();
    const res = makeRes();

    await withdrawFeesController(legacyReq(), res, next);

    expect(next).toHaveBeenCalledWith(boom);
    expect(res.status).not.toHaveBeenCalled();
    expect(lastAudit().queryParams.errorCode).toBe('UNKNOWN');
    expect(lastAudit().queryParams.error).toBe('kaboom');
  });

  it('releases the concurrency lock after a call settles', async () => {
    mockWithdrawFees.mockResolvedValue({
      transactionId: 'tx-legacy-2',
      recipient: LEGACY_RECIPIENT,
      amount: '1',
      token: 'XLM',
    });

    await withdrawFeesController(legacyReq(), makeRes(), makeNext());

    // A second call must not be rejected as concurrent.
    const res2 = makeRes();
    await withdrawFeesController(legacyReq(), res2, makeNext());
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(mockWithdrawFees).toHaveBeenCalledTimes(2);
  });
});

// ─── withdrawFeesV2Controller (POST /api/admin/fees/withdraw) ─────────────────

describe('withdrawFeesV2Controller', () => {
  const CONFIRMED: stellar.FeeWithdrawalResult = {
    transactionId: 'tx-v2-1',
    recipient: TREASURY,
    amount: '100',
    token: 'XLM',
  };

  it('returns 403 with FORBIDDEN when the caller is not an admin', async () => {
    const res = makeRes();

    await withdrawFeesV2Controller(v2Req({ role: 'scout' }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.FORBIDDEN }),
    );
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('returns 403 when the admin wallet is not allow-listed', async () => {
    const res = makeRes();

    await withdrawFeesV2Controller(v2Req({ account: OTHER_WALLET }), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('returns 400 with the required message when treasuryAddress is missing', async () => {
    const res = makeRes();

    await withdrawFeesV2Controller(
      v2Req({ body: { amountStroops: '100' } }),
      res,
      makeNext(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.VALIDATION_ERROR,
        error: 'treasuryAddress is required',
      }),
    );
    expect(lastAudit().queryParams.error).toBe('validation_failed');
  });

  it('returns 400 for a checksum-invalid treasuryAddress', async () => {
    const res = makeRes();

    await withdrawFeesV2Controller(
      v2Req({ body: { treasuryAddress: 'not-a-valid-address', amountStroops: '100' } }),
      res,
      makeNext(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-positive amountStroops', async () => {
    const res = makeRes();

    await withdrawFeesV2Controller(
      v2Req({ body: { treasuryAddress: TREASURY, amountStroops: '0' } }),
      res,
      makeNext(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-integer amountStroops', async () => {
    const res = makeRes();

    await withdrawFeesV2Controller(
      v2Req({ body: { treasuryAddress: TREASURY, amountStroops: '1.5' } }),
      res,
      makeNext(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('rejects unknown body keys (strict schema)', async () => {
    const res = makeRes();

    await withdrawFeesV2Controller(
      v2Req({ body: { treasuryAddress: TREASURY, amountStroops: '100', extra: true } }),
      res,
      makeNext(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('proposes a multi-sig action and audits multisig_pending when adminThreshold > 1', async () => {
    config.adminThreshold = 3;
    mockPropose.mockResolvedValue({ actionId: 'act-v2-1', status: 'proposed' });
    const res = makeRes();

    await withdrawFeesV2Controller(v2Req(), res, makeNext());

    expect(mockPropose).toHaveBeenCalledWith(
      'withdraw_fees',
      { treasuryAddress: TREASURY, amountStroops: '100' },
      ADMIN_WALLET,
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actionId: 'act-v2-1', requiredSignatures: 3 }),
      }),
    );
    // Neither the balance check nor the on-chain call happens while pending.
    expect(mockGetFeeBalance).not.toHaveBeenCalled();
    expect(mockWithdrawFees).not.toHaveBeenCalled();
    expect(lastAudit().queryParams.outcome).toBe('multisig_pending');
  });

  it('returns 422 and audits when amountStroops exceeds the on-chain balance', async () => {
    mockGetFeeBalance.mockResolvedValue(50n);
    const res = makeRes();

    await withdrawFeesV2Controller(v2Req(), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
    );
    expect(mockWithdrawFees).not.toHaveBeenCalled();
    expect(lastAudit().queryParams.error).toBe('amount_exceeds_balance');
  });

  it('proceeds with the withdrawal when the balance check fails (compensation)', async () => {
    mockGetFeeBalance.mockRejectedValueOnce(new Error('rpc unreachable'));
    mockWithdrawFees.mockResolvedValue(CONFIRMED);
    const res = makeRes();

    await withdrawFeesV2Controller(v2Req(), res, makeNext());

    expect(logger.warn).toHaveBeenCalled();
    expect(mockWithdrawFees).toHaveBeenCalledWith(TREASURY, '100');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 409 and audits when a withdrawal is already in progress', async () => {
    setWithdrawalLockForTesting();
    const res = makeRes();

    await withdrawFeesV2Controller(v2Req(), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
    expect(lastAudit().queryParams.error).toBe('concurrent_withdrawal_rejected');
  });

  it('withdraws, persists the DB row and audits both amounts on success', async () => {
    mockWithdrawFees.mockResolvedValue(CONFIRMED);
    const res = makeRes();

    await withdrawFeesV2Controller(v2Req(), res, makeNext());

    expect(mockWithdrawFees).toHaveBeenCalledWith(TREASURY, '100');
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        treasuryAddress: TREASURY,
        amountStroops: '100',
        txHash: 'tx-v2-1',
        adminWallet: ADMIN_WALLET,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ transactionId: 'tx-v2-1', amountStroops: '100' }),
      }),
    );
    expect(lastAudit().queryParams.outcome).toBe('success');
  });

  it('accepts a numeric amountStroops and threads it as a string', async () => {
    mockWithdrawFees.mockResolvedValue(CONFIRMED);
    const res = makeRes();

    await withdrawFeesV2Controller(
      v2Req({ body: { treasuryAddress: TREASURY, amountStroops: 100 } }),
      res,
      makeNext(),
    );

    expect(mockWithdrawFees).toHaveBeenCalledWith(TREASURY, '100');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('still returns 200 when the DB insert fails (failure compensation)', async () => {
    mockWithdrawFees.mockResolvedValue(CONFIRMED);
    mockInsert.mockRejectedValueOnce(new Error('sqlite busy'));
    const res = makeRes();

    await withdrawFeesV2Controller(v2Req(), res, makeNext());

    expect(logger.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    // The audit trail still records the successful on-chain withdrawal.
    expect(lastAudit().queryParams.outcome).toBe('success');
  });

  it('passes a trimmed Idempotency-Key header through to the DB row', async () => {
    mockWithdrawFees.mockResolvedValue(CONFIRMED);

    await withdrawFeesV2Controller(
      v2Req({ headers: { 'idempotency-key': '  key-abc  ' } }),
      makeRes(),
      makeNext(),
    );

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'key-abc' }),
    );
  });

  it('normalises a blank or non-string Idempotency-Key header to null', async () => {
    mockWithdrawFees.mockResolvedValue(CONFIRMED);

    await withdrawFeesV2Controller(
      v2Req({ headers: { 'idempotency-key': '   ' } }),
      makeRes(),
      makeNext(),
    );
    expect(mockInsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: null }),
    );

    // Multi-valued header (Express exposes arrays) is not a string → null.
    await withdrawFeesV2Controller(
      v2Req({ headers: { 'idempotency-key': ['a', 'b'] } }),
      makeRes(),
      makeNext(),
    );
    expect(mockInsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: null }),
    );
  });

  it.each([
    ['NO_FEES', 409, ErrorCode.NO_FEES],
    ['CONTRACT_PAUSED', 409, ErrorCode.CONTRACT_PAUSED],
    ['INVALID_RECIPIENT', 400, ErrorCode.INVALID_RECIPIENT],
    ['INSUFFICIENT_FEES', 422, ErrorCode.VALIDATION_ERROR],
    ['NETWORK_ERROR', 503, ErrorCode.NETWORK_ERROR],
  ])('maps FeeWithdrawalError %s to HTTP %i', async (code, status, expectedCode) => {
    mockWithdrawFees.mockRejectedValue(
      new stellar.FeeWithdrawalError('boom', code as stellar.FeeWithdrawalErrorCode),
    );
    const res = makeRes();

    await withdrawFeesV2Controller(v2Req(), res, makeNext());

    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: expectedCode }));
    expect(lastAudit().queryParams.outcome).toBe('failure');
  });

  it('forwards unexpected on-chain errors to next() and releases the lock', async () => {
    const boom = new Error('unexpected rpc shape');
    mockWithdrawFees.mockRejectedValue(boom);
    const next = makeNext();
    const res = makeRes();

    await withdrawFeesV2Controller(v2Req(), res, next);

    expect(next).toHaveBeenCalledWith(boom);
    expect(res.status).not.toHaveBeenCalled();
    expect(lastAudit().queryParams.errorCode).toBe('UNKNOWN');

    // Lock released in the finally block — a second call reaches the service.
    mockWithdrawFees.mockResolvedValue(CONFIRMED);
    const res2 = makeRes();
    await withdrawFeesV2Controller(v2Req(), res2, makeNext());
    expect(res2.status).toHaveBeenCalledWith(200);
  });
});
