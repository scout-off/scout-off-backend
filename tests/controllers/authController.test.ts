import { Request, Response, NextFunction } from 'express';
import * as sep10 from '../../src/services/sep10';
import { postToken } from '../../src/controllers/authController';

describe('postToken authentication errors', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // verifyChallenge throws Sep10Error; the client sees the generic mapped
  // message (getErrorMapping), never the detailed server-side reason.
  it.each([
    [sep10.Sep10ErrorCode.INVALID_SIGNATURE, 'Invalid challenge signature', 'Invalid challenge', 'TOKEN_INVALID'],
    [sep10.Sep10ErrorCode.CHALLENGE_EXPIRED, 'Challenge has expired', 'Challenge has expired', 'TOKEN_EXPIRED'],
  ])('returns a machine-readable code for %s', async (sep10Code, reason, message, code) => {
    jest.spyOn(sep10, 'verifyChallenge').mockImplementation(() => {
      throw new sep10.Sep10Error(sep10Code, reason);
    });

    const req = {
      body: { transaction: 'invalid-xdr' },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next = jest.fn() as NextFunction;

    await postToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: message,
      code,
    });
    expect(next).not.toHaveBeenCalled();
  });
});
