import { Request, Response, NextFunction } from 'express';
import { ipReputationCounters, resetIpReputationCounters } from '../services/ipReputation';

// ── Tier divergence counter injection (#1132) ──────────────────────────────────
//
// The actual counter lives in src/services/tierDivergenceJob.ts to avoid a
// circular import chain (metrics ← tierDivergenceJob ← db ← metrics).
// The getter is registered at startup by src/index.ts via
// `setTierDivergenceGetter`; until then it defaults to () => 0 so the metric
// is always present in Prometheus output (just zero).

let _getTierDivergenceTotal: () => number = () => 0;

/** Register the live counter getter. Called once at startup by src/index.ts. */
export function setTierDivergenceGetter(fn: () => number): void {
  _getTierDivergenceTotal = fn;
}

function getTierDivergenceForMetrics(): number {
  return _getTierDivergenceTotal();
}

export interface RouteMetric {
  count: number;
  totalLatencyMs: number;
}

export type ErrorRange = '4xx' | '5xx';

/** In-memory metrics store. Replace with Prometheus or similar in production. */
export const metricsStore: Record<string, RouteMetric> = {};

/** Tracks http_errors_total counter, labelled by status code range (4xx / 5xx). */
export const errorCountsStore: Record<ErrorRange, number> = { '4xx': 0, '5xx': 0 };

/** Whether metrics collection is enabled. Controlled by METRICS_ENABLED env var. */
export function isMetricsEnabled(): boolean {
  return process.env.METRICS_ENABLED !== 'false';
}

/**
 * Express middleware that increments per-route request counts, accumulates latency,
 * and tracks http_errors_total for 4xx and 5xx responses.
 * Disabled when METRICS_ENABLED=false.
 *
 * Unmatched routes (no req.route set — 404s, bot scans, arbitrary paths) are
 * aggregated under a single UNMATCHED_ROUTE_LABEL rather than keyed by the raw
 * req.path string. Without this bucketing, every distinct URL probed by scanners
 * or typos would permanently occupy an entry in metricsStore, giving an attacker
 * trivial unbounded cardinality growth to degrade Prometheus scraping.
 */
export const UNMATCHED_ROUTE_LABEL = 'unmatched_route';

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isMetricsEnabled()) {
    next();
    return;
  }
  const start = Date.now();
  res.on('finish', () => {
    // Use the matched Express route pattern when available; fall back to a
    // single constant label for all unmatched requests so scanner/bot traffic
    // cannot grow metricsStore without bound.
    const routeLabel = req.route?.path ?? UNMATCHED_ROUTE_LABEL;
    const key = `${req.method} ${routeLabel}`;
    const latency = Date.now() - start;
    if (!metricsStore[key]) {
      metricsStore[key] = { count: 0, totalLatencyMs: 0 };
    }
    metricsStore[key].count += 1;
    metricsStore[key].totalLatencyMs += latency;
    observeLatency(latency);

    const status = res.statusCode;
    if (status >= 400 && status < 500) {
      errorCountsStore['4xx'] += 1;
    } else if (status >= 500) {
      errorCountsStore['5xx'] += 1;
    }
  });
  next();
}

/** Returns a snapshot of collected route metrics. */
export function getMetrics(): Record<string, RouteMetric> {
  return { ...metricsStore };
}

/** Returns a snapshot of http_errors_total counters. */
export function getErrorMetrics(): Record<ErrorRange, number> {
  return { ...errorCountsStore };
}

// ─── Request-duration histogram ────────────────────────────────────────────────

/** Upper bounds (inclusive) for the request-duration histogram, in milliseconds. */
export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

export interface LatencyHistogram {
  /** bucketCounts[i] = number of observations with latency <= LATENCY_BUCKETS_MS[i] (cumulative). */
  bucketCounts: number[];
  sum: number;
  count: number;
}

export const latencyHistogram: LatencyHistogram = {
  bucketCounts: LATENCY_BUCKETS_MS.map(() => 0),
  sum: 0,
  count: 0,
};

/** Records a single request latency into the cumulative histogram. */
function observeLatency(latencyMs: number): void {
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    if (latencyMs <= LATENCY_BUCKETS_MS[i]) latencyHistogram.bucketCounts[i] += 1;
  }
  latencyHistogram.sum += latencyMs;
  latencyHistogram.count += 1;
}

