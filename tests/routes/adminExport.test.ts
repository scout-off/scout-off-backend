import { Request, Response, NextFunction } from 'express';
import { exportEvents } from '../../src/controllers/exportController';

function makeRes() {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  let statusCode = 200;
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    status: jest.fn().mockReturnThis(),
    send: jest.fn((data: string) => {
      body = data;
      return res;
    }),
    _headers: headers,
    _body: () => body,
  } as unknown as Response & { _headers: Record<string, string>; _body: () => string | undefined };
  (res.status as jest.Mock).mockImplementation((code: number) => {
    statusCode = code;
    return res;
  });
  return { res, headers, getBody: () => body, getStatus: () => statusCode };
}

describe('GET /api/admin/events/export', () => {
  it('sets Content-Type to text/csv', async () => {
    const req = {} as Request;
    const { res, headers } = makeRes();
    const next = jest.fn() as NextFunction;
    await exportEvents(req, res, next);
    expect(headers['content-type']).toBe('text/csv');
  });

  it('sets Content-Disposition attachment header', async () => {
    const req = {} as Request;
    const { res, headers } = makeRes();
    const next = jest.fn() as NextFunction;
    await exportEvents(req, res, next);
    expect(headers['content-disposition']).toContain('attachment');
  });

  it('response body contains CSV column headers', async () => {
    const req = {} as Request;
    const { res, getBody } = makeRes();
    const next = jest.fn() as NextFunction;
    await exportEvents(req, res, next);
    const body = getBody() ?? '';
    expect(body).toContain('event_type');
    expect(body).toContain('ledger');
    expect(body).toContain('timestamp');
    expect(body).toContain('payload');
  });

  it('returns 200 status', async () => {
    const req = {} as Request;
    const { res, getStatus } = makeRes();
    const next = jest.fn() as NextFunction;
    await exportEvents(req, res, next);
    expect(getStatus()).toBe(200);
  });
});
