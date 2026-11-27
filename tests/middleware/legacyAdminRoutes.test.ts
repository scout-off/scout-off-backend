import type { Request, Response, NextFunction } from 'express';
import {
  legacyAdminRoute,
  legacyFeeIdempotencyKey,
  normalizeLegacyReindex,
  LEGACY_ADMIN_SUNSET,
} from '../../src/middleware/legacyAdminRoutes';
import { legacyAdminCalls } from '../../src/middleware/metrics';

function res() {
  return { set: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis(), json: jest.fn() };
}
function req(headers: Record<string, string> = {}, body: unknown = {}): Request {
  return { headers, body } as unknown as Request;
}

it('adds deprecation and future sunset headers and counts calls', () => {
  const response = res();
  const next = jest.fn();
  const before = legacyAdminCalls.fees;
  legacyAdminRoute('fees')(req(), response as unknown as Response, next as NextFunction);
  expect(next).toHaveBeenCalledTimes(1);
  expect(response.set).toHaveBeenCalledWith('Deprecation', expect.stringMatching(/^@\d+$/));
  expect(response.set).toHaveBeenCalledWith('Sunset', LEGACY_ADMIN_SUNSET);
  expect(legacyAdminCalls.fees).toBe(before + 1);
});

it('normalizes X-Idempotency-Key for the existing middleware', () => {
  const request = req({ 'x-idempotency-key': 'test-retry' });
  legacyFeeIdempotencyKey(request, res() as unknown as Response, jest.fn());
  expect(request.headers['idempotency-key']).toBe('test-retry');
});

it('rejects conflicting header spellings', () => {
  const response = res();
  const next = jest.fn();
  legacyFeeIdempotencyKey(
    req({ 'x-idempotency-key': 'foo', 'idempotency-key': 'bar' }),
    response as unknown as Response,
    next,
  );
  expect(response.status).toHaveBeenCalledWith(400);
  expect(next).not.toHaveBeenCalled();
});

it('keeps missing idempotency key backwards compatible and increments warning metric', () => {
  const before = legacyAdminCalls.fees_missing_key;
  const next = jest.fn();
  legacyFeeIdempotencyKey(req(), res() as unknown as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(legacyAdminCalls.fees_missing_key).toBe(before + 1);
});

it('maps legacy fromLedger to a bounded background job and preserves explicit range', () => {
  const a = req({}, { fromLedger: 20 });
  normalizeLegacyReindex(a, res() as unknown as Response, jest.fn());
  expect(a.body).toEqual({ fromLedger: 20, toLedger: 10020 });
  const b = req({}, { fromLedger: 20, toLedger: 21 });
  normalizeLegacyReindex(b, res() as unknown as Response, jest.fn());
  expect(b.body).toEqual({ fromLedger: 20, toLedger: 21 });
});

it('rejects unsafe ledger integer overflow', () => {
  const response = res();
  const next = jest.fn();
  normalizeLegacyReindex(
    req({}, { fromLedger: Number.MAX_SAFE_INTEGER }),
    response as unknown as Response,
    next,
  );
  expect(response.status).toHaveBeenCalledWith(400);
  expect(next).not.toHaveBeenCalled();
});
