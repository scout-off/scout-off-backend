/**
 * Shared player/milestone authorization (#1019)
 *
 * Single authoritative decision for whether a caller may view a player's
 * profile/milestones. Used by:
 *   - REST  GET /api/players/:playerId/milestones (playerController)
 *   - REST  GET /api/players/:playerId             (playerController)
 *   - GraphQL Query.player
 *   - GraphQL Query.milestones
 *   - GraphQL Player.milestones (nested)
 *
 * Policy (identical on every surface):
 *   - Active players   → public access.
 *   - Deactivated players → owner (player_id or wallet match) or admin only.
 *     Everyone else receives the same "not found" treatment as a missing
 *     player (no data leak that the player exists but is hidden).
 */

export interface PlayerAccessContext {
  /** Authenticated Stellar wallet (undefined for anonymous callers). */
  account?: string;
  /** Authenticated role (undefined for anonymous callers). */
  role?: string;
}

export interface PlayerAccessRow {
  player_id: string;
  wallet: string;
  /** 0 = deactivated; anything else (or undefined) = active. */
  is_active?: number | null;
}

/** Return true when the caller may view the player's profile/milestones. */
export function canAccessPlayer(
  player: PlayerAccessRow,
  ctx: PlayerAccessContext,
): boolean {
  if (player.is_active === undefined || player.is_active === null || player.is_active !== 0) {
    return true; // active (or unknown state) — public
  }
  // Deactivated: owner or admin only.
  const isOwner =
    ctx.account !== undefined &&
    (ctx.account === player.player_id || ctx.account === player.wallet);
  const isAdmin = ctx.role === 'admin';
  return isOwner || isAdmin;
}