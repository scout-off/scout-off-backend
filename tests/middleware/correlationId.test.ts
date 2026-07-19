import { Request, Response, NextFunction } from 'express';
import { correlationId } from '../../src/middleware/correlationId';

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers, method: 'GET', path: '/test' } as unknown as Request;
}

function makeRes(): { headers: Record<string, string>; setHeader: jest.Mock } {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: jest.fn((k, v) => {
      headers[k] = v;
    }),
  };
}

describe('correlationId middleware', () => {
  it('generates a UUID when no header is present', () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    correlationId(req as Request, res as unknown as Response, next);
    expect(req.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['X-Correlation-ID']).toBe(req.correlationId);
    expect(next).toHaveBeenCalled();
  });

  it('uses incoming X-Correlation-ID header when provided', () => {
    const req = makeReq({ 'x-correlation-id': 'my-custom-id' });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    correlationId(req as Request, res as unknown as Response, next);
    expect(req.correlationId).toBe('my-custom-id');
    expect(res.headers['X-Correlation-ID']).toBe('my-custom-id');
  });
});
