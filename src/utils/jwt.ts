/**
 * JWT signing and dual-key verification helpers.
 *
 * Note: `src/utils/signer.ts` loads the Stellar platform keypair — JWT crypto
 * lives here so rotation logic is shared by REST middleware, GraphQL context,
 * and auth refresh/logout.
 *
 * Rotation model:
 * - New tokens are ALWAYS signed with `config.jwtSecret` (current).
 * - Verification tries the current secret first, then optionally
 *   `config.jwtSecretPrevious` while the grace window is still open
 *   (`JWT_SECRET_PREVIOUS_UNTIL`).
 */

import jwt from 'jsonwebtoken';
import config from '../config';

export type JwtVerifyPayload = jwt.JwtPayload & {
  sub?: string;
  role?: string;
  jti?: string;
  type?: string;
};

/**
 * Whether the previous JWT secret is still within its configured grace window.
 *
 * - No previous secret configured → false
 * - Previous secret set, no `jwtSecretPreviousUntil` → true (open window until
 *   operators clear `JWT_SECRET_PREVIOUS`)
 * - Previous secret set with until timestamp → true only while now < until
 */
export function isPreviousJwtSecretActive(nowMs: number = Date.now()): boolean {
  if (!config.jwtSecretPrevious) return false;
  const until = config.jwtSecretPreviousUntil;
  if (until === null) return true;
  return nowMs < until;
}

/** Ordered secrets to try during verification (current first). */
export function jwtVerificationSecrets(nowMs: number = Date.now()): string[] {
  const secrets = [config.jwtSecret];
  if (isPreviousJwtSecretActive(nowMs)) {
    secrets.push(config.jwtSecretPrevious);
  }
  return secrets;
}

/**
 * Verify a JWT against the current secret, then the previous secret when the
 * grace window is still open. Throws if no secret accepts the token.
 */
export function verifyJwt(token: string, nowMs: number = Date.now()): JwtVerifyPayload {
  const secrets = jwtVerificationSecrets(nowMs);
  let lastError: unknown;
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret) as JwtVerifyPayload;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('Invalid or expired token');
}

/** Same as `verifyJwt` but returns null instead of throwing. */
export function tryVerifyJwt(token: string, nowMs: number = Date.now()): JwtVerifyPayload | null {
  try {
    return verifyJwt(token, nowMs);
  } catch {
    return null;
  }
}

/** Sign a payload with the current JWT secret only. */
export function signJwt(
  payload: string | Buffer | object,
  options?: jwt.SignOptions,
): string {
  return jwt.sign(payload, config.jwtSecret, options);
}
