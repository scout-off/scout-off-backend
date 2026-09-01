jest.mock('../../src/graphql/loaders', () => ({
  createLoaders: jest.fn().mockReturnValue({ loaders: 'stub' }),
}));

jest.mock('../../src/services/tokenBlocklist', () => ({
  isTokenRevoked: jest.fn(),
}));

jest.mock('../../src/utils/jwt', () => ({
  tryVerifyJwt: jest.fn(),
}));

jest.mock('../../src/controllers/apiKeyController', () => ({
  resolveApiKey: jest.fn(),
}));

jest.mock('../../src/db', () => ({
  touchApiKeyLastUsed: jest.fn().mockResolvedValue(undefined),
}));

import { createContext } from '../../src/graphql/context';
import { isTokenRevoked } from '../../src/services/tokenBlocklist';
import { tryVerifyJwt } from '../../src/utils/jwt';
import { resolveApiKey } from '../../src/controllers/apiKeyController';

const mockIsTokenRevoked = isTokenRevoked as jest.Mock;
const mockTryVerifyJwt = tryVerifyJwt as jest.Mock;
const mockResolveApiKey = resolveApiKey as jest.Mock;

function makeReq(headers: Record<string, string>): any {
  return { headers, path: '/graphql' };
}

describe('GraphQL createContext auth resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTokenRevoked.mockResolvedValue(false);
  });

  it('resolves an X-API-Key into account/role scout with scopes', async () => {
    mockResolveApiKey.mockResolvedValue({
      scout_wallet: 'GSCOUT1',
      id: 42,
      scopes: ['players:read'],
    });

    const ctx = await createContext({ req: makeReq({ 'x-api-key': 'raw-key' }) });

    expect(ctx.account).toBe('GSCOUT1');
    expect(ctx.role).toBe('scout');
    expect(ctx.apiKeyScopes).toEqual(['players:read']);
  });

  it('resolves a valid Bearer JWT into account/role with undefined scopes', async () => {
    mockTryVerifyJwt.mockReturnValue({ sub: 'GPLAYER1', role: 'validator', jti: 'jti-1' });

    const ctx = await createContext({ req: makeReq({ authorization: 'Bearer good-token' }) });

    expect(ctx.account).toBe('GPLAYER1');
    expect(ctx.role).toBe('validator');
    expect(ctx.apiKeyScopes).toBeUndefined();
  });

  it('treats a revoked jti as anonymous', async () => {
    mockTryVerifyJwt.mockReturnValue({ sub: 'GPLAYER1', role: 'validator', jti: 'revoked-jti' });
    mockIsTokenRevoked.mockResolvedValue(true);

    const ctx = await createContext({ req: makeReq({ authorization: 'Bearer revoked-token' }) });

    expect(ctx.account).toBeUndefined();
    expect(ctx.role).toBeUndefined();
    expect(ctx.apiKeyScopes).toBeUndefined();
  });

  it('is anonymous with no credentials', async () => {
    const ctx = await createContext({ req: makeReq({}) });

    expect(ctx.account).toBeUndefined();
    expect(ctx.role).toBeUndefined();
    expect(ctx.apiKeyScopes).toBeUndefined();
  });

  it('is anonymous when the JWT is invalid', async () => {
    mockTryVerifyJwt.mockReturnValue(null);

    const ctx = await createContext({ req: makeReq({ authorization: 'Bearer bad-token' }) });

    expect(ctx.account).toBeUndefined();
    expect(ctx.role).toBeUndefined();
  });

  it('prefers the API key over a Bearer header when both are present', async () => {
    mockResolveApiKey.mockResolvedValue({
      scout_wallet: 'GSCOUT1',
      id: 42,
      scopes: null,
    });
    mockTryVerifyJwt.mockReturnValue({ sub: 'GPLAYER1', role: 'validator', jti: 'jti-1' });

    const ctx = await createContext({
      req: makeReq({ 'x-api-key': 'raw-key', authorization: 'Bearer good-token' }),
    });

    expect(ctx.account).toBe('GSCOUT1');
    expect(ctx.role).toBe('scout');
    expect(mockTryVerifyJwt).not.toHaveBeenCalled();
  });
});
