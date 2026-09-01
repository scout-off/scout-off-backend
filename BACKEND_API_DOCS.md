# ScoutOff Backend API Documentation

All endpoints are served from the base URL configured via `PORT` (default: `4000`).

---

## Table of Contents

- [API Versioning](#api-versioning)
- [Authentication](#authentication)
- [Idempotency](#idempotency)
- [Response Headers](#response-headers)
- [Endpoints](#endpoints) — generated OpenAPI spec, see [docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md)
- [Saved Search Run Endpoint](#saved-search-run-endpoint-get-apiscoutswalletsaved-searchesidrun)
- [Stubbed Routes](#stubbed-routes)
- [Error Format](#error-format)

---

## API Versioning

> For the full precedence rules between the URL prefix and the `API-Version`
> header, the current state of v2, and the deprecation policy, see
> [docs/api-versioning.md](docs/api-versioning.md).

The platform supports two stable API versions. All routes are available under multiple prefixes:

| Prefix     | Description                                  |
| ---------- | -------------------------------------------- |
| `/api`     | Unversioned alias (maps to v1; **deprecated** in production) |
| `/api/v1`  | Stable v1 — use this for all new integrations |
| `/api/v2`  | Stable v2 — currently identical to v1; new v2-only behaviour will be introduced here |

### Selecting a version

**URL prefix (recommended)**

```bash
# v1
curl http://localhost:4000/api/v1/players

# v2
curl http://localhost:4000/api/v2/players
```

**`API-Version` request header (alternative)**

Send `API-Version: 2` on any unversioned `/api/` path to be routed to v2 handlers:

```bash
curl -H "API-Version: 2" http://localhost:4000/api/players
```

### `API-Version` response header

Every response from an `/api/` path includes an `API-Version` response header indicating which version actually handled the request:

```
API-Version: 1
```

or

```
API-Version: 2
```

### Deprecation policy

Calling the bare `/api/` prefix (without `/v1` or `/v2`) in a **production** environment emits a `warn`-level log entry:

```
[deprecation] Unversioned /api/ path called: GET /api/players — prefer /api/v1/ or /api/v2/. Unversioned paths will be removed in a future release.
```

Clients should migrate to `/api/v1/` to suppress this warning and prepare for the eventual removal of the unversioned alias.

---

## Authentication

Most protected routes require a **Bearer JWT** obtained from `POST /auth/token`.

```
Authorization: Bearer <token>
```

Tokens are issued after a successful SEP-10 Stellar wallet challenge/response flow.

### API keys & scopes (#1019)

Server-to-server integrations can authenticate with a long-lived API key
instead of a JWT:

```
X-API-Key: <raw-key>
```

API keys are issued via `POST /api/scouts/:wallet/api-keys` and revoked via
`DELETE /api/scouts/:wallet/api-keys/:id`. Only a salted hash is stored.

#### Scope enforcement

Keys without an explicit `scopes` list (legacy keys) keep **unrestricted**
scout-level access — backward compatible with keys issued before scope
enforcement. Keys issued with an explicit `scopes` list are **restricted**:
mutating endpoints require the matching scope and return `403` with
`reason.requiredScope` otherwise.

| Scope | Enforced on |
|-------|-------------|
| `write:contacts` | `POST /scouts/:wallet/contacts/:playerId/unlock` |
| `write:subscriptions` | `POST/PUT/DELETE /scouts/:wallet/subscribe` |
| `write:trial_offers` | `POST /scouts/:wallet/trial-offers` (and its deprecated alias `/trial-offer`); `DELETE /scouts/:wallet/trial-offers/:offerId` |
| `write:webhooks` | `POST /scouts/:wallet/webhooks`, `DELETE .../:id`, `POST .../:id/test` |
| `write:api_keys` | `POST /scouts/:wallet/api-keys`, `DELETE .../:id` |
| `write:bookmarks` | bookmark & bookmark-folder mutations |
| `write:notes` | scout-note mutations |
| `write:saved_searches` | saved-search mutations |
| `write:player_tokens` | `POST /players/:playerId/tokens/buy` |
| `read:subscription` | `GET /scouts/:wallet/subscription` |

REST and GraphQL share the same scope contract (`src/utils/apiKeyScopes.ts`).
See `docs/auth.md` for the full vocabulary and legacy-compatibility rules.

---

## Idempotency

Clients writing retry logic against mutating operations (`subscribe`, `unlock`, `trial-offer` creation, fee withdrawals) should send an `Idempotency-Key` header to ensure that network failures do not cause duplicate submissions.

### Overview

The backend maintains a 24-hour cache of idempotent request responses keyed by the `Idempotency-Key` header value. Repeated requests with the same key within the cache window return the exact cached response — including any error responses — without re-executing the underlying operation.

### How to use it

**Send a stable, unique key:**

```bash
# Example: a UUID or derived value that remains the same across retries
curl -X POST http://localhost:4000/api/scouts/GSCOUT.../subscribe \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -H "Content-Type: application/json" \
  -d '{"tier":"premium","duration":30}'
```

**On success or any error, replay the same key to get the same response:**

```bash
# Same key = same response, even if this is a retry
curl -X POST http://localhost:4000/api/scouts/GSCOUT.../subscribe \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -H "Content-Type: application/json" \
  -d '{"tier":"premium","duration":30}'
# → Returns the exact same response as the first request (cached)
```

### Idempotent endpoints

The following endpoints accept and honour the `Idempotency-Key` header:

| Endpoint | Description |
|---|---|
| `POST /api/scouts/:wallet/subscribe` | Scout subscription purchase |
| `POST /api/scouts/:wallet/contacts/:playerId/unlock` | Pay-to-contact fee |
| `POST /api/scouts/:wallet/trial-offers` | Trial offer creation |
| `DELETE /api/scouts/:wallet/trial-offers/:offerId` | Trial offer cancellation |
| `POST /api/admin/fees/withdraw` | Fee withdrawal (admin) |
| Any `POST /api/scouts/:wallet/webhooks/:id/test` | Webhook delivery test (admin) |

**Note:** Endpoints *without* an `Idempotency-Key` header in the request are processed independently on each call — no caching is applied.

### Behavior

#### Success (2xx)

A successful response is cached with its status code and body. Repeating the same key returns the cached response:

```json
{ "success": true, "data": { "transactionId": "abc123...", "expiresAt": 1735689600000 } }
```

#### Error (4xx / 5xx)

Error responses are cached equally. Repeating the same key returns the same error:

```json
{ "success": false, "error": "Scout has no active on-chain subscription", "code": "NOT_SUBSCRIBED" }
```

This is intentional — retries with the same key should never trigger a new operation, even if the initial attempt failed.

#### Fingerprint conflict (409)

If the same `Idempotency-Key` is used with a **materially different request body**, the API returns `409 Conflict`:

```bash
# First request
curl -X POST http://localhost:4000/api/scouts/GSCOUT.../subscribe \
  -H "Idempotency-Key: same-key" \
  -d '{"tier":"premium","duration":30}'
# → 201 { success: true, … }

# Replay with DIFFERENT tier
curl -X POST http://localhost:4000/api/scouts/GSCOUT.../subscribe \
  -H "Idempotency-Key: same-key" \
  -d '{"tier":"basic","duration":30}'
# → 409 Conflict { error: "Idempotency key was already used with a different request" }
```

This prevents silent data corruption from typos or accidental parameter changes.

#### In-flight duplicate (409 with wait)

If a second request arrives with the same `Idempotency-Key` *while the first is still being processed*, the second request waits for the first to complete (up to 5 seconds). If the first completes within that window, the second receives the same response. If it times out:

```json
{ "error": "Request already in progress for this idempotency key" }
```

with HTTP status `409`.

This bounds the time the second caller must wait and prevents indefinite hangs.

### TTL and expiry

Idempotency cache entries expire after **24 hours** (configured via `IDEMPOTENCY_TTL_MS` in the database layer). After expiry, a repeated key is treated as a new request:

```bash
# Hour 0: First request with key "my-key"
# → Processed normally

# Hour 1: Repeat with same key
# → Cached response returned

# Hour 25: Repeat with same key
# → Key has expired, treated as NEW request (no cache hit)
```

### Best practices

1. **Generate a stable key per logical operation**, not per request attempt. A UUID known to your client is ideal:
   ```typescript
   const idempotencyKey = generateUUID(); // Once per user action
   for (let attempt = 0; attempt < 3; attempt++) {
     try {
       const res = await fetch('/api/scouts/.../subscribe', {
         headers: { 'Idempotency-Key': idempotencyKey },
         // ... body
       });
       break; // Success
     } catch (err) {
       if (attempt === 2) throw err; // Last attempt failed
     }
   }
   ```

2. **Treat 409 responses as unrecoverable** within a single logical operation. The key may have been used differently or a concurrent request is still in progress. Generate a new key for a new attempt:
   ```typescript
   if (res.status === 409) {
     // Scenario 1: fingerprint conflict — never retry with this key
     // Scenario 2: in-flight timeout — may retry after 5+ seconds
     // For safety: request a new operation with a new key instead.
   }
   ```

3. **Always send the same key for all retries of the same operation**, even if errors occur. This prevents duplicate charges / subscriptions if an error response was cached.

### Limitations

- Idempotency keys are scoped per `POST` endpoint; a key used on `POST /subscribe` has no meaning on `POST /unlock`.
- The cache window is fixed at 24 hours and cannot be extended per-request.
- If the database backing the idempotency cache is unavailable, requests proceed without idempotency protection (graceful degradation).

---

## Response Headers

Every API response includes custom headers that provide metadata about the request and response:

### `X-Correlation-ID`

**Type:** String (UUID)  
**Sent on:** Every response  
**Purpose:** Correlate logs across client, API, and backend services.

The API either echoes the `X-Correlation-ID` request header (if present) or generates a new UUID. Use this value to track a request through your observability pipeline:

```bash
curl -X GET http://localhost:4000/api/players/player-001 \
  -H "X-Correlation-ID: 550e8400-e29b-41d4-a716-446655440000"
# Response includes: X-Correlation-ID: 550e8400-e29b-41d4-a716-446655440000

# All logs from this request will include the correlation ID for easy filtering
```

### `X-API-Version`

**Type:** Integer (major version)  
**Sent on:** Every response  
**Purpose:** Indicate which API major version handled the request.

The value is the major component of the version in `package.json` (e.g., `1` for version `1.2.3`):

```
X-API-Version: 1
```

Use this to detect version mismatches or version-specific behaviour in production:

```typescript
const apiVersion = parseInt(response.headers['x-api-version'], 10);
if (apiVersion !== expectedVersion) {
  console.warn(`Expected API v${expectedVersion}, got v${apiVersion}`);
}
```

**Related:** See [API Versioning](#api-versioning) for request-side version selection via `/api/v1` or `/api/v2` URL prefixes and the `API-Version` request header.

### `X-Response-Time`

**Type:** String with milliseconds suffix (e.g., `"42ms"`)  
**Sent on:** Every response  
**Purpose:** Measure backend processing latency.

The time represents the interval from when the request arrived at the API to when the response headers were about to be sent. Network latency is not included:

```
X-Response-Time: 142ms
```

Use this to:
- Monitor endpoint performance
- Detect slow routes that may need optimization
- Correlate with alerting thresholds

---

## Endpoints

This section used to be a hand-maintained, per-endpoint reference. It drifted from the real API surface — several endpoint groups documented here were missing entirely (see #1047) — because nothing kept it in sync with the route source files, and every new endpoint required a second, easy-to-forget manual update.

That table has been replaced by a **generated OpenAPI 3.0 spec** that is produced mechanically from the route source itself (`src/routes/*.ts`) by `scripts/generate-openapi-json.js`, and validated in CI against that same source (`npm run validate:openapi`) so it cannot drift again. See [docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md) for how the generator works and how to keep it accurate when you add or change a route.

**Browse the full, current endpoint reference:**

| Surface | URL |
| --- | --- |
| Swagger UI (interactive) | `GET /api/docs/ui` |
| OpenAPI spec (JSON) | `GET /api/docs` |
| OpenAPI spec (YAML) | `GET /api/docs/yaml` |
| Source of truth (in-repo) | [src/openapi.yaml](src/openapi.yaml) |

Regenerate it locally after changing a route:

```bash
npm run build:openapi     # regenerate src/openapi.yaml + src/openapi.json
npm run validate:openapi  # confirm the committed spec matches the routes
npm run docs:check        # confirm every route has a documented summary + responses
```

---

### Admin Multi-Signature Actions

High-value admin operations require M-of-N approval when `ADMIN_THRESHOLD > 1`. The multi-signature system provides atomic execution and tamper-proof audit trails for critical platform operations.

#### Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `ADMIN_THRESHOLD` | Minimum signatures required | `1` |
| `ADMIN_WALLETS` | Comma-separated list of authorized admin wallets | Required |

`pending_admin_actions` and `admin_action_signatures` (the tables backing this subsystem) work under both `DB_DRIVER=sqlite` and `DB_DRIVER=postgres` — the two migrations (`db/011_pending_admin_actions.sql` / `db/011_pending_admin_actions_postgres.sql`) declare equivalent columns, including `proposer` and the signer-uniqueness table. Duplicate-signature detection uses `INSERT OR IGNORE` on SQLite and `INSERT ... ON CONFLICT(action_id, signer) DO NOTHING` on Postgres, both driven by a single atomic statement rather than a racy check-then-insert.

#### Action Types

The following admin operations support multi-signature approval:

- `pause_contract` — Emergency pause of platform contracts
- `unpause_contract` — Resume platform operations  
- `withdraw_fees` — Withdraw accumulated platform fees
- `register_validator` — Add new validator to authorized list
- `revoke_validator` — Remove validator from authorized list
- `bulk_validator_import` — Import multiple validators (individual actions per validator)
- `update_platform_fee` — Modify platform fee structure *(future)*

#### Multi-Signature Flow

1. **Propose Action**: First admin calls the operation endpoint (e.g., `POST /api/admin/validators/register`)
2. **Collect Signatures**: Additional admins approve via `POST /api/admin/actions/{id}/approve`
3. **Automatic Execution**: When threshold is reached, the real operation executes automatically — the same on-chain call the single-admin (`ADMIN_THRESHOLD = 1`) immediate path uses, so behavior is identical between threshold=1 and threshold>1 deployments
4. **Audit Trail**: All steps are logged with tamper-proof audit records

Every `action_type` maps to exactly one execution handler (`pause_contract` → `pauseContractOnChain`, `unpause_contract` → `unpauseContractOnChain`, `withdraw_fees` → `withdrawFees`, `register_validator` / `bulk_validator_import` → `registerValidatorOnChain`, `revoke_validator` → `revokeValidatorOnChain`); the dispatcher routes purely on `action_type`, never on payload contents. `withdraw_fees` is proposed from two call sites with different payload shapes — the legacy `POST /api/admin/fees` endpoint sends `{ recipient }`, the fully-specified `POST /api/admin/fees/withdraw` (v2) endpoint sends `{ treasuryAddress, amountStroops }` — the dispatcher accepts either.

#### `GET /api/admin/actions/pending`

List all pending multi-signature actions (expired ones are purged on read). **Requires Bearer auth (admin role).**

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "cm123456789",
      "actionType": "register_validator",
      "proposer": "GADMIN1...",
      "payload": { "validatorWallet": "GVALIDATOR..." },
      "collectedSignatures": 1,
      "requiredSignatures": 2,
      "expiresAt": 1735689600000,
      "createdAt": 1735603200000
    }
  ]
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/admin/actions/pending" \
  -H "Authorization: Bearer <admin-jwt>"
```

---

#### `GET /api/admin/actions/{id}`

Get detailed information about a specific action, including all signers collected so far. **Requires Bearer auth (admin role).**

**Response `200`**

```json
{
  "success": true,
  "data": {
    "id": "cm123456789",
    "actionType": "register_validator",
    "proposer": "GADMIN1...",
    "payload": { "validatorWallet": "GVALIDATOR..." },
    "status": "pending",
    "collectedSignatures": 1,
    "requiredSignatures": 2,
    "expiresAt": 1735689600000,
    "createdAt": 1735603200000,
    "signers": [
      { "wallet": "GADMIN1...", "signedAt": 1735603200000 }
    ]
  }
}
```

**Response `404`** — action not found

**Example request**

```bash
curl -X GET "http://localhost:4000/api/admin/actions/cm123456789" \
  -H "Authorization: Bearer <admin-jwt>"
```

---

#### `POST /api/admin/actions/{id}/approve`

Approve a pending multi-signature action. When the signature threshold is reached, the underlying operation executes automatically. **Requires Bearer auth (admin role).**

**Response `202`** — signature recorded, more approvals needed

```json
{
  "success": true,
  "message": "Signature recorded, 1 more signature(s) needed",
  "data": {
    "actionId": "cm123456789",
    "collectedSignatures": 1,
    "requiredSignatures": 2,
    "status": "pending"
  }
}
```

**Response `200`** — threshold reached, action executed

```json
{
  "success": true,
  "message": "Approval threshold reached — action executed",
  "data": {
    "actionId": "cm123456789",
    "collectedSignatures": 2,
    "requiredSignatures": 2,
    "status": "executed"
  }
}
```

**Response `409`** — duplicate signature (same admin signing the same still-pending action twice)

```json
{
  "success": false,
  "error": "Admin has already signed this action",
  "code": "CONFLICT"
}
```

**Response `409`** — action already executed (approving an action a second time after it already reached quorum)

```json
{
  "success": false,
  "error": "Action has already been executed",
  "code": "ACTION_EXECUTED"
}
```

**Response `404`** — action not found

**Response `410`** — action expired

**Response `500`** — execution failed (action reverts to `pending` and remains retryable — see below)

**Example request**

```bash
curl -X POST "http://localhost:4000/api/admin/actions/cm123456789/approve" \
  -H "Authorization: Bearer <admin-jwt>"
```

#### Error Handling and Recovery

- **Execution Failures**: If the underlying operation fails (network error, contract rejection), the action remains in `pending` status and can be retried by approving again
- **Expiry**: Actions expire after 24 hours (configurable via `ADMIN_ACTION_TTL_MS`)
- **Atomicity**: Signature collection is atomic — concurrent approvals from the same admin are handled gracefully
- **Idempotency**: Duplicate approvals return `409 Conflict` without affecting signature count

#### Single-Admin Mode

When `ADMIN_THRESHOLD = 1`, operations execute immediately without creating pending actions. The response format and audit logging remain consistent.

---

## Server-Sent Events (`GET /api/events/stream`) (#1019)

Long-lived SSE stream of contract events relevant to the authenticated wallet.
Authentication: Bearer JWT (any role) or `X-API-Key`. Optional query params:
`eventType` (one type) and `playerId` (narrowing). Wallet isolation is always
enforced; a `: ping` keep-alive comment is sent every
`SSE_KEEPALIVE_INTERVAL_MS` (default 15 s).

**Live authorization enforcement:**

- Revoking the connection's JWT (logout / admin revocation) emits a terminal
  `event: session_ended` (reason `token_revoked`) and closes the stream.
- Blocklisting the wallet (see `docs/auth.md`) emits `session_ended` (reason
  `wallet_blocklisted`) and closes it; blocklisted wallets also get `403` on
  new connections.
- No protected events are delivered after termination.

**Detection bound:** immediate for revocations/blocklists in the same process;
≤ `SSE_AUTH_SWEEP_INTERVAL_MS` (default 30 s) for changes persisted by
another instance (one sweep query per process — never per keep-alive tick).

## GraphQL (`POST /graphql`) (#1019)

Read-only GraphQL endpoint sharing the REST authorization model:

- **API keys:** `X-API-Key` is accepted; restricted keys enforce
  `read:milestones` (milestones queries) and `read:subscription`
  (`scoutSubscription`).
- **Milestones:** deactivated players follow the same owner/admin-only
  decision as REST (`src/utils/playerAccess.ts`); unauthorized callers get a
  `NOT_FOUND` error (root) or no data (nested `Player.milestones`).
- **Abuse control:** depth limit (`MAX_DEPTH = 5`) plus a query-cost limit
  (`MAX_QUERY_COST = 135`) that counts every field node — aliases included —
  so a single request with ~20+ aliased expensive operations is rejected
  with a `QUERY_COST_EXCEEDED` error instead of bypassing the depth limit.

## Saved Search Run Endpoint (`GET /api/scouts/:wallet/saved-searches/:id/run`)

Executes a stored saved-search preset against the live player index, returning paginated player results in the same shape as `GET /api/players`. This closes the gap between storing a filter preset and actually using it — scouts no longer need to manually copy filter parameters from the list endpoint into a separate player-search request.

**Authentication:** Bearer JWT (scout role required; wallet must match the authenticated account).  
**Feature flag:** `SAVED_SEARCHES` must be enabled.

### Request

```
GET /api/scouts/:wallet/saved-searches/:id/run
```

| Parameter | In | Type | Required | Description |
|-----------|-----|------|----------|-------------|
| `wallet` | path | string | ✓ | Scout's Stellar public key |
| `id` | path | integer | ✓ | Row ID of the saved search to run |
| `page` | query | integer | — | Page number (default: `1`) |
| `pageSize` | query | integer | — | Results per page (default: `20`, max: `100`) |

The stored filter parameters (`region`, `position`, `minTier`) are loaded from the saved search row and merged with any pagination parameters supplied in the query string. Pagination params in the query string always take precedence over any pagination fields that might be present in the stored filters (which are excluded at creation time by `savedSearchFilterSchema`).

### Response `200`

```json
{
  "success": true,
  "data": {
    "players": [
      {
        "player_id": "clxyz...",
        "wallet": "GABC...",
        "position": "Forward",
        "region": "West Africa",
        "metadataUri": "ipfs://Qm...",
        "progress_level": 2,
        "created_at": 1700000000,
        "tierName": "Established",
        "tierDescription": "Performance milestones verified"
      }
    ],
    "total": 42,
    "page": 1,
    "pageSize": 20
  }
}
```

### Error responses

| Status | Condition |
|--------|-----------|
| `400` | `id` is not a valid integer |
| `403` | Wallet mismatch or not the scout role |
| `404` | Saved search not found (or belongs to another scout) |

### Example

```bash
# Create a saved search
curl -X POST "http://localhost:4000/api/scouts/${WALLET}/saved-searches" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"West Africa Forwards Tier 2+","filters":{"region":"West Africa","position":"Forward","minTier":2}}'
# → { "data": { "id": 7, ... } }

# Run it (page 2, 10 results per page)
curl "http://localhost:4000/api/scouts/${WALLET}/saved-searches/7/run?page=2&pageSize=10" \
  -H "Authorization: Bearer <token>"
```

---

#### `POST /api/admin/fees/config`

Propose and execute an `update_platform_fee` multi-sig action to update the on-chain platform fee. **Requires Bearer auth (admin role).**

**Request body**
```json
{
  "actionId": "action-uuid-001",
  "newFeeBps": 300
}
```

| Field       | Type    | Required | Description                            |
|-------------|---------|----------|----------------------------------------|
| `actionId`  | string  | ✅       | Unique identifier for this action      |
| `newFeeBps` | integer | ✅       | New fee in basis points (0–10000)      |

**Response `202`**
```json
{
  "success": true,
  "data": {
    "actionId": "action-uuid-001",
    "transactionId": "stub-fee-txid-...",
    "newFeeBps": 300
  }
}
```

**Error `400`** — out-of-range value
```json
{ "success": false, "error": "newFeeBps must be between 0 and 10000" }
```

---

## Stubbed Routes

The following routes currently return data sourced entirely from indexed on-chain events and have no corresponding write/mutation endpoint in the backend:

| Route                                    | Reason                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/scouts/:wallet/subscription`   | Subscription state managed on-chain via `subscribe()`; backend is read-only   |
| `GET /api/scouts/:wallet/contacts`       | Contact unlocks managed on-chain via `pay_to_contact()`; backend is read-only |
| `GET /api/validators/milestones/pending` | Milestone approval is an on-chain transaction; backend only indexes events    |

---

## Rate Limiting

Most scout write endpoints (`subscribe`, `unlockContact`, `createTrialOffer`,
webhook registration, etc.) apply `walletRateLimit()`, which pools requests
per authenticated wallet into a shared default counter
(`RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX`, default **60 s / 60 requests**,
per wallet). Exceeding it returns:

```json
{
  "success": false,
  "error": "Too many requests, please try again later"
}
```

with HTTP status **429**.

### Per-route overrides

| Route | Limit | Reason |
|-------|-------|--------|
| `POST /api/scouts/:wallet/webhooks/:id/test` | **5 requests/minute** per wallet (`WEBHOOK_TEST_RATE_LIMIT_MAX` / `WEBHOOK_TEST_RATE_LIMIT_WINDOW_MS`), isolated from the shared default pool | Unlike a normal write, each call makes the backend issue an outbound HTTP request to a caller-supplied URL — an abuse surface a shared 60/min pool doesn't adequately bound (#1037). The 429 is returned before the outbound request is attempted. |

## Request Timeouts

A global request timeout (`REQUEST_TIMEOUT_MS`, default **30 s**) is applied to all routes via the `requestTimeout` middleware in `app.ts`. When a response has not been sent within the configured window, the middleware writes:

```json
{
  "success": false,
  "error": "Request timed out",
  "code": "REQUEST_TIMEOUT"
}
```

with HTTP status **503**.

### Per-route overrides

Certain routes override the default timeout because their expected duration differs significantly:

| Route | Timeout | Reason |
|-------|---------|--------|
| `GET /api/admin/events/export` | **120 s** | Streaming CSV export of large tables can take up to 60 s; the longer window prevents a spurious 503 on a slow-but-healthy export. |
| `POST /api/admin/reindex` | **none (0)** | Returns 202 immediately — the actual ledger backfill runs as a background job and must never be killed by a network timeout. |
| `GET /health/liveness` | **5 s** | Kubernetes liveness probe — if the process cannot respond in 5 s it should be restarted. |
| `GET /health/readiness` | **5 s** | Kubernetes readiness probe — if the DB is unresponsive for more than 5 s the pod should be removed from the load-balancer. |

### Using `createTimeout` in new routes

Import the factory from the timeout middleware to apply a custom value on a specific route:

```ts
import { createTimeout } from '../middleware/timeout';

router.get('/slow-endpoint', createTimeout(60_000), requireRole('admin'), myHandler);
```

---

## Pagination

Paginated list endpoints consistently cap page size to prevent resource exhaustion and provide predictable response times. A shared constant (`MAX_PAGE_SIZE`) is enforced across all REST and GraphQL endpoints.

### Limits

| Setting | Value | Description |
|---------|-------|-------------|
| **Default page size** | `20` | Results returned when `pageSize` is omitted |
| **Maximum page size** | `100` | Hard cap applied to all list endpoints; requests exceeding this are clamped |

### Behavior

When a client requests a `pageSize` greater than the maximum:
- The request is **clamped** to `100` results
- The response includes the actual `pageSize` used (not the requested value)
- No error is returned — the clamp is silent (by design, to simplify client retry logic)

**Example:**
```bash
# Request 500 results
curl "http://localhost:4000/api/v1/players?pageSize=500"

# Response contains pageSize: 100 (not 500)
# Client must inspect the response to detect the clamp
{
  "success": true,
  "data": [...],
  "total": 50000,
  "page": 1,
  "pageSize": 100,
  "pages": 500
}
```

### Affected endpoints

**REST endpoints:**
- `GET /api/players` (filter/search)
- `GET /api/scouts/:wallet/saved-searches/:id/run`

**GraphQL queries:**
- `players(region, position, minTier, page, pageSize)`

All of these use the shared `MAX_PAGE_SIZE = 100` constant defined in `src/utils/pagination.ts`. The clamp is applied consistently whether the endpoint is called via REST query parameters or GraphQL arguments.

### Rationale

Inconsistent or undocumented page-size caps surprise clients — asking for 500 results and silently getting 100 with no indication creates debugging confusion. A single shared constant plus documentation in responses makes the contract predictable and reduces client-side surprises.

---

## Error Format

All error responses follow this shape:

```json
{
  "success": false,
  "error": "<human-readable message>",
  "code": "<machine-readable error code>",
  "correlationId": "<optional request correlation ID>"
}
```

The `code` field provides a machine-readable error classification for programmatic error handling. The mapping from HTTP status to error code is:

| HTTP Status | Error Code                | Meaning                       |
| ----------- | ------------------------- | ----------------------------- |
| 400         | `VALIDATION_ERROR`        | Invalid input data            |
| 401         | `UNAUTHORIZED`            | Missing or invalid auth token |
| 403         | `FORBIDDEN`               | Insufficient permissions      |
| 404         | `NOT_FOUND`               | Resource not found            |
| 409         | `CONFLICT`                | Resource conflict             |
| 413         | `PAYLOAD_TOO_LARGE`       | Request body exceeds limits   |
| 415         | `UNSUPPORTED_MEDIA_TYPE`  | Invalid content type          |
| 500         | `INTERNAL_SERVER_ERROR`   | Server error                  |

**Note:** When an error is thrown with an explicit `code` property already set, that code takes precedence over the status-based mapping.

### Error Code Reference

All error codes used in REST and GraphQL responses are defined in `src/utils/errorCodes.ts` and documented below. Each code indicates when it occurs and what the client should do.

#### Generic Errors

| Code | HTTP Status | When It Occurs | Client Action |
|------|------------|-------------|--------------|
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected server error | Retry with exponential backoff; contact support if persists |
| `NOT_FOUND` | 404 | Requested resource does not exist | Verify the resource ID/path is correct; check if it was deleted |
| `VALIDATION_ERROR` | 400 | Request validation failed (Zod schema, required fields, etc.) | Fix the request payload; check field names and types against API docs |
| `MALFORMED_JSON` | 400 | Request body contains invalid JSON syntax | Verify JSON syntax; ensure Content-Type is application/json |
| `PAYLOAD_TOO_LARGE` | 413 | Request body size exceeds the server limit | Reduce payload size; split into multiple requests if needed |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Request Content-Type is not supported | Set Content-Type: application/json in request headers |

#### Authentication & Authorization

| Code | HTTP Status | When It Occurs | Client Action |
|------|------------|-------------|--------------|
| `UNAUTHORIZED` | 401 | Request lacks valid authentication (missing/invalid JWT or API key) | Provide a valid Bearer token or X-API-Key header; refresh expired tokens |
| `FORBIDDEN` | 403 | Request is authenticated but lacks permission | Verify your account role/scope; contact support to request access |
| `TOKEN_INVALID` | 401 | JWT token is invalid (malformed, signed with wrong key) | Re-authenticate and obtain a fresh token |
| `TOKEN_EXPIRED` | 401 | JWT token has expired | Refresh the token or re-authenticate |

#### Resource-Specific Errors

| Code | HTTP Status | When It Occurs | Client Action |
|------|------------|-------------|--------------|
| `PLAYER_NOT_FOUND` | 404 | The specified player was not found or is hidden from this user | Verify the player_id is correct; check if the player is deactivated |
| `WALLET_MISMATCH` | 400 | The wallet/account in the request does not match the authenticated user | Use your own wallet address in the request path |
| `FEATURE_DISABLED` | 403 | A requested feature is disabled (feature flag not enabled) | Contact support to enable the feature; check docs for availability |

#### Subscription & Access Control

| Code | HTTP Status | When It Occurs | Client Action |
|------|------------|-------------|--------------|
| `NOT_SUBSCRIBED` | 402 | Scout has no active subscription (required for this operation) | Subscribe first via /api/scouts/:wallet/subscribe |
| `SUBSCRIPTION_REQUIRED` | 403 | An active subscription is required to perform this action | Subscribe first via /api/scouts/:wallet/subscribe |

#### Payment & Blockchain Errors

| Code | HTTP Status | When It Occurs | Client Action |
|------|------------|-------------|--------------|
| `INSUFFICIENT_FUNDS` | 402 | Account balance is insufficient to complete the payment | Check account balance; deposit funds or reduce transaction amount |
| `INVALID_ACCOUNT` | 400 | The specified account does not exist or is invalid | Verify the account identifier is valid and exists |
| `NETWORK_ERROR` | 503 | A network error occurred (blockchain RPC unreachable, etc.) | Retry after a short delay; check if the blockchain is operational |
| `PAYMENT_UNKNOWN` | 500 | A payment operation failed for an unknown reason | Retry; if it persists, contact support with transaction details |
| `NO_FEES` | 400 | No accumulated fees are available to withdraw | Check again after platform fees accrue from transactions |
| `INVALID_RECIPIENT` | 400 | The withdrawal recipient address is invalid or not supported | Verify the recipient wallet/account format |
| `CONTRACT_PAUSED` | 503 | The subscription contract is paused (emergency maintenance) | Retry after a delay; operations will resume when unpaused |

#### Conflict & Concurrency Errors

| Code | HTTP Status | When It Occurs | Client Action |
|------|------------|-------------|--------------|
| `CONFLICT` | 409 | A resource conflict occurred (duplicate key, state mismatch, etc.) | Check the current state; retry with updated data or a different key |
| `PRECONDITION_FAILED` | 412 | If-Match header supplied but does not match current resource version | Fetch the current resource, get the new ETag, and retry with new ETag |
| `PRECONDITION_REQUIRED` | 428 | Request requires an If-Match header (conditional request) that was not supplied | Include the If-Match header with the current ETag from a prior GET request |

#### Administrative Actions

| Code | HTTP Status | When It Occurs | Client Action |
|------|------------|-------------|--------------|
| `EXPIRED_ACTION` | 410 | A multi-sig admin action has expired and can no longer be approved | Propose the action again to create a fresh request |
| `ACTION_EXECUTED` | 409 | A multi-sig admin action has already been executed | Check the action status; cannot re-approve completed actions |

---



**On-chain semantics:**
- The `cancel_subscription(scout)` entrypoint on the `subscription` contract marks the subscription as expired at the current ledger (no refund).
- Returns HTTP `402` with error code `NOT_SUBSCRIBED` (contract code 8) when:
  - the scout has never subscribed, or
  - the subscription has already expired naturally, or
  - the subscription was previously cancelled.
- The cancel is idempotent in the sense that a successfully cancelled subscription cannot be cancelled again (subsequent attempts return `NOT_SUBSCRIBED`).
- After cancellation `is_subscribed(scout)` returns `false` immediately.

**Response (success):**
```json
{ "success": true, "transactionId": "abc123..." }
```

**Response (no subscription):**
```json
{ "success": false, "error": "Scout has no active on-chain subscription", "code": "NOT_SUBSCRIBED" }
```

### Pause / Unpause Contract

`POST /api/admin/contract/pause` / `POST /api/admin/contract/unpause`

These endpoints invoke `pause(admin)` / `unpause(admin)` on the **subscription** contract via the platform keypair. The subscription contract's pause flag gates `subscribe`, `pay_to_contact`, and `withdraw_fees`. The `register` and `connection` contracts each have their own `pause`/`unpause` entrypoints that must be called separately if a full platform pause is needed.

**Behavior:**
- Calling `pause` when already paused is a no-op (returns success).
- Calling `unpause` when already active is a no-op (returns success).
- Only the admin address configured at contract initialization may call these.
- The platform backend routes these calls to the **subscription contract** (`SUBSCRIPTION_CONTRACT_ID`).

### Fee Balance Query

`GET /api/admin/fees` — Returns the accumulated platform fee balance from the subscription contract.

The underlying call is `get_fee_balance() → i128` on the `subscription` contract, which is a read-only simulation (no transaction submitted, no keypair required). The balance represents total fees accumulated from `subscribe` and `pay_to_contact` calls since the last `withdraw_fees`.

**Response:**
```json
{ "balanceStroops": "5000000", "balanceXLM": "0.5" }
```
