import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Keypair } from '@stellar/stellar-sdk';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { buildChallenge, verifyAndIssueToken, extractAccount } from '../services/sep10';
import { logger } from '../utils/logger';
import { extractClientIp } from '../utils/ipExtractor';
import config from '../config';
import { ErrorCode } from '../utils/errorCodes';
import { revokeToken, isTokenRevoked } from '../services/tokenBlocklist';
import { signJwt, verifyJwt } from '../utils/jwt';

// ─── Schema ────────────────────────────────────────────────────────────────────

const challengeSchema = z.object({
  account: z.string().refine(
    (val) => { try { Keypair.fromPublicKey(val); return true; } catch { return false; } },
    { message: 'Invalid Stellar public key' }
  ),
});

const tokenSchema = z.object({
  transaction: z.string().min(1),
  role: z.enum(['player', 'scout', 'validator', 'admin']).optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// ─── Token issuance helpers ────────────────────────────────────────────────────

/**
 * Issue a short-lived access token (JWT_ACCESS_TTL_SECONDS, default 15 min).
 * Includes a unique jti so the token can be individually revoked.
 * Always signed with the *current* JWT_SECRET (never the previous rotation key).
 */
function issueAccessToken(account: string, role: string): { token: string; expiresAt: number } {
  const ttl = config.jwtAccessTtlSeconds;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const token = signJwt(
    { sub: account, role, jti: crypto.randomUUID() },
    { expiresIn: ttl },
  );
  return { token, expiresAt };
}

/**
 * Issue a long-lived refresh token (7-day TTL).
 * Type claim 'refresh' distinguishes it from access tokens so the auth
 * middleware rejects it if someone tries to use it as a bearer token.
 * The jti is stored in the revocation blocklist on rotation / logout.
 * Always signed with the *current* JWT_SECRET.
 */
function issueRefreshToken(account: string, role: string): { token: string; jti: string } {
  const jti = crypto.randomUUID();
  const token = signJwt(
    { sub: account, role, type: 'refresh', jti },
    { expiresIn: config.jwtRefreshTtlSeconds },
  );
  return { token, jti };
}

// ─── GET /auth/challenge ───────────────────────────────────────────────────────

/** GET /auth/challenge?account=G... */
export function getChallenge(req: Request, res: Response, next: NextFunction): void {
  try {
    const parsed = challengeSchema.safeParse(req.query);
    if (!parsed.success) {
      logger.warn('[auth] failed_challenge_request', {
        correlationId: req.correlationId,
        origin: extractClientIp(req),
        attemptedAccount: (req.query.account as string) ?? null,
        reason: parsed.error.errors[0]?.message,
      });
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request', code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const challenge = buildChallenge(parsed.data.account);
    res.json({ challenge, networkPassphrase: config.networkPassphrase });
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/token ──────────────────────────────────────────────────────────

/** POST /auth/token  { transaction: "<signed XDR>", role?: "validator" } */
export function postToken(req: Request, res: Response, next: NextFunction): void {
  try {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn('[auth] failed_token_request invalid_body', {
        correlationId: req.correlationId,
        origin: extractClientIp(req),
        reason: parsed.error.errors[0]?.message,
      });
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request', code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const { transaction, role } = parsed.data;

    // Step 1: verify signatures and get the authenticated account.
    const { account } = verifyAndIssueToken(transaction, role);

    // Step 2: determine the effective role from the cryptographically verified account.
    const isAdmin =
      (config.adminWallet && account === config.adminWallet) ||
      (account !== null && config.adminWallets.includes(account));

    const effectiveRole = isAdmin ? 'admin' : (role ?? 'player');

    // Step 3: issue access token + refresh token pair.
    const { token: accessToken, expiresAt } = issueAccessToken(account, effectiveRole);
    const { token: refreshToken } = issueRefreshToken(account, effectiveRole);

    res.json({ token: accessToken, accessToken, refreshToken, account, expiresAt });
  } catch (err) {
    if (err instanceof Error) {
      const knownAuthErrors = [
        'Invalid challenge signature',
        'Missing source account in challenge',
        'Challenge has expired',
      ];
      if (knownAuthErrors.includes(err.message)) {
        let attemptedWallet: string | null = null;
        try { attemptedWallet = extractAccount((req.body as { transaction?: string }).transaction ?? ''); } catch { /* not extractable */ }
        logger.warn('[auth] failed_token_exchange', {
          correlationId: req.correlationId,
          origin: extractClientIp(req),
          attemptedWallet,
          reason: err.message,
        });
        res.status(401).json({ success: false, error: err.message });
        return;
      }
      logger.warn('[auth] failed_token_request malformed_xdr', {
        correlationId: req.correlationId,
        origin: extractClientIp(req),
        reason: err.message,
      });
      res.status(400).json({ success: false, error: err.message, code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    next(err);
  }
}

// ─── POST /auth/refresh ────────────────────────────────────────────────────────

/**
 * POST /auth/refresh
 *
 * Accepts a valid refresh token, verifies it, checks it is not revoked,
 * issues a new access + refresh token pair, and revokes the old refresh jti.
 */
export async function postRefresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? 'refreshToken is required',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    const { refreshToken } = parsed.data;

    // Verify signature and decode claims (current secret, then previous within grace window).
    let payload: jwt.JwtPayload;
    try {
      payload = verifyJwt(refreshToken);
    } catch (err) {
      logger.warn('[auth] refresh_token_invalid', { reason: err instanceof Error ? err.message : String(err) });
      res.status(401).json({ success: false, error: 'Invalid or expired refresh token' });
      return;
    }

    // Must carry type:'refresh' to prevent access tokens being used here.
    if (payload.type !== 'refresh') {
      res.status(401).json({ success: false, error: 'Token is not a refresh token' });
      return;
    }

    const jti = payload.jti;
    const account = payload.sub;
    const role = payload.role as string | undefined;

    if (!jti || !account) {
      res.status(401).json({ success: false, error: 'Malformed refresh token' });
      return;
    }

    // Check revocation blocklist.
    if (await isTokenRevoked(jti)) {
      logger.warn('[auth] refresh_token_revoked', { jti });
      res.status(401).json({ success: false, error: 'Refresh token has been revoked' });
      return;
    }

    // Rotate: revoke old refresh token jti immediately.
    const expiresAtSeconds = payload.exp ?? Math.floor(Date.now() / 1000) + config.jwtRefreshTtlSeconds;
    revokeToken(jti, expiresAtSeconds);

    // Issue new pair.
    const { token: newAccessToken, expiresAt } = issueAccessToken(account, role ?? 'player');
    const { token: newRefreshToken } = issueRefreshToken(account, role ?? 'player');

    res.json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt,
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/logout ─────────────────────────────────────────────────────────

const logoutSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

/**
 * POST /auth/logout
 *
 * Revokes the caller's access token jti (from the bearer header) and,
 * if a refreshToken body param is provided, its jti too.
 */
export function postLogout(req: Request, res: Response, next: NextFunction): void {
  try {
    // The access token is already verified by requireAuth middleware.
    // We need to revoke its jti.
    const header = req.headers.authorization ?? '';
    const rawAccessToken = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (rawAccessToken) {
      try {
        const decoded = jwt.decode(rawAccessToken) as jwt.JwtPayload | null;
        if (decoded?.jti && decoded.exp) {
          revokeToken(decoded.jti, decoded.exp);
        }
      } catch {
        // Best-effort — don't fail the logout
      }
    }

    // Optionally revoke the refresh token too.
    const parsed = logoutSchema.safeParse(req.body);
    if (parsed.success && parsed.data.refreshToken) {
      try {
        const rtPayload = verifyJwt(parsed.data.refreshToken);
        if (rtPayload.jti && rtPayload.exp && rtPayload.type === 'refresh') {
          revokeToken(rtPayload.jti, rtPayload.exp);
        }
      } catch {
        // Invalid refresh token on logout — that's fine, just ignore it.
        logger.debug('[auth] logout: could not verify refresh token (already expired or invalid)');
      }
    }

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}
