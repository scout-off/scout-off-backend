/**
 * Repository: contract events: queries, keyset pagination, export and cursor helpers.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: SQLite-only — still calls `getDb()` directly (7 call(s)); slated for the #640 DbDriver migration.
 */
import { getDb, getDriver, timedQuery, timedQueryAsync } from '../query';
import config from '../../config';
import { EventRecord, ContractEventType } from '../../types';
import { EVENTS_ORDER_BY_SQL } from '../../services/eventOrdering';

// ─── Query helpers ────────────────────────────────────────────────────────────

interface EventRow {
  type: string;
  payload: string;
  created_at: number | null;
  ledger_hash: string | null;
}

export interface GetEventsOptions {
  limit?: number;
  offset?: number;
  payloadFilter?: EventPayloadFilter;
  payloadAnyOf?: EventPayloadFilter[];
  payloadIn?: Record<string, Array<string | number | boolean | null>>;
  createdAfter?: number;
}

export type EventPayloadFilter = Record<string, string | number | boolean | null>;

function eventPayloadPredicate(
  filters: Pick<GetEventsOptions, 'payloadFilter' | 'payloadAnyOf' | 'payloadIn' | 'createdAfter'>,
): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const column = (field: string): string => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
      throw new Error(`Invalid event payload field: ${field}`);
    }
    return `json_extract(payload, '$."${field}"')`;
  };

  for (const [field, value] of Object.entries(filters.payloadFilter ?? {})) {
    clauses.push(`${column(field)} = ?`);
    params.push(value);
  }

  if (filters.payloadAnyOf?.length) {
    const alternatives = filters.payloadAnyOf.map((filter) => {
      const entries = Object.entries(filter);
      if (entries.length === 0) {
        throw new Error('Event payload alternatives must not be empty');
      }
      const conjunction = entries.map(([field, value]) => {
        params.push(value);
        return `${column(field)} = ?`;
      });
      return `(${conjunction.join(' AND ')})`;
    });
    clauses.push(`(${alternatives.join(' OR ')})`);
  }

  for (const [field, values] of Object.entries(filters.payloadIn ?? {})) {
    if (values.length === 0) {
      clauses.push('1 = 0');
      continue;
    }
    clauses.push(`${column(field)} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  }

  if (filters.createdAfter !== undefined) {
    clauses.push('created_at >= ?');
    params.push(filters.createdAfter);
  }

  return {
    sql: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '',
    params,
  };
}

export function queryEvents(
  type?: ContractEventType,
  opts?: GetEventsOptions,
): EventRecord[] {
  const db = getDb();
  const { limit, offset } = opts ?? {};
  const hasPagination = limit !== undefined && offset !== undefined;
  const payloadPredicate = eventPayloadPredicate(opts ?? {});

  let sql: string;
  let rows: EventRow[];
  if (type && hasPagination) {
    // sql-injection-check-ignore: EVENTS_ORDER_BY_SQL is a hardcoded ORDER BY fragment; values are bound via params.
    sql = `SELECT * FROM events WHERE type = ?${payloadPredicate.sql} ORDER BY ${EVENTS_ORDER_BY_SQL} LIMIT ? OFFSET ?`;
    rows = timedQuery(sql, () => db.prepare(sql).all(type, ...payloadPredicate.params, limit, offset) as EventRow[]);
  } else if (type) {
    // sql-injection-check-ignore: EVENTS_ORDER_BY_SQL is a hardcoded ORDER BY fragment; values are bound via params.
    sql = `SELECT * FROM events WHERE type = ?${payloadPredicate.sql} ORDER BY ${EVENTS_ORDER_BY_SQL}`;
    rows = timedQuery(sql, () => db.prepare(sql).all(type, ...payloadPredicate.params) as EventRow[]);
  } else if (hasPagination) {
    // sql-injection-check-ignore: EVENTS_ORDER_BY_SQL is a hardcoded ORDER BY fragment; values are bound via params.
    sql = `SELECT * FROM events WHERE 1 = 1${payloadPredicate.sql} ORDER BY ${EVENTS_ORDER_BY_SQL} LIMIT ? OFFSET ?`;
    rows = timedQuery(sql, () => db.prepare(sql).all(...payloadPredicate.params, limit, offset) as EventRow[]);
  } else {
    // sql-injection-check-ignore: EVENTS_ORDER_BY_SQL is a hardcoded ORDER BY fragment; values are bound via params.
    sql = `SELECT * FROM events WHERE 1 = 1${payloadPredicate.sql} ORDER BY ${EVENTS_ORDER_BY_SQL}`;
    rows = timedQuery(sql, () => db.prepare(sql).all(...payloadPredicate.params) as EventRow[]);
  }

  return rows.map((r) => ({
    source: config.contractId,
    type: r.type as ContractEventType,
    payload: JSON.parse(r.payload),
    contractAddress: config.contractId,
    created_at: r.created_at,
  }));
}

/** @deprecated Use queryEvents instead. Will be removed in next release. */
export const getEvents = queryEvents;

export function rollbackEventsFromLedger(ledger: number): void {
  const db = getDb();
  // Delete pending milestones associated with these events (since they might be re-indexed)
  // Actually, wait, it's safer to just let the indexer re-insert, but pending_milestones has a unique milestone_id so INSERT OR IGNORE will handle it.
  // We'll delete events from the specified ledger forwards.
  db.prepare('DELETE FROM events WHERE ledger >= ?').run(ledger);
}

export function getEventsCount(
  type?: ContractEventType,
  filters?: Pick<GetEventsOptions, 'payloadFilter' | 'payloadAnyOf' | 'payloadIn' | 'createdAfter'>,
): number {
  const db = getDb();
  const payloadPredicate = eventPayloadPredicate(filters ?? {});
  const sql = type
    // sql-injection-check-ignore: payloadPredicate.sql is built from validated field names and `?` placeholders; values are bound via params.
    ? `SELECT COUNT(*) AS count FROM events WHERE type = ?${payloadPredicate.sql}`
    // sql-injection-check-ignore: payloadPredicate.sql is built from validated field names and `?` placeholders; values are bound via params.
    : `SELECT COUNT(*) AS count FROM events WHERE 1 = 1${payloadPredicate.sql}`;
  const params = type ? [type, ...payloadPredicate.params] : payloadPredicate.params;
  const row = timedQuery(sql, () => db.prepare(sql).get(...params) as { count: number } | undefined);
  return row?.count ?? 0;
}

/** Filter accepted by {@link getEventsPage} — mirrors `adminDateRangeSchema` in adminController. */
export interface EventsPageFilter {
  type?: ContractEventType;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Opaque cursor used by the keyset-pagination variant of the events listing.
 * Encodes the (ledger, id) position of the last row returned on the previous
 * page so that the next page starts immediately after it, independent of
 * concurrent inserts.
 */
export interface EventsCursor {
  ledger: number;
  id: number;
}

/**
 * Encode a (ledger, id) pair into a URL-safe opaque cursor string.
 */
export function encodeEventsCursor(cursor: EventsCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/**
 * Decode a cursor string produced by {@link encodeEventsCursor}.
 * Returns `null` when the value is missing, malformed, or contains
 * non-integer fields — callers should treat `null` as "start from the
 * beginning".
 */
export function decodeEventsCursor(raw: string | undefined): EventsCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'ledger' in parsed &&
      'id' in parsed &&
      Number.isInteger((parsed as Record<string, unknown>).ledger) &&
      Number.isInteger((parsed as Record<string, unknown>).id)
    ) {
      return parsed as EventsCursor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch one page of events using a stable keyset cursor over (ledger DESC, id DESC).
 * When `afterCursor` is supplied only rows with (ledger, id) < (cursor.ledger, cursor.id)
 * are returned, making pagination stable under concurrent inserts.
 *
 * Returns up to `limit` rows and, when there are more rows beyond the page, a
 * `nextCursor` value ready to be encoded and returned to the client.
 */
export function getEventsPageKeyset(
  filter: EventsPageFilter,
  limit: number,
  afterCursor: EventsCursor | null,
): { rows: EventExportRow[]; nextCursor: EventsCursor | null } {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.type) {
    clauses.push('type = ?');
    params.push(filter.type);
  }
  if (filter.startDate) {
    clauses.push('created_at >= ?');
    params.push(filter.startDate.getTime());
  }
  if (filter.endDate) {
    clauses.push('created_at <= ?');
    params.push(filter.endDate.getTime());
  }
  if (afterCursor) {
    // Keyset condition: rows that come before the cursor in DESC order
    clauses.push('(ledger < ? OR (ledger = ? AND id < ?))');
    params.push(afterCursor.ledger, afterCursor.ledger, afterCursor.id);
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  // Fetch one extra row to know whether a next page exists
  const fetchLimit = limit + 1;
  params.push(fetchLimit);

  const sql =
    'SELECT id, type, ledger, payload, created_at FROM events ' +
    where +
    ' ORDER BY ledger DESC, id DESC LIMIT ?';

  const rawRows = timedQuery(sql, () => db.prepare(sql).all(...(params as unknown[]))) as Array<{
    id: number;
    type: string;
    ledger: number;
    payload: string;
    created_at: number | null;
  }>;

  const hasMore = rawRows.length > limit;
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;

  const rows: EventExportRow[] = pageRows.map((r) => ({
    type: r.type as ContractEventType,
    ledger: r.ledger,
    createdAt: r.created_at,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  }));

  let nextCursor: EventsCursor | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!;
    nextCursor = { ledger: last.ledger, id: last.id };
  }

  return { rows, nextCursor };
}

/** A single row read directly off the `events` table, including `ledger`, for CSV export. */
export interface EventExportRow {
  type: ContractEventType;
  ledger: number;
  createdAt: number | null;
  payload: Record<string, unknown>;
}

/**
 * Count indexed events at the SQL level, filtered by type and/or created_at range.
 * Used to populate the `total` field in paginated event responses without loading
 * all matching rows into memory.
 */
export function countEventsFiltered(filter: EventsPageFilter): number {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.type) {
    clauses.push('type = ?');
    params.push(filter.type);
  }
  if (filter.startDate) {
    clauses.push('created_at >= ?');
    params.push(filter.startDate.getTime());
  }
  if (filter.endDate) {
    clauses.push('created_at <= ?');
    params.push(filter.endDate.getTime());
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql = 'SELECT COUNT(*) AS count FROM events ' + where;
  const row = timedQuery(sql, () =>
    db.prepare(sql).get(...(params as unknown[])) as { count: number } | undefined,
  );
  return row?.count ?? 0;
}

/**
 * Fetches one bounded page of indexed events (LIMIT/OFFSET), filtered at the
 * SQL level by type and/or created_at range, ordered by ledger ascending
 * (ties broken by insertion order via `id`).
 *
 * This is the building block that makes streaming export possible: callers
 * loop, increasing `offset` by `limit` each time, until a page comes back
 * shorter than `limit` — at no point does the whole table need to live in
 * memory at once.
 */
export function getEventsPage(filter: EventsPageFilter, limit: number, offset: number): EventExportRow[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.type) {
    clauses.push('type = ?');
    params.push(filter.type);
  }
  if (filter.startDate) {
    clauses.push('created_at >= ?');
    params.push(filter.startDate.getTime());
  }
  if (filter.endDate) {
    clauses.push('created_at <= ?');
    params.push(filter.endDate.getTime());
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql =
    'SELECT type, ledger, payload, created_at FROM events ' +
    where +
    ` ORDER BY ${EVENTS_ORDER_BY_SQL} LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = timedQuery(sql, () => db.prepare(sql).all(...(params as unknown[]))) as Array<{
    type: string;
    ledger: number;
    payload: string;
    created_at: number | null;
  }>;

  return rows.map((r) => ({
    type: r.type as ContractEventType,
    ledger: r.ledger,
    createdAt: r.created_at,
    payload: JSON.parse(r.payload),
  }));
}

/**
 * Generator that lazily yields one event row at a time using
 * better-sqlite3's `Statement.iterate()` cursor, filtered by type and/or
 * created_at range, ordered by ledger ascending (ties broken by id).
 *
 * Unlike LIMIT/OFFSET pagination this uses a single prepared statement
 * cursor, so the result is a stable snapshot that does not drift when the
 * indexer inserts rows concurrently — no duplicates or skipped rows.
 */
export function* getEventsIterable(filter: EventsPageFilter): Generator<EventExportRow, void, void> {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.type) {
    clauses.push('type = ?');
    params.push(filter.type);
  }
  if (filter.startDate) {
    clauses.push('created_at >= ?');
    params.push(filter.startDate.getTime());
  }
  if (filter.endDate) {
    clauses.push('created_at <= ?');
    params.push(filter.endDate.getTime());
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql =
    'SELECT type, ledger, payload, created_at FROM events ' +
    where +
    ` ORDER BY ${EVENTS_ORDER_BY_SQL}`;

  const stmt = db.prepare(sql);
  const iterator = stmt.iterate(...(params as unknown[])) as IterableIterator<{
    type: string;
    ledger: number;
    payload: string;
    created_at: number | null;
  }>;

  for (const row of iterator) {
    yield {
      type: row.type as ContractEventType,
      ledger: row.ledger,
      createdAt: row.created_at,
      payload: JSON.parse(row.payload),
    };
  }
}


// ─── Unprocessed indexer events (#1540) ──────────────────────────────────────

/**
 * A contract event the indexer could not apply — either an unrecognised topic
 * (`unknown_type`) or one whose value failed to decode (`decode_error`). Rows
 * retain enough of the raw event (topic + value XDR) to be replayed later via
 * `POST /api/admin/indexer/unprocessed/:id/retry` once the decoder is fixed.
 *
 * Deduplicated on `(tx_hash, event_index)` so a re-poll that re-encounters the
 * same event does not create a second row.
 */
export interface UnprocessedEventRow {
  id: number;
  type: string | null;
  ledger: number;
  tx_hash: string;
  event_index: number;
  contract_id: string | null;
  /** JSON array of the event's raw topics (base64 XDR), for replay. */
  topic_json: string | null;
  /** Base64 XDR of the event's raw value, for replay. */
  value_xdr: string | null;
  /** Machine-readable reason: `unknown_type` or `decode_error`. */
  reason: string;
  /** JSON-encoded partially-decoded payload, when available. */
  payload: string | null;
  created_at: number;
}

/**
 * Record an event the indexer could not apply. Idempotent on
 * `(tx_hash, event_index)` — replaying the same event (e.g. a reorg that
 * rewinds the cursor) updates the existing row rather than duplicating it.
 */
export async function insertUnprocessedEvent(p: {
  type: string | null;
  ledger: number;
  tx_hash: string;
  event_index: number;
  contract_id: string | null;
  topic_json: string | null;
  value_xdr: string | null;
  reason: string;
  payload: string | null;
}): Promise<void> {
  const sql = `INSERT INTO indexer_unprocessed_events
      (type, ledger, tx_hash, event_index, contract_id, topic_json, value_xdr, reason, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tx_hash, event_index) DO UPDATE SET
       type = excluded.type,
       ledger = excluded.ledger,
       contract_id = excluded.contract_id,
       topic_json = excluded.topic_json,
       value_xdr = excluded.value_xdr,
       reason = excluded.reason,
       payload = excluded.payload,
       created_at = excluded.created_at`;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [
      p.type,
      p.ledger,
      p.tx_hash,
      p.event_index,
      p.contract_id,
      p.topic_json,
      p.value_xdr,
      p.reason,
      p.payload,
      Date.now(),
    ]),
  );
}

