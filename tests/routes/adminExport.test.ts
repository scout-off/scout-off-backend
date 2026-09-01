import { EventEmitter } from 'events';
import { Request, Response, NextFunction } from 'express';
import { exportEvents } from '../../src/controllers/exportController';

function makeRes() {
  const ee = new EventEmitter();
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  let statusCode = 200;
  let ended = false;
  const res = Object.assign(ee, {
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
    status: jest.fn((code: number) => { statusCode = code; return res; }),
    send: jest.fn((data: string) => { chunks.push(data); return res; }),
    write: jest.fn((chunk: string) => { chunks.push(chunk); return true; }),
    end: jest.fn(() => { ended = true; return res; }),
    json: jest.fn((data: unknown) => { chunks.push(JSON.stringify(data)); return res; }),
    _headers: headers,
    _body: () => chunks.join(''),
  });
  return { res, headers, getBody: () => chunks.join(''), getStatus: () => statusCode, isEnded: () => ended };
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

  it('streams the response via write/end rather than a single send()', async () => {
    const req = {} as Request;
    const { res, isEnded } = makeRes();
    const next = jest.fn() as NextFunction;
    await exportEvents(req, res, next);
    expect((res.write as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(isEnded()).toBe(true);
  });

  it('returns 400 for an invalid startDate query param', async () => {
    const req = { query: { startDate: 'not-a-date' } } as unknown as Request;
    const { res, getStatus } = makeRes();
    const next = jest.fn() as NextFunction;
    await exportEvents(req, res, next);
    expect(getStatus()).toBe(400);
  });

  it('returns 400 when startDate is after endDate', async () => {
    const req = {
      query: { startDate: '2025-12-01T00:00:00.000Z', endDate: '2024-01-01T00:00:00.000Z' },
    } as unknown as Request;
    const { res, getStatus } = makeRes();
    const next = jest.fn() as NextFunction;
    await exportEvents(req, res, next);
    expect(getStatus()).toBe(400);
  });
});
