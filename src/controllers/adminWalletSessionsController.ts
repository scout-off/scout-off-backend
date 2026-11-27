import { Request, Response, NextFunction } from 'express';
import { walletAddressSchema } from '../validators/admin';
import { validateParams } from '../middleware/validate';
import { listActiveSessions, revokeAllSessions } from '../services/walletTokenSessions';
import { terminateSessionsForWallet } from '../routes/events';
import { logAuditEvent } from '../services/audit';

/**
 * GET /api/admin/wallets/:wallet/sessions
 *
 * Lists every active (not superseded, not revoked, not expired) refresh-token
 * session for a wallet: jti, issuedAt, expiresAt, userAgent/IP hash.
 */
export async function listWalletSessions(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  const wallet = String(req.params.wallet);
  const sessions = await listActiveSessions(wallet);
  res.json({
    success: true,
    data: {
      wallet,
      sessions: sessions.map((s) => ({
        jti: s.jti,
        issuedAt: s.issuedAt,
        expiresAt: s.expiresAt,
        userAgent: s.userAgent,
        ipHash: s.ipHash,
        active: true,
      })),
      count: sessions.length,
    },
  });
}

/**
 * POST /api/admin/wallets/:wallet/sessions/revoke-all
 *
 * Revokes every active refresh-token session for a wallet: blocks every
 * active jti in the token blocklist (Redis pipeline), sets the per-wallet
 * `tokens_valid_after` cutoff so access tokens issued before it are rejected
 * by requireAuth even before they expire, terminates the wallet's open SSE
 * streams, and audit-logs the action.
 */
export async function revokeAllWalletSessions(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  const wallet = String(req.params.wallet);

  const { revokedCount, tokensValidAfter } = await revokeAllSessions(wallet);

  // Terminate the wallet's open SSE streams immediately.
  terminateSessionsForWallet(wallet);

  // Audit-log the compromise response.
  try {
    await logAuditEvent({
      action: 'wallet_sessions_revoked_all',
      timestamp: new Date().toISOString(),
      adminWallet: req.account ?? '',
      wallet,
      path: req.path,
      queryParams: { wallet, revokedCount, tokensValidAfter },
    });
  } catch {
    // Audit failure must not block the revocation itself.
  }

  res.json({
    success: true,
    data: {
      wallet,
      revokedCount,
      tokensValidAfter,
      message: `${revokedCount} active session(s) revoked for ${wallet}`,
    },
  });
}
