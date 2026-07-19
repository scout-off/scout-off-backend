import Database from 'better-sqlite3';
import { server } from './stellar';
import config from '../config';
import { EventRecord, ContractEventType } from '../types';

// ─── Deduplication strategy ───────────────────────────────────────────────────
//
// Primary deduplication: the `events` table has a UNIQUE constraint on `tx_hash`.
// INSERT OR IGNORE silently discards any row whose tx_hash already exists, so
// replaying the same ledger range is safe and idempotent.
//
// Canonical event ID: each event is identified by the tuple
//   (contractId, ledger, txHash, topicIndex)
// normalizeEventId() encodes this as a single opaque string that can be used
// for in-memory dedup checks before hitting the DB (e.g. in tests or caches).
//
// Stub hooks (onBeforeInsert / onAfterInsert) are called around every insert so
// future logic (metrics, alerting, secondary caches) can be added without
// touching the core indexing loop.

/**
 * Returns a canonical, stable ID for a contract event.
 * Format: `<contractId>:<ledger>:<txHash>`
 */
export function normalizeEventId(contractId: string, ledger: number, txHash: string): string {
  return `${contractId}:${ledger}:${txHash}`;
}

// Stub hook — replace with real logic as needed (e.g. metrics, alerting).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function onBeforeInsert(_eventId: string): void {
  /* hook */
}

// Stub hook — called after a successful insert (INSERT OR IGNORE may be a no-op).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function onAfterInsert(_eventId: string): void {
  /* hook */
}

// ─── DB setup ────────────────────────────────────────────────────────────────

const db = new Database(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL,
    ledger    INTEGER NOT NULL,
    tx_hash   TEXT NOT NULL UNIQUE,
    payload   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS indexer_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function getLastLedger(): number {
  const row = db.prepare('SELECT value FROM indexer_state WHERE key = ?').get('last_ledger') as
    { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

function setLastLedger(ledger: number): void {
  db.prepare(
    'INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('last_ledger', String(ledger));
}

// ─── Indexer ─────────────────────────────────────────────────────────────────

const insert = db.prepare(
  'INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload) VALUES (?, ?, ?, ?)'
);

export async function indexEvents(): Promise<void> {
  const fromLedger = getLastLedger();

  const response = await server.getEvents({
    startLedger: fromLedger || undefined,
    filters: [{ type: 'contract', contractIds: [config.contractId] }],
  });

  if (!response.events.length) return;

  const insertMany = db.transaction((events: typeof response.events) => {
    for (const raw of events) {
      const eventId = normalizeEventId(config.contractId, raw.ledger, raw.txHash);
      onBeforeInsert(eventId);
      insert.run(
        raw.topic[0]?.value() as string,
        raw.ledger,
        raw.txHash,
        JSON.stringify(raw.value?.value() ?? {})
      );
      onAfterInsert(eventId);
    }
  });

  insertMany(response.events);

  const latest = response.events.at(-1)!;
  setLastLedger(latest.ledger + 1);
}

// ─── Query helpers ────────────────────────────────────────────────────────────

export function getEvents(type?: ContractEventType): EventRecord[] {
  const rows = type
    ? (db.prepare('SELECT * FROM events WHERE type = ? ORDER BY ledger ASC').all(type) as any[])
    : (db.prepare('SELECT * FROM events ORDER BY ledger ASC').all() as any[]);

  return rows.map((r) => ({
    source: config.contractId,
    type: r.type as ContractEventType,
    payload: JSON.parse(r.payload),
    contractAddress: config.contractId,
  }));
}