/** Returns a snapshot of the request-duration histogram. */
export function getLatencyHistogram(): LatencyHistogram {
  return {
    bucketCounts: [...latencyHistogram.bucketCounts],
    sum: latencyHistogram.sum,
    count: latencyHistogram.count,
  };
}

// ─── Seconds histogram buckets (0.01 / 0.05 / 0.1 / 0.5 / 1 / 5 seconds) ─────
//
// Used by ipfs_operation_duration_seconds, db_query_duration_seconds, and
// soroban_rpc_duration_seconds.  The set covers 10 ms, 50 ms, 100 ms, 500 ms,
// 1 s and 5 s as required by the acceptance criteria (IPFS must include 100 ms,
// 500 ms, 1 s, 5 s).
const SECONDS_HISTOGRAM_BUCKETS: ReadonlyArray<number> = [0.01, 0.05, 0.1, 0.5, 1, 5];

/** A labelled cumulative histogram with seconds buckets. */
interface LabelledHistogram {
  bucketCounts: Record<string, number[]>;
  sum: Record<string, number>;
  count: Record<string, number>;
}

function createLabelledHistogram(): LabelledHistogram {
  return { bucketCounts: {}, sum: {}, count: {} };
}

function observeLabelledSeconds(hist: LabelledHistogram, label: string, seconds: number): void {
  if (!hist.bucketCounts[label]) {
    hist.bucketCounts[label] = SECONDS_HISTOGRAM_BUCKETS.map(() => 0);
    hist.sum[label] = 0;
    hist.count[label] = 0;
  }
  for (let i = 0; i < SECONDS_HISTOGRAM_BUCKETS.length; i++) {
    if (seconds <= SECONDS_HISTOGRAM_BUCKETS[i]) hist.bucketCounts[label][i] += 1;
  }
  hist.sum[label] += seconds;
  hist.count[label] += 1;
}

// ─── IPFS latency histogram ───────────────────────────────────────────────────

const ipfsHistogram: LabelledHistogram = createLabelledHistogram();

export type IpfsOperation = 'pinJson' | 'pinFile' | 'checkHealth';

export function observeIpfsLatency(operation: IpfsOperation, durationMs: number): void {
  observeLabelledSeconds(ipfsHistogram, operation, durationMs / 1000);
}

// ─── DB query duration histogram ──────────────────────────────────────────────

const dbQueryHistogram: LabelledHistogram = createLabelledHistogram();

export function observeDbQueryDuration(queryName: string, durationMs: number): void {
  observeLabelledSeconds(dbQueryHistogram, queryName, durationMs / 1000);
}

// ─── Soroban RPC latency histogram ────────────────────────────────────────────

const sorobanRpcHistogram: LabelledHistogram = createLabelledHistogram();

export type SorobanRpcOperation =
  | 'getLatestLedger'
  | 'queryEvents'
  | 'getAccount'
  | 'simulateTransaction'
  | 'sendTransaction'
  | 'getTransaction'
  | 'isSubscribed'
  | 'submitContactPayment'
  | 'logTrialOffer'
  | 'withdrawFees'
  | 'purchaseSubscription'
  | 'renewSubscription'
  | 'cancelSubscriptionOnChain'
  | 'unpauseContractOnChain'
  | 'pauseContractOnChain'
  | 'registerValidatorOnChain'
  | 'revokeValidatorOnChain'
  | 'updateProfile'
  | 'getOnChainMilestones'
  | 'stellarHealth';

export function observeSorobanRpcLatency(operation: SorobanRpcOperation, durationMs: number): void {
  observeLabelledSeconds(sorobanRpcHistogram, operation, durationMs / 1000);
}

// ─── Webhook delivery counters ────────────────────────────────────────────────

export type WebhookDeliveryStatus = 'success' | 'failure' | 'dead_letter';

const webhookDeliveryStore: Record<WebhookDeliveryStatus, number> = {
  success: 0,
  failure: 0,
  dead_letter: 0,
};

export function recordWebhookDelivery(status: WebhookDeliveryStatus): void {
  webhookDeliveryStore[status] += 1;
}

export function getWebhookDeliveryMetrics(): Record<WebhookDeliveryStatus, number> {
  return { ...webhookDeliveryStore };
}

// ─── SSE active connections gauge ─────────────────────────────────────────────

/** In-memory gauge for currently open SSE connections. */
let sseConnectionsActive = 0;

export function setSseConnectionsActive(count: number): void {
  sseConnectionsActive = Math.max(0, count);
}

export function incrementSseConnections(): void {
  sseConnectionsActive += 1;
}

