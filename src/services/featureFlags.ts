import { getFeatureFlag, getAllFeatureFlags, upsertFeatureFlag, getDb } from '../db';
import { logAuditEvent } from './audit';
import { logger } from '../utils/logger';

/** Named feature flags. Add new constants here as features are gated. */
export const FeatureFlags = {
  SAVED_SEARCHES: 'saved_searches',
  /** Fractionalized player-sponsorship via Player Tokens (scaffold stage). */
  PLAYER_TOKENS: 'player_tokens',
  PLAYER_TOKENS_ENABLED: 'player_tokens_enabled',
  SAVED_SEARCH_ALERTS_ENABLED: 'saved_search_alerts_enabled',
  GRAPHQL_ENABLED: 'graphql_enabled',
} as const;

/** Controls whether the /graphql endpoint is served. Off by default (#1126). */
export const GRAPHQL_ENABLED = FeatureFlags.GRAPHQL_ENABLED;

/** Default values used when a flag has no row and the DB is unreachable. */
const FLAG_DEFAULTS: Record<string, boolean> = {
  [FeatureFlags.GRAPHQL_ENABLED]: false,
};

export type FeatureFlagName = (typeof FeatureFlags)[keyof typeof FeatureFlags];

export interface FeatureFlagContext {
  /** Authenticated account (e.g. scout wallet). Reserved for future rollout rules. */
  account?: string;
}

const cache = new Map<string, boolean>();

/** Clear the in-memory cache (used in tests). */
export function clearFeatureFlagCache(): void {
  cache.clear();
}

// ─── Synchronous flag reads (#1126) ──────────────────────────────────────────
//
// The /graphql mount guard runs on every request and needs a plain boolean
// with no await. `isEnabled()` reads the feature_flags table synchronously via
// the better-sqlite3 handle, with a short TTL cache and a defaults fallback so
// it is safe to call before the DB is initialised (returns the default) and on
// the postgres driver (getDb() throws → default).

interface SyncCacheEntry {
  value: boolean;
  expiresAt: number;
}
const syncCache = new Map<string, SyncCacheEntry>();

function syncCacheTtlMs(): number {
  return parseInt(process.env.FEATURE_FLAG_CACHE_TTL_MS ?? '5000', 10);
}

/** No-op bootstrap kept for backwards compatibility — the feature_flags table
 *  is created and seeded by the SQL migrations (db/010_feature_flags.sql). */
export function bootstrapFeatureFlags(): void {
  /* table + seed rows are owned by the migrations */
}

/**
 * Synchronously read a feature flag. Prefer {@link isFeatureEnabled} on
 * request paths that can await; this exists for the per-request /graphql guard.
 */
export function isEnabled(key: string): boolean {
  const now = Date.now();
  const cached = syncCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let value = FLAG_DEFAULTS[key] ?? false;
  try {
    const row = getDb()
      .prepare('SELECT enabled FROM feature_flags WHERE name = ?')
      .get(key) as { enabled: number } | undefined;
    if (row !== undefined) {
      value = row.enabled !== 0;
    }
  } catch {
    // DB not initialised (tests) or non-sqlite driver — fall back to defaults.
  }

  syncCache.set(key, { value, expiresAt: now + syncCacheTtlMs() });
  return value;
}

/** Flush the synchronous flag cache. Used in tests. */
export function clearFlagCache(): void {
  syncCache.clear();
}

/**
 * Returns whether a named feature flag is enabled.
 * Reads from an in-process cache that is refreshed on admin updates.
 */
export async function isFeatureEnabled(
  flagName: string,
  _context?: FeatureFlagContext,
): Promise<boolean> {
  if (cache.has(flagName)) {
    return cache.get(flagName)!;
  }

  const row = await getFeatureFlag(flagName);
  const enabled = row?.enabled === 1;
  cache.set(flagName, enabled);
  return enabled;
}

/** Update a flag at runtime and refresh the in-process cache immediately.
 *  Reads the old value first so it can be written to the audit trail.
 */
export async function setFeatureFlag(
  flagName: string,
  enabled: boolean,
  updatedBy: string,
): Promise<void> {
  const oldRow = await getFeatureFlag(flagName);
  const oldValue = oldRow ? oldRow.enabled === 1 : false;

  await upsertFeatureFlag({
    name: flagName,
    enabled: enabled ? 1 : 0,
    updated_at: Date.now(),
    updated_by: updatedBy,
  });
  cache.set(flagName, enabled);

  await logAuditEvent({
    action: 'feature_flag_toggled',
    timestamp: new Date().toISOString(),
    adminWallet: updatedBy,
    queryParams: {
      flag_name: flagName,
      old_value: oldValue,
      new_value: enabled,
      admin_wallet: updatedBy,
    },
  }).catch(() => {});
}

/** Return all feature flag rows from the DB (bypasses in-process cache). */
export { getAllFeatureFlags };
