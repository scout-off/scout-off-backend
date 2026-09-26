import { Request, Response, NextFunction } from 'express';
import { getValidatorStats } from '../db';
import { getAllValidators, insertValidator, revokeValidatorRow, getValidatorByWallet } from '../services/indexer';
import { isValidStellarAddress } from '../utils/stellarAddress';
import { logAuditEvent } from '../services/audit';
import { registerValidatorOnChain, revokeValidatorOnChain, ValidatorActionError } from '../services/stellar';
import config from '../config';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';
import { proposeAction } from '../services/adminMultiSig';

/** GET /api/admin/validators */
export async function listValidators(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.json({ success: true, data: await getAllValidators() });
}

/**
 * POST /api/admin/validators/register
 * Invokes register_validator(validator) on the Soroban contract via the
 * platform keypair. The local `validators` row is only inserted after
 * on-chain confirmation, so a failed/rejected chain call never leaves a
 * local row that doesn't reflect contract state.
 */
export async function registerValidator(req: Request, res: Response, next: NextFunction): Promise<void> {
  const adminWallet = req.account ?? 'unknown';
  const { validatorWallet } = req.body as { validatorWallet?: string };

  if (!validatorWallet || !isValidStellarAddress(validatorWallet)) {
    logger.warn(`[admin] register_validator rejected — invalid address | admin=${adminWallet} target=${validatorWallet}`);
    res.status(400).json({
      success: false,
      error: 'Validation Error',
      details: [{ field: 'validatorWallet', message: 'Invalid Stellar address' }],
      code: ErrorCode.VALIDATION_ERROR,
    });
    return;
  }

  // Multi-sig threshold check: propose when threshold > 1.
  if (!config.adminWallets.includes(adminWallet)) {
    res.status(403).json({ success: false, error: 'Insufficient permissions' });
    return;
  }

  const proposal = await proposeAction('register_validator', { validatorWallet, action: 'register_validator' }, adminWallet);
  if (proposal.status === 'proposed') {
    logAuditEvent({
      action: 'validator_registration',
      adminWallet,
      queryParams: { validatorWallet, actionId: proposal.actionId, outcome: 'multisig_pending' },
      timestamp: new Date().toISOString(),
      contractAction: 'register_validator',
    });
    res.status(202).json({
      success: true,
      message: `Validator registration proposed, awaiting ${config.adminThreshold - 1} more admin signature(s)`,
      data: { actionId: proposal.actionId, collectedSignatures: 1, requiredSignatures: config.adminThreshold },
    });
    return;
  }

  try {
    logger.info(`[admin] action=register_validator admin=${adminWallet} target=${validatorWallet}`);
    // Audit the attempt before submitting the on-chain transaction (pre-transaction state).
    await logAuditEvent({
      action: 'validator_registration',
      adminWallet,
      queryParams: { validatorWallet },
      timestamp: new Date().toISOString(),
      contractAction: 'register_validator',
    }).catch(() => {});

    const result = await registerValidatorOnChain(validatorWallet);

    // Only mutate the local row once the chain has confirmed the register —
    // never mark it active locally while the contract call is still in flight.
    await insertValidator(validatorWallet, result.transactionId);

    await logAuditEvent({
      action: 'validator_registration',
      adminWallet,
      queryParams: { validatorWallet, transactionId: result.transactionId, outcome: 'success' },
      timestamp: new Date().toISOString(),
      contractAction: 'register_validator',
    }).catch(() => {});

    res.status(202).json({
      success: true,
      message: `Validator ${validatorWallet} registration submitted`,
      transactionId: result.transactionId,
    });
  } catch (err) {
    await logAuditEvent({
      action: 'validator_registration',
      adminWallet,
      queryParams: {
        validatorWallet,
        error: err instanceof Error ? err.message : 'unknown_error',
        errorCode: err instanceof ValidatorActionError ? err.code : 'UNKNOWN',
        outcome: 'failure',
      },
      timestamp: new Date().toISOString(),
      contractAction: 'register_validator',
    }).catch(() => {});

    if (err instanceof ValidatorActionError) {
      switch (err.code) {
        case 'ALREADY_REGISTERED':
          res.status(409).json({ success: false, error: 'Validator is already registered on-chain', code: ErrorCode.CONFLICT });
          return;
        case 'UNAUTHORIZED':
          res.status(403).json({ success: false, error: 'Unauthorized to register this validator', code: ErrorCode.FORBIDDEN });
          return;
        case 'NETWORK_ERROR':
          res.status(503).json({ success: false, error: 'Network error; please retry', code: ErrorCode.NETWORK_ERROR });
          return;
      }
    }
    next(err);
  }
}

/**
 * POST /api/admin/validators/revoke
 * Invokes revoke_validator(validator) on the Soroban contract via the
 * platform keypair. The local `validators` row is only marked revoked after
 * on-chain confirmation, so a failed/rejected chain call never leaves the
 * local row out of sync with contract state.
 */
