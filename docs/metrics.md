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

| Metric | Type | Labels | Description |
| ------ | ---- | ------ | ----------- |
| `http_requests_total` | counter | `route` | Requests served, per route |
| `http_request_duration_ms` | histogram | — | Request latency in milliseconds, across all routes |
| `http_errors_total` | counter | `range` (`4xx`, `5xx`) | Error responses by status class |

### Cache

| Metric | Type | Labels | Description |
| ------ | ---- | ------ | ----------- |
| `cache_hits_total` | counter | — | Cache hits |
| `cache_misses_total` | counter | — | Cache misses |
| `cache_evictions_total` | counter | — | Lazy evictions (an expired key was read) |
| `cache_invalidation_total` | counter | — | Player-list cache invalidations, local and from received `invalidate:players` messages |

### Dependencies

| Metric | Type | Labels | Description |
| ------ | ---- | ------ | ----------- |
| `ipfs_operation_duration_seconds` | histogram | `operation` | IPFS (Pinata/gateway) operation latency |
| `db_query_duration_seconds` | histogram | `query_name` | Database query latency, for queries wrapped in `timedQuery` |
| `soroban_rpc_duration_seconds` | histogram | `operation` | Soroban RPC call latency |

### Indexer and IPFS pins

| Metric | Type | Labels | Description |
| ------ | ---- | ------ | ----------- |
| `indexer_ledger_lag` | gauge | — | Ledgers behind the chain tip after the last indexer poll |
| `stuck_pending_pins_count` | gauge | — | Pending IPFS pins older than the reconciliation cutoff. Updated by the pin reconciliation job |
| `scout_off_tier_divergence_total` | counter | — | Players whose derived tier differs from stored `progress_level`, counted since process start (#1132) |

### Webhooks

| Metric | Type | Labels | Description |
| ------ | ---- | ------ | ----------- |
| `webhook_delivery_total` | counter | `status` (`success`, `failure`, `dead_letter`) | Webhook delivery outcomes |
| `scout_off_webhook_dead_letters_total` | gauge | `subscription_id` | Current dead-letter queue depth per subscription (#1131). Despite the `_total` suffix this is a gauge |
| `scout_off_webhook_dead_letters_inserted_total` | counter | — | Lifetime dead-letter inserts |
| `scout_off_webhook_retry_success_total` | counter | — | Dead letters successfully redelivered by the automatic retry job |

### Security and streaming

| Metric | Type | Labels | Description |
| ------ | ---- | ------ | ----------- |
| `evidence_download_rejected_total` | counter | `reason` (`budget_exceeded`, `unsupported_content`) | Rejected milestone-evidence downloads |
| `ip_reputation_blocked_total` | counter | — | Requests blocked by IP reputation scoring |
| `ip_reputation_penalised_total` | counter | — | Requests that got a reputation penalty (delay or rate restriction) |
| `sse_connections_active` | gauge | — | Open SSE connections on this process |

## Suggested alerts

Treat these thresholds as starting points and tune them for your traffic.

| Alert | Expression | For | Why |
| ----- | ---------- | --- | --- |
| Indexer lagging | `max(indexer_ledger_lag) > 100` | 10m | The API is serving stale on-chain state. See [runbook.md](runbook.md) |
| High 5xx rate | `sum(rate(http_errors_total{range="5xx"}[5m])) / sum(rate(http_requests_total[5m])) > 0.02` | 5m | More than 2% of requests are failing |
| Slow requests | `histogram_quantile(0.95, sum(rate(http_request_duration_ms_bucket[5m])) by (le)) > 1000` | 10m | p95 latency over 1 s. See [performance.md](performance.md) |
| Dead-letter queue growing | `sum(scout_off_webhook_dead_letters_total) > 0 and deriv(sum(scout_off_webhook_dead_letters_total)[30m:]) > 0` | 30m | Webhooks are failing and not being drained. See [webhooks.md](webhooks.md) |
| Tier divergence | `increase(scout_off_tier_divergence_total[15m]) > 0` | 0m | The indexer probably missed `milestone_approved` events. See [runbook.md → Tier divergence alert](runbook.md#tier-divergence-alert-1132) |
| Stuck IPFS pins | `max(stuck_pending_pins_count) > 0` | 30m | Pins aren't completing; check Pinata health |
| Slow Soroban RPC | `histogram_quantile(0.95, sum(rate(soroban_rpc_duration_seconds_bucket[5m])) by (le)) > 5` | 10m | The RPC provider is degraded |
| IP reputation spike | `sum(rate(ip_reputation_blocked_total[5m])) > 1` | 10m | Possible abuse or a misconfigured client. See [ip-reputation.md](ip-reputation.md) |

See [background-jobs.md](background-jobs.md) for the jobs that update the
indexer, pin, divergence and dead-letter metrics.
