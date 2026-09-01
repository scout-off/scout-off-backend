# Deterministic event ordering in the indexer

This document defines the total order the indexer applies to contract events
and how co-transaction groups are treated as an atomic unit (#1111).

## Total order

Every indexed row carries:

| Column | Meaning |
| --- | --- |
| `ledger` | Closed ledger sequence |
| `tx_application_order` | Application order of the transaction within the ledger |
| `event_index` | In-transaction event index |
| `contract_id` | Emitting contract (tie-break across multi-contract txs) |

**Sort key (ascending):**

```
ledger → tx_application_order → event_index → contract_id → id
```

Implemented in `src/services/eventOrdering.ts` (`normalizeAndSortEvents`,
`EVENTS_ORDER_BY_SQL`). Every consumer query (`queryEvents`, `getEventsPage`,
`getEventsIterable`) uses that `ORDER BY`.

## Deriving ordinals from RPC

1. Prefer explicit `txIndex` / `eventIndex` on the RPC event when present.
2. Else parse the event `id` / paging token (`ledger-txIndex-eventIndex`).
3. Else assign stable fallbacks: first-seen tx order within a ledger (after a
   stable pre-sort by id/txHash), and first-seen event index within a tx.

The batch is **always re-sorted** before insert/side effects, so a shuffled
RPC response still yields the same final state.

## Co-transaction atomicity

Events that share `(ledger, tx_application_order, tx_hash)` form an **atomic
group**. The indexer applies every event in a group (insert + side effects)
before moving to the next transaction. Downstream consumers must not observe
a later sibling before an earlier one from the same transaction (e.g.
`player_registered` before `milestone_submitted` in one tx).

`groupCoTransactionEvents` encodes this grouping; the indexer loop applies
groups sequentially.

## Dedup

`UNIQUE(tx_hash, event_index)` replaces the old `UNIQUE(tx_hash)` so multiple
events from one transaction are retained. Replays of the same
`(tx_hash, event_index)` are ignored via `INSERT OR IGNORE`.

## Fixture guarantee

`tests/services/eventOrdering.test.ts` asserts that an interleaved
same-ledger fixture produces a stable order and correct co-transaction
grouping regardless of input permutation.
