import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pinJson } from '../services/ipfs';
import { getEvents } from '../services/indexer';
import { invalidateMilestoneCache } from '../services/cache';
import { PlayerMilestone } from '../types';
import { logger } from '../utils/logger';

export const milestoneSchema = z.object({
  playerId: z.string().min(1),
  milestoneType: z.enum(['identity', 'performance', 'trial_offer']),
  evidenceUri: z.string().min(1),
});

export const pendingQuerySchema = z.object({
  region: z.string().optional(),
  playerId: z.string().optional(),
});

/** POST /api/validators/milestone */
function getCorrelationId(req: Request): string {
  return String(req.headers['x-correlation-id'] ?? req.headers['correlation-id'] ?? 'none');
}

export async function submitMilestoneEvidence(req: Request, res: Response, next: NextFunction) {
  try {
    const { playerId, milestoneType, evidenceUri } = milestoneSchema.parse(req.body);
    const evidenceCid = await pinJson({ playerId, milestoneType, evidenceUri });
    // Invalidate milestone + player cache so updated progress tier is reflected
    invalidateMilestoneCache(playerId);

    const validatorWallet = (req as any).account ?? 'unknown';
    const correlationId = getCorrelationId(req);
    logger.info(
      `[validator] action=submit_milestone validator=${validatorWallet} playerId=${playerId} milestoneType=${milestoneType} evidenceCid=${evidenceCid} correlationId=${correlationId}`
    );

    res.status(201).json({ success: true, data: { evidenceCid } });
  } catch (err) {
    next(err);
  }
}

/** GET /api/validators/milestones/pending */
export async function getPendingMilestones(req: Request, res: Response, next: NextFunction) {
  try {
    const { region, playerId } = pendingQuerySchema.parse(req.query);
    const submitted = getEvents('milestone_submitted').map((e) => e.payload);
    const approvedIds = new Set(
      getEvents('milestone_approved').map((e) => e.payload.milestone_id)
    );
    let pending = submitted.filter((m) => !approvedIds.has(m.milestone_id));
    if (region) pending = pending.filter((m) => m.region === region);
    if (playerId) pending = pending.filter((m) => m.playerId === playerId || m.player_id === playerId);
    const milestones: PlayerMilestone[] = pending.map((m) => ({
      status: 'pending' as const,
      approvedBy: m.validator as string || '',
      submittedAt: m.created_at as number || Math.floor(Date.now() / 1000),
      evidenceUri: m.evidence_uri as string || m.evidenceUri as string || '',
    }));
    res.json({ success: true, data: milestones });
  } catch (err) {
    next(err);
  }
}
