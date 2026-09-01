import { createId } from '@paralleldrive/cuid2';
import config from '../config';
import {
  insertPendingAdminAction,
  getPendingAdminActionById,
  updatePendingAdminActionStatus,
  insertAdminActionSignature,
  incrementActionSignatures,
  getAdminActionSignature,
  getAdminActionSignatures,
  expireStalePendingAdminActions,
  getPendingAdminActionsByStatus,
  PendingAdminActionRow,
  insertFeeWithdrawal,
  getDriver,
} from '../db';
import { insertValidator, revokeValidatorRow } from './indexer';
import { logAuditEvent } from './audit';
import { logger } from '../utils/logger';
import { incrementFeeWithdrawalDbWriteFailuresTotal } from '../middleware/metrics';
import { ErrorCode } from '../utils/errorCodes';
import {
  pauseContractOnChain,
  unpauseContractOnChain,
  withdrawFees as stellarWithdrawFees,
  registerValidatorOnChain,
  revokeValidatorOnChain,
  type FeeWithdrawalResult,
  type ContractActionResult,
} from './stellar';

export type AdminActionType =
  | 'pause_contract'
  | 'unpause_contract'
  | 'withdraw_fees'
  | 'update_platform_fee'
  | 'register_validator'
  | 'revoke_validator'
  | 'bulk_validator_import';

export interface ProposalResult {
  actionId: string;
  status: 'proposed' | 'immediate';
}

export interface ApprovalResult {
  actionId: string;
  collected: number;
  required: number;
  status: 'approved' | 'pending' | 'expired' | 'duplicate';
}

export interface ExecutionResult {
  success: boolean;
  transactionId?: string;
  error?: string;
  errorCode?: string;
}

// ─── Execute the privileged operation for a specific action type ──────────────
async function executeAdminAction(
  actionType: AdminActionType,
  payload: Record<string, unknown>,
  proposer: string,
): Promise<ExecutionResult> {
  try {
    switch (actionType) {
      case 'pause_contract': {
        const result: ContractActionResult = await pauseContractOnChain(proposer);
        return { success: true, transactionId: result.transactionId };
      }

      case 'unpause_contract': {
        const result: ContractActionResult = await unpauseContractOnChain(proposer);
        return { success: true, transactionId: result.transactionId };
      }

      case 'withdraw_fees': {
        // Two call sites propose 'withdraw_fees' with different payload shapes:
        // the legacy /fees endpoint sends { recipient }, the fully-specified
        // /fees/withdraw (v2) endpoint sends { treasuryAddress, amountStroops }.
        // Accept either so quorum-reached execution works for both.
        const recipient = (payload.treasuryAddress ?? payload.recipient) as string | undefined;
        if (!recipient) {
          return { success: false, error: 'Missing recipient in payload', errorCode: 'INVALID_PAYLOAD' };
        }
        const amountStroops = payload.amountStroops as string | undefined;
        const result: FeeWithdrawalResult =
          amountStroops === undefined
            ? await stellarWithdrawFees(recipient)
            : await stellarWithdrawFees(recipient, amountStroops);

        // Record the withdrawal in the database
        try {
          await insertFeeWithdrawal({
            idempotencyKey: null, // Multi-sig actions don't use idempotency keys
            treasuryAddress: recipient,
            amountStroops: result.amount,
            txHash: result.transactionId,
            adminWallet: proposer,
            createdAt: new Date().toISOString(),
          });
        } catch (dbErr) {
          logger.error(
            `[multisig] fee_withdrawal_db_insert_failed txHash=${result.transactionId} err=${dbErr instanceof Error ? dbErr.message : dbErr}`,
          );
          // The on-chain withdrawal succeeded but has no DB row — this cannot be
          // undone, so make the gap loud and record enough to backfill manually.
          logger.critical(
            `[multisig] fee_withdrawal_db_write_failed txHash=${result.transactionId} recipient=${recipient} amount=${result.amount} err=${dbErr instanceof Error ? dbErr.message : dbErr}`,
          );
          incrementFeeWithdrawalDbWriteFailuresTotal();
        }

        return { success: true, transactionId: result.transactionId };
      }

      case 'register_validator': {
        const validatorWallet = payload.validatorWallet as string;
        if (!validatorWallet) {
          return { success: false, error: 'Missing validatorWallet in payload', errorCode: 'INVALID_PAYLOAD' };
        }
        const result: ContractActionResult = await registerValidatorOnChain(validatorWallet);

        // Record the validator in the database
        insertValidator(validatorWallet, result.transactionId);

        return { success: true, transactionId: result.transactionId };
      }

      case 'revoke_validator': {
        const validatorWallet = payload.validatorWallet as string;
        if (!validatorWallet) {
          return { success: false, error: 'Missing validatorWallet in payload', errorCode: 'INVALID_PAYLOAD' };
        }
        const result: ContractActionResult = await revokeValidatorOnChain(validatorWallet);

        // Record the revocation in the database
        revokeValidatorRow(validatorWallet, result.transactionId);

        return { success: true, transactionId: result.transactionId };
      }

      case 'bulk_validator_import': {
        const { wallet } = payload;
        if (!wallet) {
          return { success: false, error: 'Missing wallet in payload', errorCode: 'INVALID_PAYLOAD' };
        }
        const result: ContractActionResult = await registerValidatorOnChain(wallet as string);

        // Record the validator in the database
        insertValidator(wallet as string, result.transactionId);

        return { success: true, transactionId: result.transactionId };
      }

      case 'update_platform_fee': {
        // This would require a stellar contract function that doesn't exist yet
        logger.warn(`[multisig] update_platform_fee not yet implemented in stellar service`);
        return { success: false, error: 'update_platform_fee not yet implemented', errorCode: 'NOT_IMPLEMENTED' };
      }

      default: {
        const exhaustiveCheck: never = actionType;
        return {
          success: false,
          error: `Unknown action type: ${exhaustiveCheck}`,
          errorCode: 'INVALID_ACTION_TYPE',
        };
      }
    }
  } catch (err) {
    logger.error(
      `[multisig] execution_failed action=${actionType} error=${err instanceof Error ? err.message : err}`,
    );
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      errorCode: (err as NodeJS.ErrnoException)?.code ?? 'EXECUTION_FAILED',
    };
  }
}