export function decrementSseConnections(): void {
  sseConnectionsActive = Math.max(0, sseConnectionsActive - 1);
}

// ─── Stuck pending pins gauge ─────────────────────────────────────────────────

/** In-memory gauge for currently stuck pending IPFS pins. */
let stuckPendingPinsCount = 0;

export function setStuckPendingPinsCount(count: number): void {
  stuckPendingPinsCount = Math.max(0, count);
}

export function getStuckPendingPinsCount(): number {
  return stuckPendingPinsCount;
}

// ─── Webhook dead-letter counters / gauges (#1131) ────────────────────────────
// Declared before resetMetrics so test isolation can clear them.

export interface WebhookCounters {
  deadLettersTotal: number;
  retrySuccessTotal: number;
}

export const webhookCountersStore: WebhookCounters = {
  deadLettersTotal: 0,
  retrySuccessTotal: 0,
};

/** Per-subscription gauge for current dead-letter queue depth. */
const webhookDeadLetterGaugeStore: Record<string, number> = {};

/** Timestamps of recent dead-letter inserts for rate-based alerting. */
const webhookDeadLetterInsertTimestamps: number[] = [];

/** Increment webhook_dead_letters_total counter (lifetime inserts). */
export function incrementWebhookDeadLettersTotal(): void {
  webhookCountersStore.deadLettersTotal += 1;
  webhookDeadLetterInsertTimestamps.push(Date.now());
  const cutoff = Date.now() - 60 * 60 * 1000;
  while (
    webhookDeadLetterInsertTimestamps.length > 0 &&
    webhookDeadLetterInsertTimestamps[0]! < cutoff
  ) {
    webhookDeadLetterInsertTimestamps.shift();
  }
}

/** Increment webhook_retry_success_total counter. */
export function incrementWebhookRetrySuccessTotal(): void {
  webhookCountersStore.retrySuccessTotal += 1;
}

/** Returns a snapshot of webhook counters. */
export function getWebhookCounters(): WebhookCounters {
  return { ...webhookCountersStore };
}

export function setWebhookDeadLetterGauge(
  entries: Array<{ subscriptionId: string; count: number }>,
): void {
  for (const key of Object.keys(webhookDeadLetterGaugeStore)) {
    delete webhookDeadLetterGaugeStore[key];
  }
  for (const entry of entries) {
    webhookDeadLetterGaugeStore[entry.subscriptionId] = entry.count;
  }
}

export function getWebhookDeadLetterGauge(): Record<string, number> {
  return { ...webhookDeadLetterGaugeStore };
}

export function getWebhookDeadLetterInsertTimestamps(): number[] {
  return [...webhookDeadLetterInsertTimestamps];
}

/** Test helper — clear insert-rate timestamps. */
export function resetWebhookDeadLetterInsertTimestamps(): void {
  webhookDeadLetterInsertTimestamps.length = 0;
}

/** Resets every metric store. Intended for test isolation. */
export function resetMetrics(): void {
  Object.keys(metricsStore).forEach((k) => delete metricsStore[k]);
  errorCountsStore['4xx'] = 0;
  errorCountsStore['5xx'] = 0;
  latencyHistogram.bucketCounts = LATENCY_BUCKETS_MS.map(() => 0);
  latencyHistogram.sum = 0;
  latencyHistogram.count = 0;
  cacheCountsStore.hits = 0;
  cacheCountsStore.misses = 0;
  cacheCountsStore.evictions = 0;
  cacheInvalidationStore.total = 0;
  stuckPendingPinsCount = 0;
  resetIpReputationCounters();
}

// ─── Cache hit / miss / eviction counters ─────────────────────────────────────

export interface CacheCounts {
  hits: number;
  misses: number;
  /** Incremented when a key is found but has already expired (lazy eviction). */
  evictions: number;
}

/** In-memory cache operation counters. */
export const cacheCountsStore: CacheCounts = { hits: 0, misses: 0, evictions: 0 };

/** Record a cache hit. */
export function recordCacheHit(): void {
  cacheCountsStore.hits += 1;
}

/** Record a cache miss (key was never set or has been invalidated). */
export function recordCacheMiss(): void {
  cacheCountsStore.misses += 1;
}

/**
 * Record a cache eviction — the key existed but was found to be expired at
 * read time (lazy expiry in InMemoryCacheStore; TTL handled by Redis itself,
 * so this is only incremented by the in-memory backend).
 */
export function recordCacheEviction(): void {
  cacheCountsStore.evictions += 1;
}

