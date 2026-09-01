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

import { context, trace, SpanKind, type Span, type Link } from '@opentelemetry/api';
import { Memo } from '@stellar/stellar-sdk';
import { getDb } from '../db';
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

/** Persist tx_hash → correlation_id. No-op when no ALS correlation is active. */
export function recordTxCorrelation(txHash: string, correlationId?: string): void {
  const cid = correlationId ?? getCorrelationId();
  if (!cid || !txHash) return;
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO tx_correlations (tx_hash, correlation_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(txHash, cid, Date.now());
  } catch (err) {
    // Table may not exist yet in very old test DBs; never fail submission.
    logger.warn(
      `[correlation] failed to record tx_hash=${txHash}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Look up a previously recorded correlation id for a transaction. */
export function lookupTxCorrelation(txHash: string): string | undefined {
  try {
    const row = getDb()
      .prepare('SELECT correlation_id FROM tx_correlations WHERE tx_hash = ?')
      .get(txHash) as { correlation_id: string } | undefined;
    return row?.correlation_id;
  } catch {
    return undefined;
  }
}

/**
 * Re-establish request context for an indexed event and run `fn` inside it.
 * Creates a child span linked to the originating request when a correlation
 * id is present; otherwise runs `fn` without ALS wrapping.
 */
export async function withRestoredCorrelation<T>(
  txHash: string,
  spanName: string,
  fn: (correlationId: string | undefined) => Promise<T> | T,
  parentSpan?: Span,
): Promise<T> {
  const correlationId = lookupTxCorrelation(txHash);

  const links: Link[] = [];
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
        ...(correlationId ? { 'scout.correlation_id': correlationId } : {}),
      },
    },
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
export function purgeOldTxCorrelations(maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs;
  try {
    const info = getDb().prepare('DELETE FROM tx_correlations WHERE created_at < ?').run(cutoff);
    return info.changes;
  } catch {
    return 0;
  }
}
