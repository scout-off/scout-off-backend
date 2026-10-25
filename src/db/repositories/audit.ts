/**
 * Repository: tamper-evident audit log.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';
import { computeChainHash, auditChainContent, GENESIS_HASH } from '../../utils/hashChain';
import { latestAuditCheckpoint } from '../../utils/auditCheckpoint';
import { SqliteDriver } from '../sqlite-driver';
import { PostgresDriver } from '../postgres-driver';

// ─── Audit log helpers ────────────────────────────────────────────────────────
//
// audit_log is a single, tamper-evident hash chain (see db/012_audit_log_hash_chain.sql
// and src/utils/hashChain.ts) shared by two callers: src/services/audit.ts's
// logAuditEvent (admin actions; event_source='admin_action') and
// src/utils/audit.ts's recordAudit/queryAudit (validator/player app events;
// event_source='app_event', formerly an in-memory array — see #464). Every
// insert reads the previous row's hash and chains onto it, so the two event
// sources interleave into one continuous, verifiable timeline.

export interface AuditLogRow {
  id: number;
  action: string;
  admin_wallet: string;
  query_params: string;
  created_at: string;
  prev_hash: string | null;
  hash: string;
  event_source: string;
}

/**
 * Inserts a row into audit_log and chains it onto the current end of the
 * hash chain. The "read the last hash, then insert" sequence below runs
 * inside driver.transaction() and takes tx.lockForWrite('audit_log') before
 * reading, which on both drivers guarantees no concurrent insertAuditLog
 * call can interleave between the read and the write: SqliteDriver
 * serializes all transactions on its single connection regardless (the lock
 * is a no-op there), while PostgresDriver's transactions run on genuinely
 * concurrent pooled connections — a plain BEGIN/COMMIT alone does NOT
 * prevent two of them from both reading the same "last row" under READ
 * COMMITTED, so the advisory lock is load-bearing there. A write that fails
 * (e.g. a dropped connection) throws here rather than silently vanishing —
 * callers must not swallow it.
 */
export async function insertAuditLog(p: {
  action: string;
  adminWallet?: string;
  queryParams?: Record<string, unknown>;
  createdAt: string;
  /** Defaults to 'admin_action' (the pre-existing caller, logAuditEvent). */
  eventSource?: string;
}): Promise<AuditLogRow> {
  const sql = 'INSERT INTO audit_log (hash-chained)';
  return timedQueryAsync(sql, () =>
    getDriver().transaction(async (tx) => {
      const adminWallet = p.adminWallet ?? '';
      const queryParams = JSON.stringify(p.queryParams ?? {});
      const eventSource = p.eventSource ?? 'admin_action';

      // See DbTxHandle.lockForWrite: without this, two concurrent
      // transactions on PostgresDriver's pooled connections can both read
      // the same "last row" below and both insert, producing two rows that
      // both chain onto the same prev_hash instead of a linear chain.
      await tx.lockForWrite('audit_log');

      const prevRow = await tx.get<{ hash: string }>(
        'SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1'
      );
      const checkpoint = await latestAuditCheckpoint(tx);
      const prevHash = prevRow?.hash ?? checkpoint?.last_hash ?? GENESIS_HASH;

      const hash = computeChainHash(
        auditChainContent({ action: p.action, adminWallet, queryParams, createdAt: p.createdAt, eventSource }),
        prevHash
      );

      const info = await tx.run(
        `INSERT INTO audit_log (action, admin_wallet, query_params, created_at, prev_hash, hash, event_source)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [p.action, adminWallet, queryParams, p.createdAt, prevHash, hash, eventSource]
      );

      return {
        id: info.lastId,
        action: p.action,
        admin_wallet: adminWallet,
        query_params: queryParams,
        created_at: p.createdAt,
        prev_hash: prevHash,
        hash,
        event_source: eventSource,
      };
    })
  );
}

export async function getAuditLogs(filters: {
  action?: string;
  startDate?: string;
  endDate?: string;
  eventSource?: string;
  actorWallet?: string;
  limit?: number;
  offset?: number;
}): Promise<AuditLogRow[]> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.action) { conditions.push('action = ?'); params.push(filters.action); }
  if (filters.startDate) { conditions.push('created_at >= ?'); params.push(filters.startDate); }
  if (filters.endDate) { conditions.push('created_at <= ?'); params.push(filters.endDate); }
  if (filters.eventSource) { conditions.push('event_source = ?'); params.push(filters.eventSource); }
  if (filters.actorWallet) { conditions.push('admin_wallet = ?'); params.push(filters.actorWallet); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
// sql-injection-check-ignore: `where` is built from hardcoded `col = ?` conditions; values are bound via params.
const sql = `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  return timedQueryAsync(sql, () => getDriver().all<AuditLogRow>(sql, [...params, limit, offset]));
}

export async function getAuditLogsCount(filters: {
  action?: string;
  startDate?: string;
  endDate?: string;
  eventSource?: string;
  actorWallet?: string;
}): Promise<number> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.action) { conditions.push('action = ?'); params.push(filters.action); }
  if (filters.startDate) { conditions.push('created_at >= ?'); params.push(filters.startDate); }
  if (filters.endDate) { conditions.push('created_at <= ?'); params.push(filters.endDate); }
  if (filters.eventSource) { conditions.push('event_source = ?'); params.push(filters.eventSource); }
  if (filters.actorWallet) { conditions.push('admin_wallet = ?'); params.push(filters.actorWallet); }
const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // sql-injection-check-ignore: `where` is built from hardcoded `col = ?` conditions; values are bound via params.
  const sql = `SELECT COUNT(*) AS count FROM audit_log ${where}`;
  return timedQueryAsync(sql, async () => {
    const row = await getDriver().get<{ count: number | string }>(sql, params);
    return Number(row?.count ?? 0);
  });
}

/**
 * Returns ALL audit_log rows matching the given filters, unpaginated and
 * ordered by id ascending (i.e. insertion / hash-chain order). Used by
 * verifyAuditChain() (needs every row, in chain order, to walk the whole
 * chain) and queryAudit() (the old in-memory auditStore had no pagination,
 * so this preserves that "just give me everything" contract).
 */
export async function getAllAuditLogRows(filters: {
  eventSource?: string;
  actorWallet?: string;
  action?: string;
} = {}): Promise<AuditLogRow[]> {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filters.action) { conditions.push('action = ?'); params.push(filters.action); }
  if (filters.eventSource) { conditions.push('event_source = ?'); params.push(filters.eventSource); }
  if (filters.actorWallet) { conditions.push('admin_wallet = ?'); params.push(filters.actorWallet); }
const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // sql-injection-check-ignore: `where` is built from hardcoded `col = ?` conditions; values are bound via params.
  const sql = `SELECT * FROM audit_log ${where} ORDER BY id ASC`;
  return timedQueryAsync(sql, () => getDriver().all<AuditLogRow>(sql, params));
}


/**
 * Returns at most `limit` audit_log rows with `id > afterId`, in chain order.
 *
 * The scheduled chain verifier (#1539) walks the table in bounded batches so
 * a large audit log is never loaded into memory in one go. Returning rows in
 * id order also matches hash-chain order (insertAuditLog serializes writes).
 */
export async function getAuditLogRowsAfterId(
  afterId: number,
  limit: number,
): Promise<AuditLogRow[]> {
  const sql = 'SELECT * FROM audit_log WHERE id > ? ORDER BY id ASC LIMIT ?';
  return timedQueryAsync(sql, () => getDriver().all<AuditLogRow>(sql, [afterId, limit]));
}
