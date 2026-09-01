# Authentication

This document describes the backend authentication flow for ScoutOff.
It covers SEP-10 challenge/response, JWT issuance, token claims, refresh behavior, logout, and example `curl` requests.

## SEP-10 Challenge / Response Flow

ScoutOff uses Stellar SEP-10 for wallet-based authentication.
The client proves ownership of a Stellar account by signing a server-issued challenge transaction.

## SEP-10 Server Keypair (`SEP10_SERVER_SECRET`)

Every SEP-10 challenge transaction is signed by the server with a dedicated Stellar keypair.
`verifyAndIssueToken` checks that the challenge carries this server signature before accepting the client's signature — this proves the challenge was issued by a trusted ScoutOff backend and not forged by a third party.

### Why it must be shared across all instances

In a horizontally-scaled deployment (multiple backend pods behind a load balancer), every instance must use **the same keypair**.
Without a shared keypair, instance A signs the challenge with its own random key, but if the wallet's `POST /auth/token` request is routed to instance B, the server-signature check fails — not because of anything wrong on the client side, but because instance B has a different random key.
This produces intermittent, load-distribution-dependent auth failures that are extremely hard to diagnose.

### Configuration

Set `SEP10_SERVER_SECRET` to the same Stellar secret key on every backend instance.

```bash
# Generate a new keypair (requires the Stellar CLI)
stellar keys generate sep10-server --network testnet
# Copy the secret key (starts with 'S') into your env / secrets manager

# Or generate a raw 32-byte key that can be imported as a Stellar keypair:
# openssl rand -hex 32
```

| Behaviour | Environment |
|-----------|-------------|
| Process refuses to start if unset | `production` |
| Warning logged on startup if unset | `staging` |
| Ephemeral per-process key used (single-instance local dev only) | `development` / `test` |

**The ephemeral fallback is intentionally unsafe for multi-instance deployments** — it exists only so developers can run the project locally without extra config.

### Key rotation

Rotating the SEP-10 server keypair invalidates any outstanding challenge transactions that have not yet been exchanged for a JWT.  Challenges have a 5-minute TTL, so the impact window is short.  Follow this procedure to minimise disruption:

1. **Generate a new keypair** — `stellar keys generate sep10-server-new --network mainnet`
2. **Deploy with both keys in parallel** is not required because challenges expire in 5 minutes — a brief auth interruption is acceptable during the rollout window.
3. **Update the secret** — replace `SEP10_SERVER_SECRET` in your secrets manager / Kubernetes Secret.
4. **Rolling-restart all instances** — each pod picks up the new key on startup.  Pods with the old key will reject challenges built after the restart; pods with the new key will reject challenges built before.  The 5-minute window means at most one failed auth attempt per affected client during the rollout.
5. **Verify** — run a full SEP-10 auth flow end-to-end against the updated deployment before closing the change.

> ⚠️ **Security note**: `SEP10_SERVER_SECRET` is a Stellar secret key — treat it with the same care as `JWT_SECRET`.  Never commit it to source control.  Store it in a secrets manager (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault, Kubernetes Secrets) and inject it as an environment variable at runtime.  See [docs/secrets-rotation.md](secrets-rotation.md) for the general rotation policy.

### 1. Request a SEP-10 challenge

`GET /auth/challenge?account=G...`

Request a challenge XDR by passing the client Stellar account public key in the `account` query string.

Example:

```bash
curl "http://localhost:3000/auth/challenge?account=GABC123..." \
  -H "Accept: application/json"
```

Successful response:

```json
{
  "challenge": "AAAA...",
  "networkPassphrase": "Test SDF Network"
}
```

- `challenge` is a SEP-10 transaction XDR that must be signed by the client wallet.
- `networkPassphrase` indicates which Stellar network the challenge uses.

### 2. Sign the challenge and request a JWT

`POST /auth/token`

After signing the challenge transaction, submit the signed XDR to the backend.
The request body should include the signed `transaction` and optionally a `role` hint when requesting a specific role such as `validator`.

Example:

