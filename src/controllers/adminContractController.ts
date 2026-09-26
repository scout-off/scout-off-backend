import { Request, Response, NextFunction } from 'express';
import { logAuditEvent } from '../services/audit';
import { pauseContractOnChain, unpauseContractOnChain } from '../services/stellar';
import config from '../config';
import { ErrorCode } from '../utils/errorCodes';
import { proposeAction } from '../services/adminMultiSig';

export async function pauseContract(req: Request, res: Response, next: NextFunction): Promise<void> {
try {
    const adminWallet = req.account ?? 'unknown';
    // Check if admin wallet is in allowed admin wallets
    if (!config.adminWallets.includes(adminWallet)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }
    // Check threshold for high-value operations
    const proposal = await proposeAction('pause_contract', {}, adminWallet);
    if (proposal.status === 'immediate') {
      await logAuditEvent({
        action: 'contract_state_change',
        adminWallet,
        queryParams: {},
        timestamp: new Date().toISOString(),
        contractAction: 'pause_contract',
      }).catch(() => {});

      const result = await pauseContractOnChain(adminWallet);

      await logAuditEvent({
        action: 'contract_state_change',
        adminWallet,
        queryParams: { transactionId: result.transactionId, outcome: 'success' },
        timestamp: new Date().toISOString(),
        contractAction: 'pause_contract',
      }).catch(() => {});

      res.status(202).json({
        success: true,
        message: 'Contract paused successfully',
        transactionId: result.transactionId,
      });
      return;
    }
    res.status(202).json({
      success: true,
      message: `Contract pause proposed, awaiting ${config.adminThreshold - 1} more admin signature(s)`,
      data: { actionId: proposal.actionId, collectedSignatures: 1, requiredSignatures: config.adminThreshold },
    });
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === 'CONTRACT_ALREADY_PAUSED') {
      res.status(409).json({ success: false, error: 'Contract is already paused', code: ErrorCode.CONFLICT });
      return;
    }
    next(err);
  }
}

/**
 * POST /api/admin/contract/unpause
 * Invokes unpause() on the Soroban contract via the platform keypair.
 * Returns 409 if the contract is not currently paused.
 */
export async function unpauseContract(req: Request, res: Response, next: NextFunction): Promise<void> {
try {
    const adminWallet = req.account ?? 'unknown';
    // Check if admin wallet is in allowed admin wallets
    if (!config.adminWallets.includes(adminWallet)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }
    // Check threshold for high-value operations
    const proposal = await proposeAction('unpause_contract', {}, adminWallet);
    if (proposal.status === 'immediate') {
      await logAuditEvent({
        action: 'contract_state_change',
        adminWallet,
        queryParams: {},
        timestamp: new Date().toISOString(),
        contractAction: 'unpause_contract',
      }).catch(() => {});

      const result = await unpauseContractOnChain(adminWallet);

      await logAuditEvent({
        action: 'contract_state_change',
        adminWallet,
        queryParams: { transactionId: result.transactionId, outcome: 'success' },
        timestamp: new Date().toISOString(),
        contractAction: 'unpause_contract',
      }).catch(() => {});

      res.status(202).json({
        success: true,
        message: 'Contract unpaused successfully',
        transactionId: result.transactionId,
      });
      return;
    }
    res.status(202).json({
      success: true,
      message: `Contract unpause proposed, awaiting ${config.adminThreshold - 1} more admin signature(s)`,
      data: { actionId: proposal.actionId, collectedSignatures: 1, requiredSignatures: config.adminThreshold },
    });
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === 'CONTRACT_NOT_PAUSED') {
      res.status(409).json({ success: false, error: 'Contract is not currently paused', code: ErrorCode.CONFLICT });
      return;
    }
    next(err);
  }
}
