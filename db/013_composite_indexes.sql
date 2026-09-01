-- Migration 013: add missing composite indexes for high-frequency query patterns
--
-- Each index targets a specific query in src/db/index.ts.  The column order
-- follows the selectivity / filter-first rule: equality predicates before
-- range/sort predicates so SQLite can use the index for both the WHERE
-- clause and the ORDER BY / LIMIT without a separate sort step.

-- 1. Players search: queryPlayers / countPlayers
--    Query:  WHERE region = ? AND position = ? AND progress_level >= ? AND is_active = 1
--    Replaces three single-column indexes (idx_players_region, idx_players_position,
--    idx_players_tier) with one covering index for the combined filter.
CREATE INDEX IF NOT EXISTS idx_players_region_position_tier
    ON players (region, position, progress_level);

-- 2. Subscription status check: getLatestSubscription
--    Query:  WHERE scout_wallet = ? AND cancelled_at IS NULL ORDER BY expires_at DESC LIMIT 1
--    The leading equality on scout_wallet plus the IS NULL filter on cancelled_at
--    allow SQLite to use the index for the WHERE clause; expires_at DESC drives
--    the ORDER BY so no separate sort is needed.
CREATE INDEX IF NOT EXISTS idx_subscriptions_wallet_active_expires
    ON subscriptions (scout_wallet, cancelled_at, expires_at);

-- 3. Contact unlock check: hasContactUnlock
--    Query:  WHERE scout_wallet = ? AND player_id = ? LIMIT 1
--    The existing idx_contact_unlocks_scout covers only the first column;
--    this composite index covers the full equality lookup.
CREATE INDEX IF NOT EXISTS idx_contact_unlocks_scout_player
    ON contact_unlocks (scout_wallet, player_id);

-- 4. Audit log queries: getAuditLogs / getAuditLogsCount
--    Query:  WHERE action = ? AND created_at >= ? AND created_at <= ?
--    action equality first, then the created_at range scan.
CREATE INDEX IF NOT EXISTS idx_audit_log_action_created_at
    ON audit_log (action, created_at);

-- 5. Idempotency key lookup and expiry cleanup:
--       getIdempotencyRecord:       WHERE key = ? AND expires_at > ?
--       purgeExpiredIdempotencyKeys: DELETE WHERE expires_at <= ?
--    key is the PRIMARY KEY (exact lookup), so the main benefit here is
--    covering expires_at for the TTL filter without a second pass; it also
--    makes the cleanup DELETE an index scan rather than a full table scan.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key_expires
    ON idempotency_keys (key, expires_at);