```bash
curl "http://localhost:3000/auth/token" \
  -H "Content-Type: application/json" \
  -d '{
    "transaction": "AAAA...",
    "role": "scout"
  }'
```

Successful response:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "account": "GABC123...",
  "expiresAt": 1710000000
}
```

- `token` is the JWT used for authenticated API requests.
- `account` is the authenticated Stellar account.
- `expiresAt` is the UNIX timestamp when the token expires.

Each challenge is single-use: `verifyAndIssueToken` tracks the nonce (the
challenge's `manageData` value) of every challenge it has successfully
exchanged for a token, keyed for the duration of the challenge's own 5-minute
TTL. Resubmitting the identical signed challenge — e.g. one captured via a
compromised client or a leaked request log — is rejected with `Challenge has
already been used` (#693) instead of minting another token.

## JWT Claims Structure

The backend issues JWTs with the following standard claims:

- `sub`: the Stellar account that authenticated the request.
- `role`: the assigned role for the token.
- `exp`: token expiration timestamp.

Example decoded payload:

```json
{
  "sub": "GABC123...",
  "role": "player",
  "iat": 1700000000,
  "exp": 1700086400
}
```

### Supported roles

The backend supports these token roles:

- `player`
- `scout`
- `validator`
- `admin`

The `role` may be assigned from the request or automatically elevated to `admin` if the authenticated account matches either of two configurable admin-wallet environment variables:

- **`ADMIN_WALLET`** (singular) — a single Stellar address. This is the original, backward-compatible variable. It's **required in production** (the process refuses to start without it) and produces a startup warning in staging if unset.
- **`ADMIN_WALLETS`** (plural, comma-separated) — one or more Stellar addresses, added to support the multi-sig admin-action feature (see below). If `ADMIN_WALLETS` is not set, it falls back to the value of `ADMIN_WALLET`, so a single-admin setup using only `ADMIN_WALLET` still works without extra configuration.

**How they combine:** these are not a fallback pair where one overrides the other — an authenticating account is elevated to `admin` if it matches *either* `ADMIN_WALLET` **or** is present in the `ADMIN_WALLETS` list. If you configure both with different values, both are honored simultaneously.

**Multi-sig admin actions:** `ADMIN_WALLETS` and `ADMIN_THRESHOLD` (default `1`) work together to gate high-value admin actions (contract pause/unpause, fee withdrawal). If `ADMIN_THRESHOLD` is `1`, an action from any wallet in `ADMIN_WALLETS` executes immediately. If it's greater than `1`, the action is proposed and held pending until enough distinct wallets from `ADMIN_WALLETS` co-sign it. See `src/services/adminMultiSig.ts` for the signing/approval logic.

## Token Refresh

`POST /auth/token` now returns **both** a short-lived access token and a
long-lived refresh token. Mobile clients and any client that needs to stay
authenticated across the access token's TTL should store the refresh token
securely (device keychain / secure storage — **never** `localStorage`) and
use it to obtain a new token pair silently.

### Access token TTL

The access token expires after `JWT_ACCESS_TTL_SECONDS` (default **15 minutes**,
configurable via environment variable). The `expiresAt` field in every token
response is the Unix timestamp when the access token expires.

### Refresh token TTL

The refresh token expires after **7 days**. After expiry the full SEP-10
challenge flow must be repeated.

### Token response shape (POST /auth/token)

```json
{
  "token": "eyJ...",
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "account": "GABC123...",
  "expiresAt": 1710000900
}
```

Both `token` and `accessToken` carry the same value. `token` is retained for
backwards compatibility with existing clients.

### POST /auth/refresh — silent re-authentication

Exchange a valid refresh token for a new access + refresh token pair.
**Refresh token rotation** is enforced: the submitted refresh token is revoked
immediately and a fresh one is returned. Using the same refresh token a second
time returns `401`.

Request:

```bash
curl -X POST "http://localhost:4000/auth/refresh" \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "<your-refresh-token>" }'
```

Successful response (`200`):

```json
{
  "success": true,
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "expiresAt": 1710000900
}
```

Error responses:

| Status | Reason |
|--------|--------|
| `400` | `refreshToken` field missing from body |
| `401` | Token is expired, has an invalid signature, is not a refresh token, or has been revoked (used twice) |

### Refresh token lifecycle

```
POST /auth/token
  └─► { accessToken (15 min), refreshToken (7 days) }
          │
          │  (access token expires)
          ▼
