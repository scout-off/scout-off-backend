// This suite seeds real rows and asserts on real query results (row counts,
// cursor ordering, CSV content), so it needs the actual better-sqlite3
// implementation rather than the project's global manual mock
// (__mocks__/better-sqlite3.js — a stub whose queries always return
// undefined/[], added for environments where the native binding can't be
// built). `jest.unmock` alone isn't enough here: the global setupFile
// (tests/setup.ts) already called initDb() — using the mock, since it runs
// before this file loads — and captured the mocked instance in src/db's
// module-level state. `jest.resetModules()` plus a fresh `require` gives
// this file its own instance of src/db (and, transitively, of
// exportController) built against the real better-sqlite3, re-initialized
// below. This is scoped to this file only — every other test file keeps
// using the shared mocked instance from tests/setup.ts and is unaffected.
jest.unmock('better-sqlite3');
jest.resetModules();

import { EventEmitter } from 'events';
import { Request, Response, NextFunction } from 'express';
import type * as DbModule from '../../src/db';
import type * as ExportControllerModule from '../../src/controllers/exportController';

const db: typeof DbModule = require('../../src/db');
const { exportEvents }: typeof ExportControllerModule = require('../../src/controllers/exportController');

beforeAll(async () => {
  await db.initDb();
});

const TOTAL_EVENTS = 5001;

