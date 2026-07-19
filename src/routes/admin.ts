import { Router } from 'express';
import {
  getStats,
  getAllEvents,
  getFeeSummary,
  registerValidator,
  revokeValidator,
  introspectToken,
} from '../controllers/adminController';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

/**
 * GET /api/admin/stats
 *
 * Returns aggregate platform counts: players, milestones, subscriptions, and total events.
 *
 * @response 200 { success: true, data: { players, milestones, subscriptions, events } }
 * @auth Bearer (admin role required)
 */
router.get('/stats', requireRole('admin'), getStats);

/**
 * GET /api/admin/events
 *
 * Returns all indexed Soroban contract events in insertion order.
 *
 * @response 200 { success: true, data: AdminEvent[] }
 * @auth Bearer (any authenticated user)
 */
router.get('/events', requireAuth, getAllEvents);

/**
 * GET /api/admin/fees
 *
 * Returns a list of fee withdrawal events from the contract.
 *
 * @response 200 { success: true, data: FeeHistoryItem[] }
 * @auth Bearer (any authenticated user)
 */
router.get('/fees', requireAuth, getFeeSummary);

/**
 * POST /api/admin/validators/register
 *
 * Submits a request to register a new validator on the Soroban contract.
 * Only platform admins may call this endpoint.
 *
 * @body validatorWallet {string} - Stellar public key of the validator to register
 * @response 202 { success: true, message: string }
 * @response 400 { success: false, error: string } - Invalid Stellar address
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.post('/validators/register', requireRole('admin'), registerValidator);

/**
 * POST /api/admin/validators/revoke
 *
 * Submits a request to revoke an existing validator on the Soroban contract.
 * Only platform admins may call this endpoint.
 *
 * @body validatorWallet {string} - Stellar public key of the validator to revoke
 * @response 202 { success: true, message: string }
 * @response 400 { success: false, error: string } - Invalid Stellar address
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.post('/validators/revoke', requireRole('admin'), revokeValidator);

/**
 * POST /api/admin/introspect
 *
 * Validates a JWT and returns its payload metadata without exposing secrets.
 * Useful for admins to inspect token claims (subject, role, expiry).
 *
 * @body token {string} - JWT to introspect
 * @response 200 { success: true, data: { sub, role, iat, exp } }
 * @response 400 { success: false, error: string } - Missing token or invalid/expired JWT
 * @auth Bearer (admin role required)
 */
router.post('/introspect', requireRole('admin'), introspectToken);

export default router;
