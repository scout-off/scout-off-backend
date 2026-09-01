import { Router } from 'express';
import { getChallenge, postToken, postRefresh, postLogout, tokenSchema, refreshSchema, logoutSchema } from '../controllers/authController';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { methodNotAllowed } from '../middleware/methodNotAllowed';
import { validateBody } from '../middleware/validate';
import config from '../config';

const router = Router();

const authRateLimit = rateLimit({
  name: 'auth',
  windowMs: config.authRateLimit.windowMs,
  max: config.authRateLimit.max,
});

/**
 * GET /auth/challenge
 *
 * Issue a SEP-10-style challenge transaction XDR for the given Stellar
 * account. The client signs it and exchanges it for a token via POST
 * /auth/token.
 *
 * @query account {string} - Stellar public key (G...) to build the challenge for
 * @response 200 { challenge: string, networkPassphrase: string }
 * @response 400 { success: false, error: string } - Missing/invalid account
 */
router.route('/challenge')
  .get(authRateLimit, getChallenge)
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
 * @response 200 { token, accessToken, refreshToken, account, expiresAt }
 * @response 400 { success: false, error: string } - Invalid body or malformed XDR
 * @response 401 { success: false, error: string } - Invalid signature or expired challenge
 */
router.route('/token')
  .post(authRateLimit, validateBody(tokenSchema), postToken)
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
  .post(authRateLimit, validateBody(refreshSchema), postRefresh)
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
