# Implementation Plan: Four Backend Improvements

This document outlines the four tasks being implemented to improve code quality, performance, and reliability.

## Task 1: OpenAPI Linting with Spectral

**Status:** Files created  
**Deliverables:**
- `scripts/lint-openapi.js` — Runner for Spectral CLI
- `.spectral.yaml` — Project ruleset extending spectral:oas
- `scripts/spectral-rules.js` — Custom rule definitions

**Custom Rules:**
- `operation-operationId` — Every operation must have an operationId (error)
- `scoutoff-operationid-camelcase` — operationIds must be camelCase (error)
- `scoutoff-4xx-error-schema` — 4xx responses must use ErrorResponse schema (error)
- `scoutoff-5xx-error-schema` — 5xx responses must use ErrorResponse schema (error)
- `scoutoff-2xx-has-example` — 2xx responses should have examples (warning)
- `scoutoff-auth-declared` — Protected operations must declare security (warning)

**Integration:**
- Add to `package.json` scripts: `"lint:openapi": "node scripts/lint-openapi.js"`
- Run in CI before deploying
- Fix violations in `src/openapi.yaml` as needed

**Next Steps:**
1. Install `@stoplight/spectral-cli` as dev dependency
2. Run linting and fix violations
3. Add to CI/CD pipeline

---

## Task 2: Request Timeout with AbortController Propagation

**Status:** Files created  
**Deliverables:**
- `src/middleware/timeout.ts` (enhanced) — Creates AbortController, stores in context
- `src/middleware/requestSignal.ts` — Utility to access request signal
- `src/utils/withTimeout.ts` — Combine external signal with timeouts

**Architecture:**
- Timeout middleware creates an AbortController per request
- Signal is stored in AsyncLocalStorage context (`requestContext`)
- Downstream services can access via `getRequestSignal()`
- Check `isRequestCancelled()` in loops; throw from `checkRequestCancelled()`

**Files to Update:**
- `src/services/stellar.ts` — Pass signal to Soroban RPC calls
- `src/services/ipfs.ts` — Pass signal to IPFS HTTP requests
- `src/utils/safeFetch.ts` — Accept and use signal in fetch calls
- `src/controllers/exportController.ts` — Check signal between CSV batches
- `src/controllers/scoutRecommendationsController.ts` — Check signal in loops
- `src/controllers/adminStatsController.ts` — Check signal in batch operations
- `src/db/driver.ts` (PostgreSQL) — Optionally cancel pg queries

**Benefits:**
- Timed-out requests stop using resources immediately
- Prevents resource exhaustion under load (no pile-up of hung requests)
- Client disconnects also trigger abort automatically

**Next Steps:**
1. Update services to accept and propagate signal
2. Add signal checks to long-running loops
3. Test under load to verify resource cleanup

---

## Task 3: Unified Cache Store Implementation

**Status:** Files created  
**Deliverables:**
- `src/services/inMemoryCacheStore.unified.ts` — Single, complete implementation
- `tests/services/cacheStore.contract.ts` — Contract test suite

**Consolidation:**
Remove the duplicated implementations and use one:
- ✓ Delete: `src/services/cacheStore.ts` InMemoryCacheStore (line 45)
- ✓ Delete: `src/services/inMemoryCacheStore.ts` (line 17)
- ✓ Replace: `BoundedInMemoryCacheStore` in `src/services/cache.ts` (line 83)
- Keep: CacheStore interface in `src/services/cacheStore.ts`

**Unified Features:**
- LRU eviction (Map insertion order)
- TTL-based lazy expiry
- Configurable max entries (CACHE_MAX_ENTRIES env var)
- Prefix-based deletion (deleteByPrefix)
- Metrics hooks (eviction recording)

**Configuration:**
- Consolidate to single env var: `CACHE_MAX_ENTRIES` (default 1000)
- Remove: CACHE_MAX_SIZE, PLAYER_CACHE_MAX_SIZE (aliases to same concept)

**Testing:**
- Contract test suite covers both InMemoryCacheStore and RedisCacheStore
- Verify: TTL expiry, LRU eviction, prefix deletion, type preservation, concurrency

**Next Steps:**
1. Run contract tests against InMemoryCacheStore
2. Run contract tests against RedisCacheStore
3. Delete old implementations
4. Update imports across codebase

---

## Task 4: API Docs Visibility Control

**Status:** Files created  
**Deliverables:**
- `src/config.apiDocs.ts` — Configuration and validation
- `src/routes/docs.ts` (to be updated) — Guard middleware and filtering

**Modes:**
- `public` (dev/test default) — Docs fully accessible at /api/docs, /api/docs/ui, etc.
- `admin` (staging/production default) — Behind requireRole('admin') middleware
- `disabled` — Return 404 on all doc endpoints

**Environment Variables:**
- `API_DOCS_MODE` — public | admin | disabled (defaults per NODE_ENV)
- `API_DOCS_HIDE_ADMIN` — When true in public mode, strip /admin/* paths from served spec

**Implementation Details:**
- Add guard middleware in docs router based on mode
- Optional: Filter spec at startup to remove admin paths (if API_DOCS_HIDE_ADMIN=true)
- CSP headers already allow swagger-ui-dist assets (checked)

**Documentation:**
- Update .env.example with API_DOCS_MODE and API_DOCS_HIDE_ADMIN
- Add to Helm values.yaml for deployment configuration

**Next Steps:**
1. Update `src/routes/docs.ts` with mode guard
2. Implement optional spec filtering for admin paths
3. Add configuration to .env.example
4. Test each mode (public, admin, disabled)

---

## Summary

| Task | Files Created | Status |
|------|---------------|--------|
| Spectral Linting | 3 | Ready for integration |
| Request Timeouts | 3 | Ready for signal propagation |
| Cache Consolidation | 2 | Ready for migration |
| API Docs Control | 1 (+ updates) | Ready for integration |

**Total new files:** 9  
**Updated files:** ~15 (package.json, config.ts, app.ts, services, controllers, routes)

---

## Verification Checklist

- [ ] Spectral linting runs without errors
- [ ] Contract tests pass for both cache stores
- [ ] Request cancellation works end-to-end (timeout + client disconnect)
- [ ] API docs mode switching works (public/admin/disabled)
- [ ] All imports updated after consolidation
- [ ] No unused env vars remain
- [ ] Documentation updated (.env.example, code comments)
- [ ] CI passes all checks
