import { Request, Response, NextFunction } from 'express';
import { versionRouting } from '../../src/middleware/versionRouting';

function makeReq(headers: Record<string, string>, originalUrl = '/api/players'): Partial<Request> {
  return { headers, originalUrl, path: originalUrl };
}

describe('versionRouting middleware', () => {
  const res = {} as Response;
  let next: NextFunction;

  beforeEach(() => {
    next = jest.fn();
  });

  it('sets req.apiVersionOverride = 2 when API-Version: 2 is sent', () => {
    const req = makeReq({ 'api-version': '2' }) as Request;
    versionRouting(req, res, next);
    expect(req.apiVersionOverride).toBe(2);
    expect(next).toHaveBeenCalled();
  });

  it('sets req.apiVersionOverride = 1 when API-Version: 1 is sent explicitly', () => {
    const req = makeReq({ 'api-version': '1' }) as Request;
    versionRouting(req, res, next);
    expect(req.apiVersionOverride).toBe(1);
    expect(next).toHaveBeenCalled();
  });

  it('leaves req.apiVersionOverride unset when the header is absent', () => {
    const req = makeReq({}) as Request;
    versionRouting(req, res, next);
    expect(req.apiVersionOverride).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('ignores a non-numeric header value without throwing', () => {
    const req = makeReq({ 'api-version': 'not-a-number' }) as Request;
    expect(() => versionRouting(req, res, next)).not.toThrow();
    expect(req.apiVersionOverride).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('does not set an override for an explicit /api/v2 path (no header sent)', () => {
    const req = makeReq({}, '/api/v2/players') as Request;
    versionRouting(req, res, next);
    expect(req.apiVersionOverride).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});
