/**
 * Admin multi-sig action service.
 *
 * Provides a typed interface for proposing and executing admin actions that
 * require multi-signature quorum before execution. Each action carries a full
 * payload so execution is atomic — a bulk import either succeeds for every
 * wallet or records a per-wallet failure manifest for targeted retry.
 */

import { logger } from '../utils/logger';
import { logAuditEvent } from './audit';

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

export interface AdminActionResult {
  actionId: string;
  type: AdminActionType;
  success: boolean;
  /** Present for bulk_validator_import — per-wallet outcome. */
  manifest?: WalletOutcome[];
  /** Present when the overall action failed. */
  error?: string;
}

// ─── Stub: on-chain registration ─────────────────────────────────────────────

/**
 * Stub: register a single validator on-chain.
 * Replace with a real Soroban invocation when the contract exposes
 * register_validator(wallet: Address).
 */
async function registerValidatorOnChain(wallet: string): Promise<void> {
  // TODO: invoke register_validator on Soroban contract
  logger.info(`[adminMultiSig] stub register_validator wallet=${wallet}`);
}

// ─── Bulk import ──────────────────────────────────────────────────────────────

/**
 * Execute a bulk_validator_import action atomically.
 *
 * The entire wallet list is treated as one action. Each wallet is attempted in
 * sequence and its outcome recorded. If any registration fails the action does
 * NOT report success — the manifest identifies which wallets need retry.
 *
 * Fully atomic on-chain rollback is not possible per-call; the manifest +
 * targeted retry path is the documented equivalent (see issue #1134).
 */
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
      logger.warn(
        `[adminMultiSig] bulk_validator_import partial failure actionId=${actionId} wallet=${wallet} error=${err instanceof Error ? err.message : err}`,
      );
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

// ─── Action dispatcher ────────────────────────────────────────────────────────

/**
 * Execute an admin action by type.
 * Extend this switch as new action types are added.
 */
export async function executeAdminAction(
  actionId: string,
  type: AdminActionType,
  payload: Record<string, unknown>,
  adminWallet: string,
): Promise<AdminActionResult> {
  switch (type) {
    case 'bulk_validator_import':
      return executeBulkValidatorImport(
        actionId,
        payload as BulkValidatorImportPayload,
        adminWallet,
      );

    case 'update_platform_fee':
      // Handled in a separate issue (#1133). Placeholder until wired.
      return {
        actionId,
        type,
        success: false,
        error: 'NOT_IMPLEMENTED: update_platform_fee is tracked in issue #1133',
      };

    default: {
      const exhaustive: never = type;
      return { actionId, type: exhaustive, success: false, error: `Unknown action type: ${type}` };
    }
  }
}
