/**
 * Tests for issue #1134: atomic bulk validator import.
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/services/adminMultiSig', () => ({
  executeAdminAction: jest.fn(),
}));

import { executeAdminAction } from '../../src/services/adminMultiSig';
const mockExecute = executeAdminAction as jest.Mock;

function makeToken(role: string) {
  return jwt.sign({ sub: 'GADMIN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', role }, SECRET, { expiresIn: '1h' });
}

const ADMIN_TOKEN = makeToken('admin');
const VALIDATOR_TOKEN = makeToken('validator');

const WALLET_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

beforeEach(() => {
  mockExecute.mockReset();
});

describe('POST /api/admin/validators/bulk-import', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/admin/validators/bulk-import').send({});
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    const res = await request(app)
      .post('/api/admin/validators/bulk-import')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`)
      .send({ actionId: 'a1', wallets: [WALLET_A] });
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing wallets', async () => {
    const res = await request(app)
      .post('/api/admin/validators/bulk-import')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ actionId: 'a1' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid Stellar address', async () => {
    const res = await request(app)
      .post('/api/admin/validators/bulk-import')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ actionId: 'a1', wallets: ['not-a-stellar-address'] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty wallets array', async () => {
    const res = await request(app)
      .post('/api/admin/validators/bulk-import')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ actionId: 'a1', wallets: [] });
    expect(res.status).toBe(400);
  });

  it('returns 202 on full success with manifest', async () => {
    mockExecute.mockResolvedValue({
      actionId: 'a1',
      type: 'bulk_validator_import',
      success: true,
      manifest: [
        { wallet: WALLET_A, success: true },
        { wallet: WALLET_B, success: true },
      ],
    });

    const res = await request(app)
      .post('/api/admin/validators/bulk-import')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ actionId: 'a1', wallets: [WALLET_A, WALLET_B] });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data.manifest).toHaveLength(2);
    expect(res.body.data.manifest[0].success).toBe(true);
  });

  it('returns 207 on partial failure with manifest for retry', async () => {
    mockExecute.mockResolvedValue({
      actionId: 'a1',
      type: 'bulk_validator_import',
      success: false,
      error: 'Partial import: 1 of 2 wallets failed. Retry using the manifest.',
      manifest: [
        { wallet: WALLET_A, success: true },
        { wallet: WALLET_B, success: false, error: 'contract error' },
      ],
    });

    const res = await request(app)
      .post('/api/admin/validators/bulk-import')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ actionId: 'a1', wallets: [WALLET_A, WALLET_B] });

    expect(res.status).toBe(207);
    expect(res.body.success).toBe(false);
    expect(res.body.data.manifest).toHaveLength(2);
    expect(res.body.data.manifest[1].success).toBe(false);
    expect(res.body.data.manifest[1].error).toBe('contract error');
  });

  it('calls executeAdminAction with bulk_validator_import type and full wallet list', async () => {
    mockExecute.mockResolvedValue({
      actionId: 'a1',
      type: 'bulk_validator_import',
      success: true,
      manifest: [{ wallet: WALLET_A, success: true }],
    });

    await request(app)
      .post('/api/admin/validators/bulk-import')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ actionId: 'a1', wallets: [WALLET_A] });

    expect(mockExecute).toHaveBeenCalledWith(
      'a1',
      'bulk_validator_import',
      { wallets: [WALLET_A] },
      expect.any(String),
    );
  });
});
