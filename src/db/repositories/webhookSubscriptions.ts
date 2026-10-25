/**
 * Repository: outbound webhook subscriptions.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: SQLite-only — still calls `getDb()` directly (8 call(s)); slated for the #640 DbDriver migration.
 */
import { getDb, timedQuery } from '../query';
import crypto from 'crypto';
import config from '../../config';
import { EventRecord, ContractEventType } from '../../types';
import { encryptWebhookSecret, decryptWebhookSecret } from '../../utils/webhookSecretCipher';
import { ApiKeyLimitError, MAX_API_KEYS_PER_SCOUT, MAX_WEBHOOK_SUBSCRIPTIONS_PER_SCOUT, WebhookSubscriptionLimitError } from '../../utils/scoutResourceLimits';

// ─── Webhook subscriptions (#470) ────────────────────────────────────────────
//
// Schema defined in db/012_webhook_subscriptions.sql. Each row is a subscriber
// that receives outbound event webhooks; `secret` is the per-subscriber HMAC
// key used to sign every delivery (see src/services/webhooks.ts, docs/webhooks.md).

export interface WebhookSubscription {
  id: number;
  url: string;
  secret: string;
  scout_wallet: string | null;
  event_types: string | null; // JSON array of ContractEventType strings, or null = all
  created_at: string;
  previous_secret?: string | null;
  previous_secret_expires_at?: string | null;
  // Endpoint health (#1512, migration 038). Timestamps are epoch ms.
  consecutive_failures?: number;
  failing_since?: number | null;
  last_failure_at?: number | null;
  last_success_at?: number | null;
  status?: WebhookSubscriptionStatus;
  suspended_at?: number | null;
  suspended_reason?: string | null;
}

export type WebhookSubscriptionStatus = 'active' | 'degraded' | 'suspended';

export function createWebhookSubscription(
  url: string,
  secret?: string,
  scoutWallet?: string,
  eventTypes?: string[],
  previousSecret?: string,
  previousSecretExpiresAt?: string,
): WebhookSubscription {
  const finalSecret = secret ?? crypto.randomBytes(32).toString('hex');
  // Encrypted at rest (#686) — only the ciphertext is ever persisted. The
  // plaintext is returned to the caller here (e.g. for the API response at
  // issuance time) but is never written back to storage.
  const encryptedSecret = encryptWebhookSecret(finalSecret);
  const eventTypesJson = eventTypes && eventTypes.length > 0 ? JSON.stringify(eventTypes) : null;
  const encryptedPreviousSecret = previousSecret
    ? encryptWebhookSecret(previousSecret)
    : null;
  const sql = `INSERT INTO webhook_subscriptions 
    (url, secret, scout_wallet, event_types, previous_secret, previous_secret_expires_at) 
    VALUES (?, ?, ?, ?, ?, ?)`;
  return timedQuery(sql, () => {
    const insert = getDb().transaction(() => {
      if (scoutWallet) {
        const row = getDb()
          .prepare('SELECT COUNT(*) AS count FROM webhook_subscriptions WHERE scout_wallet = ?')
          .get(scoutWallet) as { count: number } | undefined;
        if ((row?.count ?? 0) >= MAX_WEBHOOK_SUBSCRIPTIONS_PER_SCOUT) {
          throw new WebhookSubscriptionLimitError();
        }
      }

      const info = getDb().prepare(sql).run(
        url,
        encryptedSecret,
        scoutWallet ?? null,
        eventTypesJson,
        encryptedPreviousSecret ?? null,
        previousSecretExpiresAt ?? null,
      );
      return {
        id: Number(info.lastInsertRowid),
        url,
        secret: finalSecret,
        scout_wallet: scoutWallet ?? null,
        event_types: eventTypesJson,
        previous_secret: previousSecret ?? null,
        previous_secret_expires_at: previousSecretExpiresAt ?? null,
        created_at: new Date().toISOString(),
      };
    });
    return insert();
  });
}

export function listWebhookSubscriptions(): WebhookSubscription[] {
  const sql = 'SELECT * FROM webhook_subscriptions ORDER BY id ASC';
  return timedQuery(sql, () => {
    const rows = getDb().prepare(sql).all() as WebhookSubscription[];
    // Decrypted only here, in memory, immediately before the caller signs a
    // delivery with it (src/services/webhooks.ts) — never persisted.
    return rows.map((row) => ({
      ...row,
      secret: decryptWebhookSecret(row.secret),
      // previous_secret is stored encrypted, decrypt if present
      previous_secret: row.previous_secret ? decryptWebhookSecret(row.previous_secret) : null,
    }));
  });
}

/**
 * Look up a single webhook subscription by its row id.
 * Returns the row with the secret still encrypted (callers that need the
 * plaintext secret must call decryptWebhookSecret themselves).
 * Returns undefined when not found.
 */
export function getWebhookSubscriptionById(id: number): WebhookSubscription | undefined {
  const sql = 'SELECT * FROM webhook_subscriptions WHERE id = ?';
  return timedQuery(sql, () =>
    getDb().prepare(sql).get(id) as WebhookSubscription | undefined,
  );
}

/**
 * List all webhook subscriptions owned by a specific scout wallet.
 * Secrets are returned encrypted — decrypt before use.
 */
export function getWebhookSubscriptionsByScout(scoutWallet: string): WebhookSubscription[] {
  const sql = 'SELECT * FROM webhook_subscriptions WHERE scout_wallet = ? ORDER BY id ASC';
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(scoutWallet) as WebhookSubscription[],
  );
}

/**
 * Delete a webhook subscription by id, scoped to a specific scout wallet to
 * prevent cross-scout deletion. Returns true when a row was deleted.
 */