POST /auth/refresh  { refreshToken: <old> }
  └─► { accessToken (new, 15 min), refreshToken (new, 7 days) }
          │  old refresh token is NOW REVOKED
          │
          │  (repeat as needed, up to 7 days from last full SEP-10 auth)
          ▼
POST /auth/logout   (revokes access + refresh tokens)
  └─► { success: true }
```

Key properties:

- Each refresh token can only be used **once** (rotation). Reuse returns `401`.
- Refresh tokens carry `type: 'refresh'` in their JWT payload so they cannot
  be used as bearer tokens on API routes.
- The server never persists refresh tokens — only revoked `jti` values are
  stored (in `revoked_tokens`), keeping server state minimal.
- All revoked `jti` entries are pruned once their `expires_at` passes.

## Logout

`POST /auth/logout` revokes both the caller's access token and (optionally) its
paired refresh token so neither can be reused after logout.

```bash
curl -X POST "http://localhost:4000/auth/logout" \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "<your-refresh-token>" }'
```

- The `Authorization: Bearer` header is required (any valid role).
- The `refreshToken` body field is optional — omitting it only revokes the
  access token.
- After logout, any further use of the access token or the submitted refresh
  token returns `401`.

Successful response (`200`):

```json
{ "success": true, "message": "Logged out successfully" }
```

## Using the JWT for authenticated API requests

Protected endpoints require the header:

```
Authorization: Bearer <token>
```

Example request to a protected route:

```bash
curl "http://localhost:3000/api/admin/events" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

## API-key scopes (#1019)

Long-lived API keys (issued via `POST /api/scouts/:wallet/api-keys`) can be
used in place of a Bearer JWT for server-to-server integrations:

```
X-API-Key: <raw-key>
```

### How a key is stored and resolved (#1033)

The raw key is returned once at issuance and never persisted. Two *derived*
representations are stored per row, and they have deliberately different jobs:

| Column | Construction | Job |
|--------|--------------|-----|
| `key_hash` | `salt:sha256(salt + raw_key)`, random per-row salt | **The authentication proof.** Compared timing-safely against the presented key. Salted, therefore not searchable. |
| `lookup_hash` | `v1:HMAC-SHA256(API_KEY_LOOKUP_SECRET, domain ‖ raw_key)` | **A locator only.** Deterministic, so it can carry a UNIQUE index and be matched with a single equality predicate. |

Authentication is therefore two steps, and the first one never authenticates
anything on its own:

```
raw X-API-Key
   → derive lookup_hash            (src/utils/apiKeyLookup.ts)
   → SELECT … WHERE lookup_hash = ? AND revoked_at IS NULL LIMIT 1
   → verify raw key against that row's salted key_hash
   → authenticated
```

Previously there was no deterministic column to search, so resolution loaded
every active key and re-hashed the presented key against each row — cost grew
linearly with the number of issued keys, on the hot path of every request.

`lookup_hash` is never returned by any API response; `GET .../api-keys` still
exposes only a truncated `key_prefix` display hint.

**Why the HMAC pepper.** A bare digest of the raw key would let anyone holding
a read-only copy of the database (leaked backup, replica, over-broad analytics
grant) confirm a guessed or intercepted key offline and correlate the same key
across environments. `API_KEY_LOOKUP_SECRET` is held outside the database, so
the column is inert on its own. It is **required in production** (the process
refuses to start without it) and must be identical on every instance — a key
issued by one instance is otherwise unfindable by another.

**Rotating `API_KEY_LOOKUP_SECRET`.** Every stored `lookup_hash` is derived
from it, and the raw keys needed to re-derive them do not exist server-side.
To rotate: set the new secret, then `UPDATE api_keys SET lookup_hash = NULL`.
Every key falls back to the transitional path below and re-derives its lookup
value under the new pepper on its next successful use. Expect a temporary
scan cost while that drains. Do not rotate casually.

