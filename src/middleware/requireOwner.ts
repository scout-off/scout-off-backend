import { Request, Response, NextFunction } from 'express';
import { sendForbidden, sendUnauthorized } from '../utils/authError';
import { isValidStellarAddress } from '../utils/stellarAddress';

/**
 * Typed helper: returns true when the authenticated account matches the target id.
 */
export function isOwner(account: string | undefined, targetId: string): boolean {
  return !!account && account === targetId;
}

/**
 * Middleware that ensures the authenticated user (JWT sub) matches req.params.playerId.
 * Must be used after requireAuth so that req.account is already set.
 * Returns 403 if the caller is not the profile owner.
 */
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  const account = req.account;
  const playerId = req.params.playerId as string;
  if (!isOwner(account, playerId)) {
    sendForbidden(res, 'Forbidden: not the profile owner');
    return;
  }
  next();
}

export interface RequireWalletOwnerOptions {
  /**
   * HTTP status used when the authenticated account does not own the :wallet
   * param. Defaults to 403.
   *
   * 401 preserves the legacy behavior of the subscription / contacts GET
   * endpoints, which historically returned 401 (rather than 403) on wallet
   * mismatch. That divergence is a pre-existing inconsistency (see #1031)
   * kept intact so observable behavior does not change; a maintainer may
   * normalize it to 403 in a future cleanup.
   */
  mismatchStatus?: 401 | 403;
  /**
   * Reject a malformed :wallet param (not a valid Stellar address) with 400.
   * Defaults to true.
   *
   * A few legacy endpoints (subscription write routes, trial-offer routes,
   * GET contact-details) historically compared the account to the :wallet
   * param without first validating the address format. Pass false to
   * preserve that exact behavior.
   */
  validateAddress?: boolean;
}

/**
 * Shared ownership guard for the :wallet route parameter (used by every
 * scout-facing route). Must be used after requireRole/requireAuth so that
 * req.account is already set.
 *
 * - No req.account (unauthenticated) → 401 Unauthorized
 * - req.role === 'admin' → allowed regardless of wallet match
 * - Missing :wallet param → 403 Forbidden
 * - :wallet is not a valid Stellar address → 400 Invalid Stellar address
 * - req.account matches req.params.wallet → allowed
 * - Mismatch → 403 Forbidden (or 401 with `mismatchStatus: 401`)
 *
 * Returns true when the request may proceed, false when a response has been
 * sent. Exported separately from the middleware so handlers that are invoked
 * directly (unit tests, internal callers) can reuse the exact same logic
 * instead of re-implementing it inline.
 */
export function checkWalletOwnership(
  req: Request,
  res: Response,
  options: RequireWalletOwnerOptions = {},
): boolean {
  const { mismatchStatus = 403, validateAddress = true } = options;
  const account = req.account;

  if (!account) {
    sendUnauthorized(res, 'Unauthorized');
    return false;
  }

  // Admins may act on behalf of any wallet.
  if (req.role === 'admin') {
    return true;
  }

  const wallet = req.params.wallet as string;
  if (!wallet) {
    sendForbidden(res, 'Forbidden');
    return false;
  }
  if (validateAddress && !isValidStellarAddress(wallet)) {
    res.status(400).json({ success: false, error: 'Invalid Stellar address' });
    return false;
  }
  if (account !== wallet) {
    if (mismatchStatus === 401) {
      sendUnauthorized(res, 'Unauthorized');
    } else {
      sendForbidden(res, 'Forbidden: wallet does not match authenticated account');
    }
    return false;
  }

  return true;
}

/**
 * Middleware factory that enforces wallet ownership on routes with a :wallet
 * path parameter (see checkWalletOwnership for the exact semantics).
 *
 * Usage: router.get('/:wallet/subscription', requireRole('scout'), requireWalletOwner(), handler)
 */
export function requireWalletOwner(options: RequireWalletOwnerOptions = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!checkWalletOwnership(req, res, options)) return;
    next();
  };
}
