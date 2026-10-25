/**
 * Repository: trial offers between scouts and players.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';

// ─── Trial offer helpers ──────────────────────────────────────────────────────

export interface TrialOfferRow {
  id: number;
  offer_id: string;
  scout_wallet: string;
  player_id: string;
  details_uri: string;
  status: string;
  reject_reason: string | null;
  responded_at: number | null;
  created_at: number;
  /** Unix epoch seconds after which accept/reject is rejected. NULL = no expiry (pre-migration rows). */
  expires_at: number | null;
  /** Unix epoch seconds when the originating scout withdrew the offer. NULL = not cancelled. */
  cancelled_at: number | null;
}

export async function getTrialOfferById(offerId: string): Promise<TrialOfferRow | null> {
  const sql = 'SELECT * FROM trial_offers WHERE offer_id = ?';
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<TrialOfferRow>(sql, [offerId])) ?? null
  );
}

export async function insertTrialOffer(p: {
  offer_id: string;
  scout_wallet: string;
  player_id: string;
  details_uri: string;
  created_at: number;
  expires_at?: number | null;
}): Promise<void> {
  const sql = `INSERT INTO trial_offers (offer_id, scout_wallet, player_id, details_uri, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (offer_id) DO NOTHING`;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [p.offer_id, p.scout_wallet, p.player_id, p.details_uri, p.created_at, p.expires_at ?? null])
  );
}

export async function respondToTrialOffer(p: {
  offer_id: string;
  status: string;
  reject_reason?: string;
  responded_at: number;
}): Promise<void> {
  const sql = `UPDATE trial_offers SET status = ?, reject_reason = ?, responded_at = ? WHERE offer_id = ?`;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [p.status, p.reject_reason ?? null, p.responded_at, p.offer_id])
  );
}

/**
 * Cancel (withdraw) a still-pending trial offer.
 * Only succeeds when the offer exists, belongs to the given scout, and is
 * still in 'pending' status. Returns true when the cancellation was applied,
 * false when no matching pending offer was found.
 */
export async function cancelTrialOffer(offerId: string, scoutWallet: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const sql = `
    UPDATE trial_offers
    SET status = 'cancelled', cancelled_at = ?
    WHERE offer_id = ? AND scout_wallet = ? AND status = 'pending'
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [now, offerId, scoutWallet]);
    return info.changes > 0;
  });
}

/**
 * Count the number of trial offers submitted for a given player.
 * Returns 0 when the trial_offers table does not exist yet (pre-migration).
 */
export async function countTrialOffersByPlayer(playerId: string): Promise<number> {
  try {
    const sql = 'SELECT COUNT(*) AS cnt FROM trial_offers WHERE player_id = ?';
    const row = await timedQueryAsync(sql, () =>
      getDriver().get<{ cnt: number | string }>(sql, [playerId]),
    );
    return Number(row?.cnt ?? 0);
  } catch {
    // Table may not exist in very early migration states
    return 0;
  }
}
