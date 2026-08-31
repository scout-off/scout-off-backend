/**
 * Admin multi-sig action service.
 *
 * Provides a typed interface for proposing and executing admin actions that
 * require multi-signature quorum before execution.
 */

import { logger } from '../utils/logger';
import { logAuditEvent } from './audit';
import { updatePlatformFee } from './stellar';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AdminActionType =
  | 'bulk_validator_import'
  | 'update_platform_fee';

export interface WalletOutcome {
  wallet: string;
  success: boolean;
  error?: string;
}

export interface BulkValidatorImportPayload {
  wallets: string[];
}

export interface UpdatePlatformFeePayload {
  newFeeBps: number;
}

export interface AdminActionResult {
  actionId: string;
  type: AdminActionType;
  success: boolean;
  /** Present for bulk_validator_import — per-wallet outcome. */
  manifest?: WalletOutcome[];
  /** Present for update_platform_fee — new fee value. */
  newFeeBps?: number;
  transactionId?: string;
  /** Present when the overall action failed. */
  error?: string;
}

// ─── Stub: on-chain registration ─────────────────────────────────────────────

async function registerValidatorOnChain(wallet: string): Promise<void> {
  // TODO: invoke register_validator on Soroban contract
  logger.info(`[adminMultiSig] stub register_validator wallet=${wallet}`);
}

// ─── Bulk import ──────────────────────────────────────────────────────────────

export async function executeBulkValidatorImport(
  actionId: string,
  payload: BulkValidatorImportPayload,
  adminWallet: string,
): Promise<AdminActionResult> {
  const { wallets } = payload;
  const manifest: WalletOutcome[] = [];
  let hasFailure = false;

  logger.info(
    `[adminMultiSig] action=bulk_validator_import actionId=${actionId} count=${wallets.length} admin=${adminWallet}`,
  );

  for (const wallet of wallets) {
    try {
      await registerValidatorOnChain(wallet);
      manifest.push({ wallet, success: true });
    } catch (err) {
      hasFailure = true;
      manifest.push({
        wallet,
        success: false,
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  const succeeded = manifest.filter((o) => o.success).length;
  const failed = manifest.filter((o) => !o.success).length;

  logAuditEvent({
    action: 'bulk_validator_import',
    adminWallet,
    queryParams: { actionId, total: wallets.length, succeeded, failed },
    timestamp: new Date().toISOString(),
  });

  if (hasFailure) {
    return {
      actionId,
      type: 'bulk_validator_import',
      success: false,
      manifest,
      error: `Partial import: ${failed} of ${wallets.length} wallets failed. Retry using the manifest.`,
    };
  }

  return { actionId, type: 'bulk_validator_import', success: true, manifest };
}

// ─── Update platform fee ──────────────────────────────────────────────────────

export async function executeUpdatePlatformFee(
  actionId: string,
  payload: UpdatePlatformFeePayload,
  adminWallet: string,
): Promise<AdminActionResult> {
  const { newFeeBps } = payload;

  if (newFeeBps < 0 || newFeeBps > 10000) {
    return { actionId, type: 'update_platform_fee', success: false, error: 'newFeeBps must be between 0 and 10000' };
  }

  logger.info(
    `[adminMultiSig] action=update_platform_fee actionId=${actionId} newFeeBps=${newFeeBps} admin=${adminWallet}`,
  );

  const result = await updatePlatformFee(newFeeBps);

  logAuditEvent({
    action: 'update_platform_fee',
    adminWallet,
    queryParams: { actionId, newFeeBps, transactionId: result.transactionId },
    timestamp: new Date().toISOString(),
  });

  return {
    actionId,
    type: 'update_platform_fee',
    success: true,
    newFeeBps: result.newFeeBps,
    transactionId: result.transactionId,
  };
}

// ─── Action dispatcher ────────────────────────────────────────────────────────

export async function executeAdminAction(
  actionId: string,
  type: AdminActionType,
  payload: Record<string, unknown>,
  adminWallet: string,
): Promise<AdminActionResult> {
  switch (type) {
    case 'bulk_validator_import':
      return executeBulkValidatorImport(actionId, payload as BulkValidatorImportPayload, adminWallet);

    case 'update_platform_fee':
      return executeUpdatePlatformFee(actionId, payload as UpdatePlatformFeePayload, adminWallet);

    default: {
      const exhaustive: never = type;
      return { actionId, type: exhaustive, success: false, error: `Unknown action type: ${type}` };
    }
  }
}
