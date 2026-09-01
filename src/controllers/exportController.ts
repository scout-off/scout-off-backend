import { Request, Response, NextFunction } from 'express';
import { EventExportRow, getEventsIterable } from '../db';
import { adminDateRangeSchema } from './adminController';
import type { ContractEventType } from '../types';

/**
 * Dangerous leading characters that spreadsheet applications (Excel, Google
 * Sheets, LibreOffice Calc) interpret as formula triggers when they appear as
 * the first character of a CSV field. Prefixing these fields with a tab
 * character is the OWASP-recommended mitigation for CSV injection.
 *
 * @see https://owasp.org/www-community/attacks/CSV_Injection
 */
const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Escapes a single CSV field per RFC 4180: any value containing a comma,
 * double quote, or newline (\n or \r) is wrapped in double quotes, with
 * internal double quotes doubled.
 *
 * Additionally neutralizes CSV formula injection (OWASP) by prefixing any
 * field whose first character is a spreadsheet formula trigger (=, +, -, @)
 * with a tab character. The tab causes spreadsheet applications to treat the
 * field as a string literal rather than evaluating it as a formula, while
 * remaining invisible in most display contexts. The resulting field is then
 * quoted per RFC 4180 so the tab is preserved correctly by all CSV parsers.
 */
export function csvEscapeField(value: string): string {
  // Neutralize formula-injection triggers before quoting so the sanitized
  // value is always safe regardless of whether it also contains RFC 4180
  // special characters.
  const safe = CSV_FORMULA_TRIGGER.test(value) ? `\t${value}` : value;

  if (/[",\n\r\t]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/** Formats a single event row as one CSV line (including trailing newline). */
export function formatEventCsvRow(row: EventExportRow): string {
  const timestampSeconds = Math.floor((row.createdAt ?? 0) / 1000);
  const fields = [
    csvEscapeField(row.type),
    String(row.ledger),
    String(timestampSeconds),
    csvEscapeField(JSON.stringify(row.payload)),
  ];
  return fields.join(',') + '\n';
}

/**
 * GET /api/admin/events/export
 *
 * Streams indexed contract events as CSV using Node's stream/backpressure
 * primitives.  Memory usage stays bounded and roughly constant regardless of
 * table size — rows are read one at a time via a better-sqlite3 cursor
 * (`Statement.iterate()`) and written to the response in small batches with
 * explicit backpressure handling.
 *
 * ## Consistency guarantee (concurrent indexer)
 *
 * The export opens a cursor that sees a stable snapshot of the `events`
 * table as of the first `next()` call.  Rows inserted by the concurrently
 * running indexer (`indexEvents()` in src/index.ts, every 5 s) after the
 * cursor is established are **consistently excluded** from the export — no
 * row appears twice and no row within the snapshot boundary is silently
 * dropped.  This is guaranteed by:
 *
 *   1. `Statement.iterate()` — the underlying prepared-statement cursor
 *      holds a SHARED lock on the database that either (a) in WAL mode
 *      provides snapshot isolation, or (b) in rollback-journal mode prevents
 *      concurrent writes for the cursor's lifetime.
 *   2. A single pass with a fixed ORDER BY — unlike repeated LIMIT/OFFSET
 *      pagination the cursor does not recompute offsets, so concurrent
 *      inserts cannot shift rows into or out of the result window.
 *
 * ## Truncation detection
 *
 * After the last data row the response ends with a footer line:
 *
 *   __EOF__,<row_count>,,
 *
 * CSV-consuming clients can check for this line to detect a truncated
 * export (e.g. a connection drop mid-stream).  If the last line of the
 * received file is not `__EOF__,<n>,,` the export is incomplete.
 *
 * Columns:
 *   event_type — Soroban contract event name (e.g. player_registered)
 *   ledger     — ledger sequence number when the event was emitted
 *   timestamp  — Unix epoch seconds
 *   payload    — JSON-encoded event payload
 *
 * Query params (identical semantics to GET /api/admin/events):
 *   startDate  — ISO 8601, inclusive lower bound on the event's indexed time
 *   endDate    — ISO 8601, inclusive upper bound on the event's indexed time
 *   eventType  — filter to a single contract event type
 *
 * ## Client-disconnect handling
 *
 * The `for...of` loop below drives a synchronous generator
 * (`getEventsIterable`), so it only yields control back to Node's event
 * loop when `res.write()` reports backpressure and we `await` a `drain`
 * event. That is not a reliable signal on its own: a client with a fast
 * connection, or a query whose rows are small enough to never fill the
 * socket buffer, can let the loop run to completion fully synchronously —
 * during which time Node has no opportunity to dispatch the request's
 * `'close'` event even if the socket already dropped. Every
 * `DISCONNECT_CHECK_INTERVAL` rows, the loop explicitly yields via
 * `setImmediate` and checks the disconnect flag, so a dead connection is
 * noticed within one batch instead of only when (if ever) a write happens
 * to block.
 */
const DISCONNECT_CHECK_INTERVAL = 500;

export async function exportEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = adminDateRangeSchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
    });
    return;
  }

  const { startDate, endDate, eventType } = parsed.data;
  const eventTypeFilter = eventType as ContractEventType | undefined;

  res.status(200);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="events.csv"');

  res.write('event_type,ledger,timestamp,payload\n');

  const iterable = getEventsIterable({ type: eventTypeFilter, startDate, endDate });

  // Clean up the SQLite cursor when the client disconnects mid-stream, and
  // record the disconnect so the loop below can notice it even when no
  // write ever blocks (see the disconnect-handling note above).
  let clientDisconnected = false;
  if (typeof req.on === 'function') {
    req.on('close', () => {
      clientDisconnected = true;
      iterable.return?.();
    });
  }

  let rowCount = 0;

  for (const row of iterable) {
    rowCount++;
    const line = formatEventCsvRow(row);

    if (!res.write(line)) {
      // Internal buffer is full — wait for drain before writing more
      await new Promise<void>((resolve) => res.once('drain', resolve));
    }

    if (rowCount % DISCONNECT_CHECK_INTERVAL === 0) {
      // Yield to the event loop so a pending 'close' event — which Node
      // cannot dispatch while this loop keeps the call stack busy — gets a
      // chance to run and flip clientDisconnected.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (clientDisconnected || res.writableEnded || res.destroyed) {
        return;
      }
    }
  }

  if (clientDisconnected || res.writableEnded || res.destroyed) {
    return;
  }

  // Footer: lets the client detect a truncated export (missing this line
  // means the stream was interrupted before all rows were sent).
  res.write(`__EOF__,${rowCount},,\n`);
  res.end();
}
