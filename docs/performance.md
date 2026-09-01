# Performance Budget

This document defines target performance budgets for ScoutOff's most latency-sensitive API endpoints, and documents both the legacy autocannon harness and the new k6 load-test suite. Budgets are derived from a baseline run against the current implementation; they should be revisited when significant architectural changes land (e.g., a Redis cache layer, database migrations, or Soroban contract modifications).

## Budgets

All measurements are taken against a locally-running instance (single Node.js process, SQLite on disk) using the `scripts/loadtest.ts` autocannon harness.

| Endpoint | p50 | p95 | p99 | Throughput (req/s) |
|---|---|---|---|---|
| `GET /api/players` | ≤ 50 ms | ≤ 150 ms | ≤ 300 ms | ≥ 200 |
| `GET /api/players/:playerId` | ≤ 30 ms | ≤ 100 ms | ≤ 200 ms | ≥ 500 |
| `POST /auth/token` | ≤ 100 ms | ≤ 300 ms | ≤ 500 ms | ≥ 100 |

These budgets assume:

- Seeded dataset of at least 5 players (the default from `scripts/seed.ts`)
- No concurrent long-running Soroban RPC calls (the auth endpoint has no Stellar dependency; player detail reads from SQLite and cache)
- Server running on a modern laptop or CI-equivalent runner

## Running the Load Test

### 1. Seed the database

```bash
npx ts-node --project tsconfig.scripts.json scripts/seed.ts
```

### 2. Start the server

```bash
npm start
```

The server listens on `http://localhost:4000` by default (configurable via `PORT`).

### 3. Run the load test

```bash
npm run loadtest
```

This runs `autocannon` against the three endpoints sequentially, each for 30 seconds with 20 concurrent connections.

### Configuration

| Env var | Default | Description |
|---|---|---|
| `LOADTEST_TARGET` | `http://localhost:4000` | Base URL of the running server |
| `LOADTEST_DURATION_SEC` | `30` | Seconds each endpoint is exercised |
| `LOADTEST_CONNECTIONS` | `20` | Number of concurrent connections |
| `LOADTEST_PLAYER_ID` | `seed-player-001` | Player id used for detail endpoint |

## CI

The load test is **not** wired into the standard per-PR CI pipeline. It is intended for manual runs before performance-sensitive releases. If a future CI runner is provisioned with adequate resources, the budgets above can be enforced by adding a step that fails if any metric exceeds the target.

---

## k6 Load-Test Suite

The k6 suite supersedes the autocannon harness for continuous performance regression testing. It covers all major API flows, enforces SLO thresholds as first-class k6 `thresholds`, and runs nightly in CI against the staging environment.

### Suite location

```
scripts/k6/
├── config.js                     # Shared env-var config (BASE_URL, tokens, …)
├── suite.js                      # Entry-point — runs all 6 scenarios
└── scenarios/
    ├── auth-flow.js              # Scenario 1: SEP-10 challenge + token exchange
    ├── player-list.js            # Scenario 2: GET /api/players?region=…&minTier=…
    ├── player-profile.js         # Scenario 3: GET /api/players/:id
    ├── subscription-status.js    # Scenario 4: GET /api/scouts/:wallet/subscription
    ├── sse-stream.js             # Scenario 5: SSE connect + 30s keepalive hold
    └── admin-stats.js            # Scenario 6: GET /api/admin/stats
```

### SLO thresholds

| Scenario | VUs | Duration | p95 target | p99 target | Error rate |
|---|---|---|---|---|---|
| Auth flow (SEP-10) | 10 | 30 s | < 500 ms | — | < 1 % |
| Player list with filters | 50 | 30 s | < 200 ms | — | < 1 % |
| Single player profile | 20 | 30 s | — | < 100 ms | < 1 % |
| Subscription status | 20 | 30 s | < 150 ms | — | < 1 % |
| SSE stream + keepalive | 5 | 60 s | — | — | < 1 %, ≥1 keepalive/VU |
| Admin stats | 5 | 30 s | < 300 ms | — | < 1 % |

k6 exits with a **non-zero code** when any threshold is breached, making the CI step fail automatically.

### Running the suite locally

#### Prerequisites

Install k6 (one-time):
```bash
# macOS
brew install k6

# Linux (Debian/Ubuntu)
sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Windows (winget)
winget install k6 --source winget
```

#### 1. Seed and start the server

```bash
npx ts-node --project tsconfig.scripts.json scripts/seed.ts
npm start
```

#### 2. Run all 6 scenarios

