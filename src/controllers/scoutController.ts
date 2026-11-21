/**
 * Backward-compatibility barrel for the former monolithic scout controller.
 *
 * The controller was split into focused modules under `src/controllers/scout/`:
 *   - subscriptionController: subscription lifecycle (get/subscribe/renew/cancel)
 *   - contactsController:     contact list, details and paid unlock
 *   - paymentsController:     combined payment history
 *   - trialOffersController:  trial-offer submission and history
 *   - dashboardController:    consolidated scout home-screen dashboard
 *
 * Keep these re-exports for one release so existing importers
 * (`src/routes/scout.ts`, tests) continue to resolve unchanged.
 */

export {
  getSubscription,
  subscribe,
  renewSubscription,
  cancelSubscription,
  subscribeSchema,
} from './scout/subscriptionController';

export {
  getUnlockedContacts,
  getContactDetails,
  unlockContact,
  unlockContactSchema,
} from './scout/contactsController';

export { getPaymentHistory } from './scout/paymentsController';
export type { PaymentRecord } from './scout/paymentsController';

export {
  listTrialOffers,
  createTrialOffer,
  trialOfferSchema,
} from './scout/trialOffersController';

export { getScoutDashboard } from './scout/dashboardController';

export { paymentErrorStatus } from './scout/helpers';
