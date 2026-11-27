/** Integration of legacy X-Idempotency-Key normalization with the existing cache middleware. */
import express from 'express';
import request from 'supertest';
import { idempotency } from '../../src/middleware/idempotency';
import { legacyFeeIdempotencyKey } from '../../src/middleware/legacyAdminRoutes';
import { getIdempotencyRecord, claimIdempotencyKey, updateIdempotencyRecord } from '../../src/db';

jest.mock('../../src/db', () => ({
  getIdempotencyRecord: jest.fn(),
  claimIdempotencyKey: jest.fn(),
  updateIdempotencyRecord: jest.fn(),
  releaseIdempotencyKey: jest.fn(),
}));

const getRecord = getIdempotencyRecord as jest.Mock;
const claim = claimIdempotencyKey as jest.Mock;
const update = updateIdempotencyRecord as jest.Mock;

it('replaying the same key returns the first response without a second withdrawal call', async () => {
  let record: Record<string, unknown> | null = null;
  getRecord.mockImplementation(async () => record);
  claim.mockResolvedValue(true);
  update.mockImplementation(async (key: string, statusCode: number, body: unknown) => {
    record = {
      status: 'complete',
      status_code: statusCode,
      response: JSON.stringify(body),
      request_fingerprint: 'legacy-fees:GADMIN:{"recipient":"GRECIPIENT"}',
    };
  });

  const withdraw = jest.fn((_req: express.Request, res: express.Response) => {
    res.status(200).json({ success: true, data: { transactionId: 'stellar-tx-1' } });
  });
  const app = express();
  app.use(express.json());
  app.post('/admin/fees', (req, _res, next) => {
    req.account = 'GADMIN';
    next();
  }, legacyFeeIdempotencyKey,
  idempotency({ requestFingerprint: (req) => `legacy-fees:${req.account}:${JSON.stringify(req.body)}` }), withdraw);

  const send = () => request(app).post('/admin/fees')
    .set('X-Idempotency-Key', 'same-key')
    .send({ recipient: 'GRECIPIENT' });
  const first = await send();
  // The idempotency cache update is fire-and-forget after res.json().
  await new Promise<void>((resolve) => setImmediate(resolve));
  const repeat = await send();
  expect(first.status).toBe(200);
  expect(repeat.status).toBe(200);
  expect(repeat.body).toEqual(first.body);
  expect(repeat.headers['idempotent-replayed']).toBe('true');
  expect(claim).toHaveBeenCalledTimes(1);
  expect(withdraw).toHaveBeenCalledTimes(1);
});
