import { Request } from 'express';
import { getParam, getParams } from '../../src/utils/params';

function makeReq(params: Record<string, string | string[]>): Request {
  return { params } as unknown as Request;
}

describe('getParam', () => {
  it('returns a plain string param as-is', () => {
    expect(getParam(makeReq({ id: 'abc123' }), 'id')).toBe('abc123');
  });

  it('returns the first element of an array-valued param', () => {
    expect(getParam(makeReq({ id: ['first', 'second'] }), 'id')).toBe('first');
  });

  it('returns undefined for a missing param', () => {
    expect(getParam(makeReq({}), 'id')).toBeUndefined();
  });
});

describe('getParams', () => {
  it('builds a partial object from multiple string params', () => {
    const req = makeReq({ playerId: 'p1', walletId: 'w1' });
    expect(getParams(req, ['playerId', 'walletId'])).toEqual({ playerId: 'p1', walletId: 'w1' });
  });

  it('resolves array-valued params to their first element', () => {
    const req = makeReq({ playerId: ['p1', 'p2'] });
    expect(getParams(req, ['playerId'])).toEqual({ playerId: 'p1' });
  });

  it('omits keys that are missing from req.params', () => {
    const req = makeReq({ playerId: 'p1' });
    expect(getParams(req, ['playerId', 'walletId'])).toEqual({ playerId: 'p1' });
  });
});
