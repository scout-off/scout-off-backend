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
   An OTEL consumer span is started with **span links** back to the submitting
   request span and the poll span, with attribute `scout.correlation_id`.
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

## Browser access to the trace id

Every response also carries the OpenTelemetry trace id in the
`X-Trace-Id` header (`src/middleware/traceId.ts`; omitted when tracing is
disabled). The header is listed in CORS `exposedHeaders` (`src/app.ts`),
so browser frontends can read it via
`response.headers.get('X-Trace-Id')` and attach it to error reports or
support tickets.

## Housekeeping

`purgeOldTxCorrelations(maxAgeMs)` can drop stale rows; call from a periodic
job if the table grows large. Rows are tiny and keyed by `tx_hash`.

## W3C distributed tracing (#1505)

Configure `OTEL_EXPORTER_OTLP_ENDPOINT` to enable the SDK, HTTP instrumentation
(including Soroban RPC), and W3C Trace Context propagation. Without an exporter
the SDK and automatic instrumentation are not started; no export tasks or
recording spans are created. The small propagation checks and correlation
lookups still run. A no-exporter deployment preserves the legacy Redis message
format when no valid span context is present.

Both transaction submission helpers await `recordTxCorrelation`. In addition
to the human-readable correlation mapping, migration `034_tx_trace_context`
adds a durable `tx_hash → traceparent, tracestate` bridge. This context is stored
even if a caller has no correlation id. It survives restarts and can be read by
a different backend instance. Old transactions without stored context continue
to work. `purgeOldTxCorrelations` removes expired rows from both bridge tables.

`indexer.applyEvent` and `indexer.sseDispatch` carry `stellar.tx_hash`,
`stellar.ledger`, and `scoutoff.event_type`. Deferred webhook dispatch links
back to the same origin. These spans link the delayed work to the original
submission, restore request correlation for logs, and keep the original
sampling decision. They do not force unsampled requests to become sampled.

Outgoing webhooks include `traceparent` and, when present, `tracestate` for the
delivery span. Every retry remains part of that delivery. `safeFetch` injects
the current context into each independently validated HTTPS hop. These headers
are informational, contain no application secrets, and may be logged or
forwarded by receivers; they are not authentication or webhook signatures.
No baggage is persisted in the transaction bridge.

Redis cache invalidations, wallet block/unblock, token revocations, and SSE
fan-out use `{ "data": <original payload>, "trace": { "traceparent": "…",
"tracestate": "…" } }` when context is available. Receivers extract W3C
context and start linked consumer spans around local invalidation/security/SSE
work. Legacy unwrapped messages are still accepted. Invalid or missing trace
headers never prevent the original message from being handled. Upgrade all
consumers before enabling tracing producers in mixed-version deployments;
older binaries do not understand the envelope.

`tests/services/distributedTracing.test.ts` uses an in-memory span exporter to
cover outgoing HTTP, traced and legacy Redis envelopes, persisted transaction
links, span attributes, and unsampled consumers. It does not require an OTLP
collector.
