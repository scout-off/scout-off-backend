/**
 * Repository: fee withdrawals and fee config audit log.
 * Moved from src/db/index.ts (#1322).
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { timedQueryAsync, getDriver } from '../query';

export interface FeeWithdrawalRow {
  id: number;
  idempotency_key: string | null;
  treasury_address: string;
  amount_stroops: string;
  tx_hash: string;
  admin_wallet: string;
  created_at: string;
}

/**
 * Insert a confirmed fee withdrawal record.
 * UNIQUE constraints on tx_hash and idempotency_key prevent duplicates.
 */
export async function insertFeeWithdrawal(p: {
  idempotencyKey: string | null;
  treasuryAddress: string;
  amountStroops: string;
  txHash: string;
  adminWallet: string;
  createdAt: string;
}): Promise<number> {
  const sql = `
    INSERT INTO fee_withdrawals
      (idempotency_key, treasury_address, amount_stroops, tx_hash, admin_wallet, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
  `;
  return timedQueryAsync(sql, async () => {
    const info = await getDriver().run(sql, [
      p.idempotencyKey ?? null,
      p.treasuryAddress,
      p.amountStroops,
      p.txHash,
      p.adminWallet,
      p.createdAt,
    ]);
    return info.lastId;
  });
}

export async function getFeeWithdrawalByIdempotencyKey(key: string): Promise<FeeWithdrawalRow | null> {
  const sql = `SELECT * FROM fee_withdrawals WHERE idempotency_key = ? LIMIT 1`;
  return timedQueryAsync(sql, async () =>
    (await getDriver().get<FeeWithdrawalRow>(sql, [key])) ?? null,
  );
}

export async function listFeeWithdrawals(limit = 50, offset = 0): Promise<FeeWithdrawalRow[]> {
  const sql = `SELECT * FROM fee_withdrawals ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  return timedQueryAsync(sql, () => getDriver().all<FeeWithdrawalRow>(sql, [limit, offset]));
}

// ─── Fee config audit log (#1314) ────────────────────────────────────────────

export interface AdminFeeConfigLogRow {
  id: number;
  tx_hash: string;
  new_fee_bps: number;
  admin_wallet: string;
  created_at: number;
}

/** Insert an audit row when the on-chain platform fee is updated (#1314). */
export async function insertAdminFeeConfigLog(p: {
  txHash: string;
  newFeeBps: number;
  adminWallet: string;
  createdAt: number;
}): Promise<void> {
  const sql = `INSERT INTO admin_fee_config_log (tx_hash, new_fee_bps, admin_wallet, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(tx_hash) DO NOTHING`;
  await timedQueryAsync(sql, () =>
    getDriver().run(sql, [p.txHash, p.newFeeBps, p.adminWallet, p.createdAt]),
  );
}

export async function listAdminFeeConfigLog(limit = 50, offset = 0): Promise<AdminFeeConfigLogRow[]> {
  const sql = `SELECT * FROM admin_fee_config_log ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  return timedQueryAsync(sql, () =>
    getDriver().all<AdminFeeConfigLogRow>(sql, [limit, offset]),
  );
}
