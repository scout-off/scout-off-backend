/**
 * Repository: IPFS pending-pin tracking and reconciliation.
 *
 * Moved verbatim out of the 3,500-line `src/db/index.ts` barrel (#1535);
 * behaviour is unchanged. `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';

// ─── Pending pin helpers ──────────────────────────────────────────────────────

export interface PendingPinRow {
  id: number;
  payload: string;
  attempts: number;
  created_at: string;
  last_tried: string | null;
  hash?: string | null;
  /** CID written by the winning upload instance once the pin succeeds. */
  resolved_cid?: string | null;
  status?: string;
  expired_reason?: string | null;
  last_reconciled_at?: string | null;
}

export async function insertPendingPin(p: {
  payload: string;
  created_at: string;
  last_tried: string;
  hash?: string | null;
}): Promise<boolean> {
  if (p.hash) {
    const sql = `INSERT INTO pending_pins (payload, hash, created_at, last_tried) VALUES (?, ?, ?, ?) ON CONFLICT (hash) DO NOTHING`;
    return timedQueryAsync(sql, async () => {
      const info = await getDriver().run(sql, [p.payload, p.hash, p.created_at, p.last_tried]);
      return info.changes > 0;
    });
  } else {
    const sql = `INSERT INTO pending_pins (payload, created_at, last_tried) VALUES (?, ?, ?)`;
    await timedQueryAsync(sql, () => getDriver().run(sql, [p.payload, p.created_at, p.last_tried]));
    return true;
  }
}

export async function getPendingPins(): Promise<PendingPinRow[]> {
  const sql = "SELECT * FROM pending_pins WHERE status IS NULL OR status = 'pending' ORDER BY created_at ASC";
  return timedQueryAsync(sql, () => getDriver().all<PendingPinRow>(sql));
}

export async function deletePendingPin(id: number): Promise<void> {
  const sql = 'DELETE FROM pending_pins WHERE id = ?';
  await timedQueryAsync(sql, () => getDriver().run(sql, [id]));
}

export async function deletePendingPinByHash(hash: string): Promise<void> {
  const sql = 'DELETE FROM pending_pins WHERE hash = ?';
  await timedQueryAsync(sql, () => getDriver().run(sql, [hash]));
}

export async function isPendingPinByHash(hash: string): Promise<boolean> {
  const sql = "SELECT 1 FROM pending_pins WHERE hash = ? AND (status IS NULL OR status = 'pending') LIMIT 1";
  return timedQueryAsync(sql, async () => (await getDriver().get(sql, [hash])) !== undefined);
}

export async function incrementPendingPinAttempts(id: number): Promise<void> {
  const sql = 'UPDATE pending_pins SET attempts = attempts + 1, last_tried = ? WHERE id = ?';
  await timedQueryAsync(sql, () => getDriver().run(sql, [new Date().toISOString(), id]));
}

/**
 * Persist the resolved CID on a pending_pins row identified by content hash.
 *
 * Called by the winning upload instance immediately after a successful Pinata
 * upload so that any other instance waiting on the same lock can retrieve the
 * CID from the DB instead of issuing a duplicate upload.
 */
export async function setPendingPinResolvedCid(hash: string, cid: string): Promise<void> {
  const sql = "UPDATE pending_pins SET resolved_cid = ?, status = 'resolved' WHERE hash = ?";
  await timedQueryAsync(sql, () => getDriver().run(sql, [cid, hash]));
}

/**
 * Return the resolved CID for a previously completed pin identified by content
 * hash, or null if none has been recorded yet (i.e. the winning instance is
 * still uploading or the row no longer exists).
 */
export async function getResolvedCidByHash(hash: string): Promise<string | null> {
  const sql = 'SELECT resolved_cid FROM pending_pins WHERE hash = ? LIMIT 1';
  const row = await timedQueryAsync(sql, () => getDriver().get<{ resolved_cid: string | null }>(sql, [hash]));
  return row?.resolved_cid ?? null;
}

/**
 * Return pending pins created on or before olderThanIso that are pending/unresolved.
 */
export async function getStalePendingPins(olderThanIso: string, limit = 50): Promise<PendingPinRow[]> {
  const sql = `SELECT * FROM pending_pins WHERE (status IS NULL OR status = 'pending') AND created_at <= ? ORDER BY created_at ASC LIMIT ?`;
  return timedQueryAsync(sql, () => getDriver().all<PendingPinRow>(sql, [olderThanIso, limit]));
}

/**
 * Update reconciliation outcome for a pending pin.
 * Can mark status='resolved', status='expired' with an expired_reason, or update retry metadata.
 */
export async function updatePendingPinReconciliation(p: {
  id: number;
  status: string;
  expiredReason?: string | null;
  resolvedCid?: string | null;
  lastReconciledAt?: string;
}): Promise<boolean> {
  const lastReconciled = p.lastReconciledAt ?? new Date().toISOString();
  const sql = `UPDATE pending_pins SET status = ?, expired_reason = ?, resolved_cid = COALESCE(?, resolved_cid), last_reconciled_at = ? WHERE id = ?`;
  const res = await timedQueryAsync(sql, () => getDriver().run(sql, [p.status, p.expiredReason ?? null, p.resolvedCid ?? null, lastReconciled, p.id]));
  return res.changes > 0;
}

/**
 * Count the number of stuck pending pins (status is pending and created_at <= olderThanIso).
 */
export async function countStuckPendingPins(olderThanIso: string): Promise<number> {
  const sql = `SELECT COUNT(*) as count FROM pending_pins WHERE (status IS NULL OR status = 'pending') AND created_at <= ?`;
  const row = await timedQueryAsync(sql, () => getDriver().get<{ count: number | string }>(sql, [olderThanIso]));
  return Number(row?.count ?? 0);
}
