import { Request, Response, NextFunction } from 'express';
import { responseTime } from '../../src/middleware/responseTime';

function makeReqRes() {
  const headers: Record<string, string> = {};

  const req = {} as Request;
  const res = {
    headersSent: false,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    end: (..._args: unknown[]) => {
      res.headersSent = true;
      return res;
    },
    _headers: headers,
  } as unknown as Response & { _headers: Record<string, string> };
  const next = jest.fn() as NextFunction;
  return { req, res, next, headers };
}

describe('responseTime middleware', () => {
  it('calls next()', () => {
    const { req, res, next } = makeReqRes();
    responseTime(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets X-Response-Time header before res.end() completes, with "ms" suffix', () => {
    const { req, res, next, headers } = makeReqRes();
    responseTime(req, res, next);
    res.end();
    expect(headers['x-response-time']).toMatch(/^\d+ms$/);
  });

  it('X-Response-Time value is a non-negative integer', () => {
    const { req, res, next, headers } = makeReqRes();
    responseTime(req, res, next);
    res.end();
    const ms = parseInt(headers['x-response-time'], 10);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it('does not set header before res.end() is called', () => {
    const { req, res, next, headers } = makeReqRes();
    responseTime(req, res, next);
    expect(headers['x-response-time']).toBeUndefined();
  });

  it('does not attempt to set the header if headers were already sent', () => {
    const { req, res, next, headers } = makeReqRes();
    responseTime(req, res, next);
    res.headersSent = true;
    expect(() => res.end()).not.toThrow();
    expect(headers['x-response-time']).toBeUndefined();
  });

  it('forwards arguments and return value to the original res.end', () => {
    const { req, res, next } = makeReqRes();
    responseTime(req, res, next);
    const result = res.end('body', 'utf8' as BufferEncoding);
    expect(result).toBe(res);
  });
});
