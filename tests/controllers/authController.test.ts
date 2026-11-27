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
    [
      sep10.Sep10ErrorCode.INVALID_SIGNATURE,
      'Invalid challenge signature',
      'Invalid challenge',
      'TOKEN_INVALID',
    ],
    [
      sep10.Sep10ErrorCode.CHALLENGE_EXPIRED,
      'Challenge has expired',
      'Challenge has expired',
      'TOKEN_EXPIRED',
    ],
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

describe('postToken client_domain (#1514)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('puts the verified client_domain in the JWT and the audit log', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const db = require('../../src/db');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { verifyJwt } = require('../../src/utils/jwt');
    const account = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
    jest
      .spyOn(sep10, 'verifyChallenge')
      .mockReturnValue({ account, clientDomain: 'wallet.example.com' });
    const audit = jest.spyOn(db, 'insertAuditLog').mockResolvedValue(undefined);

    const req = {
      body: { transaction: 'xdr' },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await postToken(req, res, jest.fn() as NextFunction);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(verifyJwt(body.accessToken).client_domain).toBe('wallet.example.com');
    expect(verifyJwt(body.refreshToken).client_domain).toBe('wallet.example.com');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth_token_issued',
        adminWallet: account,
        queryParams: expect.objectContaining({ clientDomain: 'wallet.example.com' }),
      }),
    );
  });
});
