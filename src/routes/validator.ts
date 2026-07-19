import { Router } from 'express';
import {
  submitMilestoneEvidence,
  getPendingMilestones,
  milestoneSchema,
  pendingQuerySchema,
} from '../controllers/validatorController';
import { requireRole } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimit';

const router = Router();

const milestoneRateLimit = rateLimit({
  windowMs: Number(process.env.MILESTONE_RATE_WINDOW_MS) || 60_000,
  max: Number(process.env.MILESTONE_RATE_MAX) || 10,
});

router.post(
  '/milestone',
  milestoneRateLimit,
  requireRole('validator'),
  validateBody(milestoneSchema),
  submitMilestoneEvidence
);
router.get(
  '/milestones/pending',
  requireRole('validator'),
  validateQuery(pendingQuerySchema),
  getPendingMilestones
);

export default router;
