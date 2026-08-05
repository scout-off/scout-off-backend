import { Router } from 'express';
import { getChallenge, postToken, postRefresh, postLogout } from '../controllers/authController';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { methodNotAllowed } from '../middleware/methodNotAllowed';
import config from '../config';

const router = Router();

const authRateLimit = rateLimit({
  name: 'auth',
  windowMs: config.authRateLimit.windowMs,
  max: config.authRateLimit.max,
});

router.route('/challenge')
  .get(authRateLimit, getChallenge)
  .all(methodNotAllowed(['GET']));

router.route('/token')
  .post(authRateLimit, postToken)
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
  .post(authRateLimit, postRefresh)
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
  .post(requireAuth, postLogout)
  .all(methodNotAllowed(['POST']));

export default router;
