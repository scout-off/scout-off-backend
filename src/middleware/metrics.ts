import { Request, Response, NextFunction } from 'express';
import { retentionMetrics } from '../services/retentionMetrics';
import { ipReputationCounters, resetIpReputationCounters } from '../services/ipReputation';
import { performance } from 'perf_hooks';

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

// ── Audit chain verification (#1539) ─────────────────────────────────────────
//
// Kept here (rather than in the verifier service) so the values survive
// between scheduled runs and are available even before the first run. The
// gauge starts at 1 because no break has been observed yet; a failed run sets
// it to 0 until a later run verifies cleanly again.

let _auditChainValid = 1;
let _auditChainBreaksTotal = 0;

/** Records the outcome of the most recent audit chain verification run. */
export function setAuditChainValid(valid: boolean): void {
  _auditChainValid = valid ? 1 : 0;
}

/** Increments `scout_off_audit_chain_breaks_total` and invalidates the gauge. */
export function recordAuditChainBreak(): void {
  _auditChainBreaksTotal += 1;
  _auditChainValid = 0;
}

/** Resets both audit chain metrics (used in tests). */
export function resetAuditChainMetrics(): void {
  _auditChainValid = 1;
  _auditChainBreaksTotal = 0;
}

export function getAuditChainValid(): number {
  return _auditChainValid;
}

