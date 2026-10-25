import { Router, type Request } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { getChallenge, postToken, postRefresh, postLogout, tokenSchema, refreshSchema, logoutSchema } from '../controllers/authController';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { methodNotAllowed } from '../middleware/methodNotAllowed';
import { validateBody } from '../middleware/validate';
import { enforceAuthLockout } from '../middleware/authFailureLockout';
import config from '../config';
import { extractAccount } from '../services/sep10';
import { verifyJwt } from '../utils/jwt';

const router = Router();

router.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  next();
});

const authIpRateLimit = (endpoint: string) => rateLimit({
  name: `auth:${endpoint}:ip`,
  windowMs: config.authRateLimit.windowMs,
  max: config.authRateLimit.ipMax,
});

const authAccountRateLimit = (
  endpoint: string,
  keyGenerator: (req: Request) => string | undefined,
) => rateLimit({
  name: `auth:${endpoint}:account`,
  windowMs: config.authRateLimit.windowMs,
  max: config.authRateLimit.max,
  keyGenerator,
});

function challengeAccountKey(req: Request): string | undefined {
  const account = req.query.account;
  if (typeof account !== 'string') return undefined;
  try {
    Keypair.fromPublicKey(account);
    return `account:${account}`;
  } catch {
    return undefined;
  }
}

function tokenAccountKey(req: Request): string | undefined {
  const transaction = (req.body as { transaction?: unknown } | undefined)?.transaction;
  if (typeof transaction !== 'string') return undefined;
  const account = extractAccount(transaction);
  return account ? `account:${account}` : undefined;
}

function refreshAccountKey(req: Request): string | undefined {
  const refreshToken = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  if (typeof refreshToken !== 'string') return undefined;
  try {
    const payload = verifyJwt(refreshToken);
    return payload.type === 'refresh' && typeof payload.sub === 'string'
      ? `account:${payload.sub}`
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GET /auth/challenge
 *
 * Issue a SEP-10-style challenge transaction XDR for the given Stellar
 * account. The client signs it and exchanges it for a token via POST
 * /auth/token.
 *
 * @query account {string} - Stellar public key (G...) to build the challenge for
 * @response 200 { challenge: string, networkPassphrase: string, expiresAt: number }
 * @response 400 { success: false, error: string } - Missing/invalid account
 */
router.route('/challenge')
  .get(authIpRateLimit('challenge'), authAccountRateLimit('challenge', challengeAccountKey), getChallenge)
  .all(methodNotAllowed(['GET']));

/**
 * POST /auth/token
 *
 * Exchange a signed challenge transaction for an access + refresh token
 * pair. The caller's role is derived from the verified account: configured
 * admin wallets always get `admin`, otherwise the requested `role` (default
 * `player`) is used.
 *
 * @body { transaction: string, role?: 'validator' | 'player' | 'scout' } - Signed challenge XDR
 * @response 200 { success: true, token, accessToken, refreshToken, account, expiresAt }
 * @response 400 { success: false, error: string } - Invalid body or malformed XDR
 * @response 401 { success: false, error: string } - Invalid signature or expired challenge
 */
router.route('/token')
  .post(
    authIpRateLimit('token'),
    authAccountRateLimit('token', tokenAccountKey),
    enforceAuthLockout,
    validateBody(tokenSchema),
    postToken,
  )
  .all(methodNotAllowed(['POST']));

/**
 * POST /auth/refresh
 *
 * Exchange a valid refresh token for a new access token + refresh token pair
 * (refresh token rotation). The old refresh token is revoked immediately.
 *
 * @body { refreshToken: string }
 * @response 200 { accessToken, refreshToken, expiresAt }
 * @response 401 { success: false, error } — invalid, expired, or revoked refresh token
 */
router.route('/refresh')
  .post(
    authIpRateLimit('refresh'),
    authAccountRateLimit('refresh', refreshAccountKey),
    validateBody(refreshSchema),
    postRefresh,
  )
  .all(methodNotAllowed(['POST']));

/**
 * POST /auth/logout
 *
 * Revoke the caller's access token and any associated refresh token
 * (identified by the `jti` in the bearer token).
 *
 * @body { refreshToken?: string }
 * @response 200 { success: true }
 * @response 401 — missing/invalid bearer token
 */
router.route('/logout')
  .post(requireAuth, validateBody(logoutSchema), postLogout)
  .all(methodNotAllowed(['POST']));

export default router;
