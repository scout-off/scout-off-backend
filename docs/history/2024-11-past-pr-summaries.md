# Past PR Summaries (November 2024)

This file consolidates durable design decisions from four root-level files that were
removed in issue #1838: `FILES_CREATED.md`, `IMPLEMENTATION_PLAN.md`, `CHANGES.md`,
and `REFACTORING_SUMMARY.md`.

---

## OpenAPI Linting with Spectral

Added a Spectral ruleset (`.spectral.yaml`) to enforce API spec quality. Custom rules:

- `operation-operationId` — every operation must have an `operationId` (error)
- `scoutoff-operationid-camelcase` — operationIds must be camelCase (error)
- `scoutoff-4xx-error-schema` — 4xx responses must use the `ErrorResponse` schema (error)
- `scoutoff-5xx-error-schema` — 5xx responses must use the `ErrorResponse` schema (error)
- `scoutoff-2xx-has-example` — 2xx responses should include examples (warning)
- `scoutoff-auth-declared` — protected operations must declare security (warning)

Run with `npm run lint:openapi` (requires `@stoplight/spectral-cli` dev dependency).

---

## Request Timeout / AbortController Propagation

`src/middleware/requestSignal.ts` exposes `getRequestSignal()`, `isRequestCancelled()`,
and `checkRequestCancelled()` via `AsyncLocalStorage`. Timeout middleware creates an
`AbortController` per request and stores it in the context. Long-running services read
the signal from context rather than from `req.signal`; controllers call
`checkRequestCancelled()` between batch iterations.

`src/utils/withTimeout.ts` wraps a promise with a local deadline and merges it with an
external signal using `AbortSignal.any()` (Node ≥ 20.3) or a `Promise.race` fallback.

---

## Unified Cache Store

Three in-process cache implementations (`cacheStore.ts` InMemoryCacheStore,
`inMemoryCacheStore.ts`, and `BoundedInMemoryCacheStore` in `cache.ts`) were consolidated
into a single LRU/TTL store. The unified store is controlled by `CACHE_MAX_ENTRIES`
(default 1000); the previous `CACHE_MAX_SIZE` / `PLAYER_CACHE_MAX_SIZE` aliases map to
the same value and remain in `.env.example` for backward compatibility during migration.

---

## API Docs Visibility Control

`API_DOCS_MODE` controls who can access `/api/docs`:

| Mode       | Access                                                          |
| ---------- | --------------------------------------------------------------- |
| `public`   | Fully open (default in dev/test)                                |
| `admin`    | Requires `requireRole('admin')` (default in staging/production) |
| `disabled` | Returns 404 on all doc endpoints                                |

When `API_DOCS_HIDE_ADMIN=true` in public mode, `/admin/*` paths are stripped from the
served spec.

---

## ReindexService Refactoring

`reindexService.ts` was refactored to use `eventBatchProcessor` (shared by the live
indexer and replay service), eliminating ~96 lines (448 → 352). Key design points:

- `getIndexedContractIds()` in `src/services/indexer.ts` is the single source of truth
  for which contract IDs the indexer, reindex, and replay services all process.
- `processEventBatches` gained new hooks: `contractIds`, `getBatchSize`, `getBatchDelay`,
  `onBatchComplete`, `shouldCancel`, `isRateLimitError`, `rateLimitBackoffMs`.
- Catch-up mode, cancellation, and rate-limit backoff were migrated to those hooks with
  no behaviour change.
- A parity test (`tests/services/reindexReplayParity.test.ts`) verifies that reindex and
  replay produce identical event rows for the same ledger range.
