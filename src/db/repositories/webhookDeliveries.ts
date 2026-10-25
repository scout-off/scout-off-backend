/**
 * Repository: webhook delivery history.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: SQLite-only — still calls `getDb()` directly (4 call(s)); slated for the #640 DbDriver migration.
 */
import { getDb, timedQuery } from '../query';

// ─── Webhook delivery history (#1121) ─────────────────────────────────────────

export interface WebhookDeliveryRow {
  id: number;
  subscription_id: string;
  event_type: string;
  delivery_id: string;
  attempt_count: number;
  status: 'success' | 'failure';
  status_code: number | null;
  error_message: string | null;
  latency_ms: number | null;
  created_at: number;
}

export interface InsertWebhookDeliveryParams {
  subscriptionId: string;
  eventType: string;
  deliveryId: string;
  attemptCount: number;
  status: 'success' | 'failure';
  statusCode?: number | null;
  errorMessage?: string | null;
  latencyMs?: number | null;
}

/**
 * Persist a webhook delivery attempt record (success or failure).
 * Called by the webhook service after every dispatch.
 */
export function insertWebhookDelivery(p: InsertWebhookDeliveryParams): void {
  const sql = `
    INSERT INTO webhook_deliveries
      (subscription_id, event_type, delivery_id, attempt_count, status, status_code, error_message, latency_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  timedQuery(sql, () =>
    getDb()
      .prepare(sql)
      .run(
        p.subscriptionId,
        p.eventType,
        p.deliveryId,
        p.attemptCount,
        p.status,
        p.statusCode ?? null,
        p.errorMessage ?? null,
        p.latencyMs ?? null,
        Date.now(),
      ),
  );
}

export interface GetWebhookDeliveriesOptions {
  subscriptionId: string;
  limit?: number;
  offset?: number;
}

/** Return paginated delivery records for a given subscription (newest first). */
export function getWebhookDeliveries(
  opts: GetWebhookDeliveriesOptions,
): { data: WebhookDeliveryRow[]; total: number } {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const countSql =
    'SELECT COUNT(*) AS count FROM webhook_deliveries WHERE subscription_id = ?';
  const total = timedQuery(countSql, () => {
    const row = db.prepare(countSql).get(opts.subscriptionId) as { count: number };
    return row.count;
  });

  const dataSql = `
    SELECT * FROM webhook_deliveries
    WHERE subscription_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  const data = timedQuery(dataSql, () =>
    db.prepare(dataSql).all(opts.subscriptionId, limit, offset) as WebhookDeliveryRow[],
  );

  return { data, total };
}

export interface WebhookDeliverySummary {
  subscription_id: string;
  total: number;
  successes: number;
  failures: number;
  success_rate: number;
  last_success_at: number | null;
}

/**
 * Return a rolled-up success-rate summary for a subscription over the given
 * window (default: last 24 hours).
 */
export function getWebhookDeliverySummary(
  subscriptionId: string,
  windowMs = 24 * 60 * 60 * 1000,
): WebhookDeliverySummary {
  const db = getDb();
  const since = Date.now() - windowMs;

  const sql = `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) AS failures,
      MAX(CASE WHEN status = 'success' THEN created_at ELSE NULL END) AS last_success_at
    FROM webhook_deliveries
    WHERE subscription_id = ? AND created_at >= ?
  `;
  const row = timedQuery(sql, () =>
    db.prepare(sql).get(subscriptionId, since) as {
      total: number;
      successes: number;
      failures: number;
      last_success_at: number | null;
    },
  );

  const total = row.total ?? 0;
  const successes = row.successes ?? 0;
  return {
    subscription_id: subscriptionId,
    total,
    successes,
    failures: row.failures ?? 0,
    success_rate: total === 0 ? 0 : Math.round((successes / total) * 100) / 100,
    last_success_at: row.last_success_at ?? null,
  };
}

/**
 * Delete delivery records older than retentionMs (default 30 days).
 * Call periodically (e.g., from the indexer poll loop) to bound table growth.
 * Returns the number of rows deleted.
 */
export function pruneWebhookDeliveries(retentionMs = 30 * 24 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - retentionMs;
  const sql = 'DELETE FROM webhook_deliveries WHERE created_at < ?';
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(cutoff);
    return info.changes;
  });
}