```bash
k6 run scripts/k6/suite.js
```

#### 3. Run a single scenario

```bash
k6 run --env K6_SCENARIO=player_list scripts/k6/suite.js
```

Valid scenario names: `auth_flow`, `player_list`, `player_profile`, `subscription_status`, `sse_stream`, `admin_stats`.

#### 4. Run against staging

```bash
K6_BASE_URL=https://staging.scoutoff.io \
TEST_ADMIN_JWT=eyJ... \
TEST_SCOUT_JWT=eyJ... \
k6 run scripts/k6/suite.js
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `K6_BASE_URL` | `http://localhost:4000` | Base URL of the target server |
| `K6_SCENARIO` | *(all)* | Name of a single scenario to run |
| `TEST_ADMIN_JWT` | — | Pre-generated admin JWT (see note below) |
| `TEST_SCOUT_JWT` | — | Pre-generated scout JWT |
| `K6_PLAYER_ID` | `seed-player-001` | Player ID for profile scenario |
| `K6_SCOUT_WALLET` | *(see config.js)* | Scout wallet for subscription scenario |
| `K6_AUTH_XDR` | — | Pre-signed SEP-10 XDR for auth-flow scenario |

> **Test JWTs** — Auth tokens for k6 must be pre-generated (not live SEP-10 signed) so the suite can run offline in CI. Generate them with:
> ```bash
> node scripts/generate-test-jwt.js --role admin --secret <JWT_SECRET>
> node scripts/generate-test-jwt.js --role scout  --secret <JWT_SECRET>
> ```
> Store the output as `STAGING_ADMIN_JWT` and `STAGING_SCOUT_JWT` repository secrets.

### CI workflow

The suite is wired into `.github/workflows/loadtest.yml`:

- **Schedule**: nightly at 02:00 UTC against `https://staging.scoutoff.io`
- **Manual dispatch**: trigger from the GitHub Actions UI with an optional `scenario` filter and `base_url` override
- **Artefacts**: `k6-results.json` is uploaded for 30 days on every run (pass or fail)
- **Concurrency**: only one load-test run at a time (`concurrency: loadtest`)
- **Failure mode**: k6 exits non-zero on threshold breach → workflow step fails → nightly run is marked failed and GitHub sends a notification

### Relationship to the existing autocannon harness

The existing `scripts/loadtest.ts` (autocannon) is **preserved** for quick local smoke tests (`npm run loadtest`). The k6 suite is the authoritative performance gate for CI and staging validation. The two tools complement each other:

| Tool | Use case | CI? |
|---|---|---|
| `scripts/loadtest.ts` (autocannon) | Quick local smoke test (3 endpoints, 30 s) | No |
| `scripts/k6/suite.js` (k6) | Full regression suite with SLO enforcement (6 scenarios) | Yes — nightly |

---

## Redis Failure Behavior

This section documents the verified behavior of the Redis-backed cache and
rate-limit stores under failure conditions.  All behavior described here is
covered by tests in `tests/services/redisCacheStore.failure.test.ts`,
`tests/middleware/redisRateLimitStore.failure.test.ts`, and
`tests/services/redisIntegration.failure.test.ts`.

### Redis cache failure

The cache layer degrades gracefully on any Redis error.  An unreachable or
slow Redis connection never turns a cache failure into an application outage.

| Failure scenario | `get()` behavior | `set()` behavior | `del()` / `deleteByPrefix()` behavior |
|---|---|---|---|
| Connection refused at startup | Returns `undefined` (cache miss) | Silently completes | Silently completes |
| Connection drops mid-request | Returns `undefined` (cache miss) | Silently completes | Silently completes |
| Command timeout | Returns `undefined` after rejection | Silently completes | Silently completes |
| Recovery | Normal operation resumes | Normal operation resumes | Normal operation resumes |

**Key properties:**
- All `RedisCacheStore` methods resolve (never reject) on Redis failure.
- Cache errors are logged at `warn` level — operators are alerted without
  interrupting request handling.
- Redis internals are never exposed to API clients.
- The application takes the cache-miss/fallback path transparently.

**Bounded timeout:** Redis operations are bounded by `commandTimeout: 2000 ms`
on the shared ioredis client (`src/services/redis.ts`).  A hung Redis command
will be rejected within 2 s.  The initial TCP handshake is bounded by
`connectTimeout: 2000 ms`.

### Redis rate-limit failure

**Policy: FAIL OPEN**

When Redis raises an error (connection refused, command timeout, or connection
drop), the `rateLimit` middleware logs a warning and *allows the request*
rather than rejecting it with HTTP 500.

