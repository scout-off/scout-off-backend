import { Router } from 'express';
import {
  submitMilestoneEvidence,
  getPendingMilestones,
  milestoneSchema,
  pendingQuerySchema,
  approveBulkMilestones,
  bulkApproveSchema,
  getValidatorDashboardStats,
} from '../controllers/validatorController';
import { requireRole } from '../middleware/auth';
import { requireWalletOwner } from '../middleware/requireOwner';
import { validateBody, validateQuery } from '../middleware/validate';
import { rateLimit, playerRateLimit } from '../middleware/rateLimit';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

const router = Router();

const milestoneRateLimit = rateLimit({
  name: 'validator-milestone',
  windowMs: Number(process.env.MILESTONE_RATE_WINDOW_MS) || 60_000,
  max: Number(process.env.MILESTONE_RATE_MAX) || 10,
});

/**
 * Per-player rate limiter on POST /api/validators/milestone (#1137).
 * Keyed by `req.body.playerId` (extracted after body validation).
 * Configured via MILESTONE_PLAYER_RATE_WINDOW_MS / MILESTONE_PLAYER_RATE_MAX.
 * Independent of the IP and wallet limiters — namespaced as 'milestone-submit:player'.
 */
const milestonePlayerRateLimit = playerRateLimit();

/**
 * POST /api/validators/milestone
 *
 * Submit evidence for a player milestone. `evidenceUri` may be an
 * `https://` URL (downloaded and re-pinned to IPFS) or an `ipfs://` CID
 * (recorded directly). Invalidates the player's milestone cache on success.
 *
 * Rate-limited per IP, per validator wallet, and per target player_id (#1137).
 *
 * @body { playerId: string, milestoneType: 'identity'|'performance'|'trial_offer', evidenceUri: string }
 * @response 201 { success: true, data: { evidenceCid: string } }
 * @response 400 { success: false, error: string } - Invalid body
 * @response 413 { success: false, error: string } - Remote evidence file too large
 * @response 422 { success: false, error: string } - Remote evidence has an unsupported content type
 * @response 429 { success: false, error: string } - Per-player rate limit exceeded; Retry-After header set
 * @auth Bearer (validator role required)
 */
router.route('/milestone')
  .post(
    milestoneRateLimit,
    requireRole('validator'),
    validateBody(milestoneSchema),
    milestonePlayerRateLimit,
    submitMilestoneEvidence,
  )
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/validators/milestones/pending
 *
 * List pending milestones for the authenticated validator, optionally
 * filtered by region/position/playerId and paginated.
 *
 * @response 200 { success: true, data: PendingMilestone[], total, page, pageSize }
 * @auth Bearer (validator role required)
 */
router.route('/milestones/pending')
  .get(requireRole('validator'), validateQuery(pendingQuerySchema), getPendingMilestones)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/validators/:wallet/milestones/pending
 *
 * Same as GET /api/validators/milestones/pending, scoped explicitly to the
 * given validator wallet rather than the caller's own token.
 *
 * @param wallet {string} - Validator's Stellar public key
 * @response 200 { success: true, data: PendingMilestone[], total, page, pageSize }
 * @auth Bearer (validator role required)
 */
router.route('/:wallet/milestones/pending')
  .get(requireRole('validator'), validateQuery(pendingQuerySchema), getPendingMilestones)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/validators/milestones/approve-bulk
 *
 * Approve a batch of milestones assigned to the authenticated validator in
 * one call. Each ID is processed independently — a failure on one does not
 * abort the batch; per-ID outcomes are returned in `data`.
 *
 * @body { milestoneIds: string[] } - At least one ID required
 * @response 200 { success: true, data: Array<{ milestoneId, status: 'approved'|'invalid'|'unauthorized'|'error', error? }> }
 * @response 400 { success: false, error: string } - Empty milestoneIds
 * @auth Bearer (validator role required)
 */
router.route('/milestones/approve-bulk')
  .post(requireRole('validator'), validateBody(bulkApproveSchema), approveBulkMilestones)
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/validators/:wallet/stats
 *
 * Dashboard summary for a validator: pending count, all-time approved/rejected
 * totals, approvals in the last 30 days, and up to 20 recent activity events.
 *
 * Counts are derived from indexed milestone events — no separate write path.
 *
 * @param wallet {string} - Validator's Stellar public key
 * @response 200 { success: true, data: { wallet, pending, approvedTotal, rejectedTotal, approvedLast30d, recent: [...] } }
 * @response 401 { success: false, error: string } - Missing or invalid token
 * @response 403 { success: false, error: string } - Insufficient permissions or wallet mismatch
 * @auth Bearer (validator role required; own wallet only — admins may query any wallet)
 */
router.route('/:wallet/stats')
  .get(requireRole('validator'), requireWalletOwner(), getValidatorDashboardStats)
  .all(methodNotAllowed(['GET', 'HEAD']));

export default router;
