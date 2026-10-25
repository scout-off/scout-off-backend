/**
 * Repository: indexer cursor / last-indexed-ledger state.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: SQLite-only — still calls `getDb()` directly (2 call(s)); slated for the #640 DbDriver migration.
 */
import { getDb, timedQuery } from '../query';

// ─── State helpers ────────────────────────────────────────────────────────────

export function fetchLastIndexedLedger(): number {
  const sql = 'SELECT value FROM indexer_state WHERE key = ?';
  const row = timedQuery(sql, () =>
    getDb().prepare(sql).get('last_ledger') as { value: string } | undefined
  );
  return row ? parseInt(row.value, 10) : 0;
}

/** @deprecated Use fetchLastIndexedLedger instead. Will be removed in next release. */
export const getLastLedger = fetchLastIndexedLedger;

export function persistLastIndexedLedger(ledger: number): void {
  const sql = 'INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
  timedQuery(sql, () => getDb().prepare(sql).run('last_ledger', String(ledger)));
}

/** @deprecated Use persistLastIndexedLedger instead. Will be removed in next release. */
export const setLastLedger = persistLastIndexedLedger;
