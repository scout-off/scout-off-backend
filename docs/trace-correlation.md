# Trace correlation across the chain boundary

This document describes how a single correlation identifier travels from an
HTTP request through a Soroban transaction, the indexer, and outbound
webhook/SSE delivery (#1113).

## Why

OpenTelemetry covers in-process spans, and `x-correlation-id` +
`AsyncLocalStorage` cover a single request. Once the backend submits a
contract call, the resulting events are indexed seconds later in a different
async context. Without a bridge, "scout paid but never got the unlock
webhook" cannot be stitched into one timeline.

## Lifecycle

```
HTTP request
  └─ correlationId middleware → AsyncLocalStorage { correlationId }
       └─ stellar submit (createTxBuilder)
            ├─ Stellar text memo: "c:<nonce>" (≤28 bytes, no PII)
            └─ tx_correlations(tx_hash → correlation_id)   ← off-chain bridge
                 └─ indexer.poll
                      └─ lookupTxCorrelation(tx_hash)
                           └─ requestContext.run + OTEL span link
                                ├─ cache invalidation
                                └─ webhook / SSE fan-out
                                     └─ payload.correlationId (when present)
```

1. **Originating request** — `correlationId` middleware
   (`src/middleware/correlationId.ts`) reads `x-correlation-id` or generates a
   UUID and stores it in `requestContext`.
2. **Transaction submission** — every mutating path in
   `src/services/stellar.ts` and `src/utils/contract.ts` builds the
   transaction via `createTxBuilder` / memo helper. When ALS has a
   correlation id, a short text memo (`c:<nonce>`) is attached. After
   `sendTransaction`, `recordTxCorrelation(hash)` persists the full id keyed
   by `tx_hash` in `tx_correlations`.
3. **Indexing** — `indexEvents` looks up the correlation by `tx_hash` and
   re-enters `requestContext` via `withRestoredCorrelation` for side effects
   (player upserts, tier promotion, cache invalidation) and webhook dispatch.
   An OTEL consumer span is started with a **span link** back to the poll
   span and attribute `scout.correlation_id`.
4. **Delivery** — `dispatchEventWebhook` includes `correlationId` in the
   signed body when ALS context is present so subscribers can join logs.

## On-chain footprint

- Memo only (≤28 bytes). No PII. Full UUID stays off-chain in `tx_correlations`.
- We deliberately do **not** add a Symbol contract argument (would require
  ABI changes across five contracts). The memo + side table is enough to
  re-establish context from the indexed `tx_hash`.

## Graceful degradation

Older transactions (or submits outside a request context) have no
`tx_correlations` row. Indexing and delivery proceed normally with no ALS
correlation and no span link — behaviour matches pre-#1113.

## Querying

- Logs: look for `[cid=<id>]` (logger auto-inject) or
  `correlationId=<id>` in structured lines.
- Traces: filter on attribute `scout.correlation_id` or follow span links
  from `indexer.poll` → `indexer.applyEvent` → `indexer.webhookDispatch` /
  `webhooks.postWithRetry`.
- DB: `SELECT * FROM tx_correlations WHERE correlation_id = ?`.

## Housekeeping

`purgeOldTxCorrelations(maxAgeMs)` can drop stale rows; call from a periodic
job if the table grows large. Rows are tiny and keyed by `tx_hash`.
