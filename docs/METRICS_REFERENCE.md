# Metrics Reference

This document lists all Prometheus metrics exported by the ScoutOff backend at the `/metrics` endpoint.

## HTTP Metrics

### `http_requests_total`
- **Type**: Counter
- **Labels**: `route` (Express route pattern, e.g., `GET /api/players`)
- **Description**: Total number of HTTP requests per route
- **Notes**: Unmatched routes (404s, bot scans) are aggregated under `unmatched_route` to prevent unbounded cardinality growth

### `http_request_duration_seconds`
- **Type**: Histogram
- **Labels**: None
- **Buckets**: 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 (seconds)
- **Description**: HTTP request latency in seconds
- **Notes**: Standard Prometheus metric for HTTP latency. Replaces the deprecated `http_request_duration_ms`.

### `http_request_duration_ms` (DEPRECATED)
- **Type**: Histogram
- **Labels**: None
- **Buckets**: 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000 (milliseconds)
- **Description**: HTTP request latency in milliseconds
- **Notes**: Deprecated in favor of `http_request_duration_seconds`. Set `METRICS_LEGACY_MS=false` to disable. Will be removed in the next release.

### `http_errors_total`
- **Type**: Counter
- **Labels**: `range` (4xx or 5xx)
- **Description**: Total number of HTTP error responses by status class

## Cache Metrics

### `cache_hits_total`
- **Type**: Counter
- **Labels**: None
- **Description**: Total number of cache hits

### `cache_misses_total`
- **Type**: Counter
- **Labels**: None
- **Description**: Total number of cache misses

### `cache_evictions_total`
- **Type**: Counter
- **Labels**: None
- **Description**: Total number of lazy cache evictions (expired key reads)

### `cache_invalidation_total`
- **Type**: Counter
- **Labels**: None
- **Description**: Total number of player-list cache invalidations performed (local operations and received `invalidate:players` messages)

## Database Metrics

### `db_query_duration_seconds`
- **Type**: Histogram
- **Labels**: `query_name` (e.g., `getPlayerById`, `insertOrUpdatePlayer`)
- **Buckets**: 0.01, 0.05, 0.1, 0.5, 1, 5 (seconds)
- **Description**: Database query latency in seconds

## IPFS Metrics

### `ipfs_operation_duration_seconds`
- **Type**: Histogram
- **Labels**: `operation` (pinJson, pinFile, checkHealth)
- **Buckets**: 0.01, 0.05, 0.1, 0.5, 1, 5 (seconds)
- **Description**: IPFS operation latency in seconds

### `stuck_pending_pins_count`
- **Type**: Gauge
- **Labels**: None
- **Description**: Current number of stuck pending IPFS pins

## Soroban RPC Metrics

### `soroban_rpc_duration_seconds`
- **Type**: Histogram
- **Labels**: `operation` (getLatestLedger, queryEvents, getAccount, simulateTransaction, sendTransaction, getTransaction, isSubscribed, submitContactPayment, logTrialOffer, withdrawFees, purchaseSubscription, renewSubscription, cancelSubscriptionOnChain, unpauseContractOnChain, pauseContractOnChain, registerValidatorOnChain, revokeValidatorOnChain, updateProfile, getOnChainMilestones, stellarHealth)
- **Buckets**: 0.01, 0.05, 0.1, 0.5, 1, 5 (seconds)
- **Description**: Soroban RPC operation latency in seconds

## Webhook Metrics

### `webhook_delivery_total`
- **Type**: Counter
- **Labels**: `status` (success, failure, dead_letter)
- **Description**: Total number of webhook deliveries by status

### `scout_off_webhook_dead_letters_total`
- **Type**: Gauge
- **Labels**: `subscription_id`
- **Description**: Current webhook dead-letter queue depth by subscription

### `scout_off_webhook_dead_letters_inserted_total`
- **Type**: Counter
- **Labels**: None
- **Description**: Lifetime webhook dead-letter inserts