/** Returns a snapshot of the cache operation counters. */
export function getCacheMetrics(): CacheCounts {
  return { ...cacheCountsStore };
}

// ─── Cache invalidation counter ────────────────────────────────────────────────
//
// `cache_invalidation_total` counts every player-list cache invalidation
// performed by this process:
//   - one increment per `invalidatePlayerCache()` operation (local calls, e.g.
//     from the indexer after a player state change), and
//   - one increment per `invalidate:players` pub/sub message received from a
//     sibling instance that clears the local player-list cache.
//
// So across a multi-instance deployment each logical invalidation produces one
// increment on the originating instance and one on every instance that applies
// it locally — the metric reflects actual invalidation activity per process.

export interface CacheInvalidationCounts {
  total: number;
}

/** In-memory cache invalidation counter. */
export const cacheInvalidationStore: CacheInvalidationCounts = { total: 0 };

/** Record one player-list cache invalidation operation (local or received). */
export function recordCacheInvalidation(): void {
  cacheInvalidationStore.total += 1;
}

/** Returns the current cache invalidation counter. */
export function getCacheInvalidationTotal(): number {
  return cacheInvalidationStore.total;
}

// ─── Fee withdrawal DB-write failure counter ──────────────────────────────────

const feeWithdrawalDbWriteFailuresStore = { total: 0 };

/** Increment scout_off_fee_withdrawal_db_write_failures_total counter. */
export function incrementFeeWithdrawalDbWriteFailuresTotal(): void {
  feeWithdrawalDbWriteFailuresStore.total += 1;
}

/** Returns the current fee-withdrawal DB-write-failure counter. */
export function getFeeWithdrawalDbWriteFailuresTotal(): number {
  return feeWithdrawalDbWriteFailuresStore.total;
}

// ─── Prometheus exposition ──────────────────────────────────────────────────────

/** Content-Type for the Prometheus text exposition format (v0.0.4). */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Escapes a Prometheus label value (backslash, double-quote, newline). */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export interface SerializeMetricsExtras {
  /** Optional indexer_ledger_lag gauge value, injected by the caller. */
  indexerLedgerLag?: number;
  /** Optional sse_connections_active gauge value, injected by the caller. */
  sseConnectionsActive?: number;
  /** Optional stuck_pending_pins_count gauge value, injected by the caller. */
  stuckPendingPinsCount?: number;
}

/**
  * Serialises all collected metrics into Prometheus text exposition format.
  * Takes external gauges (e.g. indexer lag) as parameters so this stays free of
  * any dependency on the indexer or the rest of the app — it is pure and unit
  * testable on its own.
  */
