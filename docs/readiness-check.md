# Readiness Check with Indexer Lag

## Overview

The backend's readiness check (`/ready` and `/health/readiness`) now includes an indexer lag check to prevent serving stale data during deployments or after long downtimes. This warm-up gate ensures that instances are not marked as ready until the indexer has caught up to the chain tip.

## How It Works

The readiness check reports the indexer service status based on:

1. **Configuration**: `READINESS_MAX_LAG` (default: 100 ledgers)
2. **Grace Period**: `READINESS_GRACE_PERIOD_MS` (default: 5 minutes)
3. **Current Lag**: `indexerLedgerLag` (tracked in `src/services/indexer.ts`)

### Check Logic

- **Disabled**: If `READINESS_MAX_LAG = 0`, the indexer lag check is skipped (always reports `disabled`)
- **Grace Period**: During the first `READINESS_GRACE_PERIOD_MS` after startup, the indexer always reports `ok` regardless of lag
- **Normal Operation**: After the grace period, the indexer reports:
  - `ok` if `indexerLedgerLag <= READINESS_MAX_LAG`
  - `unavailable` if `indexerLedgerLag > READINESS_MAX_LAG`

## Configuration

### `READINESS_MAX_LAG`

- **Purpose**: Maximum allowable indexer lag (in ledgers) for readiness
- **Default**: `100`
- **Set to `0`**: Disables the lag check entirely
- **Recommended**: 
  - Production: `50-100` (adjust based on your network's block time)
  - Development: `0` (disable to avoid false negatives during development)

### `READINESS_GRACE_PERIOD_MS`

- **Purpose**: Startup grace period to allow initial sync from persisted cursor
- **Default**: `300000` (5 minutes)
- **Set to `0`**: Disables the grace period (check starts immediately)
- **Recommended**: 
  - Production: `300000-600000` (5-10 minutes for typical sync)
  - Development: `0` (if you want immediate feedback)

## Use Cases

### Blue-Green Deployments

When deploying a new version:
1. New pods start with a fresh process or persisted cursor
2. Indexer needs time to catch up from the last indexed ledger
3. Grace period allows initial sync without failing readiness
4. Once caught up, the new pods are marked ready and receive traffic
5. Old pods can be drained safely

### Long Downtimes

After a long downtime:
1. Indexer resumes from persisted cursor (potentially thousands of ledgers behind)
2. Grace period allows time to catch up
3. If lag exceeds threshold after grace period, instance reports degraded
4. Prevents serving stale player/milestone data

### New Empty Database

For a brand-new database:
1. No persisted cursor exists
2. Indexer starts from genesis or `INDEXER_BACKFILL_FROM_LEDGER`
3. Grace period prevents immediate readiness failure
4. Once indexer reaches tip, instance becomes ready

## Example Kubernetes Readiness Probe

```yaml
readinessProbe:
  httpGet:
    path: /health/readiness
    port: 4000
  initialDelaySeconds: 10
  periodSeconds: 5
  timeoutSeconds: 5
  failureThreshold: 3
```

The readiness probe will:
- Return `200 OK` when all services (including indexer) are ready
- Return `503 Service Unavailable` when any service is unavailable
- Include service status in the response body for debugging

## Monitoring

The indexer lag is also exposed via the `/metrics` endpoint as a gauge metric. You can monitor this with Prometheus:

```promql
# Current indexer lag
indexer_ledger_lag

# Readiness status (derived from HTTP response)
up{job="scout-off-backend", probe="readiness"}
```

## Troubleshooting

### Instance Stuck in Degraded State

If an instance remains degraded after the grace period:

1. Check current lag: `curl http://localhost:4000/health/readiness`
2. Verify `READINESS_MAX_LAG` is not too strict for your network
3. Check indexer logs for sync issues: `kubectl logs <pod> | grep indexer`
4. Consider increasing `READINESS_MAX_LAG` if network is slow

### False Negatives During Development

If readiness fails during development:

1. Set `READINESS_MAX_LAG=0` to disable the check
2. Or increase `READINESS_MAX_LAG` to a higher value
3. Set `READINESS_GRACE_PERIOD_MS=0` to skip grace period for immediate feedback

### Grace Period Too Short

If instances fail readiness before catching up:

1. Increase `READINESS_GRACE_PERIOD_MS` (e.g., `600000` for 10 minutes)
2. Monitor typical sync times and set grace period accordingly
3. Consider reducing `READINESS_MAX_LAG` if sync is consistently slow

## Liveness vs Readiness

- **Liveness** (`/health/liveness`): Always returns `200 OK` — the process is running
- **Readiness** (`/health/readiness`): Returns `503` if services are unavailable — the process should not receive traffic

The indexer lag check only affects readiness, not liveness. A lagging indexer is not a crash; it just means the instance should not serve traffic until it's caught up.

## Related Configuration

The indexer lag check works alongside these existing indexer configuration options:

- `INDEXER_LAG_WARN_THRESHOLD`: Threshold for logging warnings (default: 100)
- `INDEXER_FINALITY_MARGIN`: Finality margin for reorg protection (default: 10)
- `INDEXER_BACKFILL_FROM_LEDGER`: Starting ledger for initial sync (optional)

## Implementation Details

- Lag tracking: `src/services/indexer.ts` exports `indexerLedgerLag`
- Readiness check: `src/app.ts` `checkReadiness()` function
- Configuration: `src/config.ts` `readinessMaxLag` and `readinessGracePeriodMs`
- Tests: `tests/routes/health.test.ts` covers lagging, caught-up, and grace-period states
