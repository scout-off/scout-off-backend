/**
 * Tests for the core backfill logic used by scripts/backfill.js
 * and the INDEXER_BACKFILL_FROM_LEDGER guard in src/index.ts.
 *
 * Exercises initDb → fetchLastIndexedLedger → persistLastIndexedLedger round-trip,
 * normal backfill-to-earlier-ledger, and the already-past-target
 * edge case where the reset should be a no-op.
 */

import { fetchLastIndexedLedger, persistLastIndexedLedger, getDb } from '../../src/db';

describe('backfill core logic (scripts/backfill.js)', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM indexer_state').run();
  });

  it('fetchLastIndexedLedger returns 0 when no state exists', () => {
    expect(fetchLastIndexedLedger()).toBe(0);
  });

  it('persistLastIndexedLedger / fetchLastIndexedLedger round-trips correctly', () => {
    persistLastIndexedLedger(5_000_000);
    expect(fetchLastIndexedLedger()).toBe(5_000_000);
  });

  it('resets last_ledger to an earlier value (normal backfill)', () => {
    persistLastIndexedLedger(10_000_000);
    expect(fetchLastIndexedLedger()).toBe(10_000_000);

    persistLastIndexedLedger(8_000_000);
    expect(fetchLastIndexedLedger()).toBe(8_000_000);
  });

  it('overwrites last_ledger with a higher value (unconditional set)', () => {
    persistLastIndexedLedger(1_000_000);
    expect(fetchLastIndexedLedger()).toBe(1_000_000);

    persistLastIndexedLedger(9_000_000);
    expect(fetchLastIndexedLedger()).toBe(9_000_000);
  });

  it('is idempotent — setting the same ledger twice is safe', () => {
    persistLastIndexedLedger(3_000_000);
    persistLastIndexedLedger(3_000_000);
    expect(fetchLastIndexedLedger()).toBe(3_000_000);
  });
});

describe('INDEXER_BACKFILL_FROM_LEDGER guard (src/index.ts)', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM indexer_state').run();
  });

  /**
   * Mirrors the guard logic from src/index.ts:
   *
   *   if (config.backfillFromLedger !== null) {
   *     const stored = fetchLastIndexedLedger();
   *     if (config.backfillFromLedger < stored) {
   *       persistLastIndexedLedger(config.backfillFromLedger);
   *     }
   *   }
   *
   * The guard only resets when the target is strictly less than the stored value.
   */

  function applyBackfillGuard(backfillFromLedger: number): boolean {
    const stored = fetchLastIndexedLedger();
    if (backfillFromLedger < stored) {
      persistLastIndexedLedger(backfillFromLedger);
      return true; // reset happened
    }
    return false; // no-op
  }

  it('resets last_ledger when target is earlier than stored', () => {
    persistLastIndexedLedger(10_000_000);

    const didReset = applyBackfillGuard(7_000_000);

    expect(didReset).toBe(true);
    expect(fetchLastIndexedLedger()).toBe(7_000_000);
  });

  it('is a no-op when target equals the stored value', () => {
    persistLastIndexedLedger(5_000_000);

    const didReset = applyBackfillGuard(5_000_000);

    expect(didReset).toBe(false);
    expect(fetchLastIndexedLedger()).toBe(5_000_000);
  });

  it('is a no-op when target is already past the current indexed point', () => {
    persistLastIndexedLedger(3_000_000);

    const didReset = applyBackfillGuard(9_000_000);

    expect(didReset).toBe(false);
    expect(fetchLastIndexedLedger()).toBe(3_000_000);
  });

  it('is a no-op when no prior state exists and target is positive', () => {
    // fetchLastIndexedLedger() returns 0 when indexer_state is empty
    const didReset = applyBackfillGuard(1_000_000);

    expect(didReset).toBe(false);
    expect(fetchLastIndexedLedger()).toBe(0);
  });

  it('resets when stored is 0 and target is also 0 (equal — no-op)', () => {
    const didReset = applyBackfillGuard(0);

    expect(didReset).toBe(false);
    expect(fetchLastIndexedLedger()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #884: backfill event idempotency
// ---------------------------------------------------------------------------
//
// The events table has a UNIQUE constraint on tx_hash (db/001_initial.sql).
// The indexer inserts with INSERT OR IGNORE, so re-processing the same ledger
// range must never create duplicate rows.
// ---------------------------------------------------------------------------

describe('backfill event idempotency (#884)', () => {
  /** Insert a batch of synthetic events for ledgers [startLedger, endLedger] (inclusive).
   *  Each event gets a deterministic tx_hash so the same range always produces
   *  the same hashes — enabling duplicate detection. */
  function insertEventsForRange(startLedger: number, endLedger: number): void {
    const db = getDb();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload)
       VALUES (?, ?, ?, ?)`
    );
    const insertMany = db.transaction(
      (start: number, end: number) => {
        for (let ledger = start; ledger <= end; ledger++) {
          insert.run(
            'player_registered',
            ledger,
            `tx-${ledger}-backfill-test`,
            JSON.stringify({ player_id: `p-${ledger}` })
          );
        }
      }
    );
    insertMany(startLedger, endLedger);
  }

  function countEvents(): number {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM events')
      .get() as { n: number };
    return row.n;
  }

  function countByTxHash(txHash: string): number {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM events WHERE tx_hash = ?')
      .get(txHash) as { n: number };
    return row.n;
  }

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM events').run();
    db.prepare('DELETE FROM indexer_state').run();
  });

  // ── Test 1 ────────────────────────────────────────────────────────────────
  it('first backfill run inserts N events for ledger range 1–100', () => {
    insertEventsForRange(1, 100);
    expect(countEvents()).toBe(100);
  });

  // ── Test 2 ────────────────────────────────────────────────────────────────
  it('second backfill run for the same range 1–100 does not increase event count', () => {
    // First run
    insertEventsForRange(1, 100);
    const afterFirstRun = countEvents();
    expect(afterFirstRun).toBe(100);

    // Second run — identical range, identical tx_hashes
    insertEventsForRange(1, 100);
    const afterSecondRun = countEvents();

    // Count must stay exactly the same
    expect(afterSecondRun).toBe(afterFirstRun);
  });

  // ── Test 3 ────────────────────────────────────────────────────────────────
  it('extended backfill range 1–200 inserts only the new events (101–200)', () => {
    // Seed ledgers 1–100 first
    insertEventsForRange(1, 100);
    const afterFirst = countEvents();
    expect(afterFirst).toBe(100);

    // Now "backfill" the full range 1–200 (simulates replaying from ledger 1)
    insertEventsForRange(1, 200);
    const afterExtended = countEvents();

    // Only 100 new rows should have been added (101–200)
    expect(afterExtended).toBe(afterFirst + 100);
    expect(afterExtended).toBe(200);
  });

  // ── Test 4 ────────────────────────────────────────────────────────────────
  it('UNIQUE constraint on tx_hash is responsible for deduplication — each tx_hash appears exactly once', () => {
    // Insert twice for the same range
    insertEventsForRange(1, 50);
    insertEventsForRange(1, 50);

    // Every synthetic tx_hash in the range should appear exactly once
    for (let ledger = 1; ledger <= 50; ledger++) {
      const txHash = `tx-${ledger}-backfill-test`;
      expect(countByTxHash(txHash)).toBe(1);
    }

    // Total row count must equal the range size, not double it
    expect(countEvents()).toBe(50);
  });
});
