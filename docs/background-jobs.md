# Background Jobs

Every periodic job the backend runs in-process: what it does, how often, where
it's started, what happens when it fails, and whether it's safe with more than
one replica.

> When you add, remove or reschedule a timer, update this table.

## Summary

| Job | Interval | Config | Started in | Multi-replica safe? |
| --- | -------- | ------ | ---------- | ------------------- |
| [Indexer poll](#indexer-poll) | 5 s (+ once at boot) | hard-coded | `start()` in `src/index.ts` | **No.** Each replica polls independently, and the poll isn't single-flight across replicas (#1310) |
| [IPFS pin retry](#ipfs-pin-retry) | 30 s | hard-coded | `start()` in `src/index.ts` | **No.** Replicas may retry the same pending pin |
| [IPFS pin reconciliation](#ipfs-pin-reconciliation) | 60 s default (+ once at boot) | `IPFS_RECONCILE_INTERVAL_MS` (min 1000) | `start()` in `src/index.ts` | **No.** Replicas may reconcile the same rows |
| [Tier divergence check](#tier-divergence-check) | 5 min default (+ once at boot) | `TIER_DIVERGENCE_INTERVAL_MS` (min 1000) | `start()` in `src/index.ts` | Yes (read-only); each replica reports its own counter |
| [Token blocklist prune](#token-blocklist-prune) | 1 h (+ once at boot) | `PRUNE_INTERVAL_MS` constant | `initBlocklist()` in `src/services/tokenBlocklist.ts`, called from `start()` | Yes (idempotent `DELETE`) |
| [IP reputation decay](#ip-reputation-decay) | 1 h | `DECAY_INTERVAL_MS` constant | `startDecayTimer()` in `src/services/ipReputation.ts`, called from `start()` | Yes, but scores are per-replica (in-memory) |
| [SSE keep-alive](#sse-keep-alive-and-auth-sweep) | 15 s default | `SSE_KEEPALIVE_INTERVAL_MS` | Per connection, in `src/routes/events.ts` | Yes (per-connection) |
| [SSE auth sweep](#sse-keep-alive-and-auth-sweep) | 30 s default | `SSE_AUTH_SWEEP_INTERVAL_MS` | Lazily on the first SSE connection, in `src/routes/events.ts` | Yes (each replica sweeps its own sessions) |
| [Webhook DLQ retry](#webhook-dlq-retry-not-started) | 5 min | `DEAD_LETTER_JOB_INTERVAL_MS` constant | **Not started.** `startDeadLetterRetryJob()` exists but nothing calls it | Yes when started (rows are claimed atomically) |

## Shared behaviour

The four jobs started directly in `start()` (indexer, pin retry, pin
reconciliation, tier divergence) are wrapped in `withJobTracking()`:

- Each run catches its own errors and logs them with `logger.error`. A failed
  run never stops the timer, and the next tick runs normally.
- They use `setInterval`, so a run that takes longer than the interval can
  overlap the next one in the same process.
- On `SIGTERM`/`SIGINT` the timers are cleared and shutdown waits (with a
  deadline) for in-flight runs to finish. See
  [runbook.md → Graceful shutdown](runbook.md#graceful-shutdown-1315).

## Jobs

### Indexer poll

- **Purpose:** fetch new Soroban contract events (re-reading a finality margin)
  and write them to `events` and the derived tables.
- **Function:** `indexEvents()` in `src/services/indexer.ts`.
- **On failure:** logs `Indexer error: <message>`; the next poll retries from
  the last persisted ledger.
- **Multiple replicas:** every replica polls. Inserts use `INSERT OR IGNORE`,
  but the poll isn't single-flight across replicas, so derived-table work and
  RPC load are duplicated (#1310). Run one indexing replica if you can.
- **Signals:** `indexer_ledger_lag` gauge; see
  [runbook.md](runbook.md) for lag triage.

### IPFS pin retry

- **Purpose:** retry pending pins that failed to reach Pinata, with exponential
  backoff. Rows with `attempts >= 5` are skipped as permanently failed.
- **Function:** `retryPendingPins()` in `src/services/ipfs.ts`.
- **On failure:** logs `IPFS retry worker error: <message>`; individual pin
  failures log `[ipfs] retry failed for pending pin id=…` and increment
  `attempts`.
- **Multiple replicas:** not coordinated. Two replicas can retry the same row.

### IPFS pin reconciliation

- **Purpose:** check pending pins against Pinata and the gateways, re-pin or
  mark rows expired, and refresh the stuck-pin gauge.
- **Function:** `reconcilePendingPins()` in `src/services/ipfs.ts`.
- **On failure:** logs `IPFS reconcile worker error: <message>`.
- **Multiple replicas:** not coordinated.
- **Signals:** `stuck_pending_pins_count` gauge.

### Tier divergence check

- **Purpose:** compare each player's derived tier with the stored
  `progress_level` and report mismatches (#1132).
- **Function:** `runTierDivergenceCheck()` in `src/services/tierDivergenceJob.ts`.
- **On failure:** logs `Tier divergence check error: <message>`; a failed player
  fetch logs `[tier-divergence] failed to fetch players for reconciliation`.
- **Multiple replicas:** read-only, so safe; each replica keeps its own counter.
- **Signals:** `scout_off_tier_divergence_total`; see
  [runbook.md → Tier divergence alert](runbook.md#tier-divergence-alert-1132).

### Token blocklist prune

- **Purpose:** delete revoked-token rows whose `expires_at` has passed.
- **Function:** `pruneExpiredTokens()` in `src/services/tokenBlocklist.ts`.
  The timer is `unref()`ed.
- **On failure:** logs `[tokenBlocklist] scheduled prune failed` (or `initial
  prune failed` at boot) at warn level. Expired rows are harmless until the next
  run.
- **Multiple replicas:** safe; the delete is idempotent.

### IP reputation decay

- **Purpose:** decay the reputation score of IPs not seen for at least an hour.
  Pinned IPs are skipped.
- **Function:** the timer in `startDecayTimer()` in
  `src/services/ipReputation.ts` (idempotent, `unref()`ed).
- **On failure:** it works only on in-memory state, so there's no I/O to fail.
- **Multiple replicas:** each replica has its own in-memory scores and decays
  them independently. See [ip-reputation.md](ip-reputation.md).
- **Signals:** `ip_reputation_*` metrics.

### SSE keep-alive and auth sweep

- **Keep-alive:** each open stream sends a `: ping` comment every
  `SSE_KEEPALIVE_INTERVAL_MS` (default 15 000 ms) so proxies don't close idle
  connections. The timer is cleared when the connection closes.
- **Auth sweep:** one process-wide timer, started on the first SSE connection
  and `unref()`ed. Every `SSE_AUTH_SWEEP_INTERVAL_MS` (default 30 000 ms) it
  re-checks each session's token and wallet against the revocation blocklist
  and terminates revoked ones. It does nothing when no sessions are open.
- **Multiple replicas:** each replica sweeps its own sessions. A revocation on
  another replica is picked up within one sweep interval.
- **Signals:** `sse_connections_active` gauge. See [events.md](events.md) and
  [auth.md](auth.md).

### Webhook DLQ retry (not started)

- **Purpose:** every 5 minutes, refresh the dead-letter gauges and alerts, then
  re-attempt delivery of pending dead letters older than 10 minutes with
  `retry_count < 5`. Successful rows are deleted; failures bump `retry_count`.
- **Function:** `runDeadLetterRetryJob()`, scheduled by
  `startDeadLetterRetryJob()` in `src/services/webhookDeadLetterJob.ts` using a
  self-rescheduling `setTimeout`, so sweeps never overlap (#1018).
- **Status:** ⚠️ **nothing calls `startDeadLetterRetryJob()`**, so dead letters
  are only retried when an admin replays them (see
  [runbook.md → Draining the dead-letter queue](runbook.md#draining-the-dead-letter-queue)).
  Wiring it into `start()` is tracked as a separate issue.
- **Multiple replicas:** safe once started; each row is claimed atomically
  (`pending` → `in_progress`) before delivery.
- **Signals:** `scout_off_webhook_dead_letters_*`,
  `scout_off_webhook_retry_success_total`.
