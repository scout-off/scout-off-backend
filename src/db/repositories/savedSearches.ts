/**
 * Repository: saved searches and their notification state.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';

// ─── Scout saved-search helpers (#486) ───────────────────────────────────────

export interface SavedSearchRow {
  id: number;
  scout_wallet: string;
  name: string;
  filters: string; // JSON string
  created_at: number;
  notify_enabled: number;
}

export async function getAllActiveSavedSearches(): Promise<SavedSearchRow[]> {
  const sql = 'SELECT * FROM scout_saved_searches WHERE notify_enabled = 1';
  return timedQueryAsync(sql, () => getDriver().all<SavedSearchRow>(sql));
}

export async function getSavedSearchNotification(scoutWallet: string, playerId: string): Promise<number | null> {
  const sql = 'SELECT notified_at FROM saved_search_notifications WHERE scout_wallet = ? AND player_id = ?';
  return timedQueryAsync(sql, async () => {
    const row = await getDriver().get<{ notified_at: number }>(sql, [scoutWallet, playerId]);
    return row ? row.notified_at : null;
  });
}

export async function recordSavedSearchNotification(scoutWallet: string, playerId: string, notifiedAt: number): Promise<void> {
  const sql = 'INSERT INTO saved_search_notifications (scout_wallet, player_id, notified_at) ' +
              'VALUES (?, ?, ?) ' +
              'ON CONFLICT(scout_wallet, player_id) DO UPDATE SET notified_at = excluded.notified_at';
  await timedQueryAsync(sql, () => getDriver().run(sql, [scoutWallet, playerId, notifiedAt]));
}

/**
 * Insert a new saved search for a scout.
 * Returns the new row id.
 */
export async function insertSavedSearch(p: {
  scout_wallet: string;
  name: string;
  filters: string; // pre-serialised JSON
  created_at: number;
  notify_enabled?: number;
}): Promise<number> {
  const sql = `
    INSERT INTO scout_saved_searches (scout_wallet, name, filters, created_at, notify_enabled)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [p.scout_wallet, p.name, p.filters, p.created_at, p.notify_enabled ?? 1]);
    return info.lastId;
  });
}

/**
 * List all saved searches for a scout, ordered newest-first.
 */
export async function getSavedSearchesByScout(scoutWallet: string): Promise<SavedSearchRow[]> {
  const sql = `
    SELECT * FROM scout_saved_searches
    WHERE scout_wallet = ?
    ORDER BY created_at DESC
  `;
  return timedQueryAsync(sql, () =>
    getDriver().all<SavedSearchRow>(sql, [scoutWallet]),
  );
}

/**
 * Delete a saved search by id.
 * Only deletes rows belonging to the given scout wallet for security.
 * Returns true when a row was deleted, false when it did not exist.
 */
export async function deleteSavedSearch(id: number, scoutWallet: string): Promise<boolean> {
  const sql = `DELETE FROM scout_saved_searches WHERE id = ? AND scout_wallet = ?`;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [id, scoutWallet]);
    return info.changes > 0;
  });
}

/**
 * Get a saved search by id.
 * Only returns rows belonging to the given scout wallet for security.
 * Returns null when not found.
 */
export async function getSavedSearchById(id: number, scoutWallet: string): Promise<SavedSearchRow | null> {
  const sql = `SELECT * FROM scout_saved_searches WHERE id = ? AND scout_wallet = ?`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<SavedSearchRow>(sql, [id, scoutWallet])) ?? null
  );
}

/**
 * Update a saved search's name and/or filters.
 * Only updates rows belonging to the given scout wallet for security.
 * Returns true when a row was updated, false when it did not exist.
 */
export async function updateSavedSearch(
  id: number,
  scoutWallet: string,
  updates: { name?: string; filters?: string }
): Promise<boolean> {
  const fields: string[] = [];
  const params: (string | number)[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    params.push(updates.name);
  }
  if (updates.filters !== undefined) {
    fields.push('filters = ?');
    params.push(updates.filters);
  }

  if (fields.length === 0) {
    return false;
  }

  params.push(id, scoutWallet);
  // sql-injection-check-ignore: fields.join produces `col = ?` fragments only ("name = ?", "filters = ?"); values are bound via params.
  const sql = `UPDATE scout_saved_searches SET ${fields.join(', ')} WHERE id = ? AND scout_wallet = ?`;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, params);
    return info.changes > 0;
  });
}

/**
 * Count saved searches for a scout.
 * Used to enforce the 20 saved searches limit.
 */
export async function countSavedSearchesByScout(scoutWallet: string): Promise<number> {
  const sql = `SELECT COUNT(*) as count FROM scout_saved_searches WHERE scout_wallet = ?`;
  const row = await timedQueryAsync(sql, () =>
    getDriver().get<{ count: number | string }>(sql, [scoutWallet])
  );
  return Number(row?.count ?? 0);
}
