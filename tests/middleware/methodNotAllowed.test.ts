import { Request, Response } from 'express';
import request from 'supertest';
import { methodNotAllowed } from '../../src/middleware/methodNotAllowed';
import { ErrorCode } from '../../src/utils/errorCodes';
import app from '../../src/app';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(): Request {
  return {} as Request;
}

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    set: jest.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return res;
    }),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    _headers: headers,
  } as unknown as Response & { _headers: Record<string, string> };
  return res;
}

// ─── Unit tests: methodNotAllowed factory ─────────────────────────────────────

describe('methodNotAllowed — unit', () => {
  describe('Allow header', () => {
    it('sets the Allow header to a comma-joined list of allowed methods', () => {
      const handler = methodNotAllowed(['GET', 'HEAD']);
      const req = makeReq();
      const res = makeRes();

      handler(req, res);

      expect(res.set).toHaveBeenCalledWith('Allow', 'GET, HEAD');
    });

    it('sets Allow header with a single method', () => {
      const handler = methodNotAllowed(['POST']);
      const req = makeReq();
      const res = makeRes();

      handler(req, res);

      expect(res.set).toHaveBeenCalledWith('Allow', 'POST');
    });

    it('sets Allow header with three or more methods', () => {
      const handler = methodNotAllowed(['GET', 'PUT', 'PATCH']);
      const req = makeReq();
      const res = makeRes();

      handler(req, res);

      expect(res.set).toHaveBeenCalledWith('Allow', 'GET, PUT, PATCH');
    });

    it('preserves the exact order of methods in the Allow header', () => {
      const handler = methodNotAllowed(['DELETE', 'GET', 'POST']);
      const req = makeReq();
      const res = makeRes();

      handler(req, res);

      expect(res.set).toHaveBeenCalledWith('Allow', 'DELETE, GET, POST');
    });
  });

  describe('HTTP status', () => {
    it('responds with status 405', () => {
      const handler = methodNotAllowed(['GET']);
      const req = makeReq();
      const res = makeRes();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(405);
    });
  });

  describe('response body', () => {
    it('sets success: false', () => {
      const handler = methodNotAllowed(['GET']);
      const req = makeReq();
      const res = makeRes();

      handler(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(false);
    });

    it('sets error: "Method Not Allowed"', () => {
      const handler = methodNotAllowed(['GET']);
      const req = makeReq();
      const res = makeRes();

      handler(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.error).toBe('Method Not Allowed');
    });

    it('sets code: METHOD_NOT_ALLOWED', () => {
      const handler = methodNotAllowed(['GET']);
      const req = makeReq();
      const res = makeRes();

      handler(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.code).toBe(ErrorCode.METHOD_NOT_ALLOWED);
    });

    it('includes allowedMethods in the body matching the input array', () => {
      const allowed = ['GET', 'HEAD'];
      const handler = methodNotAllowed(allowed);
      const req = makeReq();
      const res = makeRes();

      handler(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.allowedMethods).toEqual(allowed);
    });

    it('full body shape is { success, error, code, allowedMethods }', () => {
      const allowed = ['POST'];
      const handler = methodNotAllowed(allowed);
      const req = makeReq();
      const res = makeRes();

      handler(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body).toEqual({
        success: false,
        error: 'Method Not Allowed',
        code: ErrorCode.METHOD_NOT_ALLOWED,
        allowedMethods: allowed,
      });
    });
  });

  describe('invocation order', () => {
    it('sets the Allow header before calling res.status()', () => {
      const callOrder: string[] = [];
      const handler = methodNotAllowed(['GET']);
      const req = makeReq();
      const res = makeRes();

      (res.set as jest.Mock).mockImplementation(() => {
        callOrder.push('set');
        return res;
      });
      (res.status as jest.Mock).mockImplementation(() => {
        callOrder.push('status');
        return res;
      });

      handler(req, res);

      expect(callOrder[0]).toBe('set');
      expect(callOrder[1]).toBe('status');
    });

    it('calls res.json() exactly once', () => {
      const handler = methodNotAllowed(['GET']);
      const req = makeReq();
      const res = makeRes();

      handler(req, res);

      expect(res.json).toHaveBeenCalledTimes(1);
    });
  });

  describe('edge cases', () => {
    it('handles a single method with no comma in the Allow header', () => {
      const handler = methodNotAllowed(['DELETE']);
      const req = makeReq();
      const res = makeRes();

      handler(req, res);

      expect(res.set).toHaveBeenCalledWith('Allow', 'DELETE');
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.allowedMethods).toEqual(['DELETE']);
    });

    it('returns a new handler function on each factory call (no shared state)', () => {
      const handlerA = methodNotAllowed(['GET']);
      const handlerB = methodNotAllowed(['POST']);

      expect(handlerA).not.toBe(handlerB);

      const resA = makeRes();
      const resB = makeRes();

      handlerA(makeReq(), resA);
      handlerB(makeReq(), resB);

      expect((resA.set as jest.Mock).mock.calls[0]).toEqual(['Allow', 'GET']);
      expect((resB.set as jest.Mock).mock.calls[0]).toEqual(['Allow', 'POST']);
    });

    it('allowedMethods in body is the same array reference passed in', () => {
      const allowed = ['GET', 'HEAD'];
      const handler = methodNotAllowed(allowed);
      const req = makeReq();
      const res = makeRes();

      handler(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      // deep-equal (not same ref after spreading/copying)
      expect(body.allowedMethods).toEqual(allowed);
    });
  });
});

// ─── Route-level integration: DELETE /api/players → 405 Allow: GET, HEAD ─────

describe('methodNotAllowed — route integration', () => {
  it('DELETE /api/players returns 405 with Allow: GET, HEAD', async () => {
    const res = await request(app).delete('/api/players');

    expect(res.status).toBe(405);

    // Body shape
    expect(res.body).toMatchObject({
      success: false,
      error: 'Method Not Allowed',
      code: ErrorCode.METHOD_NOT_ALLOWED,
    });
    expect(res.body.allowedMethods).toEqual(expect.arrayContaining(['GET', 'HEAD']));

    // Allow header
    const allow = res.headers['allow'] as string;
    expect(allow).toMatch(/\bGET\b/);
    expect(allow).toMatch(/\bHEAD\b/);
  });

  it('Allow header and allowedMethods body field are in sync', async () => {
    const res = await request(app).delete('/api/players');

    expect(res.status).toBe(405);

    const headerMethods = (res.headers['allow'] as string)
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);

    expect(headerMethods).toEqual(expect.arrayContaining(res.body.allowedMethods));
    expect(res.body.allowedMethods).toEqual(expect.arrayContaining(headerMethods));
  });
});
