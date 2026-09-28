/**
 * Property-based tests for indexer normalisation + DB idempotency (#1323).
 *
 * Reproducing a failure
 * ---------------------
 * fast-check reports `{ seed, path }` on failure. Re-run with:
 *
 *   fc.assert(property, { seed: <reportedSeed>, path: '<reportedPath>', endOnFailure: true })
 *
 * Side-effect idempotency (webhooks / tier updates on re-fetch within the
 * finality margin) is known to fail today — tracked separately. This suite
 * asserts DB-level idempotency via INSERT OR IGNORE / ON CONFLICT DO NOTHING.
 */

import fc from 'fast-check';
import { normalizeEventId, normalizePayload } from '../../src/services/indexer';
import { insertEvent, dbAll, countEvents } from '../helpers/db';

const PROPERTY_SEED = 1323;
const NUM_RUNS = 60;

describe('indexer normalizePayload / normalizeEventId properties (#1323)', () => {
  it('normalizePayload is idempotent and preserves values', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,12}$/),
          fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
          { maxKeys: 8 },
        ),
        (payload) => {
          const once = normalizePayload(payload);
          const twice = normalizePayload(once);
          expect(twice).toEqual(once);
          expect(Object.values(once)).toEqual(Object.values(payload));
        },
      ),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });

  it('normalizeEventId is deterministic for the same tuple', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^C[A-Z0-9]{0,8}$/),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.stringMatching(/^tx[a-z0-9]{4,16}$/),
        fc.integer({ min: 0, max: 50 }),
        (contractId, ledger, txHash, eventIndex) => {
          const a = normalizeEventId(contractId, ledger, txHash, eventIndex);
          const b = normalizeEventId(contractId, ledger, txHash, eventIndex);
          expect(a).toBe(b);
          expect(a).toBe(`${contractId}:${ledger}:${txHash}:${eventIndex}`);
        },
      ),
      { seed: PROPERTY_SEED + 1, numRuns: NUM_RUNS },
    );
  });
});

describe('indexer DB idempotency properties (#1323)', () => {
  it('re-inserting the same batch (or overlapping windows) yields the same unique rows', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            ledger: fc.integer({ min: 1, max: 500 }),
            txOrder: fc.integer({ min: 0, max: 5 }),
            eventIndex: fc.integer({ min: 0, max: 5 }),
            suffix: fc.integer({ min: 0, max: 99999 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (raw) => {
          // Unique by (tx_hash, event_index)
          const seen = new Set<string>();
          const batch = [];
          for (const r of raw) {
            const tx_hash = `prop-tx-${r.ledger}-${r.txOrder}-${r.suffix}`;
            const key = `${tx_hash}:${r.eventIndex}`;
            if (seen.has(key)) continue;
            seen.add(key);
            batch.push({
              type: 'player_registered',
              ledger: r.ledger,
              tx_hash,
              event_index: r.eventIndex,
              tx_application_order: r.txOrder,
              contract_id: 'register',
              payload: JSON.stringify({ player_id: `p-${r.suffix}` }),
            });
          }
          if (batch.length === 0) return;

          for (const ev of batch) {
            await insertEvent(ev);
          }
          const afterFirst = await countEvents('player_registered');

          // Replay full batch (finality-margin re-delivery)
          for (const ev of batch) {
            await insertEvent(ev);
          }
          const afterReplay = await countEvents('player_registered');
          expect(afterReplay).toBe(afterFirst);

          // Overlapping window: first half again
          const overlap = batch.slice(0, Math.ceil(batch.length / 2));
          for (const ev of overlap) {
            await insertEvent(ev);
          }
          const afterOverlap = await countEvents('player_registered');
          expect(afterOverlap).toBe(afterFirst);

          const rows = await dbAll<{ tx_hash: string; event_index: number }>(
            'SELECT tx_hash, event_index FROM events WHERE tx_hash LIKE ?',
            ['prop-tx-%'],
          );
          const uniq = new Set(rows.map((r) => `${r.tx_hash}:${r.event_index}`));
          expect(uniq.size).toBe(rows.length);
        },
      ),
      { seed: PROPERTY_SEED + 2, numRuns: 25 },
    );
  }, 25_000);

  // Known gap: side effects (webhooks / tier updates) are re-applied when events
  // are re-fetched within INDEXER_FINALITY_MARGIN. Tracked as a separate medium
  // issue linked from #1323 — do not enable until side-effect gating lands.
  it.skip('side-effect idempotency within finality margin (known failure — see #1323 notes)', () => {
    // Placeholder: assert webhook/tier side-effect set equal after B then B again.
  });
});
