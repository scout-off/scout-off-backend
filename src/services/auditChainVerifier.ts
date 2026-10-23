/**
 * Scheduled audit-log hash-chain verification (#1539).
 *
 * The audit log is tamper-evident (migration 012/014, src/utils/hashChain.ts),
 * but until now verification only ran when an admin called
 * `GET /api/admin/audit/verify`. A tampered row — or a write bug that breaks
 * the chain — could therefore go unnoticed indefinitely.
 *
 * This job:
 *  1. Persists its progress in `indexer_state` (`audit_verify_last_id`,
 *     `audit_verify_last_hash`, `audit_verify_last_run`,
 *     `audit_verify_last_full_run`).
 *  2. Each run verifies rows after the checkpoint in bounded batches,
 *     continuing from the last verified hash.
 *  3. Runs a full walk from genesis once a week (configurable) so edits to
 *     already-verified rows are caught too.
 *  4. On the first break: logs the exact row (id, expected/actual hash,
 *     timestamp), sets `scout_off_audit_chain_valid` to 0, increments
 *     `scout_off_audit_chain_breaks_total`, records an audit event and
 *     optionally GETs `AUDIT_ALERT_WEBHOOK_URL` through the SSRF-safe
 *     `safeFetch`.
 *
 * The checkpoint stores the last verified id *and* hash, so a future
 * retention/archive engine can resume verification from an archive boundary
 * instead of genesis.
 */

import config from '../config';
import { getAuditLogRowsAfterId, getDriver } from '../db';
import {
  auditChainContent,
  computeChainHash,
  GENESIS_HASH,
} from '../utils/hashChain';
import { logger } from '../utils/logger';
import { safeFetch } from '../utils/safeFetch';
import {
  recordAuditChainBreak,
  setAuditChainValid,
} from '../middleware/metrics';
import { logAuditEvent } from './audit';

export const KEY_LAST_ID = 'audit_verify_last_id';
export const KEY_LAST_HASH = 'audit_verify_last_hash';
export const KEY_LAST_RUN = 'audit_verify_last_run';
export const KEY_LAST_FULL_RUN = 'audit_verify_last_full_run';

export type AuditVerifyMode = 'auto' | 'incremental' | 'full';

export interface AuditVerifyCheckpoint {
  lastId: number;
  lastHash: string;
  lastRun: string | null;
  lastFullRun: string | null;
}

export interface AuditChainBreak {
  id: number;
  expectedHash: string;
  actualHash: string;
  createdAt: string;
  reason: 'hash_mismatch' | 'prev_hash_mismatch';
}

export interface AuditChainVerifyResult {
  status: 'ok' | 'broken' | 'stopped';
  mode: 'incremental' | 'full';
  rowsChecked: number;
  batches: number;
  lastVerifiedId: number;
  brokenAt: AuditChainBreak | null;
  durationMs: number;
}

export interface AuditChainVerifyOptions {
  mode?: AuditVerifyMode;
  batchSize?: number;
  /** Checked between batches so shutdown can stop the walk cleanly. */
  shouldStop?: () => boolean;
  /** Cap on batches per incremental run; the next run continues from here. */
  maxBatches?: number;
  /** Set false in tests to inspect a run without touching the checkpoint. */
  persistCheckpoint?: boolean;
  /** Overrides config.auditVerify.alertWebhookUrl (tests). */
  alertWebhookUrl?: string | null;
  now?: () => number;
}

const UPSERT_SQL =
  'INSERT INTO indexer_state (key, value) VALUES (?, ?) ' +
  'ON CONFLICT(key) DO UPDATE SET value = excluded.value';

async function readState(keys: string[]): Promise<Map<string, string>> {
  const placeholders = keys.map(() => '?').join(', ');
  // sql-injection-check-ignore: placeholders are generated `?` markers; keys are bound values.
  const rows = await getDriver().all<{ key: string; value: string }>(
    `SELECT key, value FROM indexer_state WHERE key IN (${placeholders})`,
    keys,
  );
  return new Map(rows.map((row) => [row.key, row.value]));
}

/** Reads the persisted verification checkpoint (0/genesis when absent). */
export async function getAuditVerifyCheckpoint(): Promise<AuditVerifyCheckpoint> {
  const state = await readState([
    KEY_LAST_ID,
    KEY_LAST_HASH,
    KEY_LAST_RUN,
    KEY_LAST_FULL_RUN,
  ]);
  const parsedId = Number.parseInt(state.get(KEY_LAST_ID) ?? '0', 10);
  return {
    lastId: Number.isFinite(parsedId) && parsedId > 0 ? parsedId : 0,
    lastHash: state.get(KEY_LAST_HASH) ?? GENESIS_HASH,
    lastRun: state.get(KEY_LAST_RUN) ?? null,
    lastFullRun: state.get(KEY_LAST_FULL_RUN) ?? null,
  };
}

