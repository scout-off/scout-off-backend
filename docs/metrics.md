# Metrics Reference

`GET /metrics` exposes Prometheus metrics in text format (version 0.0.4). All
values are **per process**: each replica keeps its own counters, which reset on
restart. Aggregate across replicas in Prometheus.

> Every metric with a `# HELP` line in
> [`src/middleware/metrics.ts`](../src/middleware/metrics.ts) must appear in
> the table below. `tests/metricsDocumentation.test.ts` enforces this. When you
> add a metric, add a row here.

## Scraping

- `/metrics` needs **no authentication** and isn't rate-limited (standard
  scrape pattern). Don't expose it publicly; restrict it at the ingress or
  network policy so only Prometheus can reach it.
- It responds with `Cache-Control: no-store`.
- Set `METRICS_ENABLED=false` to stop request metrics being collected.

```yaml
scrape_configs:
  - job_name: scout-off-backend
    metrics_path: /metrics
    scrape_interval: 15s
    static_configs:
      - targets: ['scout-off-backend:4000']
```

## Metrics

Histograms expose the usual `_bucket{le=…}`, `_sum` and `_count` series.
`http_request_duration_ms` uses buckets 5, 10, 25, 50, 100, 250, 500, 1000,
2500 and 5000 ms. The `*_seconds` histograms use 0.01, 0.05, 0.1, 0.5, 1 and
5 s.

### HTTP