export function deleteWebhookSubscription(id: number, scoutWallet: string): boolean {
  const sql = 'DELETE FROM webhook_subscriptions WHERE id = ? AND scout_wallet = ?';
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(id, scoutWallet);
    return info.changes > 0;
  });
}

/**
 * Idempotently seeds a subscription for the legacy WEBHOOK_URL config so
 * single-subscriber deployments keep working after moving to the DB-backed
 * subscription model. No-op if the URL is already subscribed, or if the
 * legacy webhook is not enabled/configured. Called once from initDb().
 */
export function ensureLegacyWebhookSubscription(): void {
  if (!config.webhook.enabled || !config.webhook.url) return;

  const sql = 'SELECT * FROM webhook_subscriptions WHERE url = ?';
  const existing = timedQuery(sql, () =>
    getDb().prepare(sql).get(config.webhook.url) as WebhookSubscription | undefined
  );
  if (existing) return;

  createWebhookSubscription(config.webhook.url, config.webhook.secret || undefined);
}


/**
 * Update a webhook subscription's previous secret and expiry for rotation.
 * This enables zero-downtime secret rotation where deliveries are signed
 * with both the current and previous secrets until the rotation window expires.
 *
 * @param id - Subscription ID
 * @param previousSecret - The old secret to use during rotation window
 * @param previousSecretExpiresAt - Expiry timestamp in ISO format
 */
export function updateWebhookSubscriptionPreviousSecret(
  id: number,
  previousSecret: string,
  previousSecretExpiresAt: string,
): void {
  const sql = `UPDATE webhook_subscriptions
    SET previous_secret = ?, previous_secret_expires_at = ?
    WHERE id = ?`;
  timedQuery(sql, () => getDb().prepare(sql).run(previousSecret, previousSecretExpiresAt, id));
}

/**
 * Clear a webhook subscription's previous secret (end rotation window).
 */
export function clearWebhookSubscriptionPreviousSecret(id: number): void {
  const sql = `UPDATE webhook_subscriptions
    SET previous_secret = NULL, previous_secret_expires_at = NULL
    WHERE id = ?`;
  timedQuery(sql, () => getDb().prepare(sql).run(id));
}


// ─── Endpoint health (#1512) ─────────────────────────────────────────────────

/** Record a successful delivery: clears the failure streak and degraded status. */
export function recordWebhookSubscriptionSuccess(id: number, now = Date.now()): void {
  const sql = `UPDATE webhook_subscriptions
    SET consecutive_failures = 0, failing_since = NULL, last_success_at = ?,
        status = CASE WHEN status = 'suspended' THEN status ELSE 'active' END
    WHERE id = ?`;
  timedQuery(sql, () => getDb().prepare(sql).run(now, id));
}

/**
 * Record a failed delivery and, when the streak or its time span crosses the
 * thresholds, suspend the subscription atomically. Returns the updated row, or
 * undefined if the subscription no longer exists.
 */
export function recordWebhookSubscriptionFailure(
  id: number,
  limits: { maxFailures: number; maxSpanMs: number; minFailuresForSpan: number },
  now = Date.now(),
): { row: WebhookSubscription; justSuspended: boolean } | undefined {
  return timedQuery('webhook_subscriptions health failure', () => {
    const tx = getDb().transaction(() => {
      const db = getDb();
      db.prepare(
        `UPDATE webhook_subscriptions
         SET consecutive_failures = consecutive_failures + 1,
             failing_since = COALESCE(failing_since, ?), last_failure_at = ?,
             status = CASE WHEN status = 'suspended' THEN status ELSE 'degraded' END
         WHERE id = ?`,
      ).run(now, now, id);
      const row = db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ?').get(id) as
        | WebhookSubscription
        | undefined;
      if (!row) return undefined;

      const streak = row.consecutive_failures ?? 0;
      const spanMs = now - (row.failing_since ?? now);
      let reason: string | null = null;
      if (streak >= limits.maxFailures) reason = `${streak} consecutive failures`;
      else if (streak >= limits.minFailuresForSpan && spanMs > limits.maxSpanMs) {
        reason = `failing for ${Math.round(spanMs / 3_600_000)}h (${streak} consecutive failures)`;
      }
      if (reason && row.status !== 'suspended') {
        db.prepare(
          `UPDATE webhook_subscriptions SET status = 'suspended', suspended_at = ?, suspended_reason = ? WHERE id = ?`,
        ).run(now, reason, id);
        return { row: { ...row, status: 'suspended' as const, suspended_at: now, suspended_reason: reason }, justSuspended: true };
      }
      return { row, justSuspended: false };
    });
    return tx();
  });
}

/** Return a suspended/degraded subscription to `active` with a clean health record. */
export function reactivateWebhookSubscription(id: number, now = Date.now()): boolean {
  const sql = `UPDATE webhook_subscriptions
    SET status = 'active', consecutive_failures = 0, failing_since = NULL,
        suspended_at = NULL, suspended_reason = NULL, last_success_at = ?
    WHERE id = ?`;
  return timedQuery(sql, () => getDb().prepare(sql).run(now, id).changes > 0);
}

export function countWebhookSubscriptionsByStatus(): Record<WebhookSubscriptionStatus, number> {
  const sql = 'SELECT status, COUNT(*) AS count FROM webhook_subscriptions GROUP BY status';
  return timedQuery(sql, () => {
    const counts: Record<WebhookSubscriptionStatus, number> = { active: 0, degraded: 0, suspended: 0 };
    for (const r of getDb().prepare(sql).all() as Array<{ status: WebhookSubscriptionStatus; count: number }>) {
      counts[r.status] = r.count;
    }
    return counts;
  });
}
