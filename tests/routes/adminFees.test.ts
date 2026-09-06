import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';
import app from '../../src/app';
import { logAuditEvent } from '../../src/services/audit';
import * as stellar from '../../src/services/stellar';
import { resetWithdrawalLock, setWithdrawalLockForTesting } from '../../src/controllers/adminController';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/services/audit', () => ({
  logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/stellar', () => ({
  ...jest.requireActual('../../src/services/stellar'),
  withdrawFees: jest.fn(),
  // The v2 endpoint (/fees/withdraw) pre-checks amountStroops against the
  // live on-chain balance before submitting.
  getFeeBalance: jest.fn().mockResolvedValue(1_000_000_000n),
}));

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  insertFeeWithdrawal: jest.fn().mockResolvedValue({ id: 1 }),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

const mockWithdrawFees = stellar.withdrawFees as jest.Mock;
const mockLogAuditEvent = logAuditEvent as jest.Mock;

const ADMIN_WALLET = 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';
const VALID_RECIPIENT = 'GRECIPIENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';
// Checksum-valid key — the v2 endpoint validates treasuryAddress via
// isValidStellarAddress (Keypair.fromPublicKey), which is stricter than the
// legacy regex-only check.
const V2_TREASURY = Keypair.random().publicKey();

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetWithdrawalLock();
});

// ─── Authentication & authorisation ──────────────────────────────────────────

