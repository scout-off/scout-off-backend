/**
 * Repository: admin multi-sig actions and signatures.
 * Moved from src/db/index.ts (#1322).
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver, timedQueryAsync } from '../query';

export interface PendingAdminActionRow {
  id: string;
  action_type: string;
  proposer: string;
  payload: string;
  required_signatures: number;
  collected_signatures: number;
  status: string;
  expires_at: number;
  created_at: number;
}

export async function insertPendingAdminAction(p: {
  id: string;
  action_type: string;
  proposer: string;
  payload: string;
  required_signatures: number;
  expires_at: number;
  created_at: number;
}): Promise<void> {
  const sql = `INSERT INTO pending_admin_actions (id, action_type, proposer, payload, required_signatures, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [p.id, p.action_type, p.proposer, p.payload, p.required_signatures, p.expires_at, p.created_at]));
}

export async function getPendingAdminActionById(id: string): Promise<PendingAdminActionRow | null> {
  const sql = `SELECT * FROM pending_admin_actions WHERE id = ?`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<PendingAdminActionRow>(sql, [id])) ?? null,
  );
}

export async function getPendingAdminActionsByStatus(status: string): Promise<PendingAdminActionRow[]> {
  const sql = `SELECT * FROM pending_admin_actions WHERE status = ? ORDER BY created_at DESC`;
  return timedQueryAsync(sql, () => getDriver().all<PendingAdminActionRow>(sql, [status]));
}

export async function updatePendingAdminActionStatus(id: string, status: string): Promise<void> {
  const sql = `UPDATE pending_admin_actions SET status = ? WHERE id = ?`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [status, id]));
}

export async function incrementActionSignatures(id: string): Promise<void> {
  const sql = `UPDATE pending_admin_actions SET collected_signatures = collected_signatures + 1 WHERE id = ?`;
  await timedQueryAsync(sql, () => getDriver().run(sql, [id]));
}

export async function expireStalePendingAdminActions(): Promise<number> {
  const sql = `UPDATE pending_admin_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`;
  const info = await timedQueryAsync(sql, () => getDriver().run(sql, [Date.now()]));
  return info.changes;
}

export async function insertAdminActionSignature(p: {
  action_id: string;
  signer: string;
  signed_at: number;
}): Promise<boolean> {
  const sql = `INSERT INTO admin_action_signatures (action_id, signer, signed_at) VALUES (?, ?, ?) ON CONFLICT (action_id, signer) DO NOTHING`;
  const info = await timedQueryAsync(sql, () => getDriver().run(sql, [p.action_id, p.signer, p.signed_at]));
  return info.changes > 0;
}

export async function getAdminActionSignature(action_id: string, signer: string): Promise<{ signed_at: number } | null> {
  const sql = `SELECT signed_at FROM admin_action_signatures WHERE action_id = ? AND signer = ?`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<{ signed_at: number }>(sql, [action_id, signer])) ?? null,
  );
}

export async function getAdminActionSignatures(action_id: string): Promise<{ signer: string; signed_at: number }[]> {
  const sql = `SELECT signer, signed_at FROM admin_action_signatures WHERE action_id = ? ORDER BY signed_at ASC`;
  return timedQueryAsync(sql, () => getDriver().all<{ signer: string; signed_at: number }>(sql, [action_id]));
}
