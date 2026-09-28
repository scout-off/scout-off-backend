/**
 * Property-based tests for deterministic event ordering (#1323).
 *
 * Reproducing a failure
 * ---------------------
 * fast-check reports `{ seed, path }` on failure. Re-run the failing property with:
 *
 *   fc.assert(property, { seed: <reportedSeed>, path: '<reportedPath>', endOnFailure: true })
 *
 * Or temporarily set PROPERTY_SEED to the reported seed and lower NUM_RUNS.
 * Prefer checking in a minimized counterexample as a plain regression `it(...)`.
 */

import fc from 'fast-check';
import {
  normalizeAndSortEvents,
  groupCoTransactionEvents,
  compareEventOrdinals,
  type RawIndexerEvent,
  type NormalizedIndexerEvent,
} from '../../src/services/eventOrdering';

/** Fixed seed for reproducible CI runs. */
const PROPERTY_SEED = 1323;
const NUM_RUNS = 80;

function ordinalKey(e: NormalizedIndexerEvent): string {
  return `${e.ledger}:${e.txApplicationOrder}:${e.eventIndex}:${e.contractId}:${e.txHash}`;
}

function shuffleWithSeed<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const contractIdArb = fc.constantFrom('register', 'progress', 'subscription', 'connection', 'C');

const rawEventWithIdArb: fc.Arbitrary<RawIndexerEvent> = fc
  .record({
    ledger: fc.integer({ min: 1, max: 10_000 }),
    txOrder: fc.integer({ min: 0, max: 20 }),
    eventIndex: fc.integer({ min: 0, max: 20 }),
    contractId: contractIdArb,
    txSuffix: fc.integer({ min: 0, max: 9999 }),
  })
  .map(({ ledger, txOrder, eventIndex, contractId, txSuffix }) => ({
    ledger,
    txHash: `tx-${ledger}-${txOrder}-${txSuffix}`,
    contractId,
    id: `${ledger}-${txOrder}-${eventIndex}`,
    txIndex: txOrder,
    eventIndex,
  }));

function uniqueByOrdinal(events: RawIndexerEvent[]): RawIndexerEvent[] {
  const seen = new Set<string>();
  const out: RawIndexerEvent[] = [];
  for (const e of events) {
    const key = `${e.id}|${e.contractId}|${e.txHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

const eventBatchArb = fc
  .array(rawEventWithIdArb, { minLength: 0, maxLength: 25 })
  .map(uniqueByOrdinal);

describe('eventOrdering property tests (#1323)', () => {
  it('permutation invariance: any shuffle yields the same ordered output', () => {
    fc.assert(
      fc.property(eventBatchArb, fc.nat(), (batch, shuffleSeed) => {
        const forward = normalizeAndSortEvents(batch);
        const shuffled = shuffleWithSeed(batch, shuffleSeed);
        const fromPerm = normalizeAndSortEvents(shuffled);
        expect(fromPerm.map(ordinalKey)).toEqual(forward.map(ordinalKey));
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });

  it('stable total order: ordinals are non-decreasing under compareEventOrdinals', () => {
    fc.assert(
      fc.property(eventBatchArb, (batch) => {
        const ordered = normalizeAndSortEvents(batch);
        for (let i = 1; i < ordered.length; i++) {
          expect(compareEventOrdinals(ordered[i - 1], ordered[i])).toBeLessThanOrEqual(0);
          if (ordinalKey(ordered[i - 1]) !== ordinalKey(ordered[i])) {
            expect(compareEventOrdinals(ordered[i - 1], ordered[i])).toBeLessThan(0);
          }
        }
      }),
      { seed: PROPERTY_SEED + 1, numRuns: NUM_RUNS },
    );
  });

  it('grouping: every event in exactly one group; groups never mix tx hashes', () => {
    fc.assert(
      fc.property(eventBatchArb, (batch) => {
        const ordered = normalizeAndSortEvents(batch);
        const groups = groupCoTransactionEvents(ordered);
        const flat = groups.flat();
        expect(flat).toHaveLength(ordered.length);
        expect(flat.map(ordinalKey)).toEqual(ordered.map(ordinalKey));

        for (const group of groups) {
          const first = group[0];
          for (const e of group) {
            expect(e.txHash).toBe(first.txHash);
            expect(e.ledger).toBe(first.ledger);
            expect(e.txApplicationOrder).toBe(first.txApplicationOrder);
          }
        }
      }),
      { seed: PROPERTY_SEED + 2, numRuns: NUM_RUNS },
    );
  });
});
