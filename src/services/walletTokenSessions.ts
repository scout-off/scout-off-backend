/**
 * Service: wallet token sessions.
 *
 * Higher-level operations over wallet_token_sessions + the revocation
 * blocklist:
 *   - record a refresh-token session at issue time
 *   - mark the previous jti as superseded on /auth/refresh rotation
 *   - enumerate a wallet's active sessions
 *   - revoke-all: block every active jti (Redis pipeline) and set the
 *     per-wallet `tokens_valid_after` cutoff so access tokens issued before
 *     it are rejected by requireAuth even before they expire
 */
import { logger } from '../utils/logger';
import {
  recordTokenSession,
  markTokenSuperseded,
  revokeSessions,
  getActiveSessions,
  setTokensValidAfter,
  getTokensValidAfter as dbGetTokensValidAfter,
} from '../db';
import { revokeTokens } from './tokenBlocklist';

export interface ActiveSession {
  jti: string;
  wallet: string;
  issuedAt: number;
  expiresAt: number;
  userAgent: string | null;
  ipHash: string | null;
}

/** Record a newly issued refresh-token session. Never throws — failures are logged. */
export async function trackTokenSession(p: {
  jti: string;
  wallet: string;
  issuedAt: number;
  expiresAt: number;
  userAgent?: string | null;
  ipHash?: string | null;
}): Promise<void> {
  try {
    await recordTokenSession({
      jti: p.jti,
      wallet: p.wallet,
      issuedAt: p.issuedAt,
      expiresAt: p.expiresAt,
      userAgent: p.userAgent ?? null,
      ipHash: p.ipHash ?? null,
    });
  } catch (err) {
    logger.warn('[walletTokenSessions] trackTokenSession failed:', err);
  }
}

/** Mark the previous refresh-token jti as superseded on rotation. Never throws. */
export async function markSuperseded(jti: string): Promise<void> {
  try {
    await markTokenSuperseded(jti);
  } catch (err) {
    logger.warn('[walletTokenSessions] markSuperseded failed:', err);
  }
}

/** List every active (not superseded, not revoked, not expired) session for a wallet. */
export async function listActiveSessions(wallet: string): Promise<ActiveSession[]> {
  const rows = await getActiveSessions(wallet);
  return rows.map((r) => ({
    jti: r.jti,
    wallet: r.wallet,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    userAgent: r.user_agent,
    ipHash: r.ip_hash,
  }));
}

/**
 * Revoke every active session for a wallet:
 *   1. block every active jti in the revocation blocklist (Redis pipeline + DB)
 *   2. mark the sessions revoked in wallet_token_sessions
 *   3. set the per-wallet `tokens_valid_after` cutoff to now
 *
 * Returns the number of sessions revoked and the cutoff timestamp.
 */
export async function revokeAllSessions(wallet: string): Promise<{
  revokedCount: number;
  tokensValidAfter: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const active = await listActiveSessions(wallet);

  if (active.length > 0) {
    await revokeTokens(
      active.map((s) => ({ jti: s.jti, expiresAt: s.expiresAt })),
    );
    await revokeSessions(wallet, active.map((s) => s.jti));
  }

  await setTokensValidAfter(wallet, now);

  logger.info('[walletTokenSessions] revokeAllSessions', {
    wallet,
    revokedCount: active.length,
    tokensValidAfter: now,
  });

  return { revokedCount: active.length, tokensValidAfter: now };
}

/** Return the per-wallet `tokens_valid_after` cutoff, or null when none is set. */
export async function getTokensValidAfter(wallet: string): Promise<number | null> {
  return dbGetTokensValidAfter(wallet);
}
