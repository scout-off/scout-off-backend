/**
 * Repository: webhook dead-letter queue.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: SQLite-only — still calls `getDb()` directly (11 call(s)); slated for the #640 DbDriver migration.
 */
import { getDb, timedQuery } from '../query';

// ─── Webhook dead-letter queue (#470) ────────────────────────────────────────
//
// Schema defined in db/013_webhook_dead_letters.sql. A row is inserted whenever
// postWebhookWithRetry() exhausts all retry attempts for a given subscriber,
// instead of the delivery being logged and dropped.

export type WebhookDeadLetterStatus = 'pending' | 'in_progress' | 'replayed';

export interface WebhookDeadLetter {
  id: number;
  subscription_id: number | null;
  url: string;
  event_type: string;
  payload: string;
  delivery_id: string;
  failure_reason: string;
  attempts: number;
  status: WebhookDeadLetterStatus;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
  replayed_at: string | null;
}

export interface InsertDeadLetterInput {
  subscriptionId: number | null;
  url: string;
  eventType: string;
  payload: string;
  deliveryId: string;
  failureReason: string;
  attempts: number;
}

export function insertWebhookDeadLetter(input: InsertDeadLetterInput): WebhookDeadLetter {
  const sql = `INSERT INTO webhook_dead_letters
    (subscription_id, url, event_type, payload, delivery_id, failure_reason, attempts, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`;
  return timedQuery(sql, () => {
    const info = getDb()
      .prepare(sql)
      .run(
        input.subscriptionId,
        input.url,
        input.eventType,
        input.payload,
        input.deliveryId,
        input.failureReason,
        input.attempts
      );
    return {
      id: Number(info.lastInsertRowid),
      subscription_id: input.subscriptionId,
      url: input.url,
      event_type: input.eventType,
      payload: input.payload,
      delivery_id: input.deliveryId,
      failure_reason: input.failureReason,
      attempts: input.attempts,
      status: 'pending',
      locked_by: null,
      locked_at: null,
      created_at: new Date().toISOString(),
      replayed_at: null,
    };
  });
}

export function listWebhookDeadLetters(limit: number, offset: number): WebhookDeadLetter[] {
  const sql = 'SELECT * FROM webhook_dead_letters ORDER BY id DESC LIMIT ? OFFSET ?';
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(limit, offset) as WebhookDeadLetter[]
  );
}

export function countWebhookDeadLetters(): number {
  const sql = 'SELECT COUNT(*) as count FROM webhook_dead_letters';
  return timedQuery(sql, () => {
    const row = getDb().prepare(sql).get() as { count: number } | undefined;
    return row?.count ?? 0;
  });
}

/**
 * Dead-letter counts grouped by subscription_id for metrics and alerting (#1131).
 */
export function countWebhookDeadLettersBySubscription(): Array<{
  subscription_id: number | null;
  count: number;
}> {
  const sql = `SELECT subscription_id, COUNT(*) AS count
               FROM webhook_dead_letters
               WHERE status IN ('pending', 'in_progress')
               GROUP BY subscription_id
               ORDER BY count DESC`;
  return timedQuery(sql, () =>
    getDb().prepare(sql).all() as Array<{ subscription_id: number | null; count: number }>,
  );
}

export function getWebhookDeadLetterById(id: number): WebhookDeadLetter | undefined {
  const sql = 'SELECT * FROM webhook_dead_letters WHERE id = ?';
  return timedQuery(sql, () =>
    getDb().prepare(sql).get(id) as WebhookDeadLetter | undefined
  );
}

export function markWebhookDeadLetterReplayed(id: number): void {
  const sql = "UPDATE webhook_dead_letters SET status = 'replayed', replayed_at = ?, locked_by = NULL, locked_at = NULL WHERE id = ?";
  timedQuery(sql, () => getDb().prepare(sql).run(new Date().toISOString(), id));
}

/**
 * Atomically claim a pending dead-letter row for processing by setting
 * status to 'in_progress' and recording the worker identifier.
 *
 * Returns the claimed row on success, or null if another worker already
 * claimed it (or the row was already replayed / exhausted).
 *
 * The UPDATE ... WHERE status = 'pending' is atomic in both SQLite and
 * PostgreSQL, so exactly one concurrent caller wins the race.
 */
export function claimWebhookDeadLetter(id: number, workerId: string): WebhookDeadLetter | null {
  const now = new Date().toISOString();
  const sql = `UPDATE webhook_dead_letters
    SET status = 'in_progress', locked_by = ?, locked_at = ?
    WHERE id = ? AND status = 'pending'`;
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(workerId, now, id);
    if (info.changes === 0) return null;
    return getWebhookDeadLetterById(id) ?? null;
  });
}

/**
 * Release a claim on a dead-letter row, returning it to 'pending' status.
 * Used when a sweep fails partway through and the row needs to be retried
 * by a future sweep.
 */
export function releaseWebhookDeadLetterClaim(id: number): void {
  const sql = `UPDATE webhook_dead_letters
    SET status = 'pending', locked_by = NULL, locked_at = NULL
    WHERE id = ? AND status = 'in_progress'`;
  timedQuery(sql, () => getDb().prepare(sql).run(id));
}

export function updateWebhookDeadLetterAttempt(
  id: number,
  attempts: number,
  failureReason: string
): void {
  const sql = 'UPDATE webhook_dead_letters SET attempts = ?, failure_reason = ? WHERE id = ?';
  timedQuery(sql, () => getDb().prepare(sql).run(attempts, failureReason, id));
}

/** Delete a specific dead-letter row by id. Returns true when a row was deleted. */
export function deleteWebhookDeadLetter(id: number): boolean {
  const sql = 'DELETE FROM webhook_dead_letters WHERE id = ?';
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(id);
    return info.changes > 0;
  });
}

/** Delete all dead-letter rows older than cutoffDays days. Returns the count deleted. */
export function purgeOldWebhookDeadLetters(cutoffDays: number): number {
  // created_at is stored as ISO text ("2024-01-01T00:00:00.000Z")
  const cutoff = new Date(Date.now() - cutoffDays * 24 * 60 * 60 * 1000).toISOString();
  const sql = "DELETE FROM webhook_dead_letters WHERE created_at < ?";
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(cutoff);
    return info.changes;
  });
}
