# Indexer Unprocessed Events (#1540)

The indexer (`src/services/indexer.ts`) runs every Soroban contract event
through `normalizeSorobanEvent()` and applies type-specific side effects. A
contract upgrade that **renames** an event or **reshapes** its value would
previously stop player or milestone updates silently — nothing was counted,
logged, or paged. This document describes how such events are now surfaced,
stored, and replayed.

## Outcome classification

Every event in a poll is classified into exactly one outcome:

| Outcome | Meaning | Cursor | Stored for replay |
| ------- | ------- | ------ | ----------------- |
| `applied` | Recognised type (in `CONTRACT_EVENT_TYPES`); side effects ran (or no-op). | Advances | No |
| `unknown_type` | Topic decoded, but the type is not in the allowlist. | Advances | Yes |
| `decode_error` | `normalizeSorobanEvent()` threw (unexpected value shape). | Advances, **unless** the topic is a recognised type — then the cursor is held | Yes |

The allowlist is derived from `CONTRACT_EVENT_TYPES` (`src/types/index.ts`), so
the set of "known" events cannot drift from the rest of the app.

### Cursor semantics

The poll cursor (`indexer_state.last_ledger`) tells the next poll where to
resume. The rules are:

- **`applied` and `unknown_type`** never block the cursor. An unknown event is
  parked in `indexer_unprocessed_events` and can be replayed later; holding the
  cursor on an event the indexer cannot understand would stall indexing
  permanently.
- **`decode_error` on a recognised type** (the topic is known but the value
  cannot be decoded) holds the cursor at that event's ledger. The next poll
  retries it, which is the right behaviour for a transient decode bug or a
  value that a fix will make decodable.
- **Infrastructure failures** (e.g. the database is down) while applying a
  known event are rethrown: the cursor is not advanced and the whole batch is
  retried on the next poll.

One bad event never blocks the rest of its batch — a co-transaction group and
the events after it continue to be applied even when one event is parked.

## Metrics

`scout_off_indexer_events_total{type,outcome}` is incremented for every event,
labelled by the event `type` (or the best-effort topic string for undecodable
events) and the outcome above. A sustained non-zero `unknown_type` or
`decode_error` rate means a contract upgrade renamed or reshaped an event and
needs attention.

```promql
increase(scout_off_indexer_events_total{outcome!="applied"}[15m]) > 0
```

## Storage

Unapplied events are written to `indexer_unprocessed_events`
(`db/033_indexer_unprocessed_events.sql` and its `_postgres` counterpart),
deduplicated on `(tx_hash, event_index)` so re-polling the same event (for
example after a reorg) never creates a second row. Each row retains:

- `topic_json` — a JSON array of the raw topics as base64 XDR, and
- `value_xdr` — the raw value as base64 XDR,

which together are enough to rebuild the event and replay it once the decoder
is fixed. `reason` is `unknown_type` or `decode_error`, and `payload` holds the
partially-decoded JSON when decoding got that far.

## Admin endpoints

Both require the `admin` role.

### `GET /api/admin/indexer/unprocessed`

Paginated list, newest first.

| Query | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `page` | integer ≥ 1 | 1 | 1-based page number |
| `pageSize` | integer 1–100 | 20 | Rows per page |
| `reason` | `unknown_type` \| `decode_error` | — | Optional filter |

Response: `{ success, data: UnprocessedEvent[], total, page, pageSize }`.

### `POST /api/admin/indexer/unprocessed/:id/retry`

Reruns the apply path for a stored event. On success the unprocessed row is
deleted and the event's side effects are applied; on failure the row is kept
and the reason is returned.

Response: `{ success, data: { id, status, detail } }` where `status` is
`applied`, `still_failing`, or `not_found` (HTTP 404).

The typical workflow after a contract upgrade is: deploy a build whose
`normalizeSorobanEvent` understands the new shape, confirm the
`scout_off_indexer_events_total` error rate stops growing, then retry the
parked events one by one (or in bulk with a script) via the retry endpoint.

## Adding a new event type

1. Add the type to `CONTRACT_EVENT_TYPES` in `src/types/index.ts`.
2. Teach `normalizeSorobanEvent` in `src/services/indexer.ts` how to decode it.
3. Add any side effects to the `applyOne` dispatch (and to
   `replayUnprocessedEvent` if the type has side effects that must be
   replayable).

Because the allowlist and the decoder move together, previously-parked events
of the new type can then be replayed through the retry endpoint.
