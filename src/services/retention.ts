import { createHash, randomUUID } from 'crypto';
import { mkdir, open, unlink, realpath } from 'fs/promises';
import path from 'path';
import config from '../config';
import { AuditLogRow, getDriver, purgeExpiredIdempotencyKeys } from '../db';
import { DbTxHandle } from '../db/driver';
import { RetentionPolicy, retentionTargets } from '../retentionPolicy';
import { auditChainContent, canonicalJSON, computeChainHash, GENESIS_HASH } from '../utils/hashChain';
import { AuditCheckpoint, checkpointArchivePath, latestAuditCheckpoint, signCheckpoint } from '../utils/auditCheckpoint';
import { logger } from '../utils/logger';
import { recordRetentionRun } from './retentionMetrics';

const DAY_MS = 86400000;
type Row = Record<string, unknown>;
export interface RetentionResult { table: string; eligible: number; deleted: number; batches: number }

function predicate(policy: RetentionPolicy): string {
  const extra = policy.table === 'events' ? " AND type NOT IN ('role_granted', 'role_revoked', 'role_admin_changed')"
    : policy.table === 'webhook_dead_letters' ? " AND locked_by IS NULL AND status <> 'in_progress'"
    : policy.table === 'data_export_jobs' ? " AND status IN ('completed', 'failed')" : '';
  // Both SQLite datetime() defaults and ISO timestamps occur in the dead-letter
  // table. Normalize the separator before comparison (audit uses ISO too).
  const column = retentionTargets[policy.table].clock === 'iso'
    ? `REPLACE(${policy.column}, 'T', ' ')` : policy.column;
  return `${column} < ?${extra}`;
}
function cutoff(policy: RetentionPolicy, now: number): number | string {
  const ms = now - policy.days * DAY_MS;
  return retentionTargets[policy.table].clock === 'iso'
    ? new Date(ms).toISOString().replace('T', ' ') : ms;
}

async function selectBatch(tx: DbTxHandle, policy: RetentionPolicy, before: string | number): Promise<Row[]> {
  const key = retentionTargets[policy.table].key;
  if (policy.table === 'audit_log') {
    // Only archive a contiguous PREFIX. An old row after a recent/backdated
    // entry must wait; skipping the recent entry would destroy the chain.
    const rows = await tx.all<AuditLogRow>('SELECT * FROM audit_log ORDER BY id LIMIT ?', [config.retention.batchSize]);
    const prefix: AuditLogRow[] = [];
    for (const row of rows) {
      if (Date.parse(row.created_at) >= Date.parse(String(before)) || !Number.isFinite(Date.parse(row.created_at))) break;
      prefix.push(row);
    }
    return prefix as unknown as Row[];
  }
  const lock = config.dbDriver === 'postgres' ? ' FOR UPDATE' : '';
  return tx.all<Row>(`SELECT * FROM ${policy.table} WHERE ${predicate(policy)} ORDER BY ${key} LIMIT ?${lock}`, [before, config.retention.batchSize]);
}

