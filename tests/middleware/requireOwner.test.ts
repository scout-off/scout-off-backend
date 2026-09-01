import { Request, Response, NextFunction } from 'express';
import {
  requireOwner,
  requireWalletOwner,
  checkWalletOwnership,
  isOwner,
} from '../../src/middleware/requireOwner';

function makeReqRes(account: string | undefined, playerId: string) {
  const req = { params: { playerId }, account } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

function makeWalletReqRes(
  account: string | undefined,
  wallet: string | undefined,
  role?: string,
) {
  const req = {
    params: wallet !== undefined ? { wallet } : {},
    account,
    role,
  } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

// A real Stellar public key so the middleware's address validation passes.
const VALID_WALLET = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';

describe('isOwner', () => {
  it('returns true when account matches targetId', () => {
    expect(isOwner('GPLAYER1', 'GPLAYER1')).toBe(true);
  });

  it('returns false when account does not match', () => {
    expect(isOwner('GPLAYER1', 'GPLAYER2')).toBe(false);
  });

  it('returns false when account is undefined', () => {
    expect(isOwner(undefined, 'GPLAYER1')).toBe(false);
  });
});

describe('requireOwner middleware', () => {
  it('calls next() when account matches playerId', () => {
    const { req, res, next } = makeReqRes('GPLAYER1', 'GPLAYER1');
    requireOwner(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 when account does not match playerId', () => {
    const { req, res, next } = makeReqRes('GPLAYER1', 'GPLAYER2');
    requireOwner(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when account is undefined', () => {
    const { req, res, next } = makeReqRes(undefined, 'GPLAYER1');
    requireOwner(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('checkWalletOwnership', () => {
  it('returns true when JWT wallet matches req.params.wallet', () => {
    const { req, res } = makeWalletReqRes(VALID_WALLET, VALID_WALLET);
    expect(checkWalletOwnership(req, res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns false and sends 403 when JWT wallet does NOT match req.params.wallet', () => {
    const { req, res } = makeWalletReqRes(VALID_WALLET, 'GDCTMZJTRZWFS74OKS6Z2GPJ3NCLJSUBGFI6FM7L3U3GM66F5UN2W4IT');
    expect(checkWalletOwnership(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Forbidden: wallet does not match authenticated account' }),
    );
  });

  it('returns true for admin role regardless of wallet match', () => {
    const { req, res } = makeWalletReqRes('GADMIN', 'GDIFFERENT', 'admin');
    expect(checkWalletOwnership(req, res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns false and sends 403 when req.params.wallet is missing', () => {
    const { req, res } = makeWalletReqRes(VALID_WALLET, undefined);
    expect(checkWalletOwnership(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns false and sends 400 for a malformed wallet address', () => {
    const { req, res } = makeWalletReqRes(VALID_WALLET, 'not-a-valid-address');
    expect(checkWalletOwnership(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Invalid Stellar address' }),
    );
  });

  it('returns false and sends 401 when req.account is missing (unauthenticated)', () => {
    const { req, res } = makeWalletReqRes(undefined, VALID_WALLET);
    expect(checkWalletOwnership(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'UNAUTHORIZED' }),
    );
  });

  it('sends 401 instead of 403 on mismatch when mismatchStatus is 401', () => {
    const { req, res } = makeWalletReqRes(VALID_WALLET, 'GDCTMZJTRZWFS74OKS6Z2GPJ3NCLJSUBGFI6FM7L3U3GM66F5UN2W4IT');
    expect(checkWalletOwnership(req, res, { mismatchStatus: 401 })).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'UNAUTHORIZED' }),
    );
  });
});

describe('requireWalletOwner middleware', () => {
  it('calls next() when JWT wallet matches req.params.wallet', () => {
    const { req, res, next } = makeWalletReqRes(VALID_WALLET, VALID_WALLET);
    requireWalletOwner()(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 when JWT wallet does NOT match req.params.wallet', () => {
    const { req, res, next } = makeWalletReqRes(VALID_WALLET, 'GDCTMZJTRZWFS74OKS6Z2GPJ3NCLJSUBGFI6FM7L3U3GM66F5UN2W4IT');
    requireWalletOwner()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Forbidden: wallet does not match authenticated account' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for admin role regardless of wallet match', () => {
    const { req, res, next } = makeWalletReqRes('GADMIN', 'GDIFFERENT', 'admin');
    requireWalletOwner()(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 when req.params.wallet is missing', () => {
    const { req, res, next } = makeWalletReqRes(VALID_WALLET, undefined);
    requireWalletOwner()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed wallet address', () => {
    const { req, res, next } = makeWalletReqRes(VALID_WALLET, 'not-a-valid-address');
    requireWalletOwner()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Invalid Stellar address' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when req.account is missing (unauthenticated)', () => {
    const { req, res, next } = makeWalletReqRes(undefined, VALID_WALLET);
    requireWalletOwner()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 on mismatch when mismatchStatus: 401 is configured', () => {
    const { req, res, next } = makeWalletReqRes(VALID_WALLET, 'GDCTMZJTRZWFS74OKS6Z2GPJ3NCLJSUBGFI6FM7L3U3GM66F5UN2W4IT');
    requireWalletOwner({ mismatchStatus: 401 })(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