export function getAuditChainBreaksTotal(): number {
  return _auditChainBreaksTotal;
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

/** Whether legacy http_request_duration_ms metric is exported. Default true for one release. */
export function isLegacyMsMetricEnabled(): boolean {
  return process.env.METRICS_LEGACY_MS !== 'false';
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
    observeHttpLatencySeconds(latency / 1000);

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

// ─── Seconds histogram buckets for HTTP requests (0.005 to 10s) ───────────────
//
// Standard Prometheus histogram for HTTP latency uses seconds with buckets
// suited to API latency: 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s
export const HTTP_SECONDS_BUCKETS: ReadonlyArray<number> = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface HttpSecondsHistogram {
  bucketCounts: number[];
  sum: number;
  count: number;
}

export const httpSecondsHistogram: HttpSecondsHistogram = {
  bucketCounts: HTTP_SECONDS_BUCKETS.map(() => 0),
  sum: 0,
  count: 0,
};

/** Records a single request latency in seconds into the cumulative histogram. */
function observeHttpLatencySeconds(latencySeconds: number): void {
  for (let i = 0; i < HTTP_SECONDS_BUCKETS.length; i++) {
    if (latencySeconds <= HTTP_SECONDS_BUCKETS[i]) httpSecondsHistogram.bucketCounts[i] += 1;
  }
  httpSecondsHistogram.sum += latencySeconds;
  httpSecondsHistogram.count += 1;
}

/** Returns a snapshot of the HTTP seconds histogram. */
export function getHttpSecondsHistogram(): HttpSecondsHistogram {
  return {
    bucketCounts: [...httpSecondsHistogram.bucketCounts],
    sum: httpSecondsHistogram.sum,
    count: httpSecondsHistogram.count,
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

// ─── Indexer event outcome counters (#1540) ─────────────────────────────────

/**
 * Classification of how the indexer handled a single contract event.
 *  - `applied`       — recognised event type, side effects ran (or no-op).
 *  - `unknown_type`  — topic did not match any known `CONTRACT_EVENT_TYPES` entry.
 *  - `decode_error`  — normalisation/decoding threw (unexpected value shape).
 */
export type IndexerEventOutcome = 'applied' | 'unknown_type' | 'decode_error';

/** Nested store: `type` → `outcome` → count. */
const indexerEventsStore: Record<string, Record<IndexerEventOutcome, number>> = {};

function blankOutcomes(): Record<IndexerEventOutcome, number> {
  return { applied: 0, unknown_type: 0, decode_error: 0 };
}

/** Increment `scout_off_indexer_events_total{type,outcome}` by one. */
export function recordIndexerEvent(type: string, outcome: IndexerEventOutcome): void {
  if (!indexerEventsStore[type]) indexerEventsStore[type] = blankOutcomes();
  indexerEventsStore[type][outcome] += 1;
}

/** Snapshot of the nested indexer event counters. */
export function getIndexerEventMetrics(): Record<string, Record<IndexerEventOutcome, number>> {
  const out: Record<string, Record<IndexerEventOutcome, number>> = {};
  for (const [type, outcomes] of Object.entries(indexerEventsStore)) {
    out[type] = { ...outcomes };
  }
  return out;
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

// ─── Evidence download rejections (#1331) ─────────────────────────────────────

const evidenceRejectionStore: Record<string, number> = {};

export function recordEvidenceRejection(reason: string): void {
  evidenceRejectionStore[reason] = (evidenceRejectionStore[reason] ?? 0) + 1;
}

export function getEvidenceRejectionMetrics(): Record<string, number> {
  return { ...evidenceRejectionStore };
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
  httpSecondsHistogram.bucketCounts = HTTP_SECONDS_BUCKETS.map(() => 0);
  httpSecondsHistogram.sum = 0;
  httpSecondsHistogram.count = 0;
  cacheCountsStore.hits = 0;
  cacheCountsStore.misses = 0;
  cacheCountsStore.evictions = 0;
  cacheInvalidationStore.total = 0;
  stuckPendingPinsCount = 0;
  for (const key of Object.keys(indexerEventsStore)) {
    delete indexerEventsStore[key];
  }
  unhandledRejectionsTotal = 0;
  Object.keys(rateLimitRejectedStore).forEach((k) => delete rateLimitRejectedStore[k]);
  rateLimitStoreErrorsTotal = 0;
  Object.keys(authFailuresStore).forEach((k) => delete authFailuresStore[k]);
  resetIpReputationCounters();
  resetRuntimeMetrics();
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

// ─── Unhandled promise-rejection counter (#1570) ──────────────────────────────

let unhandledRejectionsTotal = 0;

/** Increment the unhandled-rejection counter. Called from src/index.ts. */
export function incUnhandledRejections(): void {
  unhandledRejectionsTotal++;
}

// ─── Rate-limit rejection counter (#1571) ─────────────────────────────────────

/** Per-limiter rejection counts keyed by limiter namespace. */
const rateLimitRejectedStore: Record<string, number> = {};

/** Global counter for rate-limit store errors (fail-open path). */
let rateLimitStoreErrorsTotal = 0;

/**
 * Increment the rate-limit rejection counter for the given limiter namespace.
 * Namespace is a fixed string, so label cardinality is bounded.
 */
export function incRateLimitRejected(namespace: string): void {
  rateLimitRejectedStore[namespace] = (rateLimitRejectedStore[namespace] ?? 0) + 1;
}

/** Increment the rate-limit store-error counter (fail-open path). */
export function incRateLimitStoreError(): void {
  rateLimitStoreErrorsTotal++;
}

// ─── Authentication-failure counter (#1572) ───────────────────────────────────

/** Fixed set of valid auth-failure reason labels (bounded cardinality). */
export const AUTH_FAILURE_REASONS = [
  'missing_token',
  'invalid_token',
  'expired_token',
  'revoked_token',
  'forbidden_role',
  'invalid_api_key',
  'forbidden_scope',
  'sep10_invalid',
] as const;

export type AuthFailureReason = (typeof AUTH_FAILURE_REASONS)[number];

const authFailuresStore: Record<string, number> = {};

/**
 * Increment the auth-failure counter for the given reason.
 * Unknown reasons are mapped to `other` to keep cardinality bounded.
 */
export function incAuthFailure(reason: string): void {
  const validReason = (AUTH_FAILURE_REASONS as readonly string[]).includes(reason)
    ? reason
    : 'other';
  authFailuresStore[validReason] = (authFailuresStore[validReason] ?? 0) + 1;
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

// ─── Runtime metrics (process CPU, RSS, heap, event-loop lag, GC, handles) ────

/**
 * Event-loop lag monitor. Uses perf_hooks.monitorEventLoopDelay to measure
 * how long the event loop is blocked. Started at module load if metrics enabled.
 */
let eventLoopDelayMonitor: performance.EventLoopDelayMonitor | null = null;

/** Initialize event-loop lag monitoring. Called at startup. */
export function initEventLoopMonitoring(): void {
  if (!isMetricsEnabled()) return;
  try {
    eventLoopDelayMonitor = new performance.EventLoopDelayMonitor({
      resolution: 10, // 10ms resolution
    });
    eventLoopDelayMonitor.enable();
  } catch (err) {
    // monitorEventLoopDelayMonitor may not be available in all Node versions
    console.warn('[metrics] Failed to initialize event-loop monitoring:', err);
  }
}

/** Get current event-loop lag in seconds (95th percentile over the sampling window). */
export function getEventLoopLagSeconds(): number {
  if (!eventLoopDelayMonitor) return 0;
  const delays = eventLoopDelayMonitor;
  if (delays.length === 0) return 0;
  // Calculate 95th percentile
  const sorted = Array.from(delays).sort((a, b) => a - b);
  const p95Index = Math.floor(sorted.length * 0.95);
  return sorted[p95Index]! / 1000; // Convert to seconds
}

/** GC duration histogram buckets (in seconds). */
export const GC_DURATION_BUCKETS: ReadonlyArray<number> = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1];

interface GcHistogram {
  bucketCounts: number[];
  sum: number;
  count: number;
}

const gcHistogram: GcHistogram = {
  bucketCounts: GC_DURATION_BUCKETS.map(() => 0),
  sum: 0,
  count: 0,
};

/** GC performance observer. Initialized at startup if metrics enabled. */
let gcObserver: PerformanceObserver | null = null;

/** Initialize GC performance observer. Called at startup. */
export function initGcMonitoring(): void {
  if (!isMetricsEnabled()) return;
  try {
    gcObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      for (const entry of entries) {
        if (entry.name === 'gc') {
          const duration = entry.duration / 1000; // Convert to seconds
          for (let i = 0; i < GC_DURATION_BUCKETS.length; i++) {
            if (duration <= GC_DURATION_BUCKETS[i]) gcHistogram.bucketCounts[i] += 1;
          }
          gcHistogram.sum += duration;
          gcHistogram.count += 1;
        }
      }
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch (err) {
    // GC observation may not be available in all Node versions
    console.warn('[metrics] Failed to initialize GC monitoring:', err);
  }
}

/** Get GC histogram snapshot. */
export function getGcHistogram(): GcHistogram {
  return {
    bucketCounts: [...gcHistogram.bucketCounts],
    sum: gcHistogram.sum,
    count: gcHistogram.count,
  };
}

/** Get process CPU seconds total (user + system). */
export function getProcessCpuSecondsTotal(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1e6; // Convert microseconds to seconds
}

/** Get process resident memory in bytes. */
export function getProcessResidentMemoryBytes(): number {
  return process.memoryUsage().rss;
}

/** Get Node.js heap size used in bytes. */
export function getHeapSizeUsedBytes(): number {
  return process.memoryUsage().heapUsed;
}

/** Get Node.js heap size total in bytes. */
export function getHeapSizeTotalBytes(): number {
  return process.memoryUsage().heapTotal;
}

/** Get active handles count. */
export function getActiveHandles(): number {
  // process._getActiveHandles() is undocumented but widely used for monitoring
  // @ts-expect-error - accessing undocumented Node API
  return process._getActiveHandles?.()?.length ?? 0;
}

/** Reset runtime metrics (for test isolation). */
export function resetRuntimeMetrics(): void {
  gcHistogram.bucketCounts = GC_DURATION_BUCKETS.map(() => 0);
  gcHistogram.sum = 0;
  gcHistogram.count = 0;
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
  const httpSecondsHist = getHttpSecondsHistogram();
  const cache = getCacheMetrics();
  const webhook = getWebhookCounters();
  const gcHist = getGcHistogram();
  const lines: string[] = [];

  // Request count (counter) — one series per route.
  lines.push('# HELP http_requests_total Total number of HTTP requests per route');
  lines.push('# TYPE http_requests_total counter');
  for (const [route, m] of Object.entries(routes)) {
    lines.push(`http_requests_total{route="${escapeLabelValue(route)}"} ${m.count}`);
  }

  // Request duration (histogram) — cumulative buckets plus _sum and _count.
  // NEW: http_request_duration_seconds (standard Prometheus metric)
  lines.push('# HELP http_request_duration_seconds HTTP request latency in seconds');
  lines.push('# TYPE http_request_duration_seconds histogram');
  for (let i = 0; i < HTTP_SECONDS_BUCKETS.length; i++) {
    lines.push(`http_request_duration_seconds_bucket{le="${HTTP_SECONDS_BUCKETS[i]}"} ${httpSecondsHist.bucketCounts[i]}`);
  }
  lines.push(`http_request_duration_seconds_bucket{le="+Inf"} ${httpSecondsHist.count}`);
  lines.push(`http_request_duration_seconds_sum ${httpSecondsHist.sum}`);
  lines.push(`http_request_duration_seconds_count ${httpSecondsHist.count}`);

  // LEGACY: http_request_duration_ms (deprecated, will be removed in next release)
  if (isLegacyMsMetricEnabled()) {
    lines.push('# HELP http_request_duration_ms HTTP request latency in milliseconds (DEPRECATED: use http_request_duration_seconds)');
    lines.push('# TYPE http_request_duration_ms histogram');
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      lines.push(`http_request_duration_ms_bucket{le="${LATENCY_BUCKETS_MS[i]}"} ${hist.bucketCounts[i]}`);
    }
    lines.push(`http_request_duration_ms_bucket{le="+Inf"} ${hist.count}`);
    lines.push(`http_request_duration_ms_sum ${hist.sum}`);
    lines.push(`http_request_duration_ms_count ${hist.count}`);
  }

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

  lines.push('# HELP evidence_download_rejected_total Evidence downloads rejected, by reason');
  lines.push('# TYPE evidence_download_rejected_total counter');
  for (const [reason, count] of Object.entries(getEvidenceRejectionMetrics())) {
    lines.push(`evidence_download_rejected_total{reason="${reason}"} ${count}`);
  }

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

  lines.push(...retentionMetrics());
  // ─── Runtime metrics (process CPU, RSS, heap, event-loop lag, GC, handles) ────
  lines.push('# HELP process_cpu_seconds_total Total user and system CPU time spent in seconds');
  lines.push('# TYPE process_cpu_seconds_total counter');
  lines.push(`process_cpu_seconds_total ${getProcessCpuSecondsTotal()}`);

  lines.push('# HELP process_resident_memory_bytes Resident memory size in bytes');
  lines.push('# TYPE process_resident_memory_bytes gauge');
  lines.push(`process_resident_memory_bytes ${getProcessResidentMemoryBytes()}`);

  lines.push('# HELP nodejs_heap_size_used_bytes Process heap size used in bytes');
  lines.push('# TYPE nodejs_heap_size_used_bytes gauge');
  lines.push(`nodejs_heap_size_used_bytes ${getHeapSizeUsedBytes()}`);

  lines.push('# HELP nodejs_heap_size_total_bytes Total heap size in bytes');
  lines.push('# TYPE nodejs_heap_size_total_bytes gauge');
  lines.push(`nodejs_heap_size_total_bytes ${getHeapSizeTotalBytes()}`);

  lines.push('# HELP nodejs_eventloop_lag_seconds Event-loop lag in seconds (95th percentile)');
  lines.push('# TYPE nodejs_eventloop_lag_seconds gauge');
  lines.push(`nodejs_eventloop_lag_seconds ${getEventLoopLagSeconds()}`);

  lines.push('# HELP nodejs_gc_duration_seconds Garbage collection duration in seconds');
  lines.push('# TYPE nodejs_gc_duration_seconds histogram');
  for (let i = 0; i < GC_DURATION_BUCKETS.length; i++) {
    lines.push(`nodejs_gc_duration_seconds_bucket{le="${GC_DURATION_BUCKETS[i]}"} ${gcHist.bucketCounts[i]}`);
  }
  lines.push(`nodejs_gc_duration_seconds_bucket{le="+Inf"} ${gcHist.count}`);
  lines.push(`nodejs_gc_duration_seconds_sum ${gcHist.sum}`);
  lines.push(`nodejs_gc_duration_seconds_count ${gcHist.count}`);

  lines.push('# HELP nodejs_active_handles_total Number of active libuv handles');
  lines.push('# TYPE nodejs_active_handles_total gauge');
  lines.push(`nodejs_active_handles_total ${getActiveHandles()}`);
  // Indexer event outcomes (#1540) — labelled by event type and outcome.
  // A sustained non-zero `unknown_type`/`decode_error` rate means a contract
  // upgrade renamed or reshaped an event; those rows are parked in
  // `indexer_unprocessed_events` for replay (see docs/indexer.md).
  lines.push('# HELP scout_off_indexer_events_total Total number of contract events seen by the indexer, by type and outcome');
  lines.push('# TYPE scout_off_indexer_events_total counter');
  for (const [type, outcomes] of Object.entries(getIndexerEventMetrics())) {
    for (const [outcome, count] of Object.entries(outcomes)) {
      lines.push(
        `scout_off_indexer_events_total{type="${escapeLabelValue(type)}",outcome="${escapeLabelValue(outcome)}"} ${count}`,
      );
    }
  }

  // Audit chain verification (#1539). `scout_off_audit_chain_valid` is 1 when
  // the most recent scheduled verification passed, 0 after a break is found.
  lines.push('# HELP scout_off_audit_chain_valid Whether the last audit-log hash-chain verification passed (1) or found a break (0)');
  lines.push('# TYPE scout_off_audit_chain_valid gauge');
  lines.push(`scout_off_audit_chain_valid ${getAuditChainValid()}`);
  lines.push('# HELP scout_off_audit_chain_breaks_total Total number of audit-log hash-chain breaks detected since process start');
  lines.push('# TYPE scout_off_audit_chain_breaks_total counter');
  lines.push(`scout_off_audit_chain_breaks_total ${getAuditChainBreaksTotal()}`);
  // Unhandled promise-rejection counter (#1570).
  lines.push('# HELP scout_off_unhandled_rejections_total Total number of unhandled promise rejections since process start');
  lines.push('# TYPE scout_off_unhandled_rejections_total counter');
  lines.push(`scout_off_unhandled_rejections_total ${unhandledRejectionsTotal}`);

  // Rate-limit rejection counter (#1571).
  lines.push('# HELP scout_off_rate_limit_rejected_total Total rate-limited (429) requests by limiter namespace');
  lines.push('# TYPE scout_off_rate_limit_rejected_total counter');
  for (const [limiter, count] of Object.entries(rateLimitRejectedStore)) {
    lines.push(`scout_off_rate_limit_rejected_total{limiter="${escapeLabelValue(limiter)}"} ${count}`);
  }
  lines.push('# HELP scout_off_rate_limit_store_errors_total Total rate-limit store errors (fail-open path)');
  lines.push('# TYPE scout_off_rate_limit_store_errors_total counter');
  lines.push(`scout_off_rate_limit_store_errors_total ${rateLimitStoreErrorsTotal}`);

  // Authentication-failure counter (#1572).
  lines.push('# HELP scout_off_auth_failures_total Total authentication failures by reason');
  lines.push('# TYPE scout_off_auth_failures_total counter');
  for (const [reason, count] of Object.entries(authFailuresStore)) {
    lines.push(`scout_off_auth_failures_total{reason="${escapeLabelValue(reason)}"} ${count}`);
  }

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
