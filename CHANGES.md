# Implementation Changes: Four Backend Improvements

## Overview

This document describes the changes made to implement:
1. OpenAPI linting with Spectral
2. Request timeout with AbortController propagation
3. Unified cache store implementation
4. API docs visibility control

---

## 1. OpenAPI Linting with Spectral

### Files Created
- `.spectral.yaml` — Project ruleset extending spectral:oas
- `scripts/lint-openapi.js` — CLI runner for Spectral
- `scripts/spectral-rules.js` — Custom rule definitions

### Files to Update
- `package.json` — Add dev dependency and npm script

### Configuration
Add to `package.json`:
```json
{
  "devDependencies": {
    "@stoplight/spectral-cli": "^6.x"
  },
  "scripts": {
    "lint:openapi": "node scripts/lint-openapi.js"
  }
}
```

### Rules Enforced
1. **operation-operationId** (error) — Every operation must have an operationId
2. **scoutoff-operationid-camelcase** (error) — operationIds must be camelCase
3. **scoutoff-4xx-error-schema** (error) — 4xx responses use ErrorResponse schema
4. **scoutoff-5xx-error-schema** (error) — 5xx responses use ErrorResponse schema
5. **scoutoff-2xx-has-example** (warning) — 2xx responses should include examples
6. **scoutoff-auth-declared** (warning) — Protected operations declare security

### Running
```bash
npm run lint:openapi
```

### CI Integration
Add to GitHub Actions workflow:
```yaml
- name: Lint OpenAPI spec
  run: npm run lint:openapi
```

---

## 2. Request Timeout with AbortController Propagation

### Files Created
- `src/middleware/timeout.ts` (already exists, enhanced with AbortController)
- `src/middleware/requestSignal.ts` — Utilities for accessing request signal
- `src/utils/withTimeout.ts` — Combine external signals with local timeouts

### Files to Update
- `src/config.ts` — Add apiDocsConfig import if needed
- `src/app.ts` — Wire up signal in context
- `src/services/stellar.ts` — Pass signal to RPC calls
- `src/services/ipfs.ts` — Pass signal to HTTP requests
- `src/utils/safeFetch.ts` — Accept and propagate signal
- `src/controllers/exportController.ts` — Check signal in loops
- `src/controllers/scoutRecommendationsController.ts` — Check signal
- `src/controllers/adminStatsController.ts` — Check signal
- `src/db/driver.ts` (PostgreSQL) — Cancel queries on abort

### Mechanism
1. Timeout middleware creates an AbortController per request
2. Signal is stored in AsyncLocalStorage context (requestContext)
3. Services access signal via `getRequestSignal()`
4. Long-running loops check `isRequestCancelled()` or `checkRequestCancelled()`

### Usage Examples

**Fetch with signal:**
```typescript
import { getRequestSignal } from '../middleware/requestSignal';

const signal = getRequestSignal();
const response = await fetch(url, { signal });
```

**Loop with signal:**
```typescript
import { checkRequestCancelled } from '../middleware/requestSignal';

for (const batch of batches) {
  checkRequestCancelled(); // Throws if aborted
  await processBatch(batch);
}
```

**Combined timeout + signal:**
```typescript
import { withTimeoutAndSignal } from '../utils/withTimeout';

const signal = getRequestSignal();
await withTimeoutAndSignal(expensiveOperation(), 5000, signal);
```

### Behavior
- On timeout: 503 response, controller aborted, pending work stops
- On client disconnect: controller aborted, pending work stops
- Signal already aborted: operations fail immediately
- Cascades through fetch, RPC, DB calls via signal parameter

---

## 3. Unified Cache Store Implementation

### Files Created
- `src/services/inMemoryCacheStore.unified.ts` — Single complete implementation

### Files to Delete
- `src/services/cacheStore.ts` (InMemoryCacheStore class, line 45–57)
- `src/services/inMemoryCacheStore.ts` (entire file)
- Revert `BoundedInMemoryCacheStore` from `src/services/cache.ts` (use unified instead)

### Files to Update
- `src/services/cache.ts` — Replace BoundedInMemoryCacheStore with unified implementation
- `src/config.ts` — Consolidate env vars (CACHE_MAX_ENTRIES as single source)
- `.env.example` — Document CACHE_MAX_ENTRIES only

### Configuration Consolidation
**Before:** 3 env vars (CACHE_MAX_ENTRIES, CACHE_MAX_SIZE, PLAYER_CACHE_MAX_SIZE)  
**After:** 1 env var (CACHE_MAX_ENTRIES)

Update `.env.example`:
```
# CACHE_MAX_ENTRIES — Optional. Max entries in the in-memory CacheStore
# before LRU eviction. Default: 1000. Integer >= 1.
CACHE_MAX_ENTRIES=1000
```

### Features
- **LRU Eviction:** Oldest (least recently used) entry is removed when capacity exceeded
- **TTL:** Entries expire lazily on access (get/has), or never if ttlMs undefined
- **Prefix Deletion:** Remove all keys starting with prefix (e.g., players:list:*)
- **Metrics:** Eviction events recorded via recordCacheEviction()

