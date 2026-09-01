import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import * as stellar from '../../src/services/stellar';
import {
  resetWithdrawalLock,
  setWithdrawalLockForTesting,
} from '../../src/controllers/adminController';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/services/audit', () => ({
  logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/stellar', () => ({
  ...jest.requireActual('../../src/services/stellar'),
  withdrawFees: jest.fn(),
}));

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

const mockWithdrawFees = stellar.withdrawFees as jest.Mock;

const ADMIN_WALLET = 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';
const VALID_RECIPIENT = 'GRECIPIENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';

function makeAdminToken(): string {
  return jwt.sign({ sub: ADMIN_WALLET, role: 'admin' }, SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetWithdrawalLock();
});

describe('POST /api/admin/fees — concurrent withdrawal mutex', () => {
  it('returns 409 for second request while first is in progress', async () => {
    const adminToken = makeAdminToken();

    // Simulate withdrawal already in progress
    setWithdrawalLockForTesting();

    const res = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/already in progress/i);
    expect(mockWithdrawFees).not.toHaveBeenCalled();
  });

  it('fires two simultaneous requests — second gets 409 while first succeeds', async () => {
    const adminToken = makeAdminToken();

    // First request takes time to complete
    let resolveFirst!: (val: stellar.FeeWithdrawalResult) => void;
    const firstPromise = new Promise<stellar.FeeWithdrawalResult>((resolve) => {
      resolveFirst = resolve;
    });
    mockWithdrawFees.mockReturnValueOnce(firstPromise);

    // Use .end() with a callback so the request is dispatched immediately
    // instead of lazily on the next tick — needed to guarantee it's actually
    // in flight before the second request fires below.
    const first = new Promise<request.Response>((resolve, reject) => {
      request(app)
        .post('/api/admin/fees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ recipient: VALID_RECIPIENT })
        .end((err, res) => (err ? reject(err) : resolve(res)));
    });

    await new Promise((r) => setImmediate(r));

    // Second request while first is in flight — should be rejected
    const second = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });

    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already in progress/i);

    // Resolve the first request
    resolveFirst({
      transactionId: 'tx-1',
      recipient: VALID_RECIPIENT,
      amount: '100',
      token: 'XLM',
    });

    const firstResult = await first;
    expect(firstResult.status).toBe(200);
    expect(firstResult.body.success).toBe(true);
  });

  it('releases lock after successful withdrawal — next request succeeds', async () => {
    const adminToken = makeAdminToken();
    const result: stellar.FeeWithdrawalResult = {
      transactionId: 'tx-ok',
      recipient: VALID_RECIPIENT,
      amount: '500',
      token: 'XLM',
    };
    mockWithdrawFees.mockResolvedValue(result);

    const first = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(first.status).toBe(200);

    mockWithdrawFees.mockResolvedValue({ ...result, transactionId: 'tx-ok-2' });
    const second = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(second.status).toBe(200);
    expect(second.body.data.transactionId).toBe('tx-ok-2');
  });

  it('releases lock after failed withdrawal — next request is not blocked', async () => {
    const adminToken = makeAdminToken();
    mockWithdrawFees.mockRejectedValueOnce(
      new stellar.FeeWithdrawalError('No fees', 'NO_FEES'),
    );

    const first = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(first.status).toBe(409);

    mockWithdrawFees.mockResolvedValue({
      transactionId: 'tx-after-fail',
      recipient: VALID_RECIPIENT,
      amount: '200',
      token: 'XLM',
    });
    const second = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    // Should reach the service, not blocked by mutex
    expect(second.status).toBe(200);
    expect(mockWithdrawFees).toHaveBeenCalledTimes(2);
  });

  it('releases lock after unexpected error — next request proceeds', async () => {
    const adminToken = makeAdminToken();
    mockWithdrawFees.mockRejectedValueOnce(new Error('Unexpected crash'));

    const first = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(first.status).toBe(500);

    mockWithdrawFees.mockResolvedValue({
      transactionId: 'tx-after-crash',
      recipient: VALID_RECIPIENT,
      amount: '300',
      token: 'XLM',
    });
    const second = await request(app)
      .post('/api/admin/fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ recipient: VALID_RECIPIENT });
    expect(second.status).toBe(200);
    expect(second.body.data.transactionId).toBe('tx-after-crash');
  });
});