| Metric                          | Type      | Labels                 | Description                                                                                                                                                           |
| ------------------------------- | --------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http_requests_total`           | counter   | `route`                | Requests served, per route. Unmatched routes (404s, bot scans) are aggregated under `unmatched_route` to prevent unbounded cardinality growth                         |
| `http_request_duration_seconds` | histogram | —                      | Request latency in seconds, across all routes. Buckets: 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 s. Replaces the deprecated `http_request_duration_ms` |
| `http_request_duration_ms`      | histogram | —                      | Request latency in milliseconds, across all routes. Deprecated; emitted while `METRICS_LEGACY_MS` is not `false`. Will be removed in the next release                 |
| `http_errors_total`             | counter   | `range` (`4xx`, `5xx`) | Error responses by status class                                                                                                                                       |

### Cache

| Metric                     | Type    | Labels | Description                                                                            |
| -------------------------- | ------- | ------ | -------------------------------------------------------------------------------------- |
| `cache_hits_total`         | counter | —      | Cache hits                                                                             |
| `cache_misses_total`       | counter | —      | Cache misses                                                                           |
| `cache_evictions_total`    | counter | —      | Lazy evictions (an expired key was read)                                               |
| `cache_invalidation_total` | counter | —      | Player-list cache invalidations, local and from received `invalidate:players` messages |

### Dependencies

| Metric                            | Type      | Labels                                                                                                                                                                                                                                                                                                                                                                                                                                        | Description                                                                                              |
| --------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ipfs_operation_duration_seconds` | histogram | `operation` (`pinJson`, `pinFile`, `checkHealth`)                                                                                                                                                                                                                                                                                                                                                                                             | IPFS (Pinata/gateway) operation latency                                                                  |
| `db_query_duration_seconds`       | histogram | `query_name` (e.g. `getPlayerById`, `insertOrUpdatePlayer`)                                                                                                                                                                                                                                                                                                                                                                                   | Database query latency, for queries wrapped in `timedQuery`                                              |
| `soroban_rpc_duration_seconds`    | histogram | `operation` (`getLatestLedger`, `queryEvents`, `getAccount`, `simulateTransaction`, `sendTransaction`, `getTransaction`, `isSubscribed`, `submitContactPayment`, `logTrialOffer`, `withdrawFees`, `purchaseSubscription`, `renewSubscription`, `cancelSubscriptionOnChain`, `unpauseContractOnChain`, `pauseContractOnChain`, `registerValidatorOnChain`, `revokeValidatorOnChain`, `updateProfile`, `getOnChainMilestones`, `stellarHealth`) | Soroban RPC call latency                                                                                 |
| `stellar_rpc_network_match`       | gauge     | —                                                                                                                                                                                                                                                                                                                                                                                                                                             | Whether the Soroban RPC network passphrase matches config: 1 = match, 0 = mismatch, -1 = unknown (#1824) |
| `stellar_rpc_protocol_version`    | gauge     | —                                                                                                                                                                                                                                                                                                                                                                                                                                             | Protocol version reported by the Soroban RPC (-1 = unknown) (#1824)                                      |

### Indexer and IPFS pins

| Metric                                             | Type    | Labels          | Description                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `indexer_ledger_lag`                               | gauge   | —               | Ledgers behind the chain tip after the last indexer poll                                                                                                                                                                                               |
| `scout_off_indexer_last_success_timestamp_seconds` | gauge   | —               | Unix time of the last successful indexer poll, including polls that found no events (0 = never)                                                                                                                                                        |
| `scout_off_indexer_poll_failures_total`            | counter | —               | Failed indexer polls since process start                                                                                                                                                                                                               |
| `scout_off_circuit_breaker_state`                  | gauge   | `breaker`       | Circuit breaker state: 0 = closed, 1 = half-open, 2 = open                                                                                                                                                                                             |
| `scout_off_circuit_breaker_transitions_total`      | counter | `breaker`, `to` | Circuit breaker state transitions by destination state                                                                                                                                                                                                 |
| `stuck_pending_pins_count`                         | gauge   | —               | Pending IPFS pins older than the reconciliation cutoff. Updated by the pin reconciliation job                                                                                                                                                          |
| `scout_off_tier_divergence_total`                  | counter | —               | Players whose derived tier differs from stored `progress_level`, counted since process start (#1132). A sustained non-zero value indicates the indexer has missed `milestone_approved` events; run a reindex to resolve (see [runbook.md](runbook.md)) |

### Webhooks

| Metric                                          | Type    | Labels                                         | Description                                                                                           |
| ----------------------------------------------- | ------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `webhook_delivery_total`                        | counter | `status` (`success`, `failure`, `dead_letter`) | Webhook delivery outcomes                                                                             |
| `scout_off_webhook_dead_letters_total`          | gauge   | `subscription_id`                              | Current dead-letter queue depth per subscription (#1131). Despite the `_total` suffix this is a gauge |
| `scout_off_webhook_dead_letters_inserted_total` | counter | —                                              | Lifetime dead-letter inserts                                                                          |
| `scout_off_webhook_subscriptions`               | gauge   | `status`                                       | Webhook subscriptions by health status (`active`, `degraded`, `suspended`)                            |
| `scout_off_webhook_circuit_open_total`          | counter | —                                              | Deliveries skipped because the subscription's circuit breaker was open                                |
| `scout_off_webhook_retry_success_total`         | counter | —                                              | Dead letters successfully redelivered by the automatic retry job                                      |
| `scout_off_webhook_dispatch_queue_depth`        | gauge   | `state` (`pending`, `active`)                  | Indexer webhook dispatch queue depth (see [indexer-webhook-queue.md](indexer-webhook-queue.md))       |
| `scout_off_webhook_dispatch_queue_latency_ms`   | summary | —                                              | Indexer webhook dispatch latency in milliseconds (`_sum`, `_count`)                                   |

### Fees

| Metric                                             | Type    | Labels | Description                                          |
| -------------------------------------------------- | ------- | ------ | ---------------------------------------------------- |
| `scout_off_fee_withdrawal_db_write_failures_total` | counter | —      | Fee withdrawal DB write failures since process start |

### Security and streaming

| Metric                                    | Type    | Labels                                              | Description                                                                        |
| ----------------------------------------- | ------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `evidence_download_rejected_total`        | counter | `reason` (`budget_exceeded`, `unsupported_content`) | Rejected milestone-evidence downloads                                              |
| `ip_reputation_blocked_total`             | counter | —                                                   | Requests blocked by IP reputation scoring                                          |
| `ip_reputation_penalised_total`           | counter | —                                                   | Requests that got a reputation penalty (delay or rate restriction)                 |
| `sse_connections_active`                  | gauge   | —                                                   | Open SSE connections on this process                                               |
| `scout_off_auth_failures_total`           | counter | `reason`                                            | Authentication failures by reason                                                  |
| `scout_off_rate_limit_rejected_total`     | counter | `limiter`                                           | Requests rejected with 429, by limiter namespace                                   |
| `scout_off_rate_limit_store_errors_total` | counter | —                                                   | Rate-limit store errors (requests were allowed through: fail-open)                 |
| `scout_off_audit_chain_valid`             | gauge   | —                                                   | 1 when the last audit-log hash-chain verification passed, 0 after a break is found |
| `scout_off_audit_chain_breaks_total`      | counter | —                                                   | Audit-log hash-chain breaks detected since process start                           |
| `scout_off_legacy_admin_calls_total`      | counter | `route`                                             | Calls to deprecated admin routes. Non-zero means clients still use a legacy path   |
| `profile_view_record_failures_total`      | counter | —                                                   | Failures while recording a player profile view (the view itself is still served)   |

### Indexer events

| Metric                           | Type    | Labels            | Description                                                                                                                                       |
| -------------------------------- | ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scout_off_indexer_events_total` | counter | `type`, `outcome` | Contract events seen by the indexer. A sustained `unknown_type`/`decode_error` rate means events are being parked in `indexer_unprocessed_events` |

### Process and runtime

| Metric                                 | Type      | Labels | Description                                                                                           |
| -------------------------------------- | --------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `process_cpu_seconds_total`            | counter   | —      | User and system CPU time, in seconds                                                                  |
| `process_resident_memory_bytes`        | gauge     | —      | Resident memory size, in bytes                                                                        |
| `nodejs_heap_size_used_bytes`          | gauge     | —      | V8 heap in use, in bytes                                                                              |
| `nodejs_heap_size_total_bytes`         | gauge     | —      | V8 heap allocated, in bytes                                                                           |
| `nodejs_eventloop_lag_seconds`         | gauge     | —      | Event-loop delay, 95th percentile, in seconds. High values mean the event loop is saturated           |
| `nodejs_gc_duration_seconds`           | histogram | —      | Garbage-collection pause duration, in seconds. Buckets: 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1 s       |
| `nodejs_active_handles_total`          | gauge     | —      | Active libuv handles. High values may indicate resource leaks (unclosed connections, file handles, …) |
| `scout_off_unhandled_rejections_total` | counter   | —      | Unhandled promise rejections since process start                                                      |

## Configuration

| Variable            | Default | Description                                                                                                             |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `METRICS_ENABLED`   | `true`  | Enable or disable metrics collection. Set to `false` to disable                                                         |
| `METRICS_LEGACY_MS` | `true`  | Export the deprecated `http_request_duration_ms` metric. Set to `false` to disable. Will be removed in the next release |

## Performance

The `/metrics` endpoint serializes metrics in Prometheus text exposition format.
With realistic route cardinality (100+ routes), scraping the endpoint takes under
50 ms as measured in testing.

## Migrating off `http_request_duration_ms`

`http_request_duration_ms` is deprecated in favor of
`http_request_duration_seconds` to align with Prometheus best practices. During
the deprecation period (one release):

1. Both metrics are exported by default.
2. Alerting rules and dashboards should be updated to use
   `http_request_duration_seconds`.
3. Set `METRICS_LEGACY_MS=false` to test dashboards without the legacy metric.
4. In the next release, `http_request_duration_ms` will be removed entirely.

To migrate your dashboards:

- Replace `http_request_duration_ms` with `http_request_duration_seconds`.
- Update query thresholds (e.g. `100` ms → `0.1` seconds).
- Adjust bucket queries to use the new bucket boundaries: 0.005, 0.01, 0.025,
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 seconds.

## Suggested alerts

Treat these thresholds as starting points and tune them for your traffic.

| Alert                     | Expression                                                                                                     | For | Why                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Indexer lagging           | `max(indexer_ledger_lag) > 100`                                                                                | 10m | The API is serving stale on-chain state. See [runbook.md](runbook.md)                                                                    |
| High 5xx rate             | `sum(rate(http_errors_total{range="5xx"}[5m])) / sum(rate(http_requests_total[5m])) > 0.02`                    | 5m  | More than 2% of requests are failing                                                                                                     |
| Slow requests             | `histogram_quantile(0.95, sum(rate(http_request_duration_ms_bucket[5m])) by (le)) > 1000`                      | 10m | p95 latency over 1 s. See [performance.md](performance.md)                                                                               |
| Dead-letter queue growing | `sum(scout_off_webhook_dead_letters_total) > 0 and deriv(sum(scout_off_webhook_dead_letters_total)[30m:]) > 0` | 30m | Webhooks are failing and not being drained. See [webhooks.md](webhooks.md)                                                               |
| Tier divergence           | `increase(scout_off_tier_divergence_total[15m]) > 0`                                                           | 0m  | The indexer probably missed `milestone_approved` events. See [runbook.md → Tier divergence alert](runbook.md#tier-divergence-alert-1132) |
| Stuck IPFS pins           | `max(stuck_pending_pins_count) > 0`                                                                            | 30m | Pins aren't completing; check Pinata health                                                                                              |
| Slow Soroban RPC          | `histogram_quantile(0.95, sum(rate(soroban_rpc_duration_seconds_bucket[5m])) by (le)) > 5`                     | 10m | The RPC provider is degraded                                                                                                             |
| IP reputation spike       | `sum(rate(ip_reputation_blocked_total[5m])) > 1`                                                               | 10m | Possible abuse or a misconfigured client. See [ip-reputation.md](ip-reputation.md)                                                       |

See [background-jobs.md](background-jobs.md) for the jobs that update the
indexer, pin, divergence and dead-letter metrics.
