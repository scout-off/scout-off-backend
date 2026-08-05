import { Router } from 'express';
import {
  submitMilestoneEvidence,
  getPendingMilestones,
  milestoneSchema,
  pendingQuerySchema,
  approveBulkMilestones,
  bulkApproveSchema,
} from '../controllers/validatorController';
import { requireRole } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimit';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

const router = Router();

const milestoneRateLimit = rateLimit({
  name: 'validator-milestone',
  windowMs: Number(process.env.MILESTONE_RATE_WINDOW_MS) || 60_000,
  max: Number(process.env.MILESTONE_RATE_MAX) || 10,
});

router.route('/milestone')
  .post(milestoneRateLimit, requireRole('validator'), validateBody(milestoneSchema), submitMilestoneEvidence)
  .all(methodNotAllowed(['POST']));

router.route('/milestones/pending')
  .get(requireRole('validator'), validateQuery(pendingQuerySchema), getPendingMilestones)
  .all(methodNotAllowed(['GET', 'HEAD']));

router.route('/:wallet/milestones/pending')
  .get(requireRole('validator'), validateQuery(pendingQuerySchema), getPendingMilestones)
  .all(methodNotAllowed(['GET', 'HEAD']));

router.route('/milestones/approve-bulk')
  .post(requireRole('validator'), validateBody(bulkApproveSchema), approveBulkMilestones)
  .all(methodNotAllowed(['POST']));

export default router;