export async function revokeValidator(req: Request, res: Response, next: NextFunction): Promise<void> {
  const adminWallet = req.account ?? 'unknown';
  const { validatorWallet } = req.body as { validatorWallet?: string };

  if (!validatorWallet || !isValidStellarAddress(validatorWallet)) {
    logger.warn(`[admin] revoke_validator rejected — invalid address | admin=${adminWallet} target=${validatorWallet}`);
    res.status(400).json({ success: false, error: 'validatorWallet must be a valid Stellar address', code: ErrorCode.VALIDATION_ERROR });
    return;
  }

  // Multi-sig threshold check.
  if (!config.adminWallets.includes(adminWallet)) {
    res.status(403).json({ success: false, error: 'Insufficient permissions' });
    return;
  }

  // Short-circuit on already-revoked local state before touching the chain.
  const existing = await getValidatorByWallet(validatorWallet);
  if (existing?.revoked_at != null) {
    res.status(409).json({
      success: false,
      error: `Validator ${validatorWallet} is already revoked`,
      code: ErrorCode.CONFLICT,
    });
    return;
  }

  const proposal = await proposeAction('revoke_validator', { validatorWallet, action: 'revoke_validator' }, adminWallet);
  if (proposal.status === 'proposed') {
    logAuditEvent({
      action: 'validator_revocation',
      adminWallet,
      queryParams: { validatorWallet, actionId: proposal.actionId, outcome: 'multisig_pending' },
      timestamp: new Date().toISOString(),
      contractAction: 'revoke_validator',
    });
    res.status(202).json({
      success: true,
      message: `Validator revocation proposed, awaiting ${config.adminThreshold - 1} more admin signature(s)`,
      data: { actionId: proposal.actionId, collectedSignatures: 1, requiredSignatures: config.adminThreshold },
    });
    return;
  }

  try {
    logger.info(`[admin] action=revoke_validator admin=${adminWallet} target=${validatorWallet}`);
    // Audit the attempt before submitting the on-chain transaction (pre-transaction state).
    await logAuditEvent({
      action: 'validator_revocation',
      adminWallet,
      queryParams: { validatorWallet },
      timestamp: new Date().toISOString(),
      contractAction: 'revoke_validator',
    }).catch(() => {});

    const result = await revokeValidatorOnChain(validatorWallet);

    // Only mutate the local row once the chain has confirmed the revoke —
    // never mark revoked locally while the contract call is still in flight.
    await revokeValidatorRow(validatorWallet, result.transactionId);

    await logAuditEvent({
      action: 'validator_revocation',
      adminWallet,
      queryParams: { validatorWallet, transactionId: result.transactionId, outcome: 'success' },
      timestamp: new Date().toISOString(),
      contractAction: 'revoke_validator',
    }).catch(() => {});

    res.status(202).json({
      success: true,
      message: `Validator ${validatorWallet} revocation submitted`,
      transactionId: result.transactionId,
    });
  } catch (err) {
    await logAuditEvent({
      action: 'validator_revocation',
      adminWallet,
      queryParams: {
        validatorWallet,
        error: err instanceof Error ? err.message : 'unknown_error',
        errorCode: err instanceof ValidatorActionError ? err.code : 'UNKNOWN',
        outcome: 'failure',
      },
      timestamp: new Date().toISOString(),
      contractAction: 'revoke_validator',
    }).catch(() => {});

    if (err instanceof ValidatorActionError) {
      switch (err.code) {
        case 'ALREADY_REVOKED':
          res.status(409).json({ success: false, error: 'Validator is already revoked on-chain', code: ErrorCode.CONFLICT });
          return;
        case 'NOT_REGISTERED':
          res.status(409).json({ success: false, error: 'Wallet is not a registered validator on-chain', code: ErrorCode.CONFLICT });
          return;
        case 'UNAUTHORIZED':
          res.status(403).json({ success: false, error: 'Unauthorized to revoke this validator', code: ErrorCode.FORBIDDEN });
          return;
        case 'NETWORK_ERROR':
          res.status(503).json({ success: false, error: 'Network error; please retry', code: ErrorCode.NETWORK_ERROR });
          return;
      }
    }
    next(err);
  }
}

/**
 * POST /api/admin/contract/pause
 * Invokes pause() on the Soroban contract via the platform keypair.
 * Returns 409 if the contract is already paused.
 */

/**
 * GET /api/admin/validators/:wallet/stats
 * Returns validator stats: milestones_approved and milestones_rejected.
 */
export async function getValidatorStatsEndpoint(req: Request, res: Response, next: NextFunction): Promise<void> {
  const wallet = req.params.wallet as string;
  // Validate wallet address
  if (!isValidStellarAddress(wallet)) {
    res.status(400).json({ success: false, error: 'Invalid validator wallet address' });
    return;
  }
  const stats = await getValidatorStats(wallet);
  if (stats) {
    res.json({
      success: true,
      data: {
        wallet: stats.wallet,
        milestones_approved: stats.milestones_approved,
        milestones_rejected: stats.milestones_rejected
      }
    });
  } else {
    res.json({
      success: true,
      data: {
        wallet,
        milestones_approved: 0,
        milestones_rejected: 0
      }
    });
  }
}