// ─── Propose a high-value action ──────────────────────────────────────────────
// If threshold is 1, executes immediately (returns 'immediate').
// Otherwise persists a pending action for co-signing.

export async function proposeAction(
  actionType: AdminActionType,
  payload: Record<string, unknown>,
  proposer: string,
): Promise<ProposalResult> {
  await expireStalePendingAdminActions();

  const required = config.adminThreshold;
  if (required <= 1) {
    logAuditEvent({
      action: `${actionType}_proposed`,
      adminWallet: proposer,
      queryParams: { actionType, threshold: required, outcome: 'immediate' },
      timestamp: new Date().toISOString(),
    }).catch(() => {});
    return { actionId: '', status: 'immediate' };
  }

  const actionId = createId();
  const now = Date.now();
  const expiresAt = now + config.adminActionTtlMs;

  await insertPendingAdminAction({
    id: actionId,
    action_type: actionType,
    proposer,
    payload: JSON.stringify(payload),
    required_signatures: required,
    expires_at: expiresAt,
    created_at: now,
  });

  // The proposer is the first signer
  await insertAdminActionSignature({ action_id: actionId, signer: proposer, signed_at: now });
  await incrementActionSignatures(actionId);

  logAuditEvent({
    action: `${actionType}_proposed`,
    adminWallet: proposer,
    queryParams: {
      actionId,
      actionType,
      threshold: required,
      collected: 1,
      outcome: 'multisig_pending',
    },
    timestamp: new Date().toISOString(),
  }).catch(() => {});

  return { actionId, status: 'proposed' };
}

// ─── Co-sign an existing pending action ───────────────────────────────────────
// Each signer must be a distinct wallet from config.adminWallets.
// The same wallet cannot count twice. Expired proposals are rejected.
// Once the threshold is reached, status flips to 'executed' and the
// privileged on-chain operation runs exactly once.
//
// Atomicity strategy: we use INSERT OR IGNORE (SQLite) / INSERT … ON CONFLICT
// DO NOTHING (Postgres) inside a DB transaction to ensure that concurrent calls
// from the same signer can only ever insert one signature row.  The transaction
// also serialises the read-then-increment to prevent double-counting.
//
// Idempotency: the 'executed' status check at the top ensures that a retried
// call after successful quorum does not re-trigger execution.

