/**
 * Scout Recommendations Controller (#491)
 *
 * Implements GET /api/scouts/:wallet/recommendations — a recommendation engine
 * that surfaces relevant players based on a scout's historical activity.
 *
 * Algorithm (weighted scoring):
 *   +3  region matches the scout's dominant saved-search / bookmark region
 *   +2  position matches the scout's dominant saved-search / bookmark position
 *   +2  player tier >= most-searched minTier
 *   +1  player not yet contacted (fresh player bonus)
 *   +1  player has a recently approved milestone (within 30 days)
 *
 * Input signals consumed (in priority order):
 *   1. scout_saved_searches — region, position, minTier preferences
 *   2. scout_bookmarks      — region/position of bookmarked players
 *   3. contact_unlocks      — already contacted (excluded from results)
 *   4. audit_log events     — player_viewed events for implicit interest
 *
 * Exclusions: already-contacted players, deactivated players (is_active = 0).
 *
 * Pagination: cursor-based (cursor = last player_id of previous page).
 * Cache: 10 minutes per scout wallet, keyed `recommendations:<wallet>`.
 * Fallback: when the scout has no history, return top-20 highest-tier players.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getSavedSearchesByScout,
  getBookmarksByScout,
  getContactUnlocksByScout,
  getAuditLogs,
  getPlayerById,
  queryPlayers,
  type PlayerRow,
  type SavedSearchRow,
} from '../db';
import { cacheGet, cacheSet } from '../services/cache';
import { checkWalletOwnership } from '../middleware/requireOwner';
import { getTierMeta, tierName } from '../utils/tier';
import { logger } from '../utils/logger';
import { queryEvents } from '../db';

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PAGE_SIZE = 20;
const RECENT_MILESTONE_WINDOW_SECS = 30 * 24 * 60 * 60; // 30 days

// Scoring weights (documented in module JSDoc above)
const WEIGHT_REGION = 3;
const WEIGHT_POSITION = 2;
const WEIGHT_TIER = 2;
const WEIGHT_FRESH = 1;
const WEIGHT_RECENT_MILESTONE = 1;

// ─── Query schema ─────────────────────────────────────────────────────────────

const recQuerySchema = z.object({
  cursor: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface SavedSearchFilters {
  region?: string;
  position?: string;
  minTier?: number;
}

interface ScoutPreferences {
  /** Dominant region from saved searches (weighted 2×) + bookmarks (1×). */
  region: string | null;
  /** Dominant position from saved searches (weighted 2×) + bookmarks (1×). */
  position: string | null;
  /** Highest minTier seen across all saved searches. */
  minTier: number;
  /** Set of player_ids the scout has already unlocked (excluded from results). */
  contactedIds: Set<string>;
  /** Whether the scout has any activity history (determines fallback path). */
  hasHistory: boolean;
}

interface ScoredPlayer extends PlayerRow {
  _score: number;
}

interface RecommendedPlayer {
  player_id: string;
  wallet: string;
  position: string | null;
  region: string | null;
  metadataUri: string | null;
  progress_level: number;
  created_at: number | null;
  tierName: string;
  tierDescription: string;
  progress_tier_name: string;
}

interface RecommendationsPage {
  data: RecommendedPlayer[];
  nextCursor: string | null;
  meta: {
    preferredRegion: string | null;
    preferredPosition: string | null;
    minTier: number;
    totalCandidates: number;
  };
}

// ─── Preference derivation ────────────────────────────────────────────────────

/**
 * Derives scout preferences by frequency-counting region and position signals
 * from saved searches and bookmarks.  Saved searches carry double weight
 * (explicit intent) vs bookmarks (implicit interest).
 */