describe('POST /api/admin/fees — auth', () => {
  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post('/api/admin/fees')
      .send({ recipient: VALID_RECIPIENT });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 for a non-admin role (scout)', async () => {
    const token = makeToken('GSCOUT1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'scout');
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 403 for a non-admin role (validator)', async () => {
    const token = makeToken('GVAL1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'validator');
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 for an expired token', async () => {
    const expired = jwt.sign({ sub: ADMIN_WALLET, role: 'admin' }, SECRET, { expiresIn: '-1s' });
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${expired}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(res.status).toBe(401);
  });

  /**
   * Controller-level auth guard: even if the route middleware were somehow
   * bypassed, the controller independently re-checks the role.
   */
  it('returns 403 when req.role is not admin (controller-level guard)', async () => {
    // Craft a player-role token — route + controller both must reject it.
    const token = makeToken('GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'player');
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

// ─── Input validation ─────────────────────────────────────────────────────────

describe('POST /api/admin/fees — validation', () => {
  let adminToken: string;

  beforeEach(() => {
    adminToken = makeToken(ADMIN_WALLET, 'admin');
  });

  it('returns 400 when recipient is missing', async () => {
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 for an invalid Stellar address (too short)', async () => {
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: 'GSHORT' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for an address starting with wrong prefix', async () => {
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for a non-string recipient', async () => {
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: 12345 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects a malformed body at the validation layer with a structured 400', async () => {
    // validateBody(withdrawFeesSchema) short-circuits an invalid body before
    // the controller runs, so the response is the generic validation envelope
    // and no on-chain withdrawal is attempted.
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: 'BAD' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Validation Error');
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('does not call withdrawFees when validation fails', async () => {
    await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: 'INVALID' });
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });
});

// ─── No fees available (409) ──────────────────────────────────────────────────

describe('POST /api/admin/fees — no fees (409)', () => {
  let adminToken: string;

  beforeEach(() => {
    adminToken = makeToken(ADMIN_WALLET, 'admin');
    mockWithdrawFees.mockRejectedValue(
      new stellar.FeeWithdrawalError('No fees available to withdraw', 'NO_FEES'),
    );
  });

  it('returns 409 when no fees are available', async () => {
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/no fees/i);
  });

  it('logs an audit event for no-fees failure', async () => {
    await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    const call = mockLogAuditEvent.mock.calls[0][0];
    expect(call.action).toBe('fee_withdrawal_attempt');
    expect(call.adminWallet).toBe(ADMIN_WALLET);
    expect(call.contractAction).toBe('withdraw_fees');
    expect(call.queryParams.recipient).toBe(VALID_RECIPIENT);
    expect(call.queryParams.errorCode).toBe('NO_FEES');
    expect(call.queryParams.retryable).toBe(false);
    expect(call.queryParams.outcome).toBe('failure');
  });
});

// ─── Contract paused (409 — non-retryable) ───────────────────────────────────

describe('POST /api/admin/fees — CONTRACT_PAUSED (409)', () => {
  let adminToken: string;

  beforeEach(() => {
    adminToken = makeToken(ADMIN_WALLET, 'admin');
    mockWithdrawFees.mockRejectedValue(
      new stellar.FeeWithdrawalError('Contract is paused', 'CONTRACT_PAUSED'),
    );
  });

  it('returns 409 when contract is paused', async () => {
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/paused/i);
  });

  it('audit log marks CONTRACT_PAUSED as non-retryable', async () => {
    await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    const call = mockLogAuditEvent.mock.calls[0][0];
    expect(call.queryParams.errorCode).toBe('CONTRACT_PAUSED');
    expect(call.queryParams.retryable).toBe(false);
  });
});

// ─── Network / transient error (503 — retryable) ─────────────────────────────

describe('POST /api/admin/fees — NETWORK_ERROR (503)', () => {
  let adminToken: string;

  beforeEach(() => {
    adminToken = makeToken(ADMIN_WALLET, 'admin');
    mockWithdrawFees.mockRejectedValue(
      new stellar.FeeWithdrawalError('RPC timeout', 'NETWORK_ERROR'),
    );
  });

  it('returns 503 on a network/transient error', async () => {
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/network error/i);
  });

  it('audit log marks NETWORK_ERROR as retryable', async () => {
    await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    const call = mockLogAuditEvent.mock.calls[0][0];
    expect(call.queryParams.errorCode).toBe('NETWORK_ERROR');
    expect(call.queryParams.retryable).toBe(true);
  });
});

// ─── Invalid recipient from service layer (400) ───────────────────────────────

describe('POST /api/admin/fees — INVALID_RECIPIENT from service (400)', () => {
  it('returns 400 when service throws INVALID_RECIPIENT', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    mockWithdrawFees.mockRejectedValue(
      new stellar.FeeWithdrawalError('Invalid recipient', 'INVALID_RECIPIENT'),
    );
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ─── Concurrent / duplicate withdrawal (409) ─────────────────────────────────

describe('POST /api/admin/fees — concurrent withdrawal (409)', () => {
  /**
   * Verifies the in-process concurrency lock.
   *
   * Because Jest runs --runInBand (single Node.js thread), two HTTP requests
   * cannot truly be in-flight simultaneously via supertest. We instead use the
   * exported setWithdrawalLockForTesting() helper to directly put the controller
   * into "lock held" state, then verify that any new request is rejected with 409.
   * resetWithdrawalLock() in beforeEach ensures the lock is clean between tests.
   */
  it('rejects a request when the lock is already held', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');

    // Pre-set the lock to simulate a withdrawal already in progress.
    setWithdrawalLockForTesting();

    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/already in progress/i);
  });

  it('lock is not released by the rejected request — must be reset explicitly', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    setWithdrawalLockForTesting();

    // First request rejected (lock held).
    const first = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(first.status).toBe(409);

    // The 409 early-return path does NOT release the lock (only the real holder
    // releases it via the finally block). Explicitly reset for next request.
    resetWithdrawalLock();

    mockWithdrawFees.mockRejectedValueOnce(
      new stellar.FeeWithdrawalError('No fees', 'NO_FEES'),
    );
    const second = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    // Lock was released — this request reached the service (NO_FEES → 409).
    expect(second.status).toBe(409);
    expect(mockWithdrawFees).toHaveBeenCalledTimes(1);
  });

  it('releases the lock after a successful withdrawal', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    const result: stellar.FeeWithdrawalResult = {
      transactionId: 'txid-1',
      recipient: VALID_RECIPIENT,
      amount: '200',
      token: 'XLM',
    };
    mockWithdrawFees.mockResolvedValue(result);

    // First withdrawal succeeds.
    const first = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(first.status).toBe(200);

    // Second withdrawal should also succeed (lock was released).
    mockWithdrawFees.mockResolvedValue({ ...result, transactionId: 'txid-2' });
    const second = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(second.status).toBe(200);
  });

  it('releases the lock after a failed withdrawal', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    mockWithdrawFees.mockRejectedValueOnce(
      new stellar.FeeWithdrawalError('No fees', 'NO_FEES'),
    );

    const first = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(first.status).toBe(409);

    // Lock must be released — next request should reach the service.
    mockWithdrawFees.mockRejectedValueOnce(
      new stellar.FeeWithdrawalError('No fees', 'NO_FEES'),
    );
    const second = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(second.status).toBe(409);
    // Both calls reached the service
    expect(mockWithdrawFees).toHaveBeenCalledTimes(2);
  });
});