async function persistCheckpoint(
  lastId: number,
  lastHash: string,
  lastFullRun: string | null,
  nowMs: number,
): Promise<void> {
  const runIso = new Date(nowMs).toISOString();
  await getDriver().transaction(async (tx) => {
    await tx.run(UPSERT_SQL, [KEY_LAST_ID, String(lastId)]);
    await tx.run(UPSERT_SQL, [KEY_LAST_HASH, lastHash]);
    await tx.run(UPSERT_SQL, [KEY_LAST_RUN, runIso]);
    if (lastFullRun) {
      await tx.run(UPSERT_SQL, [KEY_LAST_FULL_RUN, lastFullRun]);
    }
  });
}

function decideMode(
  requested: AuditVerifyMode,
  checkpoint: AuditVerifyCheckpoint,
  nowMs: number,
): 'incremental' | 'full' {
  if (requested !== 'auto') return requested;
  // No usable checkpoint → walk from genesis.
  if (checkpoint.lastId === 0) return 'full';
  if (!checkpoint.lastFullRun) return 'full';
  const lastFullMs = Date.parse(checkpoint.lastFullRun);
  if (!Number.isFinite(lastFullMs)) return 'full';
  return nowMs - lastFullMs >= config.auditVerify.fullIntervalMs
    ? 'full'
    : 'incremental';
}