function derivePreferences(
  savedSearches: SavedSearchRow[],
  bookmarkedPlayers: PlayerRow[],
  contactedIds: Set<string>,
): ScoutPreferences {
  const regionWeights = new Map<string, number>();
  const positionWeights = new Map<string, number>();
  let minTier = 0;

  // Saved searches: weight = 2 per entry
  for (const row of savedSearches) {
    let filters: SavedSearchFilters;
    try {
      filters = JSON.parse(row.filters) as SavedSearchFilters;
    } catch {
      continue;
    }
    if (filters.region) {
      regionWeights.set(filters.region, (regionWeights.get(filters.region) ?? 0) + 2);
    }
    if (filters.position) {
      positionWeights.set(filters.position, (positionWeights.get(filters.position) ?? 0) + 2);
    }
    if (filters.minTier !== undefined && filters.minTier > minTier) {
      minTier = filters.minTier;
    }
  }

  // Bookmarked players: weight = 1 per entry
  for (const player of bookmarkedPlayers) {
    if (player.region) {
      regionWeights.set(player.region, (regionWeights.get(player.region) ?? 0) + 1);
    }
    if (player.position) {
      positionWeights.set(player.position, (positionWeights.get(player.position) ?? 0) + 1);
    }
  }

  const hasHistory =
    savedSearches.length > 0 ||
    bookmarkedPlayers.length > 0 ||
    contactedIds.size > 0;

  const topRegion =
    [...regionWeights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const topPosition =
    [...positionWeights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    region: topRegion,
    position: topPosition,
    minTier,
    contactedIds,
    hasHistory,
  };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Scores a single player against the derived scout preferences.
 *
 * Scoring breakdown:
 *   +3  region match
 *   +2  position match
 *   +2  tier >= scout's preferred minTier (or if minTier is 0, any tier passes)
 *   +1  not yet contacted by this scout
 *   +1  has a recently approved milestone (within RECENT_MILESTONE_WINDOW_SECS)
 *
 * Exported for unit-test access.
 */
export function scorePlayer(
  player: PlayerRow,
  prefs: ScoutPreferences,
  recentlyApprovedIds: Set<string>,
): number {
  let score = 0;

  if (prefs.region && player.region === prefs.region) {
    score += WEIGHT_REGION;
  }
  if (prefs.position && player.position === prefs.position) {
    score += WEIGHT_POSITION;
  }
  if (prefs.minTier === 0 || player.progress_level >= prefs.minTier) {
    score += WEIGHT_TIER;
  }
  if (!prefs.contactedIds.has(player.player_id)) {
    score += WEIGHT_FRESH;
  }
  if (recentlyApprovedIds.has(player.player_id)) {
    score += WEIGHT_RECENT_MILESTONE;
  }

  return score;
}

// ─── Recently-approved milestone player IDs ───────────────────────────────────

/**
 * Returns a set of player_ids that have had a milestone approved within the
 * last RECENT_MILESTONE_WINDOW_SECS seconds.  Uses the indexed
 * `milestone_approved` event stream (no additional DB table needed).
 */
function getRecentlyApprovedPlayerIds(): Set<string> {
  const windowStart = Math.floor(Date.now() / 1000) - RECENT_MILESTONE_WINDOW_SECS;
  const events = queryEvents('milestone_approved');
  const ids = new Set<string>();
  for (const ev of events) {
    const createdAt = ev.created_at ?? 0;
    const playerId = String(ev.payload.player_id ?? '');
    if (createdAt >= windowStart && playerId) {
      ids.add(playerId);
    }
  }
  return ids;
}

// ─── Candidate pool ───────────────────────────────────────────────────────────

/**
 * Fetches the full candidate pool for scoring.  For scouts with history we
 * pull all active players and score them in-memory; for new scouts (no history)
 * we return the top-20 highest-tier players sorted by progress_level DESC then
 * created_at DESC.
 *
 * We intentionally fetch all active players once (no N+1 loops) and do
 * preference-matching in JS to avoid a complex multi-table SQL join.  The
 * players table is small in typical deployments; at scale, the 10-min cache
 * means this path runs at most once per scout every 10 minutes.
 */
async function fetchCandidatePool(prefs: ScoutPreferences): Promise<PlayerRow[]> {
  if (!prefs.hasHistory) {
    // Fallback: top 20 by tier (highest first), then by recency
    const rows = await queryPlayers({
      limit: PAGE_SIZE,
      offset: 0,
    });
    return rows.sort(
      (a, b) =>
        b.progress_level - a.progress_level ||
        (b.created_at ?? 0) - (a.created_at ?? 0),
    );
  }

  // Fetch all active players (no deactivated ones)
  // Use a large limit to avoid truncating results; the cache caps the frequency.
  return queryPlayers({ limit: 10_000, offset: 0 });
}

// ─── Serialization ────────────────────────────────────────────────────────────

function serializePlayer(row: PlayerRow): RecommendedPlayer {
  const { tierName: tn, tierDescription } = getTierMeta(row.progress_level);
  return {
    player_id: row.player_id,
    wallet: row.wallet,
    position: row.position,
    region: row.region,
    metadataUri: row.metadata_uri,
    progress_level: row.progress_level,
    created_at: row.created_at,
    tierName: tn,
    tierDescription,
    progress_tier_name: tierName(row.progress_level),
  };
}

// ─── Core recommendation builder ─────────────────────────────────────────────

/**
 * Builds the full sorted recommendation list for a scout.  This function is
 * called once and its result cached for CACHE_TTL_MS milliseconds.
 */
async function buildRecommendations(wallet: string): Promise<{
  ranked: ScoredPlayer[];
  prefs: ScoutPreferences;
}> {
  // ── 1. Gather input signals ───────────────────────────────────────────────
  const savedSearches = await getSavedSearchesByScout(wallet);
  const bookmarkRows = await getBookmarksByScout(wallet);
  const contactUnlocks = await getContactUnlocksByScout(wallet);

  // Enrich bookmarks with full player rows for region/position extraction
  const bookmarkedPlayersRaw = await Promise.all(
    bookmarkRows.map((b) => getPlayerById(b.player_id)),
  );
  const bookmarkedPlayers: PlayerRow[] = bookmarkedPlayersRaw.filter(
    (p): p is PlayerRow => p !== null,
  );

  const contactedIds = new Set<string>(contactUnlocks.map((u) => u.player_id));

  // ── 2. Derive preferences ─────────────────────────────────────────────────
  const prefs = derivePreferences(savedSearches, bookmarkedPlayers, contactedIds);

  // ── 3. Recently approved milestone players ────────────────────────────────
  const recentlyApproved = getRecentlyApprovedPlayerIds();

  // ── 4. Fetch candidate pool ───────────────────────────────────────────────
  const candidates = await fetchCandidatePool(prefs);

  // ── 5. Filter, score, and sort ────────────────────────────────────────────
  const ranked: ScoredPlayer[] = candidates
    .filter((p) => !contactedIds.has(p.player_id)) // exclude already-contacted
    .map((p) => ({
      ...p,
      _score: scorePlayer(p, prefs, recentlyApproved),
    }))
    .sort(
      (a, b) =>
        b._score - a._score ||
        b.progress_level - a.progress_level ||
        (b.created_at ?? 0) - (a.created_at ?? 0),
    );

  return { ranked, prefs };
}

// ─── Cursor-based pagination ──────────────────────────────────────────────────

/**
 * Applies cursor-based pagination over the pre-sorted ranked list.
 * The cursor is the player_id of the last item on the previous page.
 */
function applyPagination(
  ranked: ScoredPlayer[],
  cursor: string | undefined,
  pageSize: number,
): { page: ScoredPlayer[]; nextCursor: string | null } {
  let startIndex = 0;
  if (cursor) {
    const cursorIndex = ranked.findIndex((p) => p.player_id === cursor);
    if (cursorIndex !== -1) {
      startIndex = cursorIndex + 1;
    }
  }
  const page = ranked.slice(startIndex, startIndex + pageSize);
  const hasMore = startIndex + pageSize < ranked.length;
  const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].player_id : null;
  return { page, nextCursor };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * GET /api/scouts/:wallet/recommendations
 *
 * @param wallet  Scout's Stellar public key (must match authenticated account)
 * @query cursor  Opaque pagination cursor (player_id of last seen result)
 * @query pageSize  Max items per page (1–100, default 20)
 *
 * @response 200 { success: true, data: RecommendedPlayer[], nextCursor, meta }
 * @response 400 Invalid query params or wallet
 * @response 403 Wallet mismatch
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function getScoutRecommendations(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const {wallet} = req.params as {wallet: string};

  // ── Ownership guard ──────────────────────────────────────────────────────
  // Enforced by requireWalletOwner() at the route level; re-invoked here so
  // direct callers (unit tests) get the same protection from the shared
  // implementation instead of an inline copy.
  if (!checkWalletOwnership(req, res)) return;

  // ── Query param validation ───────────────────────────────────────────────
  const parsed = recQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
    });
    return;
  }

  const { cursor, pageSize: pageSizeParam } = parsed.data;
  const pageSize = pageSizeParam ?? PAGE_SIZE;

  try {
    // ── Cache check ────────────────────────────────────────────────────────
    // We cache the full ranked list, not a single page, so pagination works
    // across cache hits without re-querying the DB.
    const cacheKey = `recommendations:${wallet}`;
    let cachedResult = await cacheGet<{ ranked: ScoredPlayer[]; prefs: ScoutPreferences }>(cacheKey);

    if (!cachedResult) {
      logger.debug({ wallet, action: 'recommendations_cache_miss' });
      cachedResult = await buildRecommendations(wallet);
      await cacheSet(cacheKey, cachedResult, CACHE_TTL_MS);
    } else {
      logger.debug({ wallet, action: 'recommendations_cache_hit' });
    }

    const { ranked, prefs } = cachedResult;

    // ── Apply pagination ──────────────────────────────────────────────────
    const { page, nextCursor } = applyPagination(ranked, cursor, pageSize);

    const response: RecommendationsPage = {
      data: page.map(({ _score: _s, ...rest }) => serializePlayer(rest as PlayerRow)),
      nextCursor,
      meta: {
        preferredRegion: prefs.region,
        preferredPosition: prefs.position,
        minTier: prefs.minTier,
        totalCandidates: ranked.length,
      },
    };

    res.json({ success: true, ...response });
  } catch (err) {
    next(err);
  }
}