// ─── Successful withdrawal ────────────────────────────────────────────────────

describe('POST /api/admin/fees — success', () => {
  const feeResult: stellar.FeeWithdrawalResult = {
    transactionId: 'txid-abc123',
    recipient: VALID_RECIPIENT,
    amount: '500000000',
    token: 'XLM',
  };

  let adminToken: string;

  beforeEach(() => {
    adminToken = makeToken(ADMIN_WALLET, 'admin');
    mockWithdrawFees.mockResolvedValue(feeResult);
  });

  it('returns 200 with transaction data on success', async () => {
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transactionId).toBe('txid-abc123');
    expect(res.body.data.recipient).toBe(VALID_RECIPIENT);
    expect(res.body.data.amount).toBe('500000000');
    expect(res.body.data.token).toBe('XLM');
  });

  it('amount is returned as a string (no precision loss)', async () => {
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(typeof res.body.data.amount).toBe('string');
  });

  it('calls withdrawFees with the validated recipient', async () => {
    await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(mockWithdrawFees).toHaveBeenCalledWith(VALID_RECIPIENT);
  });

  it('logs a success audit event with enriched fields', async () => {
    await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    const call = mockLogAuditEvent.mock.calls[0][0];
    expect(call.action).toBe('fee_withdrawal_attempt');
    expect(call.adminWallet).toBe(ADMIN_WALLET);
    expect(call.contractAction).toBe('withdraw_fees');
    expect(call.queryParams.recipient).toBe(VALID_RECIPIENT);
    expect(call.queryParams.transactionId).toBe('txid-abc123');
    expect(call.queryParams.amount).toBe('500000000');
    expect(call.queryParams.token).toBe('XLM');
    expect(call.queryParams.outcome).toBe('success');
  });

  it('audit event does not expose the JWT secret or other sensitive fields', async () => {
    await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    const call = mockLogAuditEvent.mock.calls[0][0];
    expect(JSON.stringify(call)).not.toContain(SECRET);
  });
});

// ─── Unexpected errors (500) ──────────────────────────────────────────────────

describe('POST /api/admin/fees — unexpected error', () => {
  it('delegates to error handler for non-FeeWithdrawalError errors', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    mockWithdrawFees.mockRejectedValue(new Error('RPC timeout'));
    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    // Error handler returns 500 for unhandled errors
    expect(res.status).toBe(500);
    // Audit was still logged
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    const call = mockLogAuditEvent.mock.calls[0][0];
    expect(call.action).toBe('fee_withdrawal_attempt');
    expect(call.queryParams.error).toBe('RPC timeout');
    expect(call.queryParams.outcome).toBe('failure');
  });

  it('releases the concurrency lock after an unexpected error', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    mockWithdrawFees.mockRejectedValueOnce(new Error('Unexpected crash'));

    await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });

    // Lock must be freed — subsequent request should not be rejected with 409.
    mockWithdrawFees.mockRejectedValueOnce(new Error('Unexpected crash 2'));
    const second = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    // Should be 500 (the error), NOT 409 (concurrent lock)
    expect(second.status).toBe(500);
  });
});

