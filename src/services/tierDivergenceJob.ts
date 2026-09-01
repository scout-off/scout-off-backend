/**
 * Tier divergence reconciliation job (#1132).
 *
 * A player's tier is derived off-chain from the count of `milestone_approved`
 * events recorded for them (`tierForApprovedMilestones`). The contracts also
 * store a `progress_level` that the indexer writes into the `players` table.
 * If the indexer misses a `milestone_approved` event the two silently disagree
 * and scouts see a stale tier.
 *
 * This job:
 *  1. Fetches a configurable sample of active players (batch, rate-limited).
 *  2. Derives the expected tier from the off-chain event count.
 *  3. Compares it against the stored `progress_level`.
 *  4. Increments `scout_off_tier_divergence_total` and logs each mismatch.
 *
 * Run via the `setInterval` loop in `src/index.ts`.
 *
 * ## Runbook
 * A sustained non-zero `scout_off_tier_divergence_total` means the indexer
 * has missed one or more `milestone_approved` events.  Run a full reindex to
 * replay events from the last known-good ledger and the counter should return
 * to zero.  See docs/runbook.md → "Reindexing" for the procedure.
 */

import { queryPlayers } from '../db';
import { queryEvents } from '../db';
import { tierForApprovedMilestones } from './tierPromotion';
import { logger } from '../utils/logger';
import config from '../config';

// ── In-process metric ──────────────────────────────────────────────────────────

/** Running total of tier-divergence events detected since process start. */
let tierDivergenceTotal = 0;

/** Returns the current value of the `scout_off_tier_divergence_total` counter. */
export function getTierDivergenceTotal(): number {
  return tierDivergenceTotal;
}

/** Reset the counter (used in tests). */
export function resetTierDivergenceTotal(): void {
  tierDivergenceTotal = 0;
}

// ── Job ────────────────────────────────────────────────────────────────────────

/**
 * Run one reconciliation pass over a sample of active players.
 *
 * The sample size, batch size, and interval are all configurable via
 * environment variables (see `src/config.ts`).  The function is designed to
 * be called on a `setInterval` by `src/index.ts`.
 */
export async function runTierDivergenceCheck(): Promise<void> {
  const sampleSize = config.tierDivergence.sampleSize;

  let players: Awaited<ReturnType<typeof queryPlayers>>;
  try {
    players = await queryPlayers({ limit: sampleSize, includeDeactivated: false });
  } catch (err) {
    logger.warn('[tier-divergence] failed to fetch players for reconciliation', { err });
    return;
  }

  let mismatches = 0;

  for (const player of players) {
    // Count approved milestones in the events store (off-chain derived value)
    const approvedCount = queryEvents('milestone_approved').filter(
      (e) => e.payload.player_id === player.player_id,
    ).length;

    const derivedTier = tierForApprovedMilestones(approvedCount);
    const storedTier = player.progress_level as number;

    if (derivedTier !== storedTier) {
      mismatches += 1;
      tierDivergenceTotal += 1;

      logger.warn('[tier-divergence] mismatch detected', {
        player_id: player.player_id,
        onchain: storedTier,
        derived: derivedTier,
        approved_milestone_count: approvedCount,
        metric: 'scout_off_tier_divergence_total',
      });
    }
  }

  if (mismatches > 0) {
    logger.warn('[tier-divergence] reconciliation pass complete', {
      checked: players.length,
      mismatches,
      scout_off_tier_divergence_total: tierDivergenceTotal,
    });
  } else {
    logger.debug('[tier-divergence] reconciliation pass complete — no mismatches', {
      checked: players.length,
    });
  }
}
