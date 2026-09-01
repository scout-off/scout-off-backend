import { getFeatureFlag, getAllFeatureFlags, upsertFeatureFlag } from '../db';
import { logAuditEvent } from './audit';

/** Named feature flags. Add new constants here as features are gated. */
export const FeatureFlags = {
  SAVED_SEARCHES: 'saved_searches',
  /** Fractionalized player-sponsorship via Player Tokens (scaffold stage). */
  PLAYER_TOKENS: 'player_tokens',
  PLAYER_TOKENS_ENABLED: 'player_tokens_enabled',
  SAVED_SEARCH_ALERTS_ENABLED: 'saved_search_alerts_enabled',
  GRAPHQL_ENABLED: 'graphql_enabled',
} as const;

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
