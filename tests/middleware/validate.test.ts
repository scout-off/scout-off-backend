import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateBody, validateQuery } from '../../src/middleware/validate';

// ─── Schemas (mirrors production schemas to avoid importing broken controllers)

const registerSchema = z.object({
  wallet: z.string().min(56).max(56),
  position: z.string().min(1),
  region: z.string().min(1),
  metadata: z.record(z.unknown()),
});

const milestoneSchema = z.object({
  playerId: z.string().min(1),
  milestoneType: z.enum(['identity', 'performance', 'trial_offer']),
  evidenceUri: z.string().min(1),
});

const adminQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBodyReq(body: unknown) {
  return { body, headers: { 'content-type': 'application/json' } } as unknown as Request;
}

function makeQueryReq(query: unknown) {
  return { query } as unknown as Request;
}

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

// ─── validateBody — player registration schema ────────────────────────────────

describe('validateBody — player registerSchema', () => {
  const middleware = validateBody(registerSchema);

  it('calls next() for a valid body', () => {
    const req = makeBodyReq({ wallet: 'G'.repeat(56), position: 'striker', region: 'Africa', metadata: {} });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty body', () => {
    const req = makeBodyReq({});
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when wallet is missing', () => {
    const req = makeBodyReq({ position: 'striker', region: 'Africa', metadata: {} });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when wallet is too short', () => {
    const req = makeBodyReq({ wallet: 'GSHORT', position: 'striker', region: 'Africa', metadata: {} });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when position is empty string', () => {
    const req = makeBodyReq({ wallet: 'G'.repeat(56), position: '', region: 'Africa', metadata: {} });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('error response includes a descriptive message', () => {
    const req = makeBodyReq({});
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    const jsonArg = (res.json as jest.Mock).mock.calls[0][0];
    expect(jsonArg.success).toBe(false);
    expect(typeof jsonArg.error).toBe('string');
    expect(jsonArg.error.length).toBeGreaterThan(0);
  });

  it('returns 415 when a body is sent with a missing Content-Type, before Zod validation runs', () => {
    const req = {
      body: { wallet: 'G'.repeat(56), position: 'striker', region: 'Africa', metadata: {} },
      headers: { 'content-length': '123' },
    } as unknown as Request;
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(415);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 415 when a body is sent with a non-JSON Content-Type', () => {
    const req = {
      body: { wallet: 'G'.repeat(56), position: 'striker', region: 'Africa', metadata: {} },
      headers: { 'content-length': '123', 'content-type': 'text/plain' },
    } as unknown as Request;
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(415);
    const jsonArg = (res.json as jest.Mock).mock.calls[0][0];
    expect(jsonArg.error).toBe('Content-Type must be application/json');
    expect(next).not.toHaveBeenCalled();
  });

  it('does not require a Content-Type when the request carries no body', () => {
    // Some JSON-validated routes accept a body-less request (e.g. an all-optional
    // schema) — the 415 check must not block those.
    const req = { body: undefined, headers: {} } as unknown as Request;
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400); // still fails Zod (wallet required), but not 415
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── validateBody — milestone submission schema ───────────────────────────────

describe('validateBody — milestoneSchema', () => {
  const middleware = validateBody(milestoneSchema);

  it('calls next() for a valid milestone body', () => {
    const req = makeBodyReq({ playerId: 'player-1', milestoneType: 'performance', evidenceUri: 'ipfs://Qm123' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for an empty body', () => {
    const req = makeBodyReq({});
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid milestoneType', () => {
    const req = makeBodyReq({ playerId: 'p1', milestoneType: 'unknown', evidenceUri: 'ipfs://x' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when evidenceUri is missing', () => {
    const req = makeBodyReq({ playerId: 'p1', milestoneType: 'identity' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── validateQuery — admin query schema ──────────────────────────────────────

describe('validateQuery — admin stats query', () => {
  const middleware = validateQuery(adminQuerySchema);

  it('calls next() for valid query params', () => {
    const req = makeQueryReq({ page: '1', pageSize: '10' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls next() for empty query (uses defaults)', () => {
    const req = makeQueryReq({});
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when page is zero', () => {
    const req = makeQueryReq({ page: '0' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when pageSize exceeds max', () => {
    const req = makeQueryReq({ pageSize: '200' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