### Testing
Run contract tests:
```bash
npm test -- tests/services/cacheStore.contract.ts
```

Contract suite covers both InMemoryCacheStore and RedisCacheStore:
- Basic get/set/del/has
- TTL and expiry
- Prefix deletion
- Type preservation
- Concurrent operations

---

## 4. API Docs Visibility Control

### Files Created
- `src/config.apiDocs.ts` — Mode configuration and validation
- `src/middleware/docs.guard.ts` — Guard middleware and filter function

### Files to Update
- `src/routes/docs.ts` — Apply guard middleware
- `src/app.ts` — Conditionally mount docs router
- `.env.example` — Add API_DOCS_MODE and API_DOCS_HIDE_ADMIN

### Configuration

**Environment Variables:**
```
# API_DOCS_MODE — Set to "public", "admin", or "disabled".
# - public: Docs are publicly accessible (dev/test default)
# - admin: Docs require admin role authentication (staging/production default)
# - disabled: Docs endpoints return 404
# Default: depends on NODE_ENV (public in dev/test, admin in staging/production)
API_DOCS_MODE=public

# API_DOCS_HIDE_ADMIN — Only in "public" mode. When true, the served spec
# hides /admin/* paths and admin-only components. Default: false.
API_DOCS_HIDE_ADMIN=false
```

### Modes

| Mode | Default | Behavior |
|------|---------|----------|
| `public` | development, test | Full API docs accessible to anyone |
| `admin` | staging, production | API docs require admin authentication |
| `disabled` | — | All /api/docs/* endpoints return 404 |

### Implementation Details

**Mode enforcement:**
```typescript
// In src/routes/docs.ts
import { guardApiDocs } from '../middleware/docs.guard';

router.use(guardApiDocs); // Apply to all doc routes
```

**Spec filtering (optional):**
```typescript
// In docs.ts route handler
import { filterAdminPathsFromSpec } from '../middleware/docs.guard';

const spec = loadSpec();
const served = filterAdminPathsFromSpec(spec);
res.json(served);
```

**In app.ts:**
```typescript
// Conditionally mount or always mount with guard
import docsRouter from './routes/docs';

app.use('/api/docs', docsRouter);
app.use('/api/v1/docs', docsRouter);
app.use('/api/v2/docs', docsRouter);
```

### Testing Each Mode

**Public mode:**
```bash
API_DOCS_MODE=public npm start
curl http://localhost:4000/api/docs  # 200 ✓
```

**Admin mode:**
```bash
API_DOCS_MODE=admin npm start
curl http://localhost:4000/api/docs  # 401 (no auth)
curl -H "Authorization: Bearer <admin-token>" http://localhost:4000/api/docs  # 200 ✓
```

**Disabled mode:**
```bash
API_DOCS_MODE=disabled npm start
curl http://localhost:4000/api/docs  # 404 ✓
```

### Helm Configuration
Update Helm values.yaml:
```yaml
env:
  API_DOCS_MODE: admin  # or public/disabled per environment
  API_DOCS_HIDE_ADMIN: "false"
```

---

## Summary of Changes

### Package.json
- Add `@stoplight/spectral-cli` dev dependency
- Add `lint:openapi` npm script

### Environment Variables (.env.example)
- Remove: CACHE_MAX_SIZE, PLAYER_CACHE_MAX_SIZE, CACHE_MAX_ENTRIES aliases
- Add: CACHE_MAX_ENTRIES (single var)
- Add: API_DOCS_MODE (public|admin|disabled)
- Add: API_DOCS_HIDE_ADMIN (true|false)

### Code Changes
- **timeout.ts**: Already implements AbortController logic
- **requestSignal.ts** (new): Access signal from context
- **withTimeout.ts** (new): Combine signal + timeout
- **inMemoryCacheStore.unified.ts** (new): Single cache implementation
- **docs.guard.ts** (new): Guard middleware for docs visibility
- **config.apiDocs.ts** (new): Mode configuration
- Services: Accept and propagate signals
- Cache: Use unified implementation

### Deletions
- Old InMemoryCacheStore in cacheStore.ts
- Old InMemoryCacheStore in inMemoryCacheStore.ts
- BoundedInMemoryCacheStore in cache.ts (replace with unified)

---

## Verification

After applying all changes:

```bash
# 1. Lint OpenAPI
npm run lint:openapi

# 2. Run cache contract tests
npm test -- tests/services/cacheStore.contract.ts

# 3. Full test suite
npm test

# 4. Type check
npm run typecheck

# 5. Manual verification
# - Try API docs in public mode
# - Try API docs in admin mode
# - Try API docs in disabled mode
# - Trigger a timeout and verify resource cleanup
```

---

## Rollback Plan

If issues arise:

1. **Spectral:** Disable in CI by commenting out the workflow step
2. **Request Signals:** Revert timeout.ts to not create AbortController; signals become undefined (graceful fallback)
3. **Cache:** Use previous unified.ts as fallback; three implementations are still readable for reference
4. **Docs:** Revert docs guard to always-public or default to public

All changes are backward-compatible in that they don't break existing behavior when disabled.
