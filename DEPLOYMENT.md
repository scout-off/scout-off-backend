# Deployment Notes — ScoutOff Backend

## ⚠️ SQLite + Multi-Replica Deployments

**If you deploy with more than one replica (pod/instance), you MUST switch to PostgreSQL.** The default database driver is SQLite — a single-writer, file-local database. Running multiple replicas with SQLite will cause:

- **Write conflicts**: only one replica can hold the write lock at a time
- **Data inconsistency**: each replica maintains its own independent database file, so writes on replica A are invisible to replica B
- **Unpredictable SSE behaviour**: SSE streams are scoped to a single process, so clients connected to different replicas see different state

The Helm chart defaults to autoscaling with `replicaCount ≥ 2` (see `charts/scout-off-backend/values.yaml`), which is incompatible with the default `DB_DRIVER=sqlite` setting.

### Fix

To run multi-replica deployments, set in your `.env` or Helm values:

```env
DB_DRIVER=postgres
DATABASE_URL=postgresql://user:password@host:5432/scoutoff
```

This mismatch will be enforced by a startup check in a future release; for now it is a critical configuration trap that every operator must be aware of.


## Environment Setup

Copy `.env.example` to `.env` and fill in all required values before starting the server.

> [!NOTE]
> For instructions and policies on managing, securing, and rotating long-lived secrets (such as JWT secrets, Pinata credentials, and platform signing keys), see the [Secrets Rotation Policy](docs/secrets-rotation.md).