/** Best-effort operator alert; never throws and never blocks verification. */
async function sendBreakAlert(
  webhookUrl: string | null | undefined,
  broken: AuditChainBreak,
  mode: 'incremental' | 'full',
): Promise<void> {
  if (!webhookUrl) return;
  let target: URL;
  try {
    target = new URL(webhookUrl);
  } catch {
    logger.warn('[audit-verify] AUDIT_ALERT_WEBHOOK_URL is not a valid URL');
    return;
  }
  target.searchParams.set('event', 'audit_chain_break');
  target.searchParams.set('broken_at_id', String(broken.id));
  target.searchParams.set('expected_hash', broken.expectedHash);
  target.searchParams.set('actual_hash', broken.actualHash);
  target.searchParams.set('row_created_at', broken.createdAt);
  target.searchParams.set('reason', broken.reason);
  target.searchParams.set('mode', mode);

  try {
    // safeFetch enforces https, blocks private/loopback/link-local addresses
    // and caps the response size, so an operator-supplied URL cannot be used
    // to reach the cluster's internal network.
    await safeFetch(target.toString(), { maxBytes: 4_096, timeoutMs: 5_000 });
  } catch (err) {
    logger.warn('[audit-verify] failed to deliver break alert webhook', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Verifies the audit chain from the stored checkpoint (or genesis for a full
 * run). Stops at the first break so the exact broken row is reported and the
 * checkpoint stays at the last known-good row.
 */
export async function runAuditChainVerification(
  options: AuditChainVerifyOptions = {},
): Promise<AuditChainVerifyResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const batchSize = options.batchSize ?? config.auditVerify.batchSize;
  const maxBatches = options.maxBatches ?? 100;
  const persist = options.persistCheckpoint !== false;
  const webhookUrl =
    options.alertWebhookUrl !== undefined
      ? options.alertWebhookUrl
      : config.auditVerify.alertWebhookUrl;

  const checkpoint = await getAuditVerifyCheckpoint();
  const mode = decideMode(options.mode ?? 'auto', checkpoint, startedAt);

  // A full run always starts from genesis, ignoring the checkpoint.
  let cursorId = mode === 'full' ? 0 : checkpoint.lastId;
  let prevHash = mode === 'full' ? GENESIS_HASH : checkpoint.lastHash;
  let rowsChecked = 0;
  let batches = 0;
  let stopped = false;

  for (;;) {
    if (options.shouldStop?.()) {
      stopped = true;
      break;
    }
    // Only incremental runs are chunked across scheduler ticks: a full run
    // must reach the end to be meaningful, but still reads bounded batches.
    if (mode === 'incremental' && batches >= maxBatches) break;

    const rows = await getAuditLogRowsAfterId(cursorId, batchSize);
    if (rows.length === 0) break;
    batches += 1;

    for (const row of rows) {
      if (row.prev_hash !== prevHash) {
        const broken: AuditChainBreak = {
          id: row.id,
          expectedHash: prevHash,
          actualHash: row.prev_hash ?? '',
          createdAt: row.created_at,
          reason: 'prev_hash_mismatch',
        };
        return reportBreak(
          broken, mode, rowsChecked, batches, cursorId, startedAt, now,
          webhookUrl, persist,
        );
      }

      const expectedHash = computeChainHash(
        auditChainContent({
          action: row.action,
          adminWallet: row.admin_wallet,
          queryParams: row.query_params,
          createdAt: row.created_at,
          eventSource: row.event_source,
        }),
        prevHash,
      );

      if (row.hash !== expectedHash) {
        const broken: AuditChainBreak = {
          id: row.id,
          expectedHash,
          actualHash: row.hash,
          createdAt: row.created_at,
          reason: 'hash_mismatch',
        };
        return reportBreak(
          broken, mode, rowsChecked, batches, cursorId, startedAt, now,
          webhookUrl, persist,
        );
      }

      prevHash = row.hash;
      cursorId = row.id;
      rowsChecked += 1;
    }

    if (rows.length < batchSize) break;
  }

  // A full run only counts as "done" when it actually reached the end; an
  // interrupted or batch-capped full run must be retried next time.
  const fullCompleted = mode === 'full' && !stopped;

  if (persist && (mode === 'incremental' || fullCompleted)) {
    await persistCheckpoint(
      cursorId,
      prevHash,
      fullCompleted ? new Date(now()).toISOString() : checkpoint.lastFullRun,
      now(),
    );
  }

  if (!stopped) {
    setAuditChainValid(true);
  }

  const result: AuditChainVerifyResult = {
    status: stopped ? 'stopped' : 'ok',
    mode,
    rowsChecked,
    batches,
    lastVerifiedId: cursorId,
    brokenAt: null,
    durationMs: now() - startedAt,
  };

  logger.info('[audit-verify] verification run complete', {
    mode: result.mode,
    status: result.status,
    rows_checked: result.rowsChecked,
    last_verified_id: result.lastVerifiedId,
    duration_ms: result.durationMs,
  });

  return result;
}

async function reportBreak(
  broken: AuditChainBreak,
  mode: 'incremental' | 'full',
  rowsChecked: number,
  batches: number,
  lastVerifiedId: number,
  startedAt: number,
  now: () => number,
  webhookUrl: string | null | undefined,
  persist: boolean,
): Promise<AuditChainVerifyResult> {
  recordAuditChainBreak();

  logger.error('[audit-verify] audit-log hash chain is BROKEN', {
    broken_at_id: broken.id,
    expected_hash: broken.expectedHash,
    actual_hash: broken.actualHash,
    row_created_at: broken.createdAt,
    reason: broken.reason,
    mode,
    metric: 'scout_off_audit_chain_valid=0',
  });

  // The audit event and the webhook are both best-effort: a failure to alert
  // must not hide the break, and must not make the job crash.
  try {
    await logAuditEvent({
      action: 'audit_chain_break',
      timestamp: new Date(now()).toISOString(),
      adminWallet: 'system',
      queryParams: {
        broken_at_id: broken.id,
        expected_hash: broken.expectedHash,
        actual_hash: broken.actualHash,
        row_created_at: broken.createdAt,
        reason: broken.reason,
        verification_mode: mode,
      },
    });
  } catch (err) {
    logger.error('[audit-verify] failed to write audit_chain_break audit event', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await sendBreakAlert(webhookUrl, broken, mode);

  logger.info('[audit-verify] checkpoint left at the last verified row', {
    rows_checked: rowsChecked,
    checkpoint_persisted: persist,
  });

  return {
    status: 'broken',
    mode,
    rowsChecked,
    batches,
    // The last known-good row; the checkpoint is not advanced past the break.
    lastVerifiedId,
    brokenAt: broken,
    durationMs: now() - startedAt,
  };
}

/**
 * Scheduler entry point used by `src/index.ts`. Reads the interval/batch
 * settings from config and respects shutdown between batches.
 */
export async function runScheduledAuditChainVerification(options: {
  shouldStop?: () => boolean;
} = {}): Promise<AuditChainVerifyResult> {
  return runAuditChainVerification({
    mode: 'auto',
    batchSize: config.auditVerify.batchSize,
    shouldStop: options.shouldStop,
  });
}
