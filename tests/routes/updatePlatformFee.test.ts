/**
 * Tests for issue #1133: update_platform_fee end to end.
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

beforeEach(() => {
  mockExecute.mockReset();
});

describe('POST /api/admin/fees/config', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/admin/fees/config').send({});
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    const res = await request(app)
      .post('/api/admin/fees/config')
      .set('Authorization', `Bearer ${VALIDATOR_TOKEN}`)
      .send({ actionId: 'a1', newFeeBps: 300 });
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing newFeeBps', async () => {
    const res = await request(app)
      .post('/api/admin/fees/config')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ actionId: 'a1' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for newFeeBps above 10000', async () => {
    const res = await request(app)
      .post('/api/admin/fees/config')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ actionId: 'a1', newFeeBps: 10001 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for newFeeBps below 0', async () => {
    const res = await request(app)
      .post('/api/admin/fees/config')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ actionId: 'a1', newFeeBps: -1 });
    expect(res.status).toBe(400);
  });

  it('returns 202 with transactionId and newFeeBps on success', async () => {
    mockExecute.mockResolvedValue({
      actionId: 'a1',
      type: 'update_platform_fee',
      success: true,
      transactionId: 'stub-fee-txid-123',
      newFeeBps: 300,
    });

    const res = await request(app)
      .post('/api/admin/fees/config')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ actionId: 'a1', newFeeBps: 300 });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data.newFeeBps).toBe(300);
    expect(res.body.data.transactionId).toBeDefined();
  });

  it('accepts boundary values 0 and 10000', async () => {
    mockExecute.mockResolvedValue({
      actionId: 'a2',
      type: 'update_platform_fee',
      success: true,
      transactionId: 'stub-fee-txid-456',
      newFeeBps: 0,
    });

    const res = await request(app)
      .post('/api/admin/fees/config')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ actionId: 'a2', newFeeBps: 0 });

    expect(res.status).toBe(202);
    expect(res.body.data.newFeeBps).toBe(0);
  });

  it('calls executeAdminAction with update_platform_fee type', async () => {
    mockExecute.mockResolvedValue({
      actionId: 'a3',
      type: 'update_platform_fee',
      success: true,
      transactionId: 'stub-txid',
      newFeeBps: 500,
    });

    await request(app)
      .post('/api/admin/fees/config')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ actionId: 'a3', newFeeBps: 500 });

    expect(mockExecute).toHaveBeenCalledWith(
      'a3',
      'update_platform_fee',
      { newFeeBps: 500 },
      expect.any(String),
    );
  });
});