// ─── API v1 alias ─────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/fees — versioned alias', () => {
  it('responds identically via the /api/v1 prefix', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    mockWithdrawFees.mockRejectedValue(
      new stellar.FeeWithdrawalError('No fees available to withdraw', 'NO_FEES'),
    );
    const res = await request(app)
      .post('/api/v1/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });
});

// ─── POST /api/admin/fees/withdraw (v2 — #1045) ──────────────────────────────
// The v2 endpoint validates amountStroops against the on-chain balance and
// must pass that exact amount into withdraw_fees — regression tests for the
// silently-discarded-amount bug.

describe('POST /api/admin/fees/withdraw — v2 amount threading (#1045)', () => {
  const mockGetFeeBalance = stellar.getFeeBalance as jest.Mock;

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post('/api/admin/fees/withdraw')
      .send({ treasuryAddress: V2_TREASURY, amountStroops: '100' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin role', async () => {
    const token = makeToken('GSCOUT1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'scout');
    const res = await request(app)
      .post('/api/admin/fees/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ treasuryAddress: V2_TREASURY, amountStroops: '100' });
    expect(res.status).toBe(403);
  });

  it('returns 400 for an invalid treasuryAddress', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .post('/api/admin/fees/withdraw')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ treasuryAddress: 'INVALID', amountStroops: '100' });
    expect(res.status).toBe(400);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-positive amountStroops', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .post('/api/admin/fees/withdraw')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ treasuryAddress: V2_TREASURY, amountStroops: '0' });
    expect(res.status).toBe(400);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('returns 422 when amountStroops exceeds the on-chain fee balance', async () => {
    mockGetFeeBalance.mockResolvedValue(50n);
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .post('/api/admin/fees/withdraw')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ treasuryAddress: V2_TREASURY, amountStroops: '100' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/exceeds/i);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('calls withdrawFees with the validated amount and returns the confirmed result', async () => {
    mockGetFeeBalance.mockResolvedValue(1_000_000_000n);
    mockWithdrawFees.mockResolvedValue({
      transactionId: 'v2-tx-001',
      recipient: V2_TREASURY,
      amount: '100',
      token: 'XLM',
    });
    const adminToken = makeToken(ADMIN_WALLET, 'admin');

    const res = await request(app)
      .post('/api/admin/fees/withdraw')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ treasuryAddress: V2_TREASURY, amountStroops: '100' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockWithdrawFees).toHaveBeenCalledWith(V2_TREASURY, '100');
    expect(res.body.data.transactionId).toBe('v2-tx-001');
    expect(res.body.data.treasuryAddress).toBe(V2_TREASURY);
    expect(res.body.data.amountStroops).toBe('100');
    expect(res.body.data.amount).toBe('100');
  });

  it('logs a success audit event with both the requested and actual amounts', async () => {
    mockGetFeeBalance.mockResolvedValue(1_000_000_000n);
    mockWithdrawFees.mockResolvedValue({
      transactionId: 'v2-tx-002',
      recipient: V2_TREASURY,
      amount: '100',
      token: 'XLM',
    });
    const adminToken = makeToken(ADMIN_WALLET, 'admin');

    await request(app)
      .post('/api/admin/fees/withdraw')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ treasuryAddress: V2_TREASURY, amountStroops: '100' });

    const call = mockLogAuditEvent.mock.calls.at(-1)[0];
    expect(call.action).toBe('fee_withdrawal_attempt');
    expect(call.contractAction).toBe('withdraw_fees');
    expect(call.queryParams.amountStroops).toBe('100');
    expect(call.queryParams.amount).toBe('100');
    expect(call.queryParams.transactionId).toBe('v2-tx-002');
    expect(call.queryParams.outcome).toBe('success');
  });
});
