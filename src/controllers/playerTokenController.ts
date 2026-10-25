/**
 * playerTokenController.ts
 *
 * DB-backed stub handlers for the fractionalized player-sponsorship (Player Token) feature.
 * All endpoints are gated behind the `player_tokens_enabled` feature flag. When the flag
 * is off they return 404 so the routes are invisible to callers.
 * Purchases persist in the shared database, but do not perform an XLM transfer.
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { isFeatureEnabled, FeatureFlags } from '../services/featureFlags';
import { logger } from '../utils/logger';
import {
  getPlayerTokenInventory,
  purchasePlayerTokens,
  resetPlayerTokenRegistry,
  seedPlayerTokenSupply,
} from '../db';

/** Seed a player's token supply (used by integration tests). */
export async function _stubSeedTokens(playerId: string, supply: number): Promise<void> {
  await seedPlayerTokenSupply(playerId, supply);
}

/** Reset stub state between tests. */
export async function _stubReset(): Promise<void> {
  await resetPlayerTokenRegistry();
}

// ── Validation schemas ────────────────────────────────────────────────────────

export const buyTokenSchema = z.object({
  amount: z.number().int().min(1, 'amount must be at least 1').max(Number.MAX_SAFE_INTEGER),
  buyerWallet: z.string().min(1).optional(),
}).strict();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function featureFlagGuard(res: Response): Promise<boolean> {
  if (!(await isFeatureEnabled(FeatureFlags.PLAYER_TOKENS_ENABLED))) {
    res.status(404).json({
      success: false,
      error: 'Player token endpoints are not enabled on this platform.',
    });
    return false;
  }
  return true;
}

// ── GET /api/players/:playerId/tokens ─────────────────────────────────────────

/**
 * Return the holder list and per-holder token balances for a player.
 */
export async function getPlayerTokenHolders(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!(await featureFlagGuard(res))) return;

  const {playerId} = req.params as {playerId: string};
  try {
    const inventory = await getPlayerTokenInventory(playerId);
    if (!inventory) {
      res.status(404).json({ success: false, error: 'No tokens have been issued for this player.' });
      return;
    }

    res.json({ success: true, data: { playerId, ...inventory } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/players/:playerId/tokens/buy ────────────────────────────────────

/**
 * Purchase Player Tokens for a given player.
 *
 * Supply checks and holder-balance writes execute in one DB transaction,
 * serialized per player by the database driver across all processes.
 *
 * If a concurrent purchase exhausts the remaining supply before this request
 * acquires the lock, the handler returns HTTP 409 (Conflict) rather than the
 * normal HTTP 400 (Bad Request) so callers can distinguish a lost-race from
 * an invalid request.
 *
 */
export async function buyPlayerToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!(await featureFlagGuard(res))) return;

  const {playerId} = req.params as {playerId: string};
  const buyerWallet = req.account;
  if (!buyerWallet) {
    res.status(401).json({ success: false, error: 'Authenticated account is required.' });
    return;
  }

  const parsed = buyTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.issues.map((e) => e.message).join('; '),
    });
    return;
  }

  const { amount } = parsed.data;
  if (parsed.data.buyerWallet && parsed.data.buyerWallet !== buyerWallet) {
    res.status(403).json({ success: false, error: 'buyerWallet must match the authenticated account.' });
    return;
  }

  try {
    const result = await purchasePlayerTokens(playerId, buyerWallet, amount);
    if (result.status === 'not_found') {
      res.status(404).json({ success: false, error: 'No tokens have been issued for this player.' });
      return;
    }

    if (result.status === 'exhausted') {
      res.status(409).json({
        success: false,
        error: `Supply exhausted: ${result.remaining} token(s) remaining. Concurrent purchase may have claimed the remaining supply — try a smaller amount.`,
        code: 'TOKEN_SUPPLY_EXHAUSTED',
      });
      return;
    }

    logger.info(`[playerToken] playerId=${playerId} buyer=${buyerWallet} amount=${amount} newBalance=${result.newBalance}`);

    res.json({
      success: true,
      data: {
        playerId,
        buyerWallet,
        amount,
        newBalance: result.newBalance,
      },
    });
  } catch (err) {
    next(err);
  }
}
