import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { pinJson } from '../services/ipfs';
import { getEvents } from '../db';
import { invalidateMilestoneCache } from '../services/cache';
import { recordAudit } from '../utils/audit';
import { PlayerMilestone } from '../types';

/**
 * Validates that an evidence URI is secure and properly formatted.
 * Accepts: ipfs://, https://
 * Rejects: http://, plain strings, empty strings
 */
export function isValidEvidenceUri(uri: string): boolean {
  if (!uri || typeof uri !== 'string') return false;
  return uri.startsWith('ipfs://') || uri.startsWith('https://');
}

export const milestoneSchema = z.object({
  playerId: z.string().min(1),
  milestoneType: z.enum(['identity', 'performance', 'trial_offer']),
  evidenceUri: z.string().min(1).refine(isValidEvidenceUri, 'evidenceUri must be a valid IPFS (ipfs://) or HTTPS URI'),
});

export const MAX_PAGE_SIZE = 100;

export const pendingQuerySchema = z.object({
  region: z.string().optional(),
  playerId: z.string().optional(),
  position: z.string().optional(),
  submittedBefore: z.coerce.number().int().optional(),
  submittedAfter: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

/** POST /api/validators/milestone */
function getCorrelationId(req: Request): string {
  return String(req.headers?.['x-correlation-id'] ?? req.headers?.['correlation-id'] ?? 'none');
}

export async function submitMilestoneEvidence(req: Request, res: Response, next: NextFunction) {
  try {
    const { playerId, milestoneType, evidenceUri } = milestoneSchema.parse(req.body);
    const evidenceCid = await pinJson({ playerId, milestoneType, evidenceUri });
    // Invalidate milestone + player cache so updated progress tier is reflected
    invalidateMilestoneCache(playerId);

    const validatorWallet = req.account ?? 'unknown';
    const correlationId = getCorrelationId(req);
    logger.info(
      `[validator] action=submit_milestone validator=${validatorWallet} playerId=${playerId} milestoneType=${milestoneType} evidenceCid=${evidenceCid} correlationId=${correlationId}`
    );

    recordAudit(validatorWallet, 'milestone_submitted', { playerId, milestoneType, evidenceCid }, `correlationId=${correlationId}`);

    res.status(201).json({ success: true, data: { evidenceCid } });
  } catch (err) {
    next(err);
  }
}

/** GET /api/validators/milestones/pending */
export async function getPendingMilestones(req: Request, res: Response, next: NextFunction) {
  try {
    const { region, playerId, position, submittedBefore, submittedAfter, page, pageSize } =
      pendingQuerySchema.parse(req.query);

    const submitted = getEvents('milestone_submitted').map((e) => e.payload);
    const approvedIds = new Set(
      getEvents('milestone_approved').map((e) => e.payload.milestone_id)
    );

    let pending = submitted.filter((m) => !approvedIds.has(m.milestone_id));
    if (region) pending = pending.filter((m) => m.region === region);
    if (playerId) pending = pending.filter((m) => m.player_id === playerId);
    if (position) pending = pending.filter((m) => m.position === position);
    if (submittedAfter !== undefined)
      pending = pending.filter((m) => (m.created_at as number) >= submittedAfter);
    if (submittedBefore !== undefined)
      pending = pending.filter((m) => (m.created_at as number) <= submittedBefore);

    const total = pending.length;
    const offset = (page - 1) * pageSize;
    const paginated = pending.slice(offset, offset + pageSize);

    const milestones: PlayerMilestone[] = paginated.map((m) => ({
      status: 'pending' as const,
      approvedBy: m.validator as string || '',
      submittedAt: m.created_at as number || Math.floor(Date.now() / 1000),
      evidenceUri: m.evidence_uri as string || '',
    }));

    const validatorWallet = req.account ?? 'unknown';
    recordAudit(validatorWallet, 'milestone_approved', { region: region ?? null, playerId: playerId ?? null, pendingCount: total }, 'pending milestones viewed');

    res.json({
      success: true,
      data: milestones,
      total,
      page,
      pageSize,
      hasMore: offset + pageSize < total,
    });
  } catch (err) {
    next(err);
  }
}
