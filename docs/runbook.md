# Operator Runbook

This runbook maps common incidents to their diagnosis steps and the exact
endpoints/commands to resolve them. It assumes you have a backend instance
running and an admin JWT (`<ADMIN_JWT>` below — obtain one via
`POST /auth/token` with an admin wallet, see [docs/auth.md](auth.md)).

Every command below is idempotent and safe to re-run, which is exactly what you
want during an incident. When in doubt, **observe before acting**: read the
metrics and the DB, form a hypothesis, then act.

## Reading the signals

Start every investigation with the health and metrics endpoints:

| Endpoint | What it tells you |
| -------- | ----------------- |
| `GET /health` | Process liveness, Stellar RPC reachability (`healthStatus.stellar`), DB probe (`healthStatus.db`) |
| `GET /ready`  | Readiness: `ipfs`, `db`, `stellar` — returns `503`/`degraded` when any dependency is down |
| `GET /metrics`| Prometheus metrics: `indexer_ledger_lag`, `http_requests_total`, `http_errors_total`, `db_query_duration_seconds`, `soroban_rpc_duration_seconds`, `webhook_delivery_total`, `scout_off_webhook_dead_letters_total`, `ip_reputation_blocked_total`, `sse_connections_active`, … |

**`indexer_ledger_lag`** is the single most useful indexer signal: ledgers
behind the chain tip after the last poll. It is exposed as
`indexer_ledger_lag` on `/metrics` and a warning is logged when it exceeds
`INDEXER_LAG_WARN_THRESHOLD` (default `100`). Small, transient lag is normal
(polls run every 5 s, and `INDEXER_FINALITY_MARGIN` — default `10` ledgers —
intentionally treats the tip as non-final); persistent three-figure lag is not.

## Incident → action