This is an explicit availability-over-security trade-off:

- A Redis outage temporarily disables *distributed* throttling.
- All API endpoints remain available to legitimate users during a Redis outage.
- The failure is logged at `warn` level for operator visibility.
- Per-instance in-process throttling via `InMemoryRateLimitStore` is NOT
  automatically substituted — this is by design, as the two stores count
  independently and would produce inconsistent limiting across instances.

**Rationale:**  The protected endpoints are public and auth APIs that must
remain available to legitimate users.  A Redis outage is an infrastructure
failure, not itself an attack vector.  Operators who need fail-closed behavior
for specific high-security routes should pass a custom `store` to `rateLimit()`
that implements the desired policy.

| Failure scenario | Rate-limit middleware behavior |
|---|---|
| Redis unreachable at startup | Fail open — request allowed |
| Redis drops mid-request | Fail open — request allowed |
| Redis command timeout | Fail open — request allowed after timeout |
| Redis recovers | Normal rate limiting resumes |

**Bounded timeout:** The same `commandTimeout: 2000 ms` applies to the rate
limiter's Lua script (`INCR` + `PEXPIRE`).  A hung Redis command is rejected
within 2 s, after which the middleware fails open within the same window.

### Redis connection configuration

The shared ioredis client (`src/services/redis.ts`) is configured with:

| Option | Value | Purpose |
|---|---|---|
| `connectTimeout` | 2000 ms | Bounds initial TCP handshake |
| `commandTimeout` | 2000 ms | Bounds any individual Redis command |
| `maxRetriesPerRequest` | 0 | Rejects queued commands immediately on connection loss |
| `lazyConnect` | true | Defers initial connection until first command |
| `retryStrategy` | Exponential, max 10 attempts (~22 s) | Reconnects without a connection storm |

### Operational expectations

When Redis becomes unavailable:

1. **Cache** — All cache reads return `undefined` (cache miss).  The
   application falls through to the database / upstream for every request,
   which increases load on the database.  Monitor cache hit rate and database
   latency during extended Redis outages.

2. **Rate limiting** — Distributed throttling is suspended.  The per-process
   `InMemoryRateLimitStore` is NOT automatically activated.  Operators should
   monitor Redis availability and consider activating emergency rate-limiting
   measures if an outage is prolonged.

3. **Latency** — During a Redis outage, each request adds at most
   `commandTimeout` (2 s) of latency until the connection failure is detected.
   After the first failure the ioredis client enters reconnect mode and
   subsequent commands are rejected immediately (`maxRetriesPerRequest: 0`).

4. **Recovery** — When Redis becomes healthy again, the cache and rate-limiter
   automatically resume normal operation on the next request.  No process
   restart is required.

---

## Baseline

> **Status: baseline not yet recorded — tracked in [issue #720](https://github.com/scout-off/scout-off-backend/issues/720).**
>
> The table below has placeholder values.  The first contributor to run a reproducible
> load-test against `main` should fill in the numbers and open a follow-up PR to lock
> them in.  Instructions for producing and recording a baseline are in the
> [Running the Load Test](#running-the-load-test) section above.

A baseline run has not yet been conducted.  To record one:

1. Check out the commit you want to baseline:
   ```bash
   git checkout main   # or a specific SHA
   ```
2. Seed and start the server:
   ```bash
   npm run seed
   npm start
   ```
3. Run the load test and capture stdout:
   ```bash
   npm run loadtest 2>&1 | tee loadtest-baseline.txt
   ```
4. Fill in the table below with the results, the date, and the exact commit SHA.
5. Open a PR updating this file — include the `loadtest-baseline.txt` output as a PR comment
   for reproducibility.

| Endpoint | p50 | p95 | p99 | Throughput | Recorded on | Commit |
|---|---|---|---|---|---|---|
| `GET /api/players` | — | — | — | — | *(not yet recorded)* | *(not yet recorded)* |
| `GET /api/players/:playerId` | — | — | — | — | *(not yet recorded)* | *(not yet recorded)* |
| `POST /auth/token` | — | — | — | — | *(not yet recorded)* | *(not yet recorded)* |

**Command used to produce these results** *(fill in when recording)*:
```bash
# Example — replace <SHA> and <DATE> with real values
# git checkout <SHA>
# npm run seed && npm start &
# DATABASE_SSL=false npm run loadtest
```

*Environment* *(fill in when recording)*: Node vX.Y.Z, SQLite on SSD, single-process, no Redis.
