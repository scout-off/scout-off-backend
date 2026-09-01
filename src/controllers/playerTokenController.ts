/**
 * playerTokenController.ts
 *
 * Stub handlers for the fractionalized player-sponsorship (Player Token) feature.
 * All endpoints are gated behind the `player_tokens` feature flag. When the flag
 * is off they return 404 so the routes are invisible to callers.
 *
 * Backing store: in-memory Maps — replaced by the Soroban `player_token` contract
 * or a DB table when the feature graduates out of scaffold stage.
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { isFeatureEnabled, FeatureFlags } from '../services/featureFlags';
import { logger } from '../utils/logger';
import { Mutex } from '../utils/concurrency';

// ── In-memory stub registry ───────────────────────────────────────────────────
// Key: playerId → Map<holderWallet, tokenBalance>
const holderRegistry = new Map<string, Map<string, number>>();
// Key: playerId → totalSupply
const tokenSupply = new Map<string, number>();

// ── Per-player purchase mutexes ───────────────────────────────────────────────
// One Mutex per playerId so concurrent buy requests for the same player are
// serialised. Requests for different players proceed independently.
const purchaseMutexes = new Map<string, Mutex>();

function getMutex(playerId: string): Mutex {
  let mutex = purchaseMutexes.get(playerId);
  if (!mutex) {
    mutex = new Mutex();
    purchaseMutexes.set(playerId, mutex);
  }
  return mutex;
}

/** Seed a player's token supply (used by integration tests). */
export function _stubSeedTokens(playerId: string, supply: number): void {
  tokenSupply.set(playerId, supply);
  if (!holderRegistry.has(playerId)) {
    holderRegistry.set(playerId, new Map());
  }
}

/** Reset stub state between tests. */
export function _stubReset(): void {
  holderRegistry.clear();
  tokenSupply.clear();
}

/** Reset per-player mutexes between tests. */
export function _stubResetMutexes(): void {
  purchaseMutexes.clear();
}

// ── Validation schemas ────────────────────────────────────────────────────────

export const buyTokenSchema = z.object({
  amount: z.number().int().min(1, 'amount must be at least 1'),
  buyerWallet: z.string().min(1, 'buyerWallet is required'),
}).strict();

// ── Helpers ───────────────────────────────────────────────────────────────────

function featureFlagGuard(res: Response): boolean {
  if (!isFeatureEnabled(FeatureFlags.PLAYER_TOKENS)) {
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
export function getPlayerTokenHolders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!featureFlagGuard(res)) return;

  const {playerId} = req.params as {playerId: string};

  const supply = tokenSupply.get(playerId);
  if (supply === undefined) {
    res.status(404).json({ success: false, error: 'No tokens have been issued for this player.' });
    return;
  }

  const holders = holderRegistry.get(playerId) ?? new Map<string, number>();
  let soldTokens = 0;
  const holderList: Array<{ holder: string; tokens: number }> = [];

  for (const [holder, tokens] of holders.entries()) {
    holderList.push({ holder, tokens });
    soldTokens += tokens;
  }

  res.json({
    success: true,
    data: {
      playerId,
      totalSupply: supply,
      soldTokens,
      holders: holderList,
    },
  });
}

// ── POST /api/players/:playerId/tokens/buy ────────────────────────────────────

/**
 * Purchase Player Tokens for a given player (stub).
 *
 * The supply check and balance write are wrapped in a per-playerId Mutex so
 * that concurrent requests are serialised: only one request at a time can
 * read `remaining` and commit the updated balance for a given player. This
 * eliminates the check-then-act race that would otherwise allow overselling.
 *
 * If a concurrent purchase exhausts the remaining supply before this request
 * acquires the lock, the handler returns HTTP 409 (Conflict) rather than the
 * normal HTTP 400 (Bad Request) so callers can distinguish a lost-race from
 * an invalid request.
 *
 * Design note: this controller is a TypeScript-side in-memory stub. Once the
 * Soroban `player_token` contract replaces it, atomicity moves to the
 * on-chain level and this mutex becomes unnecessary. The fix is needed today
 * because the in-memory state has no inherent transactional safety.
 */
export async function buyPlayerToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!featureFlagGuard(res)) return;

  const {playerId} = req.params as {playerId: string};

  const parsed = buyTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors.map((e) => e.message).join('; '),
    });
    return;
  }

  const { amount, buyerWallet } = parsed.data;

  const supply = tokenSupply.get(playerId);
  if (supply === undefined) {
    res.status(404).json({ success: false, error: 'No tokens have been issued for this player.' });
    return;
  }

  // Acquire the per-player mutex before reading remaining supply and writing
  // the updated balance. This ensures no other concurrent request can slip
  // between the check and the write for the same playerId.
  await getMutex(playerId).withLock(async () => {
    const holders = holderRegistry.get(playerId) ?? new Map<string, number>();
    const currentSold = Array.from(holders.values()).reduce((a, b) => a + b, 0);
    const remaining = supply - currentSold;

    if (amount > remaining) {
      // Use 409 Conflict to distinguish a lost-race (supply exhausted by a
      // concurrent purchase) from a plain validation error (400).
      res.status(409).json({
        success: false,
        error: `Supply exhausted: ${remaining} token(s) remaining. Concurrent purchase may have claimed the remaining supply — try a smaller amount.`,
        code: 'TOKEN_SUPPLY_EXHAUSTED',
      });
      return;
    }

    const prev = holders.get(buyerWallet) ?? 0;
    const newBalance = prev + amount;
    holders.set(buyerWallet, newBalance);
    holderRegistry.set(playerId, holders);

    logger.info(`[playerToken] playerId=${playerId} buyer=${buyerWallet} amount=${amount} newBalance=${newBalance}`);

    res.json({
      success: true,
      data: {
        playerId,
        buyerWallet,
        amount,
        newBalance,
      },
    });
  });
}
