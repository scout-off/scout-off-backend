import { Request, Response, NextFunction } from 'express';
import * as sep10 from '../../src/services/sep10';
import { postToken } from '../../src/controllers/authController';

describe('postToken authentication errors', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['Invalid challenge signature', 'TOKEN_INVALID'],
    ['Challenge has expired', 'TOKEN_EXPIRED'],
  ])('returns a machine-readable code for %s', (message, code) => {
    jest.spyOn(sep10, 'verifyAndIssueToken').mockImplementation(() => {
      throw new Error(message);
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

    postToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: message,
      code,
    });
    expect(next).not.toHaveBeenCalled();
  });
});
