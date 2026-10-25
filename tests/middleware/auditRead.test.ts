import { EventEmitter } from 'events';
import { NextFunction, Request, Response } from 'express';
import config from '../../src/config';
import { auditRead } from '../../src/middleware/auditRead';
import { logAuditEvent } from '../../src/services/audit';
import { logger } from '../../src/utils/logger';

jest.mock('../../src/services/audit', () => ({
  logAuditEvent: jest.fn(async () => undefined),
}));

const mockLogAuditEvent = logAuditEvent as jest.MockedFunction<typeof logAuditEvent>;

type FakeResponse = Response & EventEmitter;

function fakeRequest(overrides: Partial<Request> = {}): Request {
  return {
    account: 'GADMIN',
    role: 'admin',
    method: 'GET',
    originalUrl: '/api/admin/audit/trail?token=should-not-be-logged',
    path: '/api/admin/audit/trail',
    ip: '203.0.113.5',
    params: {},
    ...overrides,
  } as unknown as Request;
}

function runMiddleware(
  req: Request,
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  statusCode = 200,
): { res: FakeResponse; next: jest.Mock } {
  const res = new EventEmitter() as FakeResponse;
  res.statusCode = statusCode;
  const next = jest.fn();
  middleware(req, res, next as unknown as NextFunction);
  res.emit('finish');
  return { res, next };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('auditRead middleware (#1531)', () => {
  const originalEnabled = config.auditReads.enabled;

  beforeEach(() => {
    config.auditReads.enabled = true;
    mockLogAuditEvent.mockClear();
    mockLogAuditEvent.mockResolvedValue(undefined);
  });

  afterAll(() => {
    config.auditReads.enabled = originalEnabled;
  });

  it('records actor, role, target and correlation id on a 2xx response', async () => {
    const req = fakeRequest({
      params: { playerId: 'player-1' } as unknown as Request['params'],
      account: 'GSCOUT',
      role: 'scout',
    });

    const { next } = runMiddleware(
      req,
      auditRead('scout_note', (r) => `${r.account}/${r.params.playerId}`),
    );

    expect(next).toHaveBeenCalledTimes(1);
    await flush();

    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    const event = mockLogAuditEvent.mock.calls[0][0];
    expect(event.action).toBe('read:scout_note');
    expect(event.adminWallet).toBe('GSCOUT');
    expect(event.queryParams).toEqual(
      expect.objectContaining({
        actor: 'GSCOUT',
        role: 'scout',
        target: 'GSCOUT/player-1',
        method: 'GET',
        path: '/api/admin/audit/trail',
        ip: '203.0.113.5',
      }),
    );
    // The query string (which may carry secrets) and response body never leak.
    expect(JSON.stringify(event)).not.toContain('should-not-be-logged');
  });

  it.each([400, 401, 403, 404, 500])(
    'does not record a %i response',
    async (status) => {
      runMiddleware(fakeRequest(), auditRead('admin_audit_trail'), status);
      await flush();
      expect(mockLogAuditEvent).not.toHaveBeenCalled();
    },
  );

  it('does nothing when AUDIT_READS_ENABLED is off', async () => {
    config.auditReads.enabled = false;
    runMiddleware(fakeRequest(), auditRead('admin_audit_trail'));
    await flush();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('never fails the request when the audit write fails', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockLogAuditEvent.mockRejectedValueOnce(new Error('db down'));

    const { next } = runMiddleware(fakeRequest(), auditRead('admin_audit_trail'));
    await flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