export async function approveAction(
  actionId: string,
  signer: string,
): Promise<ApprovalResult> {
  await expireStalePendingAdminActions();

  const action = await getPendingAdminActionById(actionId);
  if (!action) {
    throw Object.assign(new Error('Pending action not found'), { code: 'ACTION_NOT_FOUND', status: 404 });
  }
  if (action.status === 'expired') {
    throw Object.assign(new Error('Action proposal has expired'), {
      code: ErrorCode.EXPIRED_ACTION,
      status: 410,
    });
  }
  if (action.status === 'executed') {
    throw Object.assign(new Error('Action has already been executed'), {
      code: ErrorCode.ACTION_EXECUTED,
      status: 409,
    });
  }
  if (action.status !== 'pending') {
    throw Object.assign(new Error('Action is not in a pending state'), {
      code: ErrorCode.CONFLICT,
      status: 400,
    });
  }

  if (Date.now() > action.expires_at) {
    await updatePendingAdminActionStatus(actionId, 'expired');
    throw Object.assign(new Error('Action proposal has expired'), { code: ErrorCode.EXPIRED_ACTION, status: 410 });
  }

  if (!config.adminWallets.includes(signer)) {
    throw Object.assign(new Error('Insufficient permissions'), { code: ErrorCode.FORBIDDEN, status: 403 });
  }

  // Check for duplicate signer
  const existingSig = await getAdminActionSignature(actionId, signer);
  if (existingSig) {
    return {
      actionId,
      collected: action.collected_signatures,
      required: action.required_signatures,
      status: 'duplicate',
    };
  }

  const now = Date.now();
  await insertAdminActionSignature({ action_id: actionId, signer, signed_at: now });
  await incrementActionSignatures(actionId);

  const updated = await getPendingAdminActionById(actionId);
  const collected = updated?.collected_signatures ?? action.collected_signatures + 1;

  logAuditEvent({
    action: `${action.action_type}_approved`,
    adminWallet: signer,
    queryParams: {
      actionId,
      actionType: action.action_type,
      collected,
      required: action.required_signatures,
      outcome: collected >= action.required_signatures ? 'threshold_met' : 'partially_signed',
    },
    timestamp: new Date().toISOString(),
  }).catch(() => {});

  if (collected >= action.required_signatures) {
    await updatePendingAdminActionStatus(actionId, 'executed');
    logger.info(`[multisig] action=${action.action_type} id=${actionId} threshold=${action.required_signatures} collected=${collected} — executing`);
    return { actionId, collected, required: action.required_signatures, status: 'approved' };
  }

  // ── Quorum reached — mark as executed then fire the real operation ────────
  // We mark 'executed' before calling the on-chain function so that a second
  // concurrent request that reaches this branch (theoretically possible if two
  // signers submit the Nth signature simultaneously in separate requests) will
  // hit the 'already executed' guard at the top of this function on its next
  // read, rather than double-firing.  If the on-chain call fails we revert the
  // status to 'pending' to allow retry.
  updatePendingAdminActionStatus(actionId, 'executed');

  logger.info(
    `[multisig] action=${action.action_type} id=${actionId} threshold=${action.required_signatures} collected=${collected} — executing`,
  );

  const payload = JSON.parse(action.payload) as Record<string, unknown>;
  const executionResult = await executeAdminAction(
    action.action_type as AdminActionType,
    payload,
    action.proposer,
  );

  if (!executionResult.success) {
    // Revert to pending so an operator can retry or investigate
    updatePendingAdminActionStatus(actionId, 'pending');

    logAuditEvent({
      action: `${action.action_type}_execution_failed`,
      adminWallet: signer,
      queryParams: {
        actionId,
        actionType: action.action_type,
        error: executionResult.error,
        errorCode: executionResult.errorCode,
        outcome: 'execution_failed',
      },
      timestamp: new Date().toISOString(),
    });

    throw Object.assign(
      new Error(executionResult.error ?? 'Execution failed'),
      { code: executionResult.errorCode ?? 'EXECUTION_FAILED', status: 500 },
    );
  }

  logAuditEvent({
    action: `${action.action_type}_executed`,
    adminWallet: signer,
    queryParams: {
      actionId,
      actionType: action.action_type,
      transactionId: executionResult.transactionId,
      outcome: 'execution_succeeded',
    },
    timestamp: new Date().toISOString(),
  });

  return { actionId, collected, required: action.required_signatures, status: 'approved' };
}

// ─── Lookup pending actions (with expiry sweep) ──────────────────────────────

export async function listPendingActions(): Promise<PendingAdminActionRow[]> {
  await expireStalePendingAdminActions();
  return getPendingAdminActionsByStatus('pending');
}

export async function getActionDetails(actionId: string): Promise<{
  action: PendingAdminActionRow;
  signatures: { signer: string; signed_at: number }[];
} | null> {
  const action = await getPendingAdminActionById(actionId);
  if (!action) return null;
  const signatures = await getAdminActionSignatures(actionId);
  return { action, signatures };
}