**Keys issued before this change.** They have `lookup_hash IS NULL` and cannot
be backfilled in SQL — only the one-way salted hash is stored. They keep
working and heal themselves: when the indexed lookup misses, resolution checks
*only* the not-yet-migrated rows (a partial index, so it costs nothing once
that set is empty) and writes the derived `lookup_hash` on the first
successful authentication, moving the key onto the indexed path permanently.
**No scout has to rotate a key.** This transitional path is not a general
fallback — a wrong or revoked key never triggers a full-table scan.

### Scope semantics

Every API key carries an optional `scopes` list. Authorization is enforced
through a single shared contract (`src/utils/apiKeyScopes.ts`) used by both
REST middleware (`requireApiKeyScope`) and GraphQL context/resolvers — the two
surfaces can never drift apart.

| Key state | Behavior |
|-----------|----------|
| `scopes` is `NULL` / missing / empty | **Legacy key — unrestricted.** Keeps full scout-level access, exactly as before scope enforcement existed. |
| `scopes` is the migration-default list (`read:players`, `read:milestones`, `write:contacts`, `read:subscription`) | **Legacy — unrestricted.** The `db/014_api_key_scopes.sql` column default was written into every pre-existing row, so it is treated as "predates scope enforcement" rather than as a restricted set. |
| `scopes` is malformed JSON | **Legacy — unrestricted** (fail-open, logged). A corrupt row must never brick a valid key. |
| `scopes` is any other JSON array | **Restricted.** Only operations covered by a granted scope are permitted; everything else returns `403` (REST) or a GraphQL `UNAUTHORIZED` error. |

### Scope vocabulary

| Scope | Operations |
|-------|------------|
| `read:players` | Read player profiles (public data) |
| `read:milestones` | Read player milestones |
| `read:subscription` | Read subscription status (`GET /scouts/:wallet/subscription`, GraphQL `scoutSubscription`) |
| `read:contacts` | Read unlocked contact details |
| `write:contacts` | Unlock contacts |
| `write:subscriptions` | Subscribe / renew / cancel subscriptions |
| `write:trial_offers` | Create trial offers |
| `write:webhooks` | Register / delete / test webhooks |
| `write:api_keys` | Issue / revoke / rotate API keys |
| `write:bookmarks` | Manage bookmarks and bookmark folders |
| `write:notes` | Create / update / delete scout notes |
| `write:saved_searches` | Create / update / delete saved searches |
| `write:player_tokens` | Purchase player tokens |

### Issuing restricted keys

Omit `scopes` (or pass an empty array) for a legacy/unrestricted key. Pass an
explicit list to restrict the key:

```bash
curl -X POST "http://localhost:3000/api/scouts/G.../api-keys" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "label": "ci-bot", "scopes": ["read:milestones", "write:contacts"] }'
```

Unknown scope strings are rejected at issuance (`400`). A restricted key that
lacks the scope for an operation receives `403` with `reason.requiredScope`
and `reason.providedScopes`.

### Rotating a key without downtime (#676)

Rotating a key by hand — issue a new one, then separately revoke the old one
— has two real failure modes: revoke the old key before the new one is
deployed everywhere that consumes it, and the integration goes down; or
crash after issuing the new key but before revoking the old one, and the old
key stays live indefinitely. `POST .../api-keys/:id/rotate` does both in one
atomic request, and the old key keeps working for a grace period instead of
dying immediately:

```bash
curl -X POST "http://localhost:3000/api/scouts/G.../api-keys/42/rotate" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "gracePeriodSeconds": 86400 }'
```

```json
{
  "success": true,
  "data": {
    "newKey": { "id": 57, "key": "<64-char hex>", "label": "ci-bot", "created_at": 1234567890, "scopes": ["read:milestones"] },
    "oldKey": { "id": 42, "revokesAt": 1234654290 }
  }
}
```