async function archiveAudit(rows: Row[], previousHash: string): Promise<AuditCheckpoint> {
  let hash = previousHash;
  for (const row of rows as unknown as AuditLogRow[]) {
    const calculated = computeChainHash(auditChainContent({ action: row.action, adminWallet: row.admin_wallet,
      queryParams: row.query_params, createdAt: row.created_at, eventSource: row.event_source }), hash);
    if (row.prev_hash !== hash || row.hash !== calculated) throw new Error(`Refusing to archive invalid audit row ${row.id}`);
    hash = row.hash;
  }
  await mkdir(config.retention.archiveDir, { recursive: true, mode: 0o700 });
  const filename = `audit-${randomUUID()}.json`;
  const contents = canonicalJSON({ previous_hash: previousHash, rows });
  const handle = await open(checkpointArchivePath(filename), 'wx', 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  // Persist directory metadata where supported. A failure leaves an orphan
  // archive but never permits deleting the source rows.
  if (process.platform !== 'win32') {
    const directory = await open(config.retention.archiveDir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  const content = {
    last_id: Number(rows[rows.length - 1].id), last_hash: hash, previous_hash: previousHash,
    archive_file: filename, archive_sha256: createHash('sha256').update(contents).digest('hex'),
    created_at: new Date().toISOString(),
  };
  return { ...content, signature: signCheckpoint(content) };
}

async function removeExportArchive(row: Row): Promise<void> {
  if (!row.archive_path) return;
  // Resolve symlinks and enforce the dedicated export root before deleting.
  // A path outside this root is a configuration error, never a delete target.
  let target: string;
  try { target = await realpath(String(row.archive_path)); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  const root = await realpath(config.retention.exportDir);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Export archive lies outside DATA_EXPORT_ARCHIVE_DIR');
  await unlink(target);
}

/** One bounded, atomic batch. Archive I/O precedes the mutation transaction. */
async function pruneBatch(policy: RetentionPolicy, before: string | number): Promise<number> {
  const driver = getDriver();
  let archive: AuditCheckpoint | undefined;
  let archivedRows: Row[] | undefined;
  if (policy.table === 'audit_log') {
    if (!config.retention.checkpointKey) throw new Error('Audit retention requires a signing key');
    const snapshot = await driver.transaction(async tx => {
      await tx.lockForWrite('audit_log');
      return { rows: await selectBatch(tx, policy, before), checkpoint: await latestAuditCheckpoint(tx) };
    });
    if (!snapshot.rows.length) return 0;
    archivedRows = snapshot.rows;
    archive = await archiveAudit(snapshot.rows, snapshot.checkpoint?.last_hash ?? GENESIS_HASH);
  }
  return driver.transaction(async tx => {
    await tx.lockForWrite('retention');
    if (policy.table === 'audit_log') await tx.lockForWrite('audit_log');
    if (policy.table === 'idempotency_keys') return purgeExpiredIdempotencyKeys(Number(before), config.retention.batchSize, tx);
    const rows = await selectBatch(tx, policy, before);
    if (!rows.length) return 0;
    if (archive) {
      const previous = await latestAuditCheckpoint(tx);
      if (canonicalJSON(rows) !== canonicalJSON(archivedRows) || (previous?.last_hash ?? GENESIS_HASH) !== archive.previous_hash) {
        // Another process made progress while this process wrote its archive.
        // Leave the harmless orphan; do not prune a different prefix.
        return 0;
      }
      await tx.run(`INSERT INTO audit_checkpoints
        (last_id, last_hash, previous_hash, archive_file, archive_sha256, created_at, signature) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [archive.last_id, archive.last_hash, archive.previous_hash, archive.archive_file, archive.archive_sha256, archive.created_at, archive.signature]);
    }
    if (policy.table === 'profile_views') {
      for (const row of rows) {
        await tx.run(`INSERT INTO profile_view_daily (player_id, scout_wallet, day, view_count) VALUES (?, ?, ?, 1)
          ON CONFLICT (player_id, scout_wallet, day) DO UPDATE SET view_count = profile_view_daily.view_count + 1`,
        [row.player_id, row.scout_wallet, Math.floor(Number(row.viewed_at) / DAY_MS)]);
      }
    }
    if (policy.table === 'data_export_jobs') {
      for (const row of rows) {
        await removeExportArchive(row);
        await tx.run('DELETE FROM export_download_tokens WHERE job_id = ?', [row.id]);
      }
    }
    const key = retentionTargets[policy.table].key;
    const ids = rows.map(row => row[key]);
    if (policy.table === 'audit_log') {
      // SQLite deployments may not have foreign_keys enabled; never rely on
      // cascading deletion to enforce the PII retention boundary.
      await tx.run(`DELETE FROM audit_log_pii WHERE audit_log_id IN (${ids.map(() => '?').join(',')})`, ids);
    }
    const result = await tx.run(`DELETE FROM ${policy.table} WHERE ${key} IN (${ids.map(() => '?').join(',')})`, ids);
    return result.changes;
  });
}

let running = false;
let stopping = false;
/** Dry runs issue SELECTs only, including no filesystem writes or metric changes. */
export async function runRetention(dryRun = false, now = Date.now()): Promise<RetentionResult[]> {
  if (running) throw new Error('Retention is already running');
  running = true;
  try {
    const results: RetentionResult[] = [];
    for (const policy of config.retention.policies) {
      const before = cutoff(policy, now);
      const count = await getDriver().get<{ count: string | number }>(`SELECT COUNT(*) AS count FROM ${policy.table} WHERE ${predicate(policy)}`, [before]);
      const result = { table: policy.table, eligible: Number(count?.count ?? 0), deleted: 0, batches: 0 };
      results.push(result);
      if (dryRun) continue;
      for (let batch = 0; batch < config.retention.maxBatches && !stopping; batch++) {
        const deleted = await pruneBatch(policy, before);
        if (!deleted) break;
        result.deleted += deleted;
        result.batches++;
        recordRetentionRun(policy.table, deleted, false);
        await new Promise(resolve => setTimeout(resolve, config.retention.pauseMs));
      }
      recordRetentionRun(policy.table, 0, !stopping);
      logger.info({ ...result }, 'Retention sweep completed');
    }
    return results;
  } finally { running = false; }
}

let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<unknown> | undefined;
export function startRetentionJob(): void {
  if (!config.retention.enabled || timer || inFlight) return;
  stopping = false;
  const schedule = () => {
    if (stopping) return;
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = runRetention().catch(err => logger.error({ err }, 'Retention sweep failed')).finally(() => {
        inFlight = undefined;
        schedule();
      });
    }, config.retention.intervalMs);
    timer.unref();
  };
  schedule();
}
export async function stopRetentionJob(): Promise<void> {
  stopping = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
  await inFlight;
}
