import { Request, Response, NextFunction } from 'express';
import { ZodError, ZodIssueCode } from 'zod';

jest.mock('../../src/utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { errorHandler } from '../../src/middleware/errorHandler';
import { ErrorCode } from '../../src/utils/errorCodes';

function makeReq(correlationId?: string): Request {
  return { correlationId } as unknown as Request;
}

function makeRes() {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return { status, json } as unknown as Response;
}

const next = jest.fn() as unknown as NextFunction;

// Helper to extract the response body sent to the client
function getBody(res: Response): Record<string, unknown> {
  return ((res.status as jest.Mock).mock.results[0].value.json as jest.Mock).mock.calls[0][0];
}

describe('errorHandler', () => {
  // ── existing coverage ──────────────────────────────────────────────────────
  it('includes correlationId in 500 error response when set on req', () => {
    const req = makeReq('test-corr-id');
    const res = makeRes();
    errorHandler(new Error('something went wrong'), req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(500);
    const body = getBody(res);
    expect(body.correlationId).toBe('test-corr-id');
    expect(body.success).toBe(false);
    expect(body.error).toBe('something went wrong');
  });

  it('omits correlationId when not present on req', () => {
    const req = makeReq(undefined);
    const res = makeRes();
    errorHandler(new Error('oops'), req, res, next);
    const body = getBody(res);
    expect(body.correlationId).toBeUndefined();
    expect(body.success).toBe(false);
  });

  it('includes correlationId in ZodError 400 response', () => {
    const req = makeReq('zod-corr-id');
    const res = makeRes();
    const zodErr = new ZodError([
      { code: ZodIssueCode.custom, message: 'Invalid field', path: ['field'] },
    ]);
    errorHandler(zodErr, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
    const body = getBody(res);
    expect(body.correlationId).toBe('zod-corr-id');
    expect(body.success).toBe(false);
  });

  it('returns 400 for ZodError without correlationId when req has none', () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const zodErr = new ZodError([
      { code: ZodIssueCode.custom, message: 'Bad', path: [] },
    ]);
    errorHandler(zodErr, req, res, next);
    const body = getBody(res);
    expect(body.correlationId).toBeUndefined();
    expect(body.success).toBe(false);
  });

  // ── issue #46: known errors produce appropriate status codes ───────────────
  it('returns HTTP 400 for ZodError (validation error)', () => {
    const req = makeReq();
    const res = makeRes();
    const zodErr = new ZodError([
      { code: ZodIssueCode.too_small, minimum: 1, type: 'string', inclusive: true, message: 'Too short', path: ['name'] },
    ]);
    errorHandler(zodErr, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
    const body = getBody(res);
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
  });

  it('ZodError response contains the first validation message', () => {
    const req = makeReq();
    const res = makeRes();
    const zodErr = new ZodError([
      { code: ZodIssueCode.custom, message: 'wallet is required', path: ['wallet'] },
    ]);
    errorHandler(zodErr, req, res, next);
    const body = getBody(res);
    expect(body.error).toBe('wallet is required');
  });

  // ── issue #46: unexpected errors return HTTP 500 with generic message ──────
  it('returns HTTP 500 for unexpected generic errors', () => {
    const req = makeReq();
    const res = makeRes();
    errorHandler(new Error('unexpected boom'), req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(500);
    const body = getBody(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe('unexpected boom');
  });

  it('returns HTTP 500 for thrown non-Zod errors', () => {
    const req = makeReq();
    const res = makeRes();
    errorHandler(new TypeError('cannot read property of null'), req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(500);
  });

  // ── issue #46: stack hidden in production ─────────────────────────────────
  it('does not include stack trace in the response body', () => {
    const req = makeReq();
    const res = makeRes();
    errorHandler(new Error('private error'), req, res, next);
    const body = getBody(res);
    // Stack must never be exposed in the API response
    expect(body.stack).toBeUndefined();
  });

  it('does not expose stack trace in production environment', () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const req = makeReq();
    const res = makeRes();
    errorHandler(new Error('prod error'), req, res, next);
    const body = getBody(res);
    expect(body.stack).toBeUndefined();
    process.env.NODE_ENV = prevEnv;
  });

  // ── error response shape invariants ────────────────────────────────────────
  it('response always has success: false', () => {
    const req = makeReq();
    const res = makeRes();
    errorHandler(new Error('any'), req, res, next);
    const body = getBody(res);
    expect(body.success).toBe(false);
  });

  // ── issue #882: unexpected error shapes ────────────────────────────────────

  it('returns 404 with message when error has status: 404 and message: "Resource not found"', () => {
    const req = makeReq();
    const res = makeRes();
    const err = Object.assign(new Error('Resource not found'), { status: 404 });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(404);
    const body = getBody(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Resource not found');
  });

  it('returns 500 when error has no status property', () => {
    const req = makeReq();
    const res = makeRes();
    const err = new Error('something unexpected');
    // Confirm no status property exists
    expect((err as unknown as Record<string, unknown>).status).toBeUndefined();
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(500);
    const body = getBody(res);
    expect(body.success).toBe(false);
  });

  it('returns 500 with "Internal Server Error" when error has no message property', () => {
    const req = makeReq();
    const res = makeRes();
    // Error object with message cleared
    const err = new Error('');
    Object.defineProperty(err, 'message', { value: '' });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(500);
    const body = getBody(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Internal Server Error');
  });

  it('returns 500 when a non-Error plain object is passed ({ code: "BROKEN" })', () => {
    const req = makeReq();
    const res = makeRes();
    const plainErr = { code: 'BROKEN' } as unknown as Error;
    expect(() => errorHandler(plainErr, req, res, next)).not.toThrow();
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(500);
    const body = getBody(res);
    expect(body.success).toBe(false);
  });

  it('returns 500 without crashing when null is passed as error', () => {
    const req = makeReq();
    const res = makeRes();
    expect(() => errorHandler(null as unknown as Error, req, res, next)).not.toThrow();
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(500);
    const body = getBody(res);
    expect(body.success).toBe(false);
  });

  it('returns 500 when error has status: 200 (non-error status treated as unexpected)', () => {
    const req = makeReq();
    const res = makeRes();
    const err = Object.assign(new Error('ok but wrong'), { status: 200 });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(500);
    const body = getBody(res);
    expect(body.success).toBe(false);
  });

  // ── issue #1026: proper status-to-code mapping ────────────────────────────────

  it('returns 400 with VALIDATION_ERROR code for validation errors', () => {
    const req = makeReq();
    const res = makeRes();
    const err = Object.assign(new Error('Invalid input'), { status: 400 });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
    const body = getBody(res);
    expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('returns 401 with UNAUTHORIZED code for authentication failures', () => {
    const req = makeReq();
    const res = makeRes();
    const err = Object.assign(new Error('Missing or invalid token'), { status: 401 });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(401);
    const body = getBody(res);
    expect(body.code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('returns 403 with FORBIDDEN code for authorization failures', () => {
    const req = makeReq();
    const res = makeRes();
    const err = Object.assign(new Error('Access denied'), { status: 403 });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(403);
    const body = getBody(res);
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
  });

  it('returns 404 with NOT_FOUND code for missing resources', () => {
    const req = makeReq();
    const res = makeRes();
    const err = Object.assign(new Error('Resource not found'), { status: 404 });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(404);
    const body = getBody(res);
    expect(body.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('returns 409 with CONFLICT code for conflicts', () => {
    const req = makeReq();
    const res = makeRes();
    const err = Object.assign(new Error('Resource already exists'), { status: 409 });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(409);
    const body = getBody(res);
    expect(body.code).toBe(ErrorCode.CONFLICT);
  });

  it('returns 500 with INTERNAL_SERVER_ERROR code for server errors', () => {
    const req = makeReq();
    const res = makeRes();
    const err = Object.assign(new Error('Database connection failed'), { status: 500 });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(500);
    const body = getBody(res);
    expect(body.code).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
  });

  it('preserves explicit error code if already set on error object', () => {
    const req = makeReq();
    const res = makeRes();
    const err = Object.assign(new Error('Custom error'), {
      status: 400,
      code: ErrorCode.PLAYER_NOT_FOUND,
    });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
    const body = getBody(res);
    expect(body.code).toBe(ErrorCode.PLAYER_NOT_FOUND);
  });

  it('uses explicit error code even when status would suggest a different code', () => {
    const req = makeReq();
    const res = makeRes();
    const err = Object.assign(new Error('Subscription required'), {
      status: 403,
      code: ErrorCode.SUBSCRIPTION_REQUIRED,
    });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(403);
    const body = getBody(res);
    expect(body.code).toBe(ErrorCode.SUBSCRIPTION_REQUIRED);
  });

  it('returns INTERNAL_SERVER_ERROR for unknown status codes', () => {
    const req = makeReq();
    const res = makeRes();
    const err = Object.assign(new Error('Teapot'), { status: 418 });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(418);
    const body = getBody(res);
    expect(body.code).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
  });

  it('returns PAYLOAD_TOO_LARGE code for 413 status', () => {
    const req = makeReq();
    const res = makeRes();
    const err = Object.assign(new Error('Payload too large'), { status: 413 });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(413);
    const body = getBody(res);
    expect(body.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('returns UNSUPPORTED_MEDIA_TYPE code for 415 status', () => {
    const req = makeReq();
    const res = makeRes();
    const err = Object.assign(new Error('Unsupported media type'), { status: 415 });
    errorHandler(err, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(415);
    const body = getBody(res);
    expect(body.code).toBe(ErrorCode.UNSUPPORTED_MEDIA_TYPE);
  });

  it('ZodError always returns VALIDATION_ERROR code regardless of other error properties', () => {
    const req = makeReq();
    const res = makeRes();
    const zodErr = new ZodError([
      { code: ZodIssueCode.custom, message: 'Invalid', path: ['field'] },
    ]);
    Object.assign(zodErr, { code: ErrorCode.UNAUTHORIZED });
    errorHandler(zodErr, req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
    const body = getBody(res);
    expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});
