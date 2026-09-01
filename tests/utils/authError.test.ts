import { Response } from 'express';
import { sendUnauthorized, sendForbidden, AuthErrorPayload } from '../../src/utils/authError';

function makeRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe('sendUnauthorized', () => {
  it('responds 401 with errorCode and message', () => {
    const res = makeRes();
    sendUnauthorized(res, 'Missing auth token');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith<[AuthErrorPayload]>({
      success: false,
      errorCode: 9,
      error: 'Missing auth token',
      code: 'UNAUTHORIZED',
    });
  });

  it('sets the error field to the provided message', () => {
    const res = makeRes();
    sendUnauthorized(res, 'Custom unauthorized message');
    const payload = (res.json as jest.Mock).mock.calls[0][0] as AuthErrorPayload;
    expect(payload.error).toBe('Custom unauthorized message');
  });

  it('calls res.json exactly once', () => {
    const res = makeRes();
    sendUnauthorized(res, 'test');
    expect(res.json).toHaveBeenCalledTimes(1);
  });

  it('does not call next', () => {
    const res = makeRes();
    const next = jest.fn();
    sendUnauthorized(res, 'test');
    expect(next).not.toHaveBeenCalled();
  });

  it('includes reason when provided', () => {
    const res = makeRes();
    sendUnauthorized(res, 'Missing auth token', { detail: 'no header' });
    expect(res.json).toHaveBeenCalledWith<[AuthErrorPayload]>({
      success: false,
      errorCode: 9,
      error: 'Missing auth token',
      code: 'UNAUTHORIZED',
      reason: { detail: 'no header' },
    });
  });

  it('omits reason when not provided', () => {
    const res = makeRes();
    sendUnauthorized(res, 'Invalid or expired token');
    const payload = (res.json as jest.Mock).mock.calls[0][0] as AuthErrorPayload;
    expect('reason' in payload).toBe(false);
  });
});

describe('sendForbidden', () => {
  it('responds 403 with errorCode and message', () => {
    const res = makeRes();
    sendForbidden(res, 'Insufficient permissions');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith<[AuthErrorPayload]>({
      success: false,
      errorCode: 9,
      error: 'Insufficient permissions',
      code: 'FORBIDDEN',
    });
  });

  it('passes through a message containing HTML special characters', () => {
    const res = makeRes();
    const htmlMsg = '<script>alert(\'xss\')</script> & "quoted"';
    sendForbidden(res, htmlMsg);
    const payload = (res.json as jest.Mock).mock.calls[0][0] as AuthErrorPayload;
    expect(payload.error).toBe(htmlMsg);
  });

  it('calls res.json exactly once', () => {
    const res = makeRes();
    sendForbidden(res, 'test');
    expect(res.json).toHaveBeenCalledTimes(1);
  });

  it('does not call next', () => {
    const res = makeRes();
    const next = jest.fn();
    sendForbidden(res, 'test');
    expect(next).not.toHaveBeenCalled();
  });

  it('includes reason when provided', () => {
    const res = makeRes();
    sendForbidden(res, 'Insufficient permissions', { requiredRole: 'admin', providedRole: 'player' });
    expect(res.json).toHaveBeenCalledWith<[AuthErrorPayload]>({
      success: false,
      errorCode: 9,
      error: 'Insufficient permissions',
      code: 'FORBIDDEN',
      reason: { requiredRole: 'admin', providedRole: 'player' },
    });
  });

  it('omits reason when not provided', () => {
    const res = makeRes();
    sendForbidden(res, 'Forbidden: not the profile owner');
    const payload = (res.json as jest.Mock).mock.calls[0][0] as AuthErrorPayload;
    expect('reason' in payload).toBe(false);
  });
});