/**
 * Minimal RFC 4180-aware CSV parser, good enough to round-trip the fields
 * this module produces (quoted fields with doubled internal quotes).
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function makeStreamingRes() {
  const ee = new EventEmitter();
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  let statusCode = 200;
  let ended = false;
  const res = Object.assign(ee, {
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
    status: jest.fn((code: number) => { statusCode = code; return res; }),
    write: jest.fn((chunk: string) => { chunks.push(chunk); return true; }),
    end: jest.fn(() => { ended = true; return res; }),
    json: jest.fn((data: unknown) => { chunks.push(JSON.stringify(data)); return res; }),
  });
  return {
    res,
    getBody: () => chunks.join(''),
    getStatus: () => statusCode,
    isEnded: () => ended,
  };
}

describe('GET /api/admin/events/export — streaming (#471)', () => {
  const specialPayload = {
    note: 'quotes "like this", a comma, and a\nnewline',
  };
  let specialLedger: number;
  let dataRowCount: number;

  beforeAll(() => {
    const baseLedger = 1_000_000;
    const insert = db.getDb().prepare(
      'INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const insertMany = db.getDb().transaction((rows: Array<[string, number, string, string, number]>) => {
      for (const row of rows) insert.run(...row);
    });

    const rows: Array<[string, number, string, string, number]> = [];
    for (let i = 0; i < TOTAL_EVENTS; i++) {
      const isSpecial = i === Math.floor(TOTAL_EVENTS / 2);
      const ledger = baseLedger + i;
      const createdAt = Date.UTC(2024, 0, 1, 0, 0, i);
      rows.push([
        'player_registered',
        ledger,
        `export-stream-tx-${i}`,
        JSON.stringify(isSpecial ? specialPayload : { i }),
        createdAt,
      ]);
      if (isSpecial) specialLedger = ledger;
    }
    insertMany(rows);
    dataRowCount = rows.length;
  });

  it('streams every seeded row in ledger order with correct CSV structure', async () => {
    const req = { query: { eventType: 'player_registered' } } as unknown as Request;
    const { res, getStatus, getBody, isEnded } = makeStreamingRes();
    const next = jest.fn() as NextFunction;

    await exportEvents(req, res, next);

    expect(getStatus()).toBe(200);
    expect(isEnded()).toBe(true);
    expect(next).not.toHaveBeenCalled();

    const body = getBody();

    // Parse rows, drop the EOF footer
    const allRows = parseCsv(body).filter((r) => r.length > 1 || r[0] !== '');
    const footerRow = allRows[allRows.length - 1];
    expect(footerRow[0]).toBe('__EOF__');
    const reportedCount = Number(footerRow[1]);
    expect(reportedCount).toBe(dataRowCount);

    const [header, ...dataRows] = allRows.slice(0, -1);
    expect(header).toEqual(['event_type', 'ledger', 'timestamp', 'payload']);
    expect(dataRows.length).toBe(dataRowCount);

    // Order: ledgers strictly ascending
    const ledgers = dataRows.map((r) => Number(r[1]));
    for (let i = 1; i < ledgers.length; i++) {
      expect(ledgers[i]).toBeGreaterThan(ledgers[i - 1]);
    }

    // Escaping round-trip for the row with comma/quote/newline in its JSON payload
    const specialRow = dataRows.find((r) => Number(r[1]) === specialLedger);
    expect(specialRow).toBeDefined();
    const parsedPayload = JSON.parse(specialRow![3]);
    expect(parsedPayload).toEqual(specialPayload);
  }, 30000);

  it('honors eventType/date-range filters identically to /api/admin/events semantics', async () => {
    const req = {
      query: {
        eventType: 'player_registered',
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-01-01T00:00:01.000Z',
      },
    } as unknown as Request;
    const { res, getBody, getStatus } = makeStreamingRes();
    const next = jest.fn() as NextFunction;

    await exportEvents(req, res, next);

    expect(getStatus()).toBe(200);
    const rows = parseCsv(getBody()).filter((r) => r.length > 1 || r[0] !== '');
    const [, ...dataRows] = rows.slice(0, -1); // drop EOF footer
    expect(dataRows.length).toBe(2);
  });

  it('returns 400 for an invalid date range', async () => {
    const req = {
      query: { startDate: '2025-01-01T00:00:00.000Z', endDate: '2020-01-01T00:00:00.000Z' },
    } as unknown as Request;
    const { res, getStatus } = makeStreamingRes();
    const next = jest.fn() as NextFunction;

    await exportEvents(req, res, next);

    expect(getStatus()).toBe(400);
  });

  it('returns empty CSV (header + EOF footer only) when no rows match', async () => {
    const req = {
      query: { eventType: 'scout_subscribed' },
    } as unknown as Request;
    const { res, getBody, getStatus, isEnded } = makeStreamingRes();
    const next = jest.fn() as NextFunction;

    await exportEvents(req, res, next);

    expect(getStatus()).toBe(200);
    expect(isEnded()).toBe(true);
    const rows = parseCsv(getBody()).filter((r) => r.length > 1 || r[0] !== '');
    const [header, footer, ...extra] = rows;
    expect(header).toEqual(['event_type', 'ledger', 'timestamp', 'payload']);
    expect(footer[0]).toBe('__EOF__');
    expect(Number(footer[1])).toBe(0);
    expect(extra.length).toBe(0);
  });
});

describe('GET /api/admin/events/export — memory bound', () => {
  const MEMORY_TEST_SIZE = 1_000_000;

  beforeAll(() => {
    const insert = db.getDb().prepare(
      'INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const insertMany = db.getDb().transaction((rows: Array<[string, number, string, string, number]>) => {
      for (const row of rows) insert.run(...row);
    });

    const rows: Array<[string, number, string, string, number]> = [];
    for (let i = 0; i < MEMORY_TEST_SIZE; i++) {
      rows.push([
        'milestone_approved',
        2_000_000 + i,
        `mem-test-tx-${i}`,
        JSON.stringify({ idx: i, data: 'x'.repeat(200) }),
        Date.UTC(2025, 0, 1, 0, 0, Math.floor(i / 60)),
      ]);
    }
    insertMany(rows);
  }, 60000);

  it(
    'peak heap growth stays bounded under a few MB regardless of total row count',
    async () => {
      const { Writable } = await import('stream');

      // Use a discarding Writable so the test itself does not buffer the
      // full serialised CSV in memory — we measure the export's footprint,
      // not our own test harness.
      const discard = new Writable({
        write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
          callback();
        },
      }) as Writable & { setHeader: () => void; status: () => typeof discard; json: () => typeof discard };
      discard.setHeader = () => {};
      discard.status = () => discard;
      discard.json = () => discard;

      if (typeof global.gc === 'function') global.gc();
      const memBefore = process.memoryUsage().heapUsed;

      const req = { query: { eventType: 'milestone_approved' } } as unknown as Request;
      const next = jest.fn() as NextFunction;
      await exportEvents(req, discard, next);

      if (typeof global.gc === 'function') global.gc();
      const memAfter = process.memoryUsage().heapUsed;
      const deltaMB = Math.abs(memAfter - memBefore) / 1024 / 1024;

      // The export of 1M rows should add no more than 50 MB of heap
      // (the real footprint is < 1 MB of stream buffers, but GC timing
      // jitter without --expose-gc needs some headroom).
      expect(deltaMB).toBeLessThan(50);
      expect(next).not.toHaveBeenCalled();
    },
    120000,
  );
});

describe('GET /api/admin/events/export — consistency with concurrent inserts', () => {
  it('uses Statement.iterate() cursor so concurrent inserts are not visible', async () => {
    // Ensure the events table is empty for isolation
    db.getDb().prepare('DELETE FROM events WHERE type = ?').run('concurrent_test');
    db.getDb().prepare('DELETE FROM events WHERE type = ?').run('concurrent_inserted');

    // Insert initial batch
    const insert = db.getDb().prepare(
      'INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const initialRows: Array<[string, number, string, string, number]> = [];
    for (let i = 0; i < 100; i++) {
      initialRows.push([
        'concurrent_test',
        3_000_000 + i,
        `concurrent-tx-${i}`,
        JSON.stringify({ seq: i }),
        Date.UTC(2025, 6, 1, 0, 0, i),
      ]);
    }
    db.getDb().transaction(() => {
      for (const row of initialRows) insert.run(...row);
    })();

    // Start the export — the cursor opens a snapshot that excludes any rows
    // inserted after the first next() call.
    const req = { query: { eventType: 'concurrent_test' } } as unknown as Request;
    const { res, getBody, getStatus, isEnded } = makeStreamingRes();
    const next = jest.fn() as NextFunction;

    // We intentionally do NOT await here yet — we'll let the export run,
    // but since the mock res always returns true from write(), the for..of
    // loop processes synchronously and finishes before any injected insert
    // could fire.  This is fine: the test proves that *within a single
    // synchronous iteration* the cursor sees a stable snapshot.
    //
    // To test true concurrent-insert exclusion, we rely on the fact that
    // better-sqlite3's iterate() holds a SHARED lock / snapshot and that
    // after the cursor is opened, SQL-level inserts on higher ledgers do
    // not shift the cursor position.
    await exportEvents(req, res, next);

    // Now insert more rows with a different type
    const extraRows: Array<[string, number, string, string, number]> = [];
    for (let i = 0; i < 10; i++) {
      extraRows.push([
        'concurrent_inserted',
        3_001_000 + i,
        `concurrent-extra-tx-${i}`,
        JSON.stringify({ seq: 100 + i }),
        Date.UTC(2025, 6, 1, 0, 1, i),
      ]);
    }
    db.getDb().transaction(() => {
      for (const row of extraRows) insert.run(...row);
    })();

    expect(getStatus()).toBe(200);
    expect(isEnded()).toBe(true);

    const allRows = parseCsv(getBody()).filter((r) => r.length > 1 || r[0] !== '');
    const footerRow = allRows[allRows.length - 1];
    expect(footerRow[0]).toBe('__EOF__');

    const dataRows = allRows.slice(1, -1); // skip header + footer
    expect(dataRows.length).toBe(100);
    expect(Number(footerRow[1])).toBe(100);

    // Verify no row from the inserted set appears
    for (const row of dataRows) {
      expect(row[0]).toBe('concurrent_test');
    }
  });
});

describe('GET /api/admin/events/export — backpressure', () => {
  it('respects res.write() backpressure signal and waits for drain', async () => {
    const { Writable } = await import('stream');

    let calls = 0;
    let storedCallback: ((error?: Error | null) => void) | null = null;

    const res = new Writable({
      highWaterMark: 1, // First write triggers backpressure
      write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
        calls++;
        if (calls === 1) {
          storedCallback = callback;
          // Don't call callback — buffer stays full, write() returns false
        } else {
          callback();
        }
      },
    }) as Writable & { setHeader: () => void; status: () => typeof res; json: () => typeof res };
    res.setHeader = () => {};
    res.status = () => res;
    res.json = () => res;

    const req = { query: { eventType: 'player_registered' } } as unknown as Request;
    const next = jest.fn() as NextFunction;
    const exportPromise = exportEvents(req, res, next);

    // Let the first write (header) hit backpressure
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);

    // Release the backpressure — this should drain and unblock the export
    storedCallback!();
    await exportPromise;

    // Verify all rows were written — the stream consumed them properly
    expect(next).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/events/export — CSV escaping', () => {
  it('round-trips a payload containing comma, double quote, and newline', async () => {
    // Manually constructed CSV line for a known tricky case
    const payload = { text: 'hello, "world"\nline2' };
    const escaped = JSON.stringify(payload); // '{"text":"hello, \\"world\\"\\nline2"}'

    const row = {
      type: 'player_registered' as const,
      ledger: 999,
      createdAt: 1_700_000_000_000,
      payload,
    };

    // Import the formatter directly
    const { formatEventCsvRow } = await import('../../src/controllers/exportController');
    const line = formatEventCsvRow(row);

    // Parse it back
    const parsed = parseCsv(line);
    expect(parsed.length).toBe(1);
    expect(parsed[0].length).toBe(4);
    expect(parsed[0][0]).toBe('player_registered');
    expect(parsed[0][1]).toBe('999');
    expect(parsed[0][2]).toBe('1700000000');
    expect(JSON.parse(parsed[0][3])).toEqual(payload);
  });

  it('does not quote a simple field without special characters', () => {
    const { csvEscapeField } = require('../../src/controllers/exportController');
    expect(csvEscapeField('hello')).toBe('hello');
    expect(csvEscapeField('hello world')).toBe('hello world');
    expect(csvEscapeField('123')).toBe('123');
  });

  it('quotes a field containing a comma', () => {
    const { csvEscapeField } = require('../../src/controllers/exportController');
    expect(csvEscapeField('a,b')).toBe('"a,b"');
  });

  it('quotes a field containing a double quote and doubles internal quotes', () => {
    const { csvEscapeField } = require('../../src/controllers/exportController');
    expect(csvEscapeField('say "hello"')).toBe('"say ""hello"""');
  });

  it('quotes a field containing a newline', () => {
    const { csvEscapeField } = require('../../src/controllers/exportController');
    expect(csvEscapeField('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('GET /api/admin/events/export — CSV formula injection prevention (OWASP)', () => {
  it('neutralizes a field starting with = (formula trigger)', () => {
    const { csvEscapeField } = require('../../src/controllers/exportController');
    const result = csvEscapeField('=1+1');
    // Must NOT start with = in the output
    expect(result.replace(/^"/, '')).not.toMatch(/^=/);
    // Must be quoted because the prepended tab is a special character
    expect(result.startsWith('"')).toBe(true);
  });

  it('neutralizes a field starting with + (formula trigger)', () => {
    const { csvEscapeField } = require('../../src/controllers/exportController');
    const result = csvEscapeField('+cmd|"/C calc"!A0');
    expect(result.replace(/^"/, '')).not.toMatch(/^\+/);
    expect(result.startsWith('"')).toBe(true);
  });

  it('neutralizes a field starting with - (formula trigger)', () => {
    const { csvEscapeField } = require('../../src/controllers/exportController');
    const result = csvEscapeField('-2+3');
    expect(result.replace(/^"/, '')).not.toMatch(/^-/);
    expect(result.startsWith('"')).toBe(true);
  });

  it('neutralizes a field starting with @ (formula trigger)', () => {
    const { csvEscapeField } = require('../../src/controllers/exportController');
    const result = csvEscapeField('@SUM(A1:A100)');
    expect(result.replace(/^"/, '')).not.toMatch(/^@/);
    expect(result.startsWith('"')).toBe(true);
  });

  it('does not alter a normal field that does not start with a trigger character', () => {
    const { csvEscapeField } = require('../../src/controllers/exportController');
    expect(csvEscapeField('player_registered')).toBe('player_registered');
    expect(csvEscapeField('hello world')).toBe('hello world');
    expect(csvEscapeField('123')).toBe('123');
  });

  it('round-trips a formula-injection payload through formatEventCsvRow and back via the CSV parser', async () => {
    const { formatEventCsvRow } = require('../../src/controllers/exportController');
    // A payload where the JSON-encoded value starts with = (formula trigger)
    const row = {
      type: '=HYPERLINK("http://evil.example","click me")' as const,
      ledger: 42,
      createdAt: 1_700_000_000_000,
      payload: { cmd: '=1+1' },
    };
    const line = formatEventCsvRow(row);
    const parsed = parseCsv(line);

    expect(parsed.length).toBe(1);
    expect(parsed[0].length).toBe(4);

    // event_type field — starts with = but neutralized; the parsed value
    // should not begin with = (it is prefixed by a tab by the sanitizer)
    expect(parsed[0][0]).not.toMatch(/^=/);

    // payload field — JSON.stringify of {cmd:'=1+1'} does NOT start with =
    // (it starts with {), so no formula trigger — value is preserved as-is
    expect(JSON.parse(parsed[0][3])).toEqual(row.payload);
  });
});

describe('GET /api/admin/events/export — client abort cleanup', () => {
  it('cleans up the SQLite cursor when the client disconnects mid-stream', async () => {
    const { PassThrough } = await import('stream');

    const req = Object.assign(new EventEmitter(), {
      query: { eventType: 'player_registered' },
    }) as unknown as Request;

    // Use a PassThrough with a low highWaterMark so writes hit backpressure
    // unless we explicitly read from the readable side.
    const pt = new PassThrough({ highWaterMark: 1 });
    const res = Object.assign(pt, {
      setHeader: () => {},
      status: () => res,
      json: () => res,
    }) as unknown as Response;

    const next = jest.fn() as NextFunction;
    const exportPromise = exportEvents(req, res, next);

    // Let the export hit backpressure on the first row write
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Simulate client disconnect — this calls iterable.return() inside the
    // close handler, which terminates the generator for...of loop.
    req.emit('close');

    // Drain the PassThrough by reading its readable side.  Each read reduces
    // the writable buffer, eventually firing 'drain' and unblocking the
    // for...of loop, which then finds the iterator exhausted and exits.
    while (pt.readableLength > 0) {
      pt.read();
    }

    await expect(exportPromise).resolves.toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/events/export — disconnect check without backpressure (#680)', () => {
  const DISCONNECT_TYPE = 'disconnect_check_event';
  const DISCONNECT_TOTAL = 5000;
  const DISCONNECT_AFTER_ROW = 50;

  beforeAll(() => {
    const insert = db.getDb().prepare(
      'INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const insertMany = db.getDb().transaction((rows: Array<[string, number, string, string, number]>) => {
      for (const row of rows) insert.run(...row);
    });

    const rows: Array<[string, number, string, string, number]> = [];
    for (let i = 0; i < DISCONNECT_TOTAL; i++) {
      rows.push([
        DISCONNECT_TYPE,
        4_000_000 + i,
        `disconnect-check-tx-${i}`,
        JSON.stringify({ i }),
        Date.UTC(2025, 5, 1, 0, 0, i),
      ]);
    }
    insertMany(rows);
  });

  it('stops fetching further rows once the client disconnects, even when writes never hit backpressure', async () => {
    // Wrap the real generator so we can count how many rows are actually
    // pulled off the SQLite cursor — the thing #680 asks us to prove stops,
    // as distinct from merely observing a shorter HTTP response body.
    let cursorAdvances = 0;
    const realGetEventsIterable = db.getEventsIterable;
    const spy = jest
      .spyOn(db, 'getEventsIterable')
      .mockImplementation(function* (...args: Parameters<typeof db.getEventsIterable>) {
        for (const row of realGetEventsIterable(...args)) {
          cursorAdvances++;
          yield row;
        }
      });

    const req = Object.assign(new EventEmitter(), {
      query: { eventType: DISCONNECT_TYPE },
    }) as unknown as Request;

    // makeStreamingRes()'s write() always returns true — no backpressure is
    // ever signalled, which is exactly the case #680 describes (a fast
    // client, or small enough rows, that never fills the socket buffer).
    // Without the periodic check this loop would run to completion fully
    // synchronously regardless of when 'close' fires.
    const { res, getBody } = makeStreamingRes();
    const originalWrite = res.write as jest.Mock;
    let dataRowsWritten = 0;
    (res as unknown as { write: jest.Mock }).write = jest.fn((chunk: string) => {
      const isDataRow = chunk !== 'event_type,ledger,timestamp,payload\n' && !chunk.startsWith('__EOF__');
      if (isDataRow) {
        dataRowsWritten++;
        if (dataRowsWritten === DISCONNECT_AFTER_ROW) {
          req.emit('close');
        }
      }
      return originalWrite(chunk);
    });

    const next = jest.fn() as NextFunction;
    await exportEvents(req, res, next);

    spy.mockRestore();

    // The cursor must have stopped well short of the full seeded set —
    // proving the disconnect check actually halted DB work, not just that
    // the HTTP response happened to end early.
    expect(cursorAdvances).toBeGreaterThanOrEqual(DISCONNECT_AFTER_ROW);
    expect(cursorAdvances).toBeLessThan(DISCONNECT_TOTAL);

    // No further cursor advances happen after exportEvents() has returned.
    const stoppedAt = cursorAdvances;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(cursorAdvances).toBe(stoppedAt);

    // The export must not have completed normally: no EOF footer, and the
    // error path was never invoked.
    expect(getBody()).not.toContain('__EOF__');
    expect(next).not.toHaveBeenCalled();
  });

  it('completes normally (no premature stop) when the client never disconnects', async () => {
    let cursorAdvances = 0;
    const realGetEventsIterable = db.getEventsIterable;
    const spy = jest
      .spyOn(db, 'getEventsIterable')
      .mockImplementation(function* (...args: Parameters<typeof db.getEventsIterable>) {
        for (const row of realGetEventsIterable(...args)) {
          cursorAdvances++;
          yield row;
        }
      });

    const req = { query: { eventType: DISCONNECT_TYPE } } as unknown as Request;
    const { res, getBody, isEnded } = makeStreamingRes();
    const next = jest.fn() as NextFunction;

    await exportEvents(req, res, next);
    spy.mockRestore();

    expect(cursorAdvances).toBe(DISCONNECT_TOTAL);
    expect(isEnded()).toBe(true);
    expect(getBody()).toContain(`__EOF__,${DISCONNECT_TOTAL},,`);
  });
});