### `scout_off_webhook_retry_success_total`
- **Type**: Counter
- **Labels**: None
- **Description**: Successful dead-letter auto-retries

## SSE Metrics

### `sse_connections_active`
- **Type**: Gauge
- **Labels**: None
- **Description**: Current number of open SSE connections

## Indexer Metrics

### `indexer_ledger_lag`
- **Type**: Gauge
- **Labels**: None
- **Description**: Ledgers behind the chain tip after the last poll

## Evidence Download Metrics

### `evidence_download_rejected_total`
- **Type**: Counter
- **Labels**: `reason`
- **Description**: Evidence downloads rejected, by reason

## IP Reputation Metrics

### `ip_reputation_blocked_total`
- **Type**: Counter
- **Labels**: None
- **Description**: Total number of requests blocked by IP reputation scoring

### `ip_reputation_penalised_total`
- **Type**: Counter
- **Labels**: None
- **Description**: Total number of requests that received a reputation penalty (delay or rate restriction)

## Tier Divergence Metrics

### `scout_off_tier_divergence_total`
- **Type**: Counter
- **Labels**: None
- **Description**: Total number of player tier divergence events detected since process start
- **Notes**: A sustained non-zero value indicates the indexer has missed `milestone_approved` events. Run a reindex to resolve (see `docs/runbook.md`).

## Fee Withdrawal Metrics

### `scout_off_fee_withdrawal_db_write_failures_total`
- **Type**: Counter
- **Labels**: None
- **Description**: Total number of fee withdrawal DB write failures

## Process Metrics

### `process_cpu_seconds_total`
- **Type**: Counter
- **Labels**: None
- **Description**: Total user and system CPU time spent in seconds

### `process_resident_memory_bytes`
- **Type**: Gauge
- **Labels**: None
- **Description**: Resident memory size in bytes

## Node.js Runtime Metrics

### `nodejs_heap_size_used_bytes`
- **Type**: Gauge
- **Labels**: None
- **Description**: Process heap size used in bytes

### `nodejs_heap_size_total_bytes`
- **Type**: Gauge
- **Labels**: None
- **Description**: Total heap size in bytes

### `nodejs_eventloop_lag_seconds`
- **Type**: Gauge
- **Labels**: None
- **Description**: Event-loop lag in seconds (95th percentile)
- **Notes**: Measures how long the event loop is blocked. High values indicate the event loop is saturated.

### `nodejs_gc_duration_seconds`
- **Type**: Histogram
- **Labels**: None
- **Buckets**: 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1 (seconds)
- **Description**: Garbage collection duration in seconds

### `nodejs_active_handles_total`
- **Type**: Gauge
- **Labels**: None
- **Description**: Number of active libuv handles
- **Notes**: High values may indicate resource leaks (unclosed connections, file handles, etc.)

## Configuration

### `METRICS_ENABLED`
- **Default**: `true`
- **Description**: Enable or disable metrics collection. Set to `false` to disable.

### `METRICS_LEGACY_MS`
- **Default**: `true`
- **Description**: Export the deprecated `http_request_duration_ms` metric. Set to `false` to disable. Will be removed in the next release.

## Performance

The `/metrics` endpoint serializes metrics in Prometheus text exposition format. With realistic route cardinality (100+ routes), scraping the endpoint takes under 50ms as measured in testing.

## Migration Notes

### Deprecating `http_request_duration_ms`

The `http_request_duration_ms` metric is deprecated in favor of `http_request_duration_seconds` to align with Prometheus best practices. During the deprecation period (one release):

1. Both metrics are exported by default
2. Alerting rules and dashboards should be updated to use `http_request_duration_seconds`
3. Set `METRICS_LEGACY_MS=false` to test dashboards without the legacy metric
4. In the next release, `http_request_duration_ms` will be removed entirely

To migrate your dashboards:
- Replace `http_request_duration_ms` with `http_request_duration_seconds`
- Update query thresholds (e.g., `100` ms → `0.1` seconds)
- Adjust bucket queries to use the new bucket boundaries: 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 seconds