- The replacement key inherits the old key's `label` and `scopes` — rotation
  replaces credentials, not policy. Update scopes with a separate issue/revoke
  pair if the rotated key also needs a different scope list.
- `gracePeriodSeconds` is optional and defaults to `86400` (24h); the maximum
  is 7 days (`604800`). `0` revokes the old key immediately, equivalent to a
  plain `DELETE`.
- The old key (`oldKey.id`) keeps authenticating normally until
  `oldKey.revokesAt` (a unix timestamp, seconds) and is rejected from that
  moment on — enforced live by the same active-key queries used for every
  `X-API-Key` request (`revoke_after IS NULL OR revoke_after > now`), so
  there is no background sweep job and no window where an already-elapsed
  key is still mistakenly accepted.
- **Recommended integrator workflow:** call rotate, deploy the returned
  `newKey.key` to every system that uses the old one, then optionally call
  `DELETE .../api-keys/:oldId` once the rollout is confirmed complete instead
  of waiting out the full grace period. If the rollout isn't done in time,
  call rotate again on the *new* key before its own eventual expiry — do not
  rely on an indefinitely long `gracePeriodSeconds` as a substitute for
  finishing the rollout.
- Rotating an already-revoked or unknown key id returns `404`. Rotating
  requires the `write:api_keys` scope, same as issuing and revoking.

### API key expiry (#674)

Server-to-server keys embedded in long-lived configuration, CI secrets, or
third-party integrations are easy to forget. Without an automatic expiry a
leaked or forgotten key stays valid indefinitely — every such key is a
permanent liability with no natural decay.

**Default lifetime.** Keys issued without an explicit `expiresInDays` value
expire after `API_KEY_DEFAULT_TTL_DAYS` days (default: **90 days**). The
`expires_at` timestamp (unix seconds) is returned at issuance and included
in `GET .../api-keys` list responses:

```bash
curl -X POST "http://localhost:3000/api/scouts/G.../api-keys" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "label": "ci-bot" }'
# → { "data": { "id": 42, "key": "...", "expires_at": 1763308800, ... } }
```

**Requesting a specific lifetime.** Pass `expiresInDays` to override the
default:

```bash
# 30-day key
-d '{ "label": "short-lived", "expiresInDays": 30 }'

# No expiry (explicit opt-in — use sparingly)
-d '{ "label": "permanent", "expiresInDays": 0 }'
```

**Enforcement.** Expiry is enforced live — every active-key query used for
`X-API-Key` authentication checks `expires_at IS NULL OR expires_at > now`,
so an expired key stops resolving immediately with no background sweep. An
expired key returns the same `401 Unauthorized` as a revoked or unknown key;
the body message is `"Invalid or revoked API key"`.

**Rotation and expiry.** When a key is rotated (`POST .../api-keys/:id/rotate`),
the replacement key inherits the original lifetime: if the old key was issued
with a 90-day lifetime, the new key also gets a fresh 90-day window from the
time of rotation. A key with no expiry (`expires_at: null`) produces a
no-expiry replacement.

