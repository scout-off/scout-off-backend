import { Request, Response, NextFunction } from 'express';
import z from 'zod';
import jwt from 'jsonwebtoken';
import { revokeToken, isTokenRevoked } from '../services/tokenBlocklist';
import { ErrorCode } from '../utils/errorCodes';

export const revokeTokenSchema = z.object({
  jti: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
}).strict().refine((d) => !!d.jti || !!d.token, { message: 'jti or token is required' });

/** POST /api/admin/tokens/revoke */
export async function revokeTokenController(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = revokeTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'jti or token is required', code: ErrorCode.VALIDATION_ERROR });
    return;
  }

  const defaultExpiresAt = Math.floor(Date.now() / 1000) + 86400;
  let jti = parsed.data.jti;
  let expiresAt = defaultExpiresAt;

  if (!jti && parsed.data.token) {
    const decoded = jwt.decode(parsed.data.token) as jwt.JwtPayload | null;
    if (!decoded?.jti) {
      res.status(400).json({ success: false, error: 'Token does not contain a jti claim', code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    jti = decoded.jti;
    expiresAt = decoded.exp ?? defaultExpiresAt;
  }

  revokeToken(jti as string, expiresAt);
  res.json({ success: true, data: { jti } });
}

/**
 * POST /api/admin/introspect
 *
 * Decodes the caller's OWN bearer token (from the Authorization header) only.
 * Any `token` field in the request body is intentionally ignored — accepting
 * an arbitrary token there would let an admin introspect another user's
 * claims (#279).
 */
export async function introspectToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  // requireRole('admin') has already verified this header's token.
  // Any `token` field in the request body is intentionally ignored — accepting
  // an arbitrary token there would let an admin introspect another user's
  // claims (#279).
  const callerToken = (req.headers.authorization ?? '').slice(7);
  const payload = jwt.decode(callerToken) as jwt.JwtPayload | null;
  if (!payload) {
    res.status(400).json({ success: false, error: 'Invalid or expired token', code: ErrorCode.TOKEN_INVALID });
    return;
  }

  // Revocation check — only meaningful when the token carries a jti claim.
  const revoked = payload.jti ? isTokenRevoked(payload.jti) : false;

  // A token is valid when it has not expired AND has not been revoked.
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = payload.exp !== undefined ? payload.exp <= nowSec : false;
  const valid = !expired && !revoked;

  // Human-readable ISO 8601 timestamps (supplementary — tests do not require these).
  const iatIso = payload.iat !== undefined ? new Date(payload.iat * 1000).toISOString() : undefined;
  const expIso = payload.exp !== undefined ? new Date(payload.exp * 1000).toISOString() : undefined;

  res.json({
    success: true,
    data: {
      // Fields required by existing tests — kept at the top level of data.
      sub: payload.sub,
      role: payload.role,
      iat: payload.iat,
      exp: payload.exp,
      // Supplementary fields added by this issue.
      valid,
      ...(revoked && { revoked: true }),
      ...(iatIso !== undefined && { iatIso }),
      ...(expIso !== undefined && { expIso }),
    },
  });
}
