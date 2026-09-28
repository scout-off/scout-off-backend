/**
 * Driver-agnostic DB helpers for tests (#1324).
 *
 * Use these instead of sync getDb().prepare() so suites run under DB_DRIVER=sqlite
 * and DB_DRIVER=postgres. PostgresDriver does NOT translate INSERT OR IGNORE at
 * runtime (only migrate.ts does during migrations).
 */

import config from '../../src/config';
import { getDriver } from '../../src/db';

export function isPostgres(): boolean {
  return config.dbDriver === 'postgres';
}

export async function dbRun(
  sql: string,
  params?: unknown[],
): Promise<{ changes: number; lastId: number }> {
  return getDriver().run(sql, params);
}

export async function dbGet<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
  return getDriver().get<T>(sql, params);
}

export async function dbAll<T>(sql: string, params?: unknown[]): Promise<T[]> {
  return getDriver().all<T>(sql, params);
}

export async function dbExec(sql: string): Promise<void> {
  return getDriver().exec(sql);
}

export interface TestEventInsert {
  type: string;
  ledger: number;
  ledger_hash?: string | null;
  tx_hash: string;
  payload?: string;
  created_at?: number;
  tx_application_order?: number;
  event_index?: number;
  contract_id?: string;
}

const EVENTS_COLUMNS =
  'type, ledger, ledger_hash, tx_hash, payload, created_at, tx_application_order, event_index, contract_id';

/**
 * Idempotent event insert matching indexer dedup on (tx_hash, event_index).
 */
export async function insertEvent(partial: TestEventInsert): Promise<{ changes: number; lastId: number }> {
  const {
    type,
    ledger,
    ledger_hash = null,
    tx_hash,
    payload = '{}',
    created_at = Date.now(),
    tx_application_order = 0,
    event_index = 0,
    contract_id = '',
  } = partial;

  const placeholders = '?, ?, ?, ?, ?, ?, ?, ?, ?';
  const params = [
    type,
    ledger,
    ledger_hash,
    tx_hash,
    payload,
    created_at,
    tx_application_order,
    event_index,
    contract_id,
  ];

  if (isPostgres()) {
    const sql = `INSERT INTO events (${EVENTS_COLUMNS}) VALUES (${placeholders})
      ON CONFLICT (tx_hash, event_index) DO NOTHING`;
    return dbRun(sql, params);
  }

  const sql = `INSERT OR IGNORE INTO events (${EVENTS_COLUMNS}) VALUES (${placeholders})`;
  return dbRun(sql, params);
}

export async function resetTables(tableNames: string[]): Promise<void> {
  for (const table of tableNames) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
      throw new Error(`refusing to reset unsafe table name: ${table}`);
    }
    await dbRun(`DELETE FROM ${table}`);
  }
}

export async function countEvents(type?: string): Promise<number> {
  if (type) {
    const row = await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM events WHERE type = ?', [
      type,
    ]);
    return row?.count ?? 0;
  }
  const row = await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM events');
  return row?.count ?? 0;
}

export async function fetchLastIndexedLedgerTest(): Promise<number> {
  const row = await dbGet<{ value: string }>(
    'SELECT value FROM indexer_state WHERE key = ?',
    ['last_ledger'],
  );
  return row ? parseInt(row.value, 10) : 0;
}

export async function persistLastIndexedLedgerTest(ledger: number): Promise<void> {
  const sql =
    'INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
  await dbRun(sql, ['last_ledger', String(ledger)]);
}