| Variable | Required | Notes |
|---|---|---|
| `CONTRACT_ID` | — | Legacy single-contract address (backward compat). Falls back as default for each per-contract var below. |
| `REGISTER_CONTRACT_ID` | ✅ | Deployed `register` Soroban contract address |
| `PROGRESS_CONTRACT_ID` | ✅ | Deployed `progress` Soroban contract address |
| `SUBSCRIPTION_CONTRACT_ID` | ✅ | Deployed `subscription` Soroban contract address |
| `CONNECTION_CONTRACT_ID` | ✅ | Deployed `connection` Soroban contract address |
| `JWT_SECRET` | ✅ | Min 32 chars; rotate via dual-key window (see below) |
| `JWT_SECRET_PREVIOUS` | — | Previous signing secret during rotation grace window |
| `JWT_SECRET_PREVIOUS_UNTIL` | — | Absolute grace-window end (Unix seconds or ISO-8601). After this time previous tokens are rejected even if `JWT_SECRET_PREVIOUS` is still set |
| `SEP10_SERVER_SECRET` | ✅ | Stellar secret key (starts with `S`) used to sign and verify SEP-10 challenge transactions. **Must be identical across every backend instance** — without it each process generates an ephemeral random keypair, causing cross-instance auth failures under a load balancer. Generate with `stellar keys generate` and store in your secrets manager. See [docs/auth.md](docs/auth.md#sep-10-server-keypair-sep10_server_secret) for rotation guidance. |
| `HORIZON_URL` | ✅ | e.g. `https://horizon-testnet.stellar.org` |
| `SOROBAN_RPC_URL` | ✅ | e.g. `https://soroban-testnet.stellar.org` |
| `NETWORK` | ✅ | `testnet` or `mainnet` |
| `PINATA_API_KEY` / `PINATA_SECRET` | ✅ | IPFS upload credentials |
| `DB_DRIVER` | — | Database driver: `sqlite` (default) or `postgres` |
| `DB_PATH` | — | SQLite file path (default: `scout-off.db`); only used when `DB_DRIVER=sqlite` |
| `DATABASE_URL` | — (required when `DB_DRIVER=postgres`) | PostgreSQL connection string, e.g. `postgresql://user:pass@host:5432/db` |
| `SSE_KEEPALIVE_INTERVAL_MS` | — | Keep-alive ping interval for SSE connections, in ms (default: `15000`) |
| `SSE_MAX_CONNECTIONS` | — | Max concurrent SSE connections; `0` = unlimited (default: `0`) |
| `PORT` | — | API port (default: `4000`) |
| `LOG_LEVEL` | — | `debug` / `info` / `warn` / `error` |
| `LOG_SKIP_PATHS` | — | Comma-separated paths requestLogger silences (default: health + metrics probes) |
| `LOG_SAMPLE_RATE` | — | Float 0–1 sample rate for non-skipped paths (default: `1` = log all) |
| `STELLAR_HEALTH_CHECK` | — | Set `false` in staging to skip Stellar RPC check |
| `TRUSTED_PROXY_COUNT` | — | Number of trusted reverse proxies (default: `1`). Set to the exact number of proxy hops between the internet and this server. **Fail-safe**: if the observed `X-Forwarded-For` chain has fewer entries than this value implies, `extractClientIp()` falls back to the raw socket address rather than trusting the attacker-controlled leftmost value. A chain shorter than expected (direct connection bypassing a proxy, or a client crafting a short header) will therefore appear to come from the connecting IP, not a spoofed address. |
| `ADMIN_WALLET` | — | Single admin wallet address (for backward compatibility) |
| `ADMIN_WALLETS` | — | Comma-separated list of admin wallet addresses (e.g., `GABC...,GDEF...`) |
| `ADMIN_THRESHOLD` | — | Number of admin signatures required for high-value operations (default: `1`) |
| `ADMIN_ACTION_TTL_MS` | — | TTL for pending admin multi-sig actions in milliseconds (default: `3600000` = 1 hour) |
| `CORS_ALLOWED_ORIGINS` | — | Comma-separated CORS allowed origins (defaults per env: `*` in dev, `https://staging.scoutoff.io` in staging, `https://app.scoutoff.io,https://scoutoff.io` in prod) |
| `ADMIN_IP_ALLOWLIST` | — | Comma-separated list of **IPv4** addresses/CIDR ranges allowed to reach admin endpoints (e.g. `192.168.1.0/24,10.0.0.1`). Unset/empty disables the check. IPv6 is not supported yet — any IPv6 client IP is rejected with 403 regardless of this setting (fail closed). |
| `RATE_LIMIT_ENABLED` | — | Enable rate limiting (default: `true`). See [docs/rate-limiting.md](docs/rate-limiting.md). |
| `RATE_LIMIT_WINDOW_MS` | — | Rate limit window in milliseconds (default: `60000`). See [docs/rate-limiting.md](docs/rate-limiting.md). |
| `RATE_LIMIT_MAX` | — | Max requests per window per IP (default: `60`). See [docs/rate-limiting.md](docs/rate-limiting.md). |
| `AUTH_RATE_LIMIT_WINDOW_MS` | — | Auth rate limit window (default: `60000`). See [docs/rate-limiting.md](docs/rate-limiting.md). |
| `AUTH_RATE_LIMIT_MAX` | — | Max auth requests per window (default: `5`). See [docs/rate-limiting.md](docs/rate-limiting.md). |
| `READINESS_MAX_LAG` | — | Maximum indexer ledger lag (in ledgers) allowed for readiness check. If the indexer is more than this many ledgers behind the chain tip, the readiness check will report the indexer as unavailable. Default: `100`. Set to `0` to disable the lag check. |
| `READINESS_GRACE_PERIOD_MS` | — | Startup grace period in milliseconds for the readiness lag check. After process startup, the indexer is allowed to lag without failing readiness for this duration (to accommodate initial sync from persisted cursor). Default: `300000` (5 minutes). Set to `0` to disable the grace period. |

---

## Platform Signing Key (`PLATFORM_SECRET_KEY`)

The backend signs Soroban transactions (e.g. subscription cancellations, contract pause/unpause) with a single platform Stellar keypair, loaded from `PLATFORM_SECRET_KEY` via `src/utils/signer.ts`. Every contract call the backend makes fails without a funded, valid key configured.

### Generating the key

```bash
stellar keys generate --network testnet platform
stellar keys show platform   # prints the secret seed (starts with S) and public key (starts with G)
```

For mainnet, generate with a standard BIP-39-compatible tool instead of `--network testnet`.

### Funding requirements

- **Testnet**: fund the public key via Friendbot:
  ```bash
  curl "https://friendbot.stellar.org?addr=<PLATFORM_PUBLIC_KEY>"
  ```
- **Mainnet**: manually transfer sufficient native XLM to the public key to cover ongoing transaction fees. Monitor the balance — an underfunded key causes contract calls to fail with fee/sequence errors.

### Shared across instances

`PLATFORM_SECRET_KEY` **must be identical across every backend instance/replica**. The key is used to sign transactions from a single Stellar account, and Stellar transactions are ordered by a per-account sequence number — if instances used different keys, or the same key without coordination, concurrent submissions from multiple pods can race on that sequence number and reject each other's transactions. Store the key once in your secrets manager (or Kubernetes Secret, see below) and wire every instance to the same value; do not generate a per-instance key.

### Kubernetes

Set it via the `scout-off-secrets` Secret alongside the other required keys:

```bash
kubectl create secret generic scout-off-secrets \
  ... \
  --from-literal=PLATFORM_SECRET_KEY=<stellar-secret-key-starting-with-S> \
  --namespace <your-namespace>
```

### Rotation

See [Platform Signing Keypairs](docs/secrets-rotation.md#3-platform-signing-keypairs-platform_secret_key--platform_secret) in the Secrets Rotation Policy for the funded-keypair rotation procedure, including the required downtime.

---

## Multi-Contract Architecture

ScoutOff deploys five separate Soroban contracts, each with its own on-chain address:

| Contract | Env var | Purpose |
|---|---|---|
| `register` | `REGISTER_CONTRACT_ID` | Player profiles, progress levels |
| `progress` | `PROGRESS_CONTRACT_ID` | Milestone submission and approval |
| `subscription` | `SUBSCRIPTION_CONTRACT_ID` | Scout subscriptions, contact fees, fee balance |
| `connection` | `CONNECTION_CONTRACT_ID` | Scout-player connections, trial offers |
| `player_token` | _(not yet wired)_ | Player token contract (future) |

### Deploying the contracts

Deploy each crate to testnet (or mainnet), noting the resulting contract ID:

```bash
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/register.wasm \
  --source deployer --network testnet
# → REGISTER_CONTRACT_ID=CABC...

stellar contract deploy --wasm target/wasm32-unknown-unknown/release/progress.wasm \
  --source deployer --network testnet
# → PROGRESS_CONTRACT_ID=CDEF...

stellar contract deploy --wasm target/wasm32-unknown-unknown/release/subscription.wasm \
  --source deployer --network testnet
# → SUBSCRIPTION_CONTRACT_ID=CGHI...

stellar contract deploy --wasm target/wasm32-unknown-unknown/release/connection.wasm \
  --source deployer --network testnet
# → CONNECTION_CONTRACT_ID=CJKL...
```

### Initializing each contract

```bash
# register
stellar contract invoke --id $REGISTER_CONTRACT_ID --source admin --network testnet \
  -- initialize --admin $ADMIN_ADDR --token $TOKEN_ADDR --platform_fee_bps 500

# progress (needs register address so it can cross-call update_progress_level)
stellar contract invoke --id $PROGRESS_CONTRACT_ID --source admin --network testnet \
  -- initialize --admin $ADMIN_ADDR --register_contract $REGISTER_CONTRACT_ID

# subscription
stellar contract invoke --id $SUBSCRIPTION_CONTRACT_ID --source admin --network testnet \
  -- initialize --admin $ADMIN_ADDR --token $TOKEN_ADDR --platform_fee_bps 500

# connection (needs register + subscription addresses)
stellar contract invoke --id $CONNECTION_CONTRACT_ID --source admin --network testnet \
  -- initialize --admin $ADMIN_ADDR \
     --register_contract $REGISTER_CONTRACT_ID \
     --subscription_contract $SUBSCRIPTION_CONTRACT_ID
```

### Registering authorized updaters

Both `progress` and `connection` need permission to call `update_progress_level`
on the `register` contract. Register each using the new `add_authorized_updater`
entrypoint:

```bash
# Allow the progress contract to update player progress
stellar contract invoke --id $REGISTER_CONTRACT_ID --source admin --network testnet \
  -- add_authorized_updater --updater $PROGRESS_CONTRACT_ID

# Allow the connection contract to update player progress (for trial offers)
stellar contract invoke --id $REGISTER_CONTRACT_ID --source admin --network testnet \
  -- add_authorized_updater --updater $CONNECTION_CONTRACT_ID
```

Both addresses will coexist in the allowlist — adding the second does not evict
the first. Verify with:

```bash
stellar contract invoke --id $REGISTER_CONTRACT_ID --source any --network testnet \
  -- get_authorized_updaters
# → ["CDEF...", "CJKL..."]
```

### Pausing and unpausing

Each contract (`register`, `subscription`, `connection`) exposes `pause(admin)`
and `unpause(admin)` entrypoints that the backend routes to via the
`pauseContractOnChain` / `unpauseContractOnChain` helpers in `stellar.ts`.
The backend currently routes pause/unpause calls to the **subscription** contract.
To pause all user-facing operations, call `pause` on each contract individually
if needed.

```bash
stellar contract invoke --id $SUBSCRIPTION_CONTRACT_ID --source admin --network testnet \
  -- pause --admin $ADMIN_ADDR
```

### Backward compatibility

Single-contract deployments that set only `CONTRACT_ID` continue to work without
changes. Each per-contract env var falls back to `CONTRACT_ID` when unset,
preserving backward compatibility during staged migrations.


## Kubernetes / Helm Deployment

The `helm/scout-off-backend/` directory contains a production-grade Helm 3 chart
(API version `v2`) for deploying the backend to Kubernetes.

### Default topology: single-replica SQLite

The chart's defaults deploy a **single replica backed by SQLite**:
`replicaCount: 1`, `hpa.enabled: false`, `pdb.enabled: false`, and
`env.DB_DRIVER: sqlite`. This is the only topology that is internally
consistent out of the box — SQLite is a single-process, single-file database
with no support for concurrent access from multiple processes, so scaling to
multiple pods while on SQLite would give every pod its own unshared, ephemeral
database file (writes invisible across pods, data lost on restart).

To scale horizontally you **must** switch to PostgreSQL first. Add `DATABASE_URL`
to the Kubernetes Secret (it contains credentials and must never live in the
ConfigMap), then upgrade:

```bash
# 1. Add DATABASE_URL to the existing Secret (or re-create it):
kubectl create secret generic scout-off-secrets \
  ... \
  --from-literal=DATABASE_URL=postgresql://user:pass@host:5432/db \
  --dry-run=client -o yaml | kubectl apply -f - --namespace <your-namespace>

# 2. Switch the driver and enable scaling:
helm upgrade --install scout-off-backend ./helm/scout-off-backend \
  --set env.DB_DRIVER=postgres \
  --set replicaCount=3 \
  --set hpa.enabled=true
```

See [docs/postgres-migration.md](docs/postgres-migration.md) for the migration
procedure. If you override the defaults into the broken combination
(SQLite + more than one replica, or SQLite + HPA enabled), the chart prints a
loud warning in its NOTES.txt output instead of silently deploying it; the
`scripts/validate-helm-chart.sh` CI check enforces this invariant on every
push.

### Prerequisites

- Helm 3.x installed (`helm version`)
- A Kubernetes cluster with `kubectl` configured
- The `scout-off-secrets` Kubernetes Secret created in the target namespace
  **before** the first `helm install` (see below)

### 1. Create the Kubernetes Secret

All sensitive env vars are sourced exclusively from a Kubernetes Secret — they
are never stored in the ConfigMap or committed to source control.

```bash
kubectl create secret generic scout-off-secrets \
  --from-literal=JWT_SECRET=<min-32-char-random-string> \
  --from-literal=SEP10_SERVER_SECRET=<stellar-secret-key-starting-with-S> \
  --from-literal=PLATFORM_SECRET_KEY=<stellar-secret-key-starting-with-S> \
  --from-literal=API_KEY_LOOKUP_SECRET=$(openssl rand -hex 32) \
  --from-literal=ADMIN_WALLETS=<comma-separated-stellar-admin-addresses> \
  --from-literal=PINATA_API_KEY=<your-pinata-api-key> \
  --from-literal=PINATA_SECRET=<your-pinata-secret> \
  --from-literal=WEBHOOK_SECRET_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  --from-literal=REGISTER_CONTRACT_ID=<deployed-register-contract-id> \
  --from-literal=PROGRESS_CONTRACT_ID=<deployed-progress-contract-id> \
  --from-literal=SUBSCRIPTION_CONTRACT_ID=<deployed-subscription-contract-id> \
  --from-literal=CONNECTION_CONTRACT_ID=<deployed-connection-contract-id> \
  --namespace <your-namespace>
```

For PostgreSQL deployments, also add:
```bash
  --from-literal=DATABASE_URL=postgresql://user:pass@host:5432/db
```

Optional keys (only include when needed):
```bash
  --from-literal=CONTRACT_ID=<legacy-single-contract-id>        # backward compat
  --from-literal=JWT_SECRET_PREVIOUS=<old-secret>               # during rotation
  --from-literal=JWT_SECRET_PREVIOUS_UNTIL=<ISO-8601-datetime>  # during rotation
  --from-literal=ADMIN_WALLET=<single-admin-address>            # backward compat
  --from-literal=REDIS_URL=redis://:password@host:6379           # distributed cache
  --from-literal=WEBHOOK_SECRET=<hmac-secret>                   # legacy WEBHOOK_URL
```

> **Horizontal scaling note:** `SEP10_SERVER_SECRET` is the most important variable to
> get right in a multi-pod deployment. Every pod **must** receive the same value.
> If pods receive different keys (or any pod falls back to the ephemeral random
> key because the variable is absent), a challenge built by one pod will be
> rejected by any other pod — causing intermittent, hard-to-diagnose auth
> failures proportional to `(N-1)/N` where N is the replica count.
> Store the key in the Kubernetes Secret (as shown above) — the Deployment
> template wires it via `secretKeyRef` so all pods share the exact same value.
> See [docs/auth.md](docs/auth.md#sep-10-server-keypair-sep10_server_secret) for
> generation instructions and the safe rotation procedure.

### JWT secret rotation runbook (zero-downtime dual-key)

Do **not** hard-cutover `JWT_SECRET` alone — that instantly invalidates every
active access and refresh token. Use the dual-key window instead:

1. **Stage previous secret + grace deadline**
   ```bash
   # Capture the currently deployed secret, then create a new one
   OLD_JWT_SECRET=$(kubectl get secret scout-off-secrets -n <ns> -o jsonpath='{.data.JWT_SECRET}' | base64 -d)
   NEW_JWT_SECRET=$(openssl rand -hex 32)
   # Grace window must cover the longest-lived token (refresh TTL = 7 days)
   UNTIL=$(date -u -v+7d +%Y-%m-%dT%H:%M:%SZ)   # macOS; on Linux: date -u -d '+7 days' --iso-8601=seconds
   ```

2. **Apply both secrets and redeploy**
   ```bash
   kubectl create secret generic scout-off-secrets \
     --from-literal=CONTRACT_ID=<same-as-before> \
     --from-literal=JWT_SECRET="$NEW_JWT_SECRET" \
     --from-literal=JWT_SECRET_PREVIOUS="$OLD_JWT_SECRET" \
     --from-literal=JWT_SECRET_PREVIOUS_UNTIL="$UNTIL" \
     --from-literal=SEP10_SERVER_SECRET=<same-as-before> \
     --dry-run=client -o yaml | kubectl apply -f - --namespace <your-namespace>
   kubectl rollout restart deployment/scout-off-backend --namespace <your-namespace>
   ```
   New tokens are signed only with `JWT_SECRET`. Tokens signed with the old
   secret continue to verify until `JWT_SECRET_PREVIOUS_UNTIL`.

3. **After the grace window**
   Remove `JWT_SECRET_PREVIOUS` / `JWT_SECRET_PREVIOUS_UNTIL` from the Secret
   and roll out again. Compromised individual sessions should still be killed
   via the token blocklist (`tokenBlocklist`), not by rotating the secret.

For non-JWT secrets, rotate by deleting and re-creating the Secret, then
triggering a rollout:

```bash
kubectl delete secret scout-off-secrets --namespace <your-namespace>
kubectl create secret generic scout-off-secrets \
  --from-literal=CONTRACT_ID=<new-value> \
  --from-literal=JWT_SECRET=<new-value> \
  --namespace <your-namespace>
kubectl rollout restart deployment/scout-off-backend --namespace <your-namespace>
```

### 2. Install the chart

```bash
helm install scout-off-backend ./helm/scout-off-backend \
  --namespace <your-namespace> \
  --create-namespace \
  --set image.tag=<git-sha-or-semver>
```

### 3. Upgrade

```bash
helm upgrade scout-off-backend ./helm/scout-off-backend \
  --namespace <your-namespace> \
  --set image.tag=<new-tag>
```

### 4. Override values

Create a `my-values.yaml` file with any overrides and pass it with `-f`:

```bash
helm upgrade --install scout-off-backend ./helm/scout-off-backend \
  --namespace production \
  -f my-values.yaml \
  --set image.tag=v1.2.3
```

Common overrides:

| Key | Default | Description |
|-----|---------|-------------|
| `image.tag` | chart appVersion | Docker image tag to deploy |
| `replicaCount` | `1` | Pod count. Keep at `1` while `env.DB_DRIVER=sqlite` (SQLite is single-process); raise it only after switching to PostgreSQL |
| `hpa.enabled` | `false` | Enable autoscaling. Requires `env.DB_DRIVER=postgres` + `env.DATABASE_URL` |
| `hpa.maxReplicas` | `10` | Maximum pods under autoscaling (only when `hpa.enabled=true`) |
| `hpa.targetCPUUtilizationPercentage` | `70` | CPU threshold to trigger scale-up |
| `hpa.targetMemoryUtilizationPercentage` | `80` | Memory threshold to trigger scale-up |
| `pdb.enabled` | `false` | Enable a PodDisruptionBudget. Enable for multi-replica (PostgreSQL-backed) deployments |
| `ingress.enabled` | `false` | Expose the service via an Ingress |
| `ingress.hosts[0].host` | `api.scoutoff.io` | Public hostname |
| `ingress.tls[0].secretName` | `scout-off-tls` | TLS certificate Secret name |
| `resources.requests.cpu` | `100m` | CPU request |
| `resources.limits.cpu` | `500m` | CPU limit |
| `resources.requests.memory` | `256Mi` | Memory request |
| `resources.limits.memory` | `512Mi` | Memory limit |
| `secretName` | `scout-off-secrets` | Name of the Kubernetes Secret |
| `env.NODE_ENV` | `production` | Node environment |
| `env.DB_DRIVER` | `sqlite` | `sqlite` or `postgres` |

### 5. Lint the chart

```bash
helm lint helm/scout-off-backend
```

### 6. Render templates locally (dry-run)

```bash
helm template scout-off-backend ./helm/scout-off-backend \
  --set image.tag=local-test
```

This produces a Deployment, Service, ConfigMap, and (when `ingress.enabled=true`)
an Ingress resource. The HPA and PodDisruptionBudget are only rendered when
`hpa.enabled=true` / `pdb.enabled=true` respectively.

### 7. Uninstall

```bash
helm uninstall scout-off-backend --namespace <your-namespace>
```

> **Note:** Uninstalling the chart does **not** delete the `scout-off-secrets`
> Secret. Delete it manually if you are tearing down the environment entirely.

## Cache Configuration

### CACHE_NAMESPACE — preventing key collisions on shared Redis (#672)

When two or more deployments (staging + production, or a blue/green pair) share the same Redis
instance, cache keys must be namespaced so they cannot collide. Without a namespace, a cache
write from staging could silently be served to production requests (or vice versa).

| Variable | Default | Description |
|---|---|---|
| `CACHE_NAMESPACE` | `NODE_ENV` value | Prefix prepended to every cache key. |
| `REDIS_URL` | _(unset — in-memory)_ | Redis connection URL. When unset, an in-memory store is used and namespacing is a no-op. |
| `PLAYER_CACHE_TTL_MS` | `60000` | TTL for player list cache entries (ms). |

**Default behavior:** `CACHE_NAMESPACE` defaults to `NODE_ENV`, so `development`, `test`,
`staging`, and `production` environments are always distinct out-of-the-box without any
operator action.

**When to override:** Set `CACHE_NAMESPACE` explicitly when two deployments share both the
same `NODE_ENV` *and* the same Redis instance — e.g., two production pods in a blue/green
cutover using separate logical namespaces:

```bash
# Blue deployment
CACHE_NAMESPACE=production-blue

# Green deployment
CACHE_NAMESPACE=production-green
```

> **Helm:** Add `CACHE_NAMESPACE` to the Kubernetes Secret alongside `REDIS_URL`:
> ```bash
> kubectl create secret generic scout-off-secrets ... \
>   --from-literal=REDIS_URL=redis://:password@host:6379 \
>   --from-literal=CACHE_NAMESPACE=production
> ```

### API Key Expiry — API_KEY_DEFAULT_TTL_DAYS (#674)

Server-to-server API keys default to a 90-day lifetime so that forgotten or leaked keys
automatically decay rather than remaining valid indefinitely.

| Variable | Default | Description |
|---|---|---|
| `API_KEY_DEFAULT_TTL_DAYS` | `90` | Default key lifetime in days. `0` disables automatic expiry. |

Callers can override the default at issuance time by passing `expiresInDays` in the
`POST /api/scouts/:wallet/api-keys` request body (see [docs/auth.md](docs/auth.md#api-keys)).

## Build & Start

```bash
npm install
npm run build      # compiles TypeScript → dist/
npm start          # runs dist/index.js
```

For development with hot-reload:

```bash
npm run dev
```

## Contract ID Configuration

The backend supports both **single-contract** and **multi-contract** deployment models via a fallback chain in environment variables.

### The Fallback Chain

When a component needs a contract ID, it looks up the hierarchy in this order:

1. **Specific contract ID** (e.g., `REGISTER_CONTRACT_ID`, `PROGRESS_CONTRACT_ID`, etc.)
2. **Fallback: `CONTRACT_ID`** (universal contract address)
3. **Empty string** (defaults to empty if nothing is set)

This design enables two deployment patterns:

#### Single-Contract Deployments (Default)

In a single-contract deployment, all functionality lives in one deployed Soroban contract:

```env
# .env
CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA

# No per-contract IDs needed; all operations use CONTRACT_ID above
```

**Example use case:** Development, testing, or smaller deployments where one contract handles player registration, progress tracking, subscriptions, and connections.

#### Multi-Contract Deployments

In a multi-contract deployment, separate concerns are split across different contracts:

```env
# .env
CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA

# Optional per-contract overrides (each defaults to CONTRACT_ID above if not set)
REGISTER_CONTRACT_ID=CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
PROGRESS_CONTRACT_ID=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
SUBSCRIPTION_CONTRACT_ID=CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD
CONNECTION_CONTRACT_ID=CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE
```

**Example use case:** Production deployments where each domain has its own audited contract for better isolation, security, and independent upgrades.

### When to Set Each Per-Contract ID

| Variable | Purpose | When to Set |
|---|---|---|
| `REGISTER_CONTRACT_ID` | Player registration contract | Multi-contract setup with separate registration logic |
| `PROGRESS_CONTRACT_ID` | Milestone/progress tracking contract | Multi-contract setup with separate progress tracking |
| `SUBSCRIPTION_CONTRACT_ID` | Subscription management contract | Multi-contract setup with separate subscription logic |
| `CONNECTION_CONTRACT_ID` | Connection/relationship contract | Multi-contract setup with separate connection logic |

If any per-contract ID is **not** set, the system falls back to `CONTRACT_ID`. If `CONTRACT_ID` itself is unset, operations using that contract will fail (the system requires at least one defined contract ID).

### Known Limitation: Indexer Single-Contract Assumption

The event indexer (`src/services/indexer.ts`) currently assumes a **single contract** and only monitors `config.contractId` for events. In multi-contract deployments, events emitted by separate contracts (e.g., `PROGRESS_CONTRACT_ID`, `SUBSCRIPTION_CONTRACT_ID`) are **not indexed**.

**Workaround:** For multi-contract deployments, deploy separate indexer instances for each contract, each pointing to a different `CONTRACT_ID`.

**Tracking:** See [GitHub Issue #XXX](https://github.com/scoutoff/scout-off-backend/issues/XXX) for planned multi-contract indexer support.

### Configuration Examples

**Single-contract (simplest):**
```env
CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
NODE_ENV=production
NETWORK=mainnet
# ... other required env vars
```

**Multi-contract with per-contract IDs:**
```env
CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
REGISTER_CONTRACT_ID=CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
PROGRESS_CONTRACT_ID=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
SUBSCRIPTION_CONTRACT_ID=CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD
NODE_ENV=production
NETWORK=mainnet
# ... other required env vars
```

**Hybrid (partial multi-contract):**
```env
CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
PROGRESS_CONTRACT_ID=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
# REGISTER_CONTRACT_ID, SUBSCRIPTION_CONTRACT_ID, CONNECTION_CONTRACT_ID not set
# → registration uses CONTRACT_ID (CAAA...)
# → progress uses PROGRESS_CONTRACT_ID (CCCC...)
# → subscriptions use CONTRACT_ID (CAAA...)
# → connections use CONTRACT_ID (CAAA...)
```

## Multi-Sig Admin Operations

High-value admin operations require M-of-N multi-signature approval. See [docs/admin-multisig.md](docs/admin-multisig.md) for full details on the multi-sig lifecycle, state machine, endpoints, and configuration.

Quick reference:

1. **Configure admin wallets**: Set `ADMIN_WALLETS` to a comma-separated list of Stellar addresses (e.g., `ADMIN_WALLETS=GABC123...,GDEF456...`)
2. **Set threshold**: Configure `ADMIN_THRESHOLD` to the minimum number of admin signatures required (e.g., `ADMIN_THRESHOLD=2`)
3. **Backward compatibility**: If `ADMIN_WALLETS` is not set, the system falls back to `ADMIN_WALLET` with threshold 1
4. **TTL for proposals**: Configure `ADMIN_ACTION_TTL_MS` to control how long pending approvals remain valid (default: 1 hour)
5. **Operations affected**:
   - `POST /api/admin/fees` (withdraw fees)
   - `POST /api/admin/contract/pause`
   - `POST /api/admin/contract/unpause`
   - Other high-value admin endpoints
6. **Single-signer immediate execution**: When `ADMIN_THRESHOLD=1`, operations execute immediately without multi-sig approval

## Database Migrations

The server auto-creates the SQLite database on first start using `db/001_initial.sql`.  
For schema changes, add a new numbered migration file (`db/002_*.sql`) and apply it before deploying:

```bash
sqlite3 scout-off.db < db/002_your_migration.sql
```

Always back up the database file before running migrations in production.

## Database Backups

The `scripts/backup-db.sh` script copies the SQLite file to a timestamped backup location.
It supports local paths, AWS S3, and Google Cloud Storage.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `DB_PATH` | — | Path to the SQLite file (default: `scout-off.db`) |
| `BACKUP_DEST` | ✅ | Backup destination — local path, `s3://…`, or `gs://…` |

### One-off backup

```bash
# Local
DB_PATH=/data/scout-off.db BACKUP_DEST=/var/backups/scout-off npm run backup-db

# AWS S3 (requires aws CLI and credentials in environment)
DB_PATH=/data/scout-off.db BACKUP_DEST=s3://my-bucket/scout-off-backups npm run backup-db

# Google Cloud Storage (requires gsutil / gcloud SDK)
DB_PATH=/data/scout-off.db BACKUP_DEST=gs://my-bucket/scout-off-backups npm run backup-db

# Equivalent direct invocation
DB_PATH=/data/scout-off.db BACKUP_DEST=/var/backups/scout-off bash scripts/backup-db.sh
```

The script exits with code `1` and prints an error to stderr on any failure (file missing, CLI not found, copy error, or verification failure).

Every backup is verified immediately after creation:

1. The script captures row counts for `players`, `events`, and `migrations` from the live database.
2. It writes a `.counts` sidecar file alongside the backup (same destination prefix).
3. It runs `scripts/verify-backup.sh`, which copies the backup to a scratch directory, runs `PRAGMA integrity_check`, and confirms the key table row counts match the sidecar.

Requires the `sqlite3` CLI on the host running backups (`python3` is used as a fallback when `sqlite3` is unavailable).

### Restore-verification drills

Run periodic drills against historical backups to confirm they remain restorable. Use `--verify-only` (delegates to `scripts/verify-backup.sh`) or call the verifier directly:

```bash
# Local backup + sidecar created at backup time
npm run backup-db -- --verify-only /var/backups/scout-off/scout-off-20250720T120000Z.db

# S3 (downloads backup and .counts sidecar automatically)
npm run backup-db -- --verify-only s3://my-bucket/scout-off-backups/scout-off-20250720T120000Z.db

# GCS
npm run backup-db -- --verify-only gs://my-bucket/scout-off-backups/scout-off-20250720T120000Z.db

# Direct verifier with explicit expected counts (e.g. if the sidecar was lost)
EXPECT_PLAYERS=120 EXPECT_EVENTS=5400 EXPECT_MIGRATIONS=18 \
  npm run verify-backup -- /var/backups/scout-off/scout-off-20250720T120000Z.db

# Equivalent direct invocations
bash scripts/backup-db.sh --verify-only /var/backups/scout-off/scout-off-20250720T120000Z.db
EXPECT_PLAYERS=120 EXPECT_EVENTS=5400 EXPECT_MIGRATIONS=18 \
  bash scripts/verify-backup.sh /var/backups/scout-off/scout-off-20250720T120000Z.db
```

Suggested schedule: weekly verification of the most recent backup, plus a monthly spot-check of a random older backup. Failed verification exits non-zero — wire alerts to your cron/systemd log monitoring the same way as backup failures.

Example weekly cron (`/etc/cron.d/scout-off-backup-verify`):

```cron
0 3 * * 0 ubuntu LATEST=$(aws s3 ls s3://my-bucket/scout-off-backups/ | awk '/\.db$/ { print $4 }' | sort | tail -1) && \
  bash /opt/scout-off/scripts/backup-db.sh --verify-only "s3://my-bucket/scout-off-backups/${LATEST}" >> /var/log/scout-off-backup-verify.log 2>&1
```

### Scheduling via cron

Add an entry to `/etc/cron.d/scout-off-backup` (runs hourly):

```cron
0 * * * * ubuntu DB_PATH=/data/scout-off.db BACKUP_DEST=s3://my-bucket/scout-off-backups bash /opt/scout-off/scripts/backup-db.sh >> /var/log/scout-off-backup.log 2>&1
```

Or as a systemd timer (`/etc/systemd/system/scout-off-backup.timer`):

```ini
[Unit]
Description=ScoutOff database backup

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

With a companion service (`/etc/systemd/system/scout-off-backup.service`):

```ini
[Unit]
Description=ScoutOff database backup

[Service]
Type=oneshot
EnvironmentFile=/etc/scout-off.env
ExecStart=/bin/bash /opt/scout-off/scripts/backup-db.sh
```

Enable with:

```bash
systemctl enable --now scout-off-backup.timer
```

### Backup retention

The script does not manage retention. Use your cloud provider's lifecycle policies or a tool like `find` for local pruning:

```bash
# Delete local backups older than 7 days
find /var/backups/scout-off -name '*.db' -mtime +7 -delete
```

For S3, configure an [Object Lifecycle rule](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html) to expire objects after your desired retention window.

## Rate Limiting

For detailed documentation on rate limiting configuration, behavior, and namespacing, see [docs/rate-limiting.md](docs/rate-limiting.md).

**Quick summary:**
- Per-IP rate limiting via in-memory store (configurable window and max requests)
- Per-wallet rate limiting for authenticated endpoints
- Separate auth endpoint limits for brute-force protection
- Fail-open on store error (prioritizes availability)

## Reindexing

For detailed documentation on reindexing workflows, status polling, and operational considerations, see [docs/reindexing.md](docs/reindexing.md).

**Quick summary:**
- Reindex by posting to `POST /api/admin/indexer/reindex` with `{ fromLedger: N }`
- Poll status via separate endpoint (exact URL TBD in docs/reindexing.md)
- Single reindex at a time (singleton guard enforced)
- Cursor is rewound on completion (see docs for implications)

## CI/CD Expectations

- CI runs on every push via `.github/workflows/ci.yml`
- Pipeline: `npm install` → `npm run build` → `npm test`
- Deploy only from a passing main branch build
- Set all required env vars as CI/CD secrets — never commit `.env`

## Health & Monitoring

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness check; includes Stellar RPC status |
| `GET /ready` | Readiness probe; checks IPFS connectivity |
| `GET /health/dependencies` | Operator incident probe; returns endpoint, version, and real round-trip latency per downstream (admin-gated) |
| `GET /version` | Deployed package version and git commit SHA |

Configure your load balancer or orchestrator to poll `/health` every 30 seconds.  
Alert on consecutive failures (≥ 2) to catch Stellar RPC or IPFS outages early.

### Incident Diagnosis & Downstream Dependencies (`GET /health/dependencies`)

During partial outages or performance degradation, operators can call `GET /health/dependencies` (requires admin Bearer token auth) to inspect individual downstream dependencies:
- **Stellar RPC**: Resolved endpoint, protocol version/health status, and live round-trip latency.
- **Horizon**: Resolved endpoint, Horizon/Core version, and live round-trip latency.
- **IPFS Gateway**: Resolved gateway endpoint, web server handshake string, and live round-trip latency.
- **Redis**: Resolved endpoint (sanitized), Redis server version, and live round-trip latency.
- **Database**: Resolved connection target, engine version (PostgreSQL or SQLite), and live query latency.

Response example:
```json
{
  "status": "ok",
  "dependencies": {
    "stellar": { "endpoint": "https://soroban-testnet.stellar.org", "version": "healthy (protocol 20)", "status": "ok", "latencyMs": 142 },
    "horizon": { "endpoint": "https://horizon-testnet.stellar.org", "version": "2.30.0", "status": "ok", "latencyMs": 85 },
    "ipfs": { "endpoint": "https://gateway.pinata.cloud", "version": "nginx/1.22.1", "status": "ok", "latencyMs": 210 },
    "redis": { "endpoint": "redis://***@127.0.0.1:6379", "version": "7.0.5", "status": "ok", "latencyMs": 3 },
    "db": { "endpoint": "sqlite (./scout-off.db)", "version": "SQLite 3.39.5", "status": "ok", "latencyMs": 1 }
  }
}
```

Recommended metrics to track:
- HTTP 5xx error rate
- Event indexer lag (gap between latest on-chain event and last indexed event, exposed as `indexer_ledger_lag` on `GET /metrics`)
- SQLite file size growth

For what to do when these signals go wrong — indexer lag, stale tiers, missing webhooks, RPC/IPFS outages, DB slowness, plus reindex/replay, dead-letter drain, cache flush, circuit-breaker, and pause/unpause procedures — see the [Operator Runbook](docs/runbook.md).

### Docker Compose Healthcheck

The `docker-compose.yml` configures a healthcheck on the backend service that polls `/health/liveness` every 10 seconds:

```yaml
healthcheck:
  test: ["CMD", "wget", "--spider", "-q", "http://localhost:4000/health/liveness"]
  interval: 10s
  timeout: 5s
  retries: 3
  start_period: 15s
```

Docker marks the container `(healthy)` once the first probe succeeds. The `start_period` of 15 seconds gives the Express server time to initialize before probes are counted as failures. The `--spider` flag tells `wget` to perform a HEAD-only request without downloading the response body, keeping healthcheck logs quiet. Run `docker compose ps` to confirm the container status shows `(healthy)` after startup.

## Multi-Sig Admin Operations

High-value admin operations (withdraw fees, pause/unpause contract) require M-of-N multi-signature approval:

1. **Configure admin wallets**: Set `ADMIN_WALLETS` to a comma-separated list of Stellar addresses (e.g., `ADMIN_WALLETS=GABC123...,GDEF456...`)
2. **Set threshold**: Configure `ADMIN_THRESHOLD` to the minimum number of admin signatures required (e.g., `ADMIN_THRESHOLD=2`)
3. **Backward compatibility**: If `ADMIN_WALLETS` is not set, the system falls back to `ADMIN_WALLET` with threshold 1
4. **Operations affected**:
   - `POST /api/admin/fees` (withdraw fees)
   - `POST /api/admin/contract/pause`
   - `POST /api/admin/contract/unpause`
5. **Single-signer attempts**: When threshold > 1, single-admin attempts return 403 with "High-value operation requires multiple admin signatures"

## Smoke Tests After Deployment

Run these checks immediately after every deployment:

1. `GET /health` → `{ "status": "ok" }`
2. `GET /ready` → `{ "status": "ok" }`
3. `GET /api/players` → returns array (may be empty)
4. `GET /auth/challenge?account=<any_valid_G_address>` → returns XDR challenge
5. `GET /api/admin/fees` with a valid admin JWT → returns fee history array

If any check fails, roll back to the previous build immediately.

## Release Process

1. Merge feature branch to `main` after PR review and CI green
2. Tag the release: `git tag v<semver> && git push --tags`
3. Build the Docker image (or run `npm run build` on the target server)
4. Apply any pending DB migrations
5. The deploy script handles starting the new process and flipping traffic automatically.
6. Run smoke tests (see above) - this happens automatically in the staging pipeline.
7. Monitor logs for 10 minutes post-deploy

## Blue-Green Deployment Topology

Staging uses a local blue-green deployment strategy to eliminate restart downtime.

### Topology
- **Process Manager**: PM2 manages two identical Node.js services named `scout-off-backend-blue` (port 4000) and `scout-off-backend-green` (port 4001).
- **Reverse Proxy**: Nginx routes traffic to the active slot.
- **State**: The currently active slot is stored in a `.active-slot` file in the deployment root.

### Nginx Configuration Requirement
To support dynamic traffic flipping, Nginx must be configured to use a dedicated upstream config block located at `/etc/nginx/conf.d/scout-off-upstream.conf`.

1. Create the upstream config file:
   ```bash
   sudo touch /etc/nginx/conf.d/scout-off-upstream.conf
   sudo chmod 666 /etc/nginx/conf.d/scout-off-upstream.conf
   echo "upstream scout_off_backend { server 127.0.0.1:4000; }" > /etc/nginx/conf.d/scout-off-upstream.conf
   ```
2. In your main Nginx site config (e.g., `/etc/nginx/sites-available/scout-off`), use the upstream:
   ```nginx
   location / {
       proxy_pass http://scout_off_backend;
       # ... other proxy headers ...
   }
   ```

### Manual Override & Rollback
If you need to manually rollback traffic to the previously active slot:
```bash
# From the deployment root path:
bash scripts/deploy-staging.sh . rollback
```

To manually view the PM2 processes:
```bash
pm2 status
pm2 logs scout-off-backend-blue
pm2 logs scout-off-backend-green
```
