import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { approveAction, listPendingActions, getActionDetails, executeAdminAction } from '../services/adminMultiSig';
import config from '../config';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';

export const updatePlatformFeeSchema = z.object({
  actionId: z.string().min(1),
  newFeeBps: z.number().int().min(0).max(10000),
});

/**
 * POST /api/admin/fees/config
 *
 * Propose an update_platform_fee multi-sig action and execute it.
 * Routes through the existing admin multi-sig action dispatcher.
 */
export async function updatePlatformFeeController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const adminWallet = req.account ?? 'unknown';
    const parsed = updatePlatformFeeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request body' });
      return;
    }

    const { actionId, newFeeBps } = parsed.data;
    logger.info(`[admin] action=update_platform_fee actionId=${actionId} newFeeBps=${newFeeBps} admin=${adminWallet}`);

    const result = await executeAdminAction(
      actionId,
      'update_platform_fee',
      { newFeeBps },
      adminWallet,
    );

    if (!result.success) {
      res.status(400).json({ success: false, error: result.error });
      return;
    }

    res.status(202).json({
      success: true,
      data: { actionId, transactionId: result.transactionId, newFeeBps: result.newFeeBps },
    });
  } catch (err) {
    next(err);
  }
}

const STELLAR_ADDRESS_RE_BULK = /^G[A-Z2-7]{55}$/;

export const bulkValidatorImportSchema = z.object({
  actionId: z.string().min(1),
  wallets: z
    .array(z.string().regex(STELLAR_ADDRESS_RE_BULK, 'Each wallet must be a valid Stellar address'))
    .min(1, 'wallets must contain at least one address')
    .max(100, 'wallets may contain at most 100 addresses per batch'),
});

/**
 * POST /api/admin/validators/bulk-import
 *
 * Propose and execute an atomic bulk validator import as a single multi-sig action.
 * All wallets are processed together; partial success is reported via a manifest.
 */
export async function bulkValidatorImport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const adminWallet = req.account ?? 'unknown';
    const parsed = bulkValidatorImportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request body' });
      return;
    }

    const { actionId, wallets } = parsed.data;
    logger.info(`[admin] action=bulk_validator_import actionId=${actionId} count=${wallets.length} admin=${adminWallet}`);

    const result = await executeAdminAction(
      actionId,
      'bulk_validator_import',
      { wallets },
      adminWallet,
    );

    if (!result.success) {
      // Partial failure — 207 Multi-Status with manifest for retry
      res.status(207).json({ success: false, error: result.error, data: { manifest: result.manifest } });
      return;
    }

    res.status(202).json({ success: true, data: { actionId, manifest: result.manifest } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/actions/pending
 * List all pending multi-admin actions (expired ones are purged on read).
 */
export async function getPendingActions(req: Request, res: Response, next: NextFunction): Promise<void> {
  const actions = (await listPendingActions()).map((a) => ({
    id: a.id,
    actionType: a.action_type,
    proposer: a.proposer,
    payload: JSON.parse(a.payload),
    collectedSignatures: a.collected_signatures,
    requiredSignatures: a.required_signatures,
    expiresAt: a.expires_at,
    createdAt: a.created_at,
  }));
  res.json({ success: true, data: actions });
}

/**
 * GET /api/admin/actions/:id
 * Get details of a specific pending action including collected signers.
 */
export async function getPendingActionById(req: Request, res: Response, next: NextFunction): Promise<void> {
  const details = await getActionDetails(req.params.id as string);
  if (!details) {
    res.status(404).json({ success: false, error: 'Action not found', code: ErrorCode.NOT_FOUND });
    return;
  }
  res.json({
    success: true,
    data: {
      id: details.action.id,
      actionType: details.action.action_type,
      proposer: details.action.proposer,
      payload: JSON.parse(details.action.payload),
      status: details.action.status,
      collectedSignatures: details.action.collected_signatures,
      requiredSignatures: details.action.required_signatures,
      expiresAt: details.action.expires_at,
      createdAt: details.action.created_at,
      signers: details.signatures.map((s) => ({ wallet: s.signer, signedAt: s.signed_at })),
    },
  });
}

/**
 * POST /api/admin/actions/:id/approve
 * Co-sign a pending multi-admin action.
 */
export async function approvePendingAction(req: Request, res: Response, next: NextFunction): Promise<void> {
try {
    const adminWallet = req.account ?? 'unknown';

    if (!config.adminWallets.includes(adminWallet)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }

    const result = await approveAction(req.params.id as string, adminWallet);

    if (result.status === 'duplicate') {
      res.status(409).json({
        success: false,
        error: 'Admin has already signed this action',
        code: ErrorCode.CONFLICT,
        data: { actionId: result.actionId, collectedSignatures: result.collected, requiredSignatures: result.required },
      });
      return;
    }

    if (result.status === 'approved') {
      res.status(200).json({
        success: true,
        message: 'Approval threshold reached — action executed',
        data: {
          actionId: result.actionId,
          collectedSignatures: result.collected,
          requiredSignatures: result.required,
          status: 'executed',
        },
      });
      return;
    }

    res.status(202).json({
      success: true,
      message: `Signature recorded, ${result.required - result.collected} more signature(s) needed`,
      data: {
        actionId: result.actionId,
        collectedSignatures: result.collected,
        requiredSignatures: result.required,
        status: 'pending',
      },
    });
  } catch (err) {
    const error = err as Error & { code?: string; status?: number };
    if (error.status === 404) {
      res.status(404).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error.status === 410) {
      res.status(410).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error.status === 409) {
      res.status(409).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error.status === 403) {
      res.status(403).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error.status === 400) {
      res.status(400).json({ success: false, error: error.message, code: error.code });
      return;
    }
    next(err);
  }
}