/**
 * Fetch one page of unprocessed events, newest first, optionally filtered by
 * `reason`. Also returns the total count for pagination metadata.
 */
export async function listUnprocessedEvents(opts: {
  limit?: number;
  offset?: number;
  reason?: string;
}): Promise<{ data: UnprocessedEventRow[]; total: number }> {
  const driver = getDriver();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const where = opts.reason ? 'WHERE reason = ?' : '';
  const params = opts.reason ? [opts.reason] : [];

  // sql-injection-ok: `where` is either empty or the fixed 'WHERE reason = ?'.
  const countSql = `SELECT COUNT(*) AS count FROM indexer_unprocessed_events ${where}`;
  const countRow = await timedQueryAsync(countSql, () =>
    driver.get<{ count: number | string }>(countSql, params),
  );
  const total = Number(countRow?.count ?? 0);

  // sql-injection-ok: `where` is either empty or the fixed 'WHERE reason = ?'.
  const dataSql = `SELECT * FROM indexer_unprocessed_events ${where}
                   ORDER BY created_at DESC, id DESC
                   LIMIT ? OFFSET ?`;
  const data = await timedQueryAsync(dataSql, () =>
    driver.all<UnprocessedEventRow>(dataSql, [...params, limit, offset]),
  );

  return { data, total };
}

/** Fetch a single unprocessed event by id, or null when absent. */
export async function getUnprocessedEventById(id: number): Promise<UnprocessedEventRow | null> {
  const sql = 'SELECT * FROM indexer_unprocessed_events WHERE id = ?';
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<UnprocessedEventRow>(sql, [id])) ?? null,
  );
}

/** Delete an unprocessed event once it has been replayed (or discarded). */
export async function deleteUnprocessedEvent(id: number): Promise<void> {
  const sql = 'DELETE FROM indexer_unprocessed_events WHERE id = ?';
  await timedQueryAsync(sql, () => getDriver().run(sql, [id]));
}
