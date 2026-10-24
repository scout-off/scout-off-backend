/**
 * Online, resumable, rate-limited re-encryption of encrypted-at-rest fields
 * onto the active keyring key (#1513).
 *
 * Each tick selects up to `encryptionReencryptBatchSize` rows whose ciphertext is
 * not on the active key id (legacy `v1:` and plaintext rows included), and
 * rewrites each with optimistic concurrency (`WHERE id = ? AND col = ?`) so a
 * concurrent application write is never overwritten. Progress is derived from
 * the data itself (rows not on the active key), so a restart simply resumes.
 * Self-rescheduling setTimeout (like the dead-letter job) prevents overlap.
 */
import config from '../config';
import { getDriver } from '../db';
import { logger } from '../utils/logger';
import { decryptField, encryptField, FieldCipherPurpose, getKeyring } from '../utils/fieldCipher';

interface Target {
  purpose: FieldCipherPurpose;
  table: string;
  column: string;
  nullable: boolean;
}

export const REENCRYPTION_TARGETS: readonly Target[] = [
  { purpose: 'notes', table: 'scout_player_notes', column: 'note_text', nullable: false },
  { purpose: 'notes', table: 'scout_player_notes_v2', column: 'content', nullable: false },
  { purpose: 'webhook', table: 'webhook_subscriptions', column: 'secret', nullable: false },
  { purpose: 'webhook', table: 'webhook_subscriptions', column: 'previous_secret', nullable: true },
];

const IDLE_INTERVAL_MS = 5 * 60 * 1000;

export interface ReencryptionResult {
  scanned: number;
  reencrypted: number;
  /** Lost the optimistic-concurrency race; picked up again on a later tick. */
  conflicts: number;
  /** Could not be decrypted (e.g. key missing from the keyring). */
  failed: number;
}

/** Re-encrypt one batch per target purpose that has a keyring. Never logs plaintext or key material. */
export async function reencryptBatch(
  batchSize = config.encryptionReencryptBatchSize,
): Promise<ReencryptionResult> {
  const result: ReencryptionResult = { scanned: 0, reencrypted: 0, conflicts: 0, failed: 0 };
  const db = getDriver();

  for (const t of REENCRYPTION_TARGETS) {
    const ring = getKeyring(t.purpose);
    if (!ring) continue;

    const notNull = t.nullable ? ` AND ${t.column} IS NOT NULL` : '';
    let lastId = 0;
    let remaining = batchSize;
    while (remaining > 0) {
      const rows = await db.all<{ id: number; value: string }>(
        // sql-injection-ok: table/column come from the hard-coded REENCRYPTION_TARGETS; values are bound.
        `SELECT id, ${t.column} AS value FROM ${t.table}
         WHERE id > ? AND ${t.column} NOT LIKE ?${notNull}
         ORDER BY id LIMIT ?`,
        [lastId, `v2:${ring.activeKeyId}:%`, remaining],
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        lastId = row.id;
        result.scanned += 1;
        try {
          const next = encryptField(decryptField(row.value, { purpose: t.purpose }), {
            purpose: t.purpose,
          });
          const { changes } = await db.run(
            // sql-injection-ok: table/column come from the hard-coded REENCRYPTION_TARGETS; values are bound.
            `UPDATE ${t.table} SET ${t.column} = ? WHERE id = ? AND ${t.column} = ?`,
            [next, row.id, row.value],
          );
          if (changes > 0) result.reencrypted += 1;
          else result.conflicts += 1;
        } catch (err) {
          result.failed += 1;
          logger.warn(
            `[encryption] cannot re-encrypt ${t.table}.${t.column} id=${row.id}: ${(err as Error).message}`,
          );
        }
      }
      remaining -= rows.length;
    }
  }
  return result;
}

export interface KeyCounts {
  purpose: FieldCipherPurpose;
  table: string;
  column: string;
  total: number;
  /** key id → number of rows; includes `v1` (legacy), `plaintext` and `unknown`. */
  byKeyId: Record<string, number>;
}

/** Per-key ciphertext counts for every target (admin status, key retirement). */
export async function getEncryptionStatus(): Promise<{
  notes: { activeKeyId: string | null; keyIds: string[]; targets: KeyCounts[] };
  webhook: { activeKeyId: string | null; keyIds: string[]; targets: KeyCounts[] };
}> {
  const db = getDriver();
  const out = {
    notes: { activeKeyId: null as string | null, keyIds: [] as string[], targets: [] as KeyCounts[] },
    webhook: { activeKeyId: null as string | null, keyIds: [] as string[], targets: [] as KeyCounts[] },
  };

  for (const purpose of ['notes', 'webhook'] as const) {
    const ring = getKeyring(purpose);
    out[purpose].activeKeyId = ring?.activeKeyId ?? null;
    out[purpose].keyIds = ring ? [...ring.keys.keys()] : [];
  }

  for (const t of REENCRYPTION_TARGETS) {
    const ids = out[t.purpose].keyIds;
    const c = t.column;
    const selects = [
      'COUNT(*) AS total',
      `SUM(CASE WHEN ${c} LIKE 'v1:%' THEN 1 ELSE 0 END) AS v1`,
      `SUM(CASE WHEN ${c} NOT LIKE 'v1:%' AND ${c} NOT LIKE 'v2:%' THEN 1 ELSE 0 END) AS plaintext`,
      ...ids.map((_, i) => `SUM(CASE WHEN ${c} LIKE ? THEN 1 ELSE 0 END) AS k${i}`),
    ];
    const row =
      (await db.get<Record<string, number | string | null>>(
        // sql-injection-ok: table/column come from the hard-coded REENCRYPTION_TARGETS; values are bound.
        `SELECT ${selects.join(', ')} FROM ${t.table} WHERE ${c} IS NOT NULL`,
        ids.map((id) => `v2:${id}:%`),
      )) ?? {};
    const n = (v: unknown): number => Number(v ?? 0);
    const byKeyId: Record<string, number> = { v1: n(row.v1), plaintext: n(row.plaintext) };
    ids.forEach((id, i) => {
      byKeyId[id] = n(row[`k${i}`]);
    });
    const total = n(row.total);
    byKeyId.unknown = total - Object.values(byKeyId).reduce((a, b) => a + b, 0);
    out[t.purpose].targets.push({ purpose: t.purpose, table: t.table, column: c, total, byKeyId });
  }
  return out;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (!running) return;
  let delay = IDLE_INTERVAL_MS;
  try {
    const r = await reencryptBatch();
    if (r.reencrypted > 0 || r.conflicts > 0) {
      logger.info(`[encryption] re-encrypted ${r.reencrypted} row(s), ${r.conflicts} conflict(s), ${r.failed} failed`);
      delay = config.encryptionReencryptIntervalMs;
    }
  } catch (err) {
    logger.error(`[encryption] re-encryption tick failed: ${(err as Error).message}`);
  }
  if (running) {
    timer = setTimeout(() => void tick(), delay);
    timer.unref?.();
  }
}

/** Start the background job when at least one keyring is configured. */
export function startFieldReencryptionJob(): void {
  if (running || (!getKeyring('notes') && !getKeyring('webhook'))) return;
  running = true;
  timer = setTimeout(() => void tick(), config.encryptionReencryptIntervalMs);
  timer.unref?.();
}

export function stopFieldReencryptionJob(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