export function serializeMetrics(extras: SerializeMetricsExtras = {}): string {
  const routes = getMetrics();
  const errors = getErrorMetrics();
  const hist = getLatencyHistogram();
  const cache = getCacheMetrics();
  const webhook = getWebhookCounters();
  const lines: string[] = [];

  // Request count (counter) — one series per route.
  lines.push('# HELP http_requests_total Total number of HTTP requests per route');
  lines.push('# TYPE http_requests_total counter');
  for (const [route, m] of Object.entries(routes)) {
    lines.push(`http_requests_total{route="${escapeLabelValue(route)}"} ${m.count}`);
  }

  // Request duration (histogram) — cumulative buckets plus _sum and _count.
  lines.push('# HELP http_request_duration_ms Request latency in milliseconds');
  lines.push('# TYPE http_request_duration_ms histogram');
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    lines.push(`http_request_duration_ms_bucket{le="${LATENCY_BUCKETS_MS[i]}"} ${hist.bucketCounts[i]}`);
  }
  lines.push(`http_request_duration_ms_bucket{le="+Inf"} ${hist.count}`);
  lines.push(`http_request_duration_ms_sum ${hist.sum}`);
  lines.push(`http_request_duration_ms_count ${hist.count}`);

  // Error rate (counter) — labelled by status class.
  lines.push('# HELP http_errors_total Total number of HTTP error responses by status class');
  lines.push('# TYPE http_errors_total counter');
  lines.push(`http_errors_total{range="4xx"} ${errors['4xx']}`);
  lines.push(`http_errors_total{range="5xx"} ${errors['5xx']}`);

  // Cache hit/miss/eviction counters.
  lines.push('# HELP cache_hits_total Total number of cache hits');
  lines.push('# TYPE cache_hits_total counter');
  lines.push(`cache_hits_total ${cache.hits}`);
  lines.push('# HELP cache_misses_total Total number of cache misses');
  lines.push('# TYPE cache_misses_total counter');
  lines.push(`cache_misses_total ${cache.misses}`);
  lines.push('# HELP cache_evictions_total Total number of lazy cache evictions (expired key reads)');
  lines.push('# TYPE cache_evictions_total counter');
  lines.push(`cache_evictions_total ${cache.evictions}`);

  // Cache invalidation counter.
  lines.push('# HELP cache_invalidation_total Total number of player-list cache invalidations performed (local operations and received invalidate:players messages)');
  lines.push('# TYPE cache_invalidation_total counter');
  lines.push(`cache_invalidation_total ${cacheInvalidationStore.total}`);

  // IPFS operation duration histogram.
  lines.push('# HELP ipfs_operation_duration_seconds IPFS operation latency in seconds');
  lines.push('# TYPE ipfs_operation_duration_seconds histogram');
  for (const [operation, counts] of Object.entries(ipfsHistogram.bucketCounts)) {
    for (let i = 0; i < SECONDS_HISTOGRAM_BUCKETS.length; i++) {
      lines.push(`ipfs_operation_duration_seconds_bucket{operation="${escapeLabelValue(operation)}",le="${SECONDS_HISTOGRAM_BUCKETS[i]}"} ${counts[i]}`);
    }
    lines.push(`ipfs_operation_duration_seconds_bucket{operation="${escapeLabelValue(operation)}",le="+Inf"} ${ipfsHistogram.count[operation]}`);
    lines.push(`ipfs_operation_duration_seconds_sum{operation="${escapeLabelValue(operation)}"} ${ipfsHistogram.sum[operation]}`);
    lines.push(`ipfs_operation_duration_seconds_count{operation="${escapeLabelValue(operation)}"} ${ipfsHistogram.count[operation]}`);
  }

  // DB query duration histogram.
  lines.push('# HELP db_query_duration_seconds Database query latency in seconds');
  lines.push('# TYPE db_query_duration_seconds histogram');
  for (const [queryName, counts] of Object.entries(dbQueryHistogram.bucketCounts)) {
    for (let i = 0; i < SECONDS_HISTOGRAM_BUCKETS.length; i++) {
      lines.push(`db_query_duration_seconds_bucket{query_name="${escapeLabelValue(queryName)}",le="${SECONDS_HISTOGRAM_BUCKETS[i]}"} ${counts[i]}`);
    }
    lines.push(`db_query_duration_seconds_bucket{query_name="${escapeLabelValue(queryName)}",le="+Inf"} ${dbQueryHistogram.count[queryName]}`);
    lines.push(`db_query_duration_seconds_sum{query_name="${escapeLabelValue(queryName)}"} ${dbQueryHistogram.sum[queryName]}`);
    lines.push(`db_query_duration_seconds_count{query_name="${escapeLabelValue(queryName)}"} ${dbQueryHistogram.count[queryName]}`);
  }

  // Soroban RPC latency histogram.
  lines.push('# HELP soroban_rpc_duration_seconds Soroban RPC operation latency in seconds');
  lines.push('# TYPE soroban_rpc_duration_seconds histogram');
  for (const [operation, counts] of Object.entries(sorobanRpcHistogram.bucketCounts)) {
    for (let i = 0; i < SECONDS_HISTOGRAM_BUCKETS.length; i++) {
      lines.push(`soroban_rpc_duration_seconds_bucket{operation="${escapeLabelValue(operation)}",le="${SECONDS_HISTOGRAM_BUCKETS[i]}"} ${counts[i]}`);
    }
    lines.push(`soroban_rpc_duration_seconds_bucket{operation="${escapeLabelValue(operation)}",le="+Inf"} ${sorobanRpcHistogram.count[operation]}`);
    lines.push(`soroban_rpc_duration_seconds_sum{operation="${escapeLabelValue(operation)}"} ${sorobanRpcHistogram.sum[operation]}`);
    lines.push(`soroban_rpc_duration_seconds_count{operation="${escapeLabelValue(operation)}"} ${sorobanRpcHistogram.count[operation]}`);
  }

  // Webhook delivery counters.
  const webhookDelivery = getWebhookDeliveryMetrics();
  lines.push('# HELP webhook_delivery_total Total number of webhook deliveries by status');
  lines.push('# TYPE webhook_delivery_total counter');
  lines.push(`webhook_delivery_total{status="success"} ${webhookDelivery.success}`);
  lines.push(`webhook_delivery_total{status="failure"} ${webhookDelivery.failure}`);
  lines.push(`webhook_delivery_total{status="dead_letter"} ${webhookDelivery.dead_letter}`);

  // SSE active connections gauge.
  if (extras.sseConnectionsActive !== undefined) {
    lines.push('# HELP sse_connections_active Current number of open SSE connections');
    lines.push('# TYPE sse_connections_active gauge');
    lines.push(`sse_connections_active ${extras.sseConnectionsActive}`);
  }

  // Indexer lag (gauge) — optional, injected by the caller.
  if (extras.indexerLedgerLag !== undefined) {
    lines.push('# HELP indexer_ledger_lag Ledgers behind the chain tip after the last poll');
    lines.push('# TYPE indexer_ledger_lag gauge');
    lines.push(`indexer_ledger_lag ${extras.indexerLedgerLag}`);
  }

  // Stuck pending IPFS pins gauge.
  const stuckPins = extras.stuckPendingPinsCount !== undefined ? extras.stuckPendingPinsCount : getStuckPendingPinsCount();
  lines.push('# HELP stuck_pending_pins_count Current number of stuck pending IPFS pins');
  lines.push('# TYPE stuck_pending_pins_count gauge');
  lines.push(`stuck_pending_pins_count ${stuckPins}`);

  // Dead-letter queue depth gauge (#1131) — broken down per subscription.
  lines.push('# HELP scout_off_webhook_dead_letters_total Current webhook dead-letter queue depth by subscription');
  lines.push('# TYPE scout_off_webhook_dead_letters_total gauge');
  const dlGauge = getWebhookDeadLetterGauge();
  for (const [subscriptionId, count] of Object.entries(dlGauge)) {
    lines.push(
      `scout_off_webhook_dead_letters_total{subscription_id="${escapeLabelValue(subscriptionId)}"} ${count}`,
    );
  }
  // Always emit a lifetime insert counter for dashboards that prefer counters.
  lines.push('# HELP scout_off_webhook_dead_letters_inserted_total Lifetime webhook dead-letter inserts');
  lines.push('# TYPE scout_off_webhook_dead_letters_inserted_total counter');
  lines.push(`scout_off_webhook_dead_letters_inserted_total ${webhook.deadLettersTotal}`);
  lines.push('# HELP scout_off_webhook_retry_success_total Successful dead-letter auto-retries');
  lines.push('# TYPE scout_off_webhook_retry_success_total counter');
  lines.push(`scout_off_webhook_retry_success_total ${webhook.retrySuccessTotal}`);

  // IP reputation counters.
  lines.push('# HELP ip_reputation_blocked_total Total number of requests blocked by IP reputation scoring');
  lines.push('# TYPE ip_reputation_blocked_total counter');
  lines.push(`ip_reputation_blocked_total ${ipReputationCounters.blocked}`);
  lines.push('# HELP ip_reputation_penalised_total Total number of requests that received a reputation penalty (delay or rate restriction)');
  lines.push('# TYPE ip_reputation_penalised_total counter');
  lines.push(`ip_reputation_penalised_total ${ipReputationCounters.penalised}`);

  // Tier divergence counter (#1132) — counts mismatches between derived off-chain
  // tier and the stored progress_level detected by the reconciliation job.
  // A sustained non-zero value indicates the indexer has missed milestone_approved
  // events; run a reindex to resolve (see docs/runbook.md).
  lines.push('# HELP scout_off_tier_divergence_total Total number of player tier divergence events detected since process start');
  lines.push('# TYPE scout_off_tier_divergence_total counter');
  lines.push(`scout_off_tier_divergence_total ${getTierDivergenceForMetrics()}`);

  return lines.join('\n') + '\n';
}

/**
  * Builds the GET /metrics Express handler. The indexer-lag getter is injected so
  * this module never imports the indexer.
  */
export function createMetricsHandler(
  getIndexerLedgerLag: () => number = () => 0,
  getSseConnectionsActive: () => number = () => 0,
  getStuckPinsCount: () => number = () => getStuckPendingPinsCount(),
) {
  return (_req: Request, res: Response): void => {
    res.set('Content-Type', PROMETHEUS_CONTENT_TYPE);
    res.send(serializeMetrics({
      indexerLedgerLag: getIndexerLedgerLag(),
      sseConnectionsActive: getSseConnectionsActive(),
      stuckPendingPinsCount: getStuckPinsCount(),
    }));
  };
}
