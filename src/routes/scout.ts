import { Router } from 'express';
import {
  getSubscription,
  getUnlockedContacts,
  unlockContact,
  getPaymentHistory,
} from '../controllers/scoutController';
import { requireAuth } from '../middleware/auth';

const router = Router();

/**
 * GET /api/scouts/:wallet/subscription
 *
 * Returns the active subscription status for a scout wallet.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @response 200 { success: true, data: { active: boolean, tier: string, expiresAt: string } }
 * @response 401 { success: false, error: string } - Missing or invalid token
 * @auth Bearer (any authenticated user)
 */
router.get('/:wallet/subscription', requireAuth, getSubscription);

/**
 * GET /api/scouts/:wallet/contacts
 *
 * Returns the list of player contacts unlocked by this scout.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @response 200 { success: true, data: Contact[] }
 * @response 401 { success: false, error: string } - Missing or invalid token
 * @auth Bearer (any authenticated user)
 */
router.get('/:wallet/contacts', requireAuth, getUnlockedContacts);

/**
 * POST /api/scouts/:wallet/contacts/:playerId/unlock
 *
 * Records a pay-to-contact unlock for a player. The on-chain payment must be
 * completed via the Soroban pay_to_contact function before calling this endpoint.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param playerId {string} - Target player's on-chain identifier
 * @response 200 { success: true, data: Contact }
 * @response 401 { success: false, error: string } - Missing or invalid token
 * @auth Bearer (any authenticated user)
 */
router.post('/:wallet/contacts/:playerId/unlock', requireAuth, unlockContact);
router.get('/:wallet/payments', requireAuth, getPaymentHistory);

export default router;
