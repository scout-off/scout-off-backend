import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';

// register_validator performs a real Soroban RPC round-trip in production —
// mock just this one function (matching admin.test.ts's approach) so the
// "valid wallet" success-path assertion below doesn't depend on a live RPC
// endpoint being reachable from the test environment.
jest.mock('../../src/services/stellar', () => ({
  ...jest.requireActual('../../src/services/stellar'),
  registerValidatorOnChain: jest.fn().mockResolvedValue({ transactionId: 'e2e-register-txid' }),
}));

import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
// Same wallet tests/setup.ts wires up as ADMIN_WALLET — several endpoints
// exercised below (validators/register, fees withdrawal) gate on
// config.adminWallets.includes(req.account) in addition to role:'admin', so
// the token must be issued for that exact wallet rather than a freshly
// generated SEP-10 keypair (which can self-declare role:'admin' but will
// never satisfy the wallet-identity check).
const ADMIN_WALLET = process.env.ADMIN_WALLET ?? 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';

describe('Admin query schema date filtering (#30)', () => {
  let token: string;

  beforeAll(() => {
    token = jwt.sign({ sub: ADMIN_WALLET, role: 'admin' }, SECRET, { expiresIn: '1h' });
  });

  describe('GET /api/admin/events', () => {
    it('returns 200 with no query params', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 200 with valid ISO startDate and endDate', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ startDate: '2024-01-01T00:00:00.000Z', endDate: '2025-12-31T00:00:00.000Z' })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('returns 400 for invalid startDate format', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ startDate: 'not-a-date' })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('startDate');
    });

    it('returns 400 for invalid endDate format', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ endDate: '31-12-2024' })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('endDate');
    });

    it('returns 400 when startDate is after endDate', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ startDate: '2025-12-01T00:00:00.000Z', endDate: '2024-01-01T00:00:00.000Z' })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].message).toContain('startDate must not be after endDate');
    });
  });

  describe('GET /api/admin/fees', () => {
    it('returns 200 with no query params', async () => {
      const res = await request(app)
        .get('/api/admin/fees')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('returns 400 for invalid startDate on /fees', async () => {
      const res = await request(app)
        .get('/api/admin/fees')
        .query({ startDate: 'bad-date' })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('startDate');
    });
  });

  describe('GET /api/admin/events - ledger range validation', () => {
    it('returns 400 for invalid fromLedger (non-numeric)', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ fromLedger: 'abc' })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('fromLedger');
    });

    it('returns 400 for invalid toLedger (negative)', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ toLedger: -1 })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('toLedger');
    });

    it('returns 400 when fromLedger > toLedger', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ fromLedger: 100, toLedger: 50 })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].message).toContain('fromLedger must not be greater than toLedger');
    });
  });

  describe('GET /api/admin/events - pagination validation', () => {
    it('returns 400 for invalid page (negative)', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ page: -1 })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('page');
    });

    it('returns 400 for invalid pageSize (exceeds max)', async () => {
      // Max pageSize is 200 (see adminPagination.test.ts's "exceeding max
      // (200)" case, which pins this boundary against the same endpoint) —
      // 201 is the smallest value that exceeds it.
      const res = await request(app)
        .get('/api/admin/events')
        .query({ pageSize: 201 })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('pageSize');
    });
  });

  describe('POST /api/admin/indexer/reindex - fromLedger validation', () => {
    it('returns 400 for invalid fromLedger (string)', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/reindex')
        .set('Authorization', `Bearer ${token}`)
        .send({ fromLedger: 'abc' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('fromLedger');
    });

    it('returns 400 for invalid fromLedger (negative)', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/reindex')
        .set('Authorization', `Bearer ${token}`)
        .send({ fromLedger: -1 });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('fromLedger');
    });

    it('returns 200 for valid fromLedger', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/reindex')
        .set('Authorization', `Bearer ${token}`)
        .send({ fromLedger: 100 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/admin/validators/register - wallet validation', () => {
    it('returns 400 for invalid wallet address', async () => {
      const res = await request(app)
        .post('/api/admin/validators/register')
        .set('Authorization', `Bearer ${token}`)
        .send({ validatorWallet: 'INVALID' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('validatorWallet');
      expect(res.body.details[0].message).toBe('Invalid Stellar address');
    });

    it('returns 202 for valid wallet address', async () => {
      const validWallet = Keypair.random().publicKey();
      const res = await request(app)
        .post('/api/admin/validators/register')
        .set('Authorization', `Bearer ${token}`)
        .send({ validatorWallet: validWallet });
      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/admin/fees - recipient validation', () => {
    it('returns 400 for invalid recipient address', async () => {
      const res = await request(app)
        .post('/api/admin/fees')
        .set('Authorization', `Bearer ${token}`)
        .send({ recipient: 'INVALID' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('recipient');
      expect(res.body.details[0].message).toBe('Invalid Stellar address');
    });
  });
});