**Configuring the default.** Set `API_KEY_DEFAULT_TTL_DAYS` to change the
server-wide default (see [DEPLOYMENT.md](../DEPLOYMENT.md#api-key-expiry--api_key_default_ttl_days-674)).
Set to `0` to disable automatic expiry globally (not recommended for
production).

### GraphQL scope enforcement

GraphQL accepts the same `X-API-Key` header. Restricted keys are enforced on
GraphQL read scopes: `milestones` requires `read:milestones`, and
`scoutSubscription` requires `read:subscription`. Legacy keys and
JWT/anonymous requests are never scope-gated.

## SSE live revocation & wallet blocklisting (#1019)

`GET /api/events/stream` authenticates when the connection is established, but
an *established* connection is also monitored so revoked tokens and
blocklisted wallets lose access immediately:

- **Token revocation** — if the JWT used to open the stream is revoked (e.g.
  `POST /auth/logout` or admin token revocation), the connection emits a
  terminal `session_ended` event with `reason: "token_revoked"` and closes.
  No further protected events are delivered.
- **Wallet blocklisting** — if the authenticated wallet is blocklisted, the
  connection emits `session_ended` with `reason: "wallet_blocklisted"` and
  closes. Blocklisted wallets also cannot open a new stream (`403`).

### Detection bound

| Scenario | Bound |
|----------|-------|
| Revocation/blocklist processed in the **same process** as the SSE connection | **Immediate** — delivered synchronously via in-process events. |
| Revocation/blocklist persisted by **another instance** | **≤ `SSE_AUTH_SWEEP_INTERVAL_MS`** (default `30 000` ms). A single sweep query per process (never one per keep-alive tick) picks up cross-process changes. |

There is no database query per keep-alive tick — the keep-alive path stays
O(1) regardless of how many connections are open.

### Managing the wallet blocklist

The blocklist is persisted in `wallet_blocklist` (migration `022`). The
service (`src/services/walletBlocklist.ts`) exposes `blocklistWallet`,
`unblocklistWallet`, `isWalletBlocklisted`, and an in-process
`onWalletBlocked` event.


## End-to-End Curl Walkthrough

This section provides a copy-pasteable walkthrough of the complete SEP-10
authentication flow using `curl` and the Stellar CLI. Run these commands
against a local dev server (`npm run dev` → `http://localhost:4000`).

### Prerequisites

- A Stellar account keypair (generate with `stellar keys generate --network testnet test-user`)
- The dev server running locally (`npm run dev`)
- The Stellar CLI installed (`stellar --version`)

### 1. Request a Challenge

```bash
ACCOUNT="GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
curl -s "http://localhost:4000/auth/challenge?account=$ACCOUNT" | jq .
```

Response:

```json
{
  "transaction": "AAAAAgAAAAD...",
  "network_passphrase": "Test SDF Network ; September 2015"
}
```

Save the `transaction` XDR for the next step.

### 2. Sign the Challenge (Stellar CLI)

The challenge transaction must be signed with the account's secret key.
This step uses the Stellar CLI — it cannot be done with `curl` alone.

```bash
# Save the challenge XDR to a file
curl -s "http://localhost:4000/auth/challenge?account=$ACCOUNT" | jq -r '.transaction' > /tmp/challenge.xdr

# Sign it with your secret key
SECRET="SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
stellar tx sign --xdr /tmp/challenge.xdr --sign-with $SECRET --network testnet > /tmp/signed.xdr

SIGNED_XDR=$(cat /tmp/signed.xdr)
echo "Signed XDR: ${SIGNED_XDR:0:40}..."
```

> **Note:** In a frontend application, this signing step is handled by the
> Stellar wallet extension (Freighter, Albedo, etc.) via the
> `@stellar/stellar-sdk` or `@creit.tech/stellar-wallets-kit` library.

### 3. Exchange the Signed Challenge for a JWT

```bash
curl -s "http://localhost:4000/auth/token" \
  -H "Content-Type: application/json" \
  -d "{\"transaction\": \"$SIGNED_XDR\"}" | jq .
```

Response:

```json
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "dGhpcyBpcyBh...",
  "token": "eyJhbGciOi...",
  "account": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "expiresAt": "2026-08-28T12:00:00.000Z"
}
```

Save both `accessToken` and `refreshToken` — you'll need them for the next steps.

### 4. Use the Bearer Token

Include the `accessToken` in the `Authorization` header for all authenticated requests:

```bash
TOKEN="eyJhbGciOi..."

# Example: list players
curl -s "http://localhost:4000/api/players" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Example: check subscription status (scout role required)
curl -s "http://localhost:4000/api/scouts/$ACCOUNT/subscription" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### 5. Refresh the Token

When the access token expires (default: 24 hours), use the refresh token to
obtain a new pair:

```bash
REFRESH="dGhpcyBpcyBh..."

curl -s "http://localhost:4000/auth/refresh" \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\": \"$REFRESH\"}" | jq .
```

Response includes a new `accessToken` and `refreshToken`. The old refresh token
is immediately revoked on success (rotation).

### 6. Log Out

Revoke the current access token and optionally the refresh token:

```bash
# Revoke access token only
curl -s "http://localhost:4000/auth/logout" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Revoke both access and refresh tokens
curl -s "http://localhost:4000/auth/logout" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\": \"$REFRESH\"}" | jq .
```

Response:

```json
{ "success": true }
```

### Complete Script

Save this as `scripts/auth-flow-test.sh` and run it against a local dev server:

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="${1:-http://localhost:4000}"
ACCOUNT="${2:-GXXXXXXXXXX}"   # replace with your test account
SECRET="${3:-SXXXXXXXXXX}"    # replace with your secret key

echo "=== 1. Request challenge ==="
CHALLENGE=$(curl -s "$BASE/auth/challenge?account=$ACCOUNT" | jq -r '.transaction')
echo "Challenge: ${CHALLENGE:0:50}..."

echo "=== 2. Sign challenge ==="
echo "$CHALLENGE" > /tmp/auth-test-challenge.xdr
stellar tx sign --xdr /tmp/auth-test-challenge.xdr --sign-with "$SECRET" --network testnet > /tmp/auth-test-signed.xdr
SIGNED=$(cat /tmp/auth-test-signed.xdr)

echo "=== 3. Exchange for JWT ==="
TOKENS=$(curl -s "$BASE/auth/token" -H "Content-Type: application/json" -d "{\"transaction\":\"$SIGNED\"}")
ACCESS=$(echo "$TOKENS" | jq -r '.accessToken')
REFRESH=$(echo "$TOKENS" | jq -r '.refreshToken')
echo "Access token: ${ACCESS:0:30}..."

echo "=== 4. Authenticated request ==="
curl -s "$BASE/api/players" -H "Authorization: Bearer $ACCESS" | jq '. | length'

echo "=== 5. Refresh ==="
NEW_TOKENS=$(curl -s "$BASE/auth/refresh" -H "Content-Type: application/json" -d "{\"refreshToken\":\"$REFRESH\"}")
echo "New access token: $(echo "$NEW_TOKENS" | jq -r '.accessToken' | cut -c1-30)..."

echo "=== 6. Logout ==="
curl -s "$BASE/auth/logout" -H "Authorization: Bearer $ACCESS"
echo ""

echo "✅ Auth flow complete"
```


## Auth-related endpoints

### `GET /auth/challenge?account=G...`

- Purpose: request a SEP-10 challenge transaction for the given Stellar account.
- Authentication: none.
- Returns: challenge XDR and network passphrase.

### `POST /auth/token`

- Purpose: submit the signed SEP-10 challenge and receive a JWT access token
  and a refresh token.
- Authentication: none.
- Request body:
  - `transaction` (string): signed challenge XDR
  - `role` (optional string): requested role hint
- Returns: `accessToken`, `refreshToken`, authenticated `account`, and `expiresAt` timestamp.
  The legacy `token` field mirrors `accessToken` for backwards compatibility.

### `POST /auth/refresh`

- Purpose: exchange a valid refresh token for a new access + refresh token pair
  (rotation — the submitted token is revoked on success).
- Authentication: none (refresh token in request body).
- Request body:
  - `refreshToken` (string): a non-expired, non-revoked refresh token
- Returns: `accessToken`, `refreshToken`, `expiresAt`.
- Errors: `400` missing field; `401` invalid/expired/revoked token.

### `POST /auth/logout`

- Purpose: revoke the caller's access token and optionally their refresh token.
- Authentication: Bearer access token (any role).
- Request body (optional):
  - `refreshToken` (string): if provided, this refresh token is also revoked.
- Returns: `{ success: true }`.

### `POST /api/admin/introspect`

This admin route can be used to verify a token and inspect its payload.
It requires a valid admin JWT and is useful for debugging.

Example:

```bash
curl "http://localhost:3000/api/admin/introspect" \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "token": "<token-to-inspect>" }'
```

Successful response:

```json
{
  "success": true,
  "data": {
    "sub": "GABC123...",
    "role": "admin",
    "iat": 1700000000,
    "exp": 1700086400
  }
}
```
