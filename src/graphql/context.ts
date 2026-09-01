/**
 * GraphQL request context factory.
 *
 * Extracts the JWT from the Authorization header (same logic as the REST
 * requireAuth middleware) or an X-API-Key header (same resolution as the
 * REST API-key path) and populates ctx.account + ctx.role + ctx.apiKeyScopes
 * so resolvers can enforce auth the same way the REST layer does (#1019).
 *
 * A fresh set of DataLoaders is created per request so batching is scoped
 * correctly.
 */

import { Request } from 'express';
import { createLoaders, type RequestLoaders } from './loaders';
import { isTokenRevoked } from '../services/tokenBlocklist';
import { logger } from '../utils/logger';
import { tryVerifyJwt } from '../utils/jwt';

export interface GraphQLContext {
  account: string | undefined;
  role: string | undefined;
  /**
   * Parsed API-key scopes when the request was authenticated with an
   * X-API-Key. `null` = legacy/unrestricted key; `undefined` = request was
   * not authenticated with an API key (JWT or anonymous). Resolvers enforce
   * the shared scope contract through src/utils/apiKeyScopes.ts.
   */
  apiKeyScopes: string[] | null | undefined;
  loaders: RequestLoaders;
  /** Raw Express request, available to resolvers that need it. */
  req: Request;
}

/**
 * Resolve an X-API-Key header exactly like the REST auth middleware does
 * (same resolveApiKey + touchApiKeyLastUsed path), so the two surfaces can
 * never drift apart. Returns the authenticated context fields, or null when
 * the key is invalid/revoked.
 */
async function resolveApiKeyRequest(
  req: Request,
): Promise<{ account: string; role: string; apiKeyScopes: string[] | null } | null> {
  const apiKeyHeader = req.headers['x-api-key'];
  if (!apiKeyHeader || typeof apiKeyHeader !== 'string') return null;
  try {
    // Lazy require mirrors middleware/auth.ts — avoids a circular module
    // dependency at load time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveApiKey } = require('../controllers/apiKeyController') as {
      resolveApiKey: (rawKey: string) => Promise<{
        scout_wallet: string;
        id: number;
        scopes: string[] | null;
      } | null>;
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { touchApiKeyLastUsed } = require('../db') as {
      touchApiKeyLastUsed: (id: number) => Promise<void>;
    };
    const resolved = await resolveApiKey(apiKeyHeader);
    if (!resolved) {
      logger.warn({ path: req.path, error: 'graphql: invalid or revoked API key' });
      return null;
    }
    Promise.resolve(touchApiKeyLastUsed(resolved.id)).catch(() => { /* best-effort */ });
    return {
      account: resolved.scout_wallet,
      role: 'scout',
      apiKeyScopes: resolved.scopes,
    };
  } catch (err) {
    logger.warn({ path: req.path, error: 'graphql: API key auth error' }, err);
    return null;
  }
}

/**
 * Builds the GraphQL context for every request.
 * Called by graphql-yoga's `context` option.
 */
export async function createContext({ req }: { req: Request }): Promise<GraphQLContext> {
  const loaders = createLoaders();

  // ── X-API-Key path (mirrors REST requireAuth) ─────────────────────────────
  const apiKeyAuth = await resolveApiKeyRequest(req);
  if (apiKeyAuth) {
    return { ...apiKeyAuth, loaders, req };
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    logger.debug({ path: req.path, msg: 'graphql: no bearer token' });
    return { account: undefined, role: undefined, apiKeyScopes: undefined, loaders, req };
  }

  const token = header.slice(7);
  const payload = tryVerifyJwt(token);
  if (!payload) {
    logger.debug({ path: req.path, msg: 'graphql: invalid jwt' });
    return { account: undefined, role: undefined, apiKeyScopes: undefined, loaders, req };
  }

  if (payload.jti && (await isTokenRevoked(payload.jti))) {
    logger.debug({ path: req.path, msg: 'graphql: revoked token' });
    return { account: undefined, role: undefined, apiKeyScopes: undefined, loaders, req };
  }

  return {
    account: payload.sub,
    role: payload.role,
    apiKeyScopes: undefined,
    loaders,
    req,
  };
}