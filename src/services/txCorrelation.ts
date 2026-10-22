/**
 * Cross-boundary trace correlation (#1113).
 *
 * Lifecycle:
 *   1. HTTP middleware sets correlationId in AsyncLocalStorage.
 *   2. On Soroban submit we stamp a short memo (≤28 bytes, no PII) and persist
 *      (tx_hash → correlation_id) in tx_correlations.
 *   3. The indexer looks up the correlation by tx_hash, re-enters
 *      requestContext, and links OTEL spans for poll → side-effects → webhooks.
 *   4. Webhook/SSE fan-out inherits the restored ALS context (and may echo the
 *      id in the delivery payload).
 *
 * Older transactions without a row degrade gracefully: indexing proceeds with
 * no correlation context and no span link.
 */

import { context, propagation, trace, SpanKind, isSpanContextValid, ROOT_CONTEXT, type Attributes, type Span, type Link, type SpanContext } from '@opentelemetry/api';
import { injectTraceHeaders, extractTraceContext } from '../utils/traceContext';
import { Memo } from '@stellar/stellar-sdk';
import { getDriver } from '../db';
import { getCorrelationId, requestContext } from '../utils/requestContext';
import { logger } from '../utils/logger';

const tracer = trace.getTracer('scout-off-backend');

/** Stellar text memos are capped at 28 bytes. */
export const CORRELATION_MEMO_MAX_BYTES = 28;

/** Prefix used so operators can recognise correlation memos on explorers. */
export const CORRELATION_MEMO_PREFIX = 'c:';

/**
 * Truncate a correlation id into a memo-safe, non-PII nonce.
 * Full id remains in tx_correlations for indexer lookup.
 */
export function toCorrelationMemoText(correlationId: string): string {
  const budget = CORRELATION_MEMO_MAX_BYTES - CORRELATION_MEMO_PREFIX.length;
  const body = correlationId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, budget);
  return `${CORRELATION_MEMO_PREFIX}${body}`;
}

/** Build a Stellar text memo from the current ALS correlation id, or null. */
export function correlationMemoFromContext(): ReturnType<typeof Memo.text> | null {
  const cid = getCorrelationId();
  if (!cid) return null;
  return Memo.text(toCorrelationMemoText(cid));
}

/** Persist request correlation and valid W3C context independently. */
export async function recordTxCorrelation(txHash: string, correlationId?: string): Promise<void> {
  const cid = correlationId ?? getCorrelationId();
  await recordTxTraceContext(txHash);
  if (!cid || !txHash) return;
  try {
    await getDriver().run(
      `INSERT INTO tx_correlations (tx_hash, correlation_id, created_at)
       VALUES (?, ?, ?) ON CONFLICT(tx_hash) DO NOTHING`, [txHash, cid, Date.now()],
    );
  } catch (err) {
    // Table may not exist yet in very old test DBs; never fail submission.
    logger.warn(
      `[correlation] failed to record tx_hash=${txHash}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Store sampled and unsampled contexts alike; never persist baggage or secrets. */
async function recordTxTraceContext(txHash: string): Promise<void> {
  const active = trace.getSpanContext(context.active());
  if (!txHash || !active || !isSpanContextValid(active)) return;
  const headers = injectTraceHeaders();
  if (!headers.traceparent) return;
  try {
    await getDriver().run(
      `INSERT INTO tx_trace_context (tx_hash, traceparent, tracestate, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(tx_hash) DO NOTHING`,
      [txHash, headers.traceparent, headers.tracestate ?? null, Date.now()],
    );
  } catch (err) {
    logger.warn('[correlation] failed to store transaction trace context:', err);
  }
}

export async function lookupTxSpanContext(txHash: string): Promise<SpanContext | undefined> {
  // The no-op global propagator exposes no fields. With no SDK/exporter this
  // avoids an additional DB read per event; explicit test providers still work.
  if (!propagation.fields().includes('traceparent')) return undefined;
  try {
    const row = await getDriver().get<{ traceparent: string; tracestate: string | null }>(
      'SELECT traceparent, tracestate FROM tx_trace_context WHERE tx_hash = ?',
      [txHash],
    );
    return row ? extractTraceContext({
      traceparent: row.traceparent, ...(row.tracestate ? { tracestate: row.tracestate } : {}),
    }) : undefined;
  } catch {
    return undefined;
  }
}

/** Look up a previously recorded correlation id for a transaction. */
export async function lookupTxCorrelation(txHash: string): Promise<string | undefined> {
  try {
    const row = await getDriver().get<{ correlation_id: string }>(
      'SELECT correlation_id FROM tx_correlations WHERE tx_hash = ?', [txHash],
    );
    return row?.correlation_id;
  } catch {
    return undefined;
  }
}

/**
 * Re-establish request context for an indexed event and run `fn` inside it.
 * Links delayed work to the stored origin, independently of the log correlation
 * id. Without a correlation id, `fn` still runs under the event span.
 */
export async function withRestoredCorrelation<T>(
  txHash: string,
  spanName: string,
  fn: (correlationId: string | undefined) => Promise<T> | T,
  parentSpan?: Span,
  attributes: Attributes = {},
): Promise<T> {
  const [correlationId, origin] = await Promise.all([
    lookupTxCorrelation(txHash), lookupTxSpanContext(txHash),
  ]);

  const links: Link[] = [];
  if (origin) links.push({ context: origin });
  if (parentSpan) {
    links.push({ context: parentSpan.spanContext() });
  }

  const span = tracer.startSpan(
    spanName,
    {
      kind: SpanKind.CONSUMER,
      links,
      attributes: {
        'scout.tx_hash': txHash,
        'stellar.tx_hash': txHash,
        ...attributes,
        ...(correlationId ? { 'scout.correlation_id': correlationId } : {}),
      },
    },
    // The originating sampling decision crosses the delayed chain boundary.
    origin ? trace.setSpanContext(ROOT_CONTEXT, origin) : context.active(),
  );

  const run = async (): Promise<T> => {
    try {
      return await context.with(trace.setSpan(context.active(), span), async () => fn(correlationId));
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  };

  if (!correlationId) {
    return run();
  }

  return requestContext.run({ correlationId }, run);
}

/** Drop correlation rows older than `maxAgeMs` (housekeeping). */
export async function purgeOldTxCorrelations(maxAgeMs: number): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  try {
    const info = await getDriver().run('DELETE FROM tx_correlations WHERE created_at < ?', [cutoff]);
    await getDriver().run('DELETE FROM tx_trace_context WHERE created_at < ?', [cutoff]);
    return info.changes;
  } catch {
    return 0;
  }
}