| Incident | Symptoms | Diagnosis | Action |
| -------- | -------- | --------- | ------ |
| **Indexer stalled** | `indexer_ledger_lag` climbing; `player_registered`/`milestone_approved` events missing from the API; webhooks/SSE quiet | `GET /metrics` → `indexer_ledger_lag`; `GET /health` → `healthStatus.stellar` | If Stellar RPC is down, fix RPC first (below). If RPC is fine, check the indexer log for poll errors, then [replay](#targeted-replay-vs-full-reindex) from where it stopped. |
| **Tiers wrong** | A player's tier (0–3) doesn't match their approved milestones; scouts report stale tiers | Compare `GET /api/players/:playerId/milestones` against the tier thresholds in [docs/tier-promotion.md](tier-promotion.md) | The tier is derived from `milestone_approved` events — if events were indexed twice or never, run a [targeted replay](#targeted-replay-vs-full-reindex) over the range containing the approvals, then verify with the player endpoint. Cache may also be stale (see [cache flush](#cache-flush)). |
| **Webhooks not arriving** | Subscriber gets nothing; `webhook_delivery_total` flat or erroring | `GET /api/admin/webhooks/dead-letters` — see [Draining the dead-letter queue](#draining-the-dead-letter-queue) | Requeue the affected deliveries. If they fail again, check the subscriber (docs/webhooks.md) — a permanently broken subscriber should be fixed or removed, not replayed forever. |
| **RPC down** | `/health` → `healthStatus.stellar: error`; `/ready` → `stellar: unavailable`; `soroban_rpc_duration_seconds` spiking then failing | Check the circuit breaker (below) and the RPC provider status page | Fix/replace `SOROBAN_RPC_URL`. The circuit breaker opens after 3 consecutive failures and recovers automatically after its 10 s reset window — no manual reset needed. Once RPC is back, watch `indexer_ledger_lag` and [replay](#targeted-replay-vs-full-reindex) if the gap grew large. |
| **IPFS down** | `/ready` → `ipfs: unavailable`; player registration/milestone uploads fail | Check `PINATA_API_KEY`/`PINATA_SECRET`, Pinata status | Restore Pinata credentials/connectivity. Reads degrade to DB/cache; nothing to replay — uploads retry when it recovers. |
| **DB slow / locked** | `db_query_duration_seconds` p95 climbing; `SLOW_QUERY_THRESHOLD_MS` (default 50) warnings in logs; `/ready` → `db: unavailable` | `GET /health` → `healthStatus.db`; check slow-query logs; check SQLite lock contention or Postgres pool | SQLite: `VACUUM`/WAL settings, stop long `GET /api/admin/events/export` runs during peak. Postgres: see [docs/postgres-migration.md](postgres-migration.md). The cache absorbs read load — confirm `REDIS_URL` is set and cache metrics show hits. |

## Targeted replay vs full reindex

There are three ways to re-fetch events. Choose by how much history you need:

| Tool | Scope | When to use |
| ---- | ----- | ----------- |
| `POST /api/admin/reindex` | Arbitrary `[fromLedger, toLedger]` range (≤ 10 000 ledgers), background job with live status | Most precise: replay the exact range where events were missed or corrupted. |
| `POST /api/admin/indexer/reindex` | Resets stored `last_ledger` to `fromLedger`; the normal poll loop replays from there onward | "From here to the tip" — e.g. after an RPC outage. |
| `npm run backfill -- --backfill <fromLedger>` | CLI equivalent of the above (operates on `dist/`, so run `npm run build` first) | When you have shell access and no admin token handy. |

### Full reindex (background job)

```bash
curl -X POST http://localhost:4000/api/admin/reindex \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"fromLedger": 4500000, "toLedger": 4520000}'
```

Expected: `202 { "success": true, "data": { "fromLedger": ..., "toLedger": ..., "status": "running" } }`.
`409` means a job is already running; `422` means the range exceeds 10 000
ledgers or `fromLedger >= toLedger`.

Poll progress:

```bash
curl -H "Authorization: Bearer $ADMIN_JWT" http://localhost:4000/api/admin/reindex/status
```

Expected:

```json
{
  "success": true,
  "data": {
    "status": "running",
    "from_ledger": 4500000,
    "to_ledger": 4520000,
    "ledgers_processed": 1234,
    "ledgers_total": 20001,
    "events_inserted": 87,
    "started_at": "2026-08-01T12:00:00.000Z",
    "completed_at": null,
    "error_message": null
  }
}
```

`status` is one of `idle | running | complete | error`. Events are inserted with
`INSERT OR IGNORE` and deduplicated on `tx_hash`, so replaying a range that was
already indexed is safe — duplicates are silently skipped. The job logs
`reindex_started` / `reindex_completed` / `reindex_error` audit entries
(`GET /api/admin/audit`). On completion the indexer resumes from
`toLedger + 1` automatically.

### Targeted replay (reset last_ledger)

```bash
curl -X POST http://localhost:4000/api/admin/indexer/reindex \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"fromLedger": 4520000}'
```

Expected: `200 { "success": true, "data": { "fromLedger": 4520000, "previous": 4520031 } }` —
the next 5 s poll re-fetches from ledger 4520000. CLI equivalent:

```bash
npm run build   # backfill runs from dist/
node scripts/backfill.js --backfill 4520000
```

> **Tip:** for "tiers wrong", replaying the range containing the affected
> player's `milestone_approved` transactions is enough — the indexer recomputes
> tiers from the (deduplicated) approval count on every poll. A full reindex
> from genesis is almost never needed.

## Draining the dead-letter queue

Webhook deliveries that exhaust their retries land in the dead-letter queue
(`webhook_dead_letters`). Watch `scout_off_webhook_dead_letters_total` on
`/metrics` and the critical log `webhook_dead_letter_threshold_crossed` (see
[docs/webhooks.md](webhooks.md#alerting-and-metrics-1131)) — the log line names
the top culprit subscriptions.
(see [docs/webhooks.md](webhooks.md) for delivery/retry mechanics).

```bash
# 1. See what's stuck
curl -H "Authorization: Bearer $ADMIN_JWT" \
  "http://localhost:4000/api/admin/webhooks/dead-letters?page=1&pageSize=20"

# 2. Requeue one delivery (re-signs with the subscriber's current secret)
curl -X POST -H "Authorization: Bearer $ADMIN_JWT" \
  http://localhost:4000/api/admin/webhooks/dead-letters/42/requeue
```

Expected: `200 { "success": true, "message": "...", "data": { "id": 42, "status": "replayed" } }`.
`409` = already replayed; `502` = delivery failed again (the row stays
`pending`, check the subscriber). The legacy alias
`POST /api/admin/webhooks/:id/replay` does the same thing.

Housekeeping:

```bash
# Purge all dead letters older than 7 days (default; tune with ?olderThanDays=)
curl -X DELETE -H "Authorization: Bearer $ADMIN_JWT" \
  "http://localhost:4000/api/admin/webhooks/dead-letters"

# Purge a single row
curl -X DELETE -H "Authorization: Bearer $ADMIN_JWT" \
  http://localhost:4000/api/admin/webhooks/dead-letters/42
```

**Runbook rule:** requeue when the subscriber was briefly down; purge when the
subscriber is gone. A dead queue that keeps refilling is a subscriber bug, not
a delivery bug.

## Cache flush

The player/milestone search cache invalidates **automatically**: the indexer
calls `invalidatePlayerCache()` after every `player_registered` /
`milestone_approved` batch, which clears all `players:list:*` entries (and the
single `players:<id>` entry when known). In Redis deployments the invalidation
is fanned out to every instance over the `invalidate:players` pub/sub channel,
so one instance's indexer clears the others' caches too.

There is **no manual cache-flush endpoint today**. When you need to force a
flush anyway:

1. **Restart the backend** — in-memory caches start empty. On a multi-instance
   deployment restart instances one at a time behind the load balancer.
2. **Or wait for the TTL** — entries expire after `PLAYER_CACHE_TTL_MS`
   (default `60000` ms).

Stale single-player entries are only ever invalidated by id, never by wildcard,
so a wrong tier after a replay usually means the replay didn't cover the
approval (re-check `GET /api/admin/reindex/status`) rather than a stuck cache.

## Circuit-breaker state

Outbound Soroban RPC calls run through a circuit breaker
(`src/utils/circuitBreaker.ts`):

- **State:** `CLOSED` (normal) → `OPEN` after 3 consecutive failures →
  `HALF_OPEN` after the 10 s reset window (a probe request then decides).
- While `OPEN`, calls fail fast with `ServiceUnavailable: Circuit breaker is OPEN`
  instead of hanging on a dead RPC.

Check it:

```bash
curl -s http://localhost:4000/ready | jq '.services.stellar'
# "unavailable" ⇒ OPEN/HALF_OPEN — RPC is failing and being probed
```

There is **no manual reset endpoint** — the breaker resets itself after its
reset timeout and closes again on the first success. If RPC has been down for a
while, `GET /health` shows `stellar: error`; fix the RPC and the breaker heals
itself. (Retries: up to 3 attempts with exponential backoff + jitter, base
1000 ms; 408/429/network/5xx are retryable, other 4xx fail fast.)

## Pause / unpause procedure

The contract has a pause/unpause circuit breaker for emergencies:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_JWT" \
  http://localhost:4000/api/admin/contract/pause
# → 202 { "success": true, "message": "...", "transactionId": "..." }

# ... resolve the incident ...

curl -X POST -H "Authorization: Bearer $ADMIN_JWT" \
  http://localhost:4000/api/admin/contract/unpause
# → 202 { "success": true, "message": "...", "transactionId": "..." }
```

> **Note:** these endpoints currently **simulate** the pause — no real on-chain
> transaction is issued (see the route JSDoc in `src/routes/admin.ts`). While
> "paused", on-chain calls from the backend that hit the contract's
> paused-state guard return error code 10 (`ContractPaused`). Re-run the
> health checks after unpausing and watch `indexer_ledger_lag` for a few polls.

## Post-incident checklist

1. `GET /ready` — all of `db`, `ipfs`, `stellar` OK.
2. `GET /metrics` — `indexer_ledger_lag` near 0 and stable.
3. Spot-check affected entities via the API (tier, milestones, webhooks).
4. If you used the runbook to fix something the docs didn't predict, update
   this file — and add any new doc to [docs/README.md](README.md).

## Tier divergence alert (#1132)

**Symptom:** `scout_off_tier_divergence_total` in `GET /metrics` is non-zero or
growing. Scouts may see stale progress tiers for one or more players.

**Cause:** The indexer missed one or more `milestone_approved` events. The
off-chain derived tier (from the `milestone_approved` event count) no longer
matches the stored `progress_level`.

**Diagnosis:**

```bash
# 1. Check the current mismatch count
curl -s http://localhost:4000/metrics | grep scout_off_tier_divergence

# 2. Find which players are affected in the structured logs
# Look for entries with msg "tier-divergence mismatch detected"
# Each entry contains: player_id, onchain (stored), derived, approved_milestone_count
```

**Resolution:**

Run a full reindex to replay events from the last known-good ledger:

```bash
# Reset the indexer to replay from a safe ledger (e.g. 1000 ledgers back)
INDEXER_BACKFILL_FROM_LEDGER=<safe_ledger> npm start
# or trigger via the admin endpoint:
curl -X POST http://localhost:4000/api/admin/reindex \
  -H "Authorization: Bearer <ADMIN_JWT>"
```

After reindexing completes, `scout_off_tier_divergence_total` should stop
growing and the next reconciliation pass (every `TIER_DIVERGENCE_INTERVAL_MS`,
default 5 min) should log zero mismatches.

**Configuration:**

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `TIER_DIVERGENCE_INTERVAL_MS` | `300000` (5 min) | How often to run the reconciliation pass |
| `TIER_DIVERGENCE_SAMPLE_SIZE` | `100` | Max players sampled per pass |

## Circuit breaker tuning

The backend maintains circuit breakers to fail fast when downstream dependencies degrade:

| Variable | Default | Unit | Effect |
| -------- | ------- | ---- | ------ |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `5` | count | Consecutive failures before generic circuit breaker trips open |
| `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` | `30000` (30 s) | ms | Cooldown duration before generic breaker tests dependency recovery |
| `IPFS_BREAKER_FAILURE_THRESHOLD` | `5` | count | Consecutive failures before Pinata IPFS circuit breaker trips open |
| `IPFS_BREAKER_RESET_TIMEOUT_MS` | `30000` (30 s) | ms | Cooldown duration before IPFS breaker tests Pinata recovery |

When open, calls fail immediately with `CircuitBreakerOpenError` rather than consuming sockets while waiting on network timeouts. See [docs/degradation-contracts.md](degradation-contracts.md#circuit-breakers) for degradation contracts and behavior under failure.

## Graceful shutdown (#1315)

The server implements an ordered drain sequence on `SIGTERM`/`SIGINT`:

1. Flip draining flag → `/ready` and `/health/readiness` return `503` immediately (liveness stays `200`).
2. Optional pre-stop delay (`SHUTDOWN_PRESTOP_DELAY_MS`, default `0`) so load balancers observe the `503` before traffic stops.
3. Stop all background schedulers (indexer poll, IPFS retry/reconcile, tier-divergence check).
4. Await in-flight job executions (up to 60 % of `SHUTDOWN_TIMEOUT_MS`).
5. Drain SSE sessions — sends `event: session_ended\ndata: {"reason":"server_shutdown"}` to every connected client.
6. `server.close()` + `closeIdleConnections()` — stops accepting new HTTP connections.
7. Close Redis, database, tracing SDK.
8. Exit `0`.

**Configuration:**

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Hard limit before forced `exit(1)`. Align with Helm `terminationGracePeriodSeconds`. |
| `SHUTDOWN_PRESTOP_DELAY_MS` | `0` | Pre-stop sleep to let load balancers drain in-flight connections before traffic stops. |

**Kubernetes alignment:**

Set `terminationGracePeriodSeconds` ≥ `SHUTDOWN_TIMEOUT_MS / 1000 + 5` (buffer for OS signal delivery and container runtime overhead). A `preStop` hook sleep of `SHUTDOWN_PRESTOP_DELAY_MS / 1000` seconds ensures the pod stops receiving traffic before `SIGTERM` is sent:

```yaml
lifecycle:
  preStop:
    exec:
      command: ["sleep", "5"]
terminationGracePeriodSeconds: 20
```

**Expected log sequence on clean shutdown:**

```
Received SIGTERM, starting graceful shutdown...
[shutdown] waiting for 1 in-flight job(s)...
[sse] draining 3 session(s) for shutdown
HTTP server closed
Redis connections closed
Database connection closed
Tracing SDK shut down
```

Exit code `0` confirms clean drain. Exit code `1` with "timed out" means a job or SSE session blocked beyond `SHUTDOWN_TIMEOUT_MS` — increase the timeout or investigate the blocking operation.

## Configurable retention (#1506)

Retention starts after DB migrations and is disabled by default. Before enabling
it, inspect `GET /api/admin/retention/dry-run` with an admin bearer token. This
read-only endpoint returns candidate counts, zero deleted rows and zero batches;
it creates no archives and changes no retention metrics. Audit candidate counts
may exceed the next removable prefix when a recent row blocks older backdated
entries. A sweep never skips a blocking audit entry.

Default policy durations: profile views 180 days (daily rollup), webhook delivery
history 30 days, security events 90 days, unclaimed dead letters 90 days, indexed
events 365 days, audit records 365 days (archive + checkpoint). Idempotency and
completed/failed export jobs expire at their stored deadline. Indexed role events
are exempt because `/api/admin/introspect` derives membership from their history.
Unknown tables/columns, invalid strategies, duplicate policies and non-integer
or negative days are rejected at startup. Profile/audit retention must be at
least one day. Null timestamps are retained for operator investigation.

Environment settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RETENTION_ENABLED` | `false` | Enable scheduled sweeps |
| `RETENTION_INTERVAL_MS` | `86400000` | Delay before first and between completed sweeps |
| `RETENTION_BATCH_SIZE` | `1000` | Maximum rows per mutation transaction, 1–1000 |
| `RETENTION_PAUSE_MS` | `100` | Yield between batches, 1–60000 ms |
| `RETENTION_MAX_BATCHES` | `100` | Per-table budget per sweep |
| `RETENTION_ARCHIVE_DIR` | `./data/audit-archives` | Durable restricted audit archive volume |
| `RETENTION_CHECKPOINT_KEY` | unset | Independent 32-byte hex HMAC signing key; required when enabling audit retention |
| `DATA_EXPORT_ARCHIVE_DIR` | `./data/exports` | Only root within which export files can be deleted |
| `RETENTION_POLICIES` | defaults above | JSON array replacing all policies; `[]` disables all table policies |

For example, retain only webhook history and roll up profile views:

```json
[
  { "table": "webhook_deliveries", "column": "created_at", "days": 30, "strategy": "delete" },
  { "table": "profile_views", "column": "viewed_at", "days": 180, "strategy": "aggregate-then-delete" }
]
```

Set `RETENTION_ENABLED=true` after reviewing the dry run and backing up the DB.
Use a secret manager for `RETENTION_CHECKPOINT_KEY`; it must be identical across
replicas. Store audit archives on persistent storage available to every replica
that verifies the chain. On Unix new directories/files use 0700/0600; provision
equivalent restricted ACLs on Windows. Backup the archives, database checkpoints
and signing key together. Key rotation requires re-signing checkpoints under a
controlled migration; removing/replacing the key immediately invalidates old
checkpoints. Do not reuse a JWT or webhook secret as the checkpoint key.

Sweeps do not overlap in-process; transaction/advisory locks serialize mutation
batches across replicas. PostgreSQL batches lock candidate rows. Audit archive
I/O happens before the mutation transaction, which rechecks the exact prefix
and previous checkpoint to avoid deleting a prefix changed by another replica.
A crash before commit may leave an unreferenced archive; identify these by
comparing filenames to `audit_checkpoints` and retain them for investigation
before manual cleanup. A committed archive must never be removed while its
checkpoint is needed. The verifier checks the latest archive and live suffix;
for a historical compliance audit also verify every retained archive digest and
replay its rows in checkpoint order, including previous-hash links.

`scout_off_retention_rows_deleted_total{table}` counts successful deletions since
process start, and `scout_off_retention_last_run_timestamp_seconds{table}` records
the last successful sweep. A bounded sweep can leave a backlog; monitor these
alongside dry-run candidate counts and tune batch budget, pause or schedule.
The scheduler logs and surfaces failures without pruning unarchived audit rows.
Graceful shutdown stops the timer, lets the current batch finish, and drains
retention before closing the DB. Restore a failed export cleanup's job metadata
only if its archive still exists; expired files removed before a transaction
rollback may already be gone. See [data privacy](data-privacy.md) for erasure,
rollup identity and archive handling.
