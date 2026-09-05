import { Router } from 'express';
import {
  getSubscription,
  getUnlockedContacts,
  getContactDetails,
  unlockContact,
  getPaymentHistory,
  subscribe,
  renewSubscription,
  cancelSubscription,
  listTrialOffers,
  createTrialOffer,
  trialOfferSchema,
  unlockContactSchema,
  subscribeSchema,
  getScoutDashboard,
} from '../controllers/scoutController';
import { cancelTrialOfferHandler } from '../controllers/trialOfferController';
import { getScoutRecommendations } from '../controllers/scoutRecommendationsController';
import {
  putScoutNote,
  getScoutNoteHandler,
  listScoutNotesHandler,
  createPlayerNote,
  listPlayerNotes,
  updatePlayerNote,
  deletePlayerNote,
  upsertNoteSchema,
  noteContentSchema,
} from '../controllers/scoutNotesController';
import { issueApiKey, listApiKeys, revokeApiKey, rotateApiKey, issueKeySchema, rotateKeySchema } from '../controllers/apiKeyController';
import {
  addBookmark,
  removeBookmark,
  listBookmarks,
  createBookmarkFolder,
  listBookmarkFolders,
  deleteBookmarkFolderHandler,
  addBookmarkSchema,
  createBookmarkFolderSchema,
} from '../controllers/scoutBookmarksController';
import {
  createSavedSearch,
  listSavedSearches,
  deleteSavedSearchHandler,
  updateSavedSearchHandler,
  runSavedSearch,
  createSavedSearchSchema,
  updateSavedSearchSchema,
} from '../controllers/scoutSavedSearchesController';
import {
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  testWebhook,
  registerWebhookSchema,
} from '../controllers/webhookSubscriptionController';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag';
import { FeatureFlags } from '../services/featureFlags';
import { requireRole, requireApiKeyScope } from '../middleware/auth';
import { requireWalletOwner } from '../middleware/requireOwner';
import { idempotency } from '../middleware/idempotency';
import { validateBody } from '../middleware/validate';
import { walletRateLimit } from '../middleware/rateLimit';
import { methodNotAllowed } from '../middleware/methodNotAllowed';
import { emptyBodySchema } from '../validators/emptyBody';
import config from '../config';

const router = Router();

/**
 * Stricter, purpose-tuned limit for the webhook test-delivery route (#1037):
 * unlike a normal write, each call makes the backend issue an outbound HTTP
 * request to a caller-supplied URL, so it's rate limited separately from —
 * and more tightly than — the shared default walletRateLimit() pool used by
 * the other scout write endpoints below.
 */
const webhookTestRateLimit = walletRateLimit({
  name: 'webhook-test',
  windowMs: config.webhookTestRateLimit.windowMs,
  max: config.webhookTestRateLimit.max,
});

/**
 * GET /api/scouts/:wallet/subscription
 *
 * Returns the active subscription status for a scout wallet.
 * Response includes a `gracePeriodActive` boolean field.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @response 200 { success: true, data: { active, tier, expiresAt, remainingDays, gracePeriodActive } }
 * @response 401 { success: false, error: string } - Missing or invalid token
 * @auth Bearer (scout role required)
 */
router.route('/:wallet/subscription')
  .get(requireRole('scout'), requireApiKeyScope('read:subscription'), requireWalletOwner({ mismatchStatus: 401 }), getSubscription)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/scouts/:wallet/subscribe
 *
 * Purchase a new scout subscription.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @body { tier: 'basic' | 'premium', duration: number (1–365 days) }
 * @header Idempotency-Key {string} - Optional. Ensures safe retries: duplicate keys return
 *   the cached response for 24 hours without triggering a new on-chain transaction.
 * @response 201 { success: true, data: { transactionId, tier, expiresAt, status } }
 * @response 400 { success: false, error: string } - Invalid tier or duration
 * @response 402 { success: false, error: string } - Insufficient XLM balance
 * @response 403 { success: false, error: string } - Scout role required or wallet mismatch
 * @auth Bearer (scout role required)
 *
 * PUT /api/scouts/:wallet/subscribe
 *
 * Renew or create a subscription.
 * If an existing subscription exists, extends its expiry by `duration` days.
 * If no subscription exists, behaves like POST (creates a new one).
 *
 * @param wallet {string} - Scout's Stellar public key
 * @body { tier: 'basic' | 'premium', duration: number (1–365 days) }
 * @response 200 { success: true, data: { transactionId, tier, expiresAt, status } } - Renewal
 * @response 201 { success: true, data: { transactionId, tier, expiresAt, status } } - New subscription
 * @response 400 { success: false, error: string } - Invalid tier or duration
 * @response 402 { success: false, error: string } - Insufficient XLM balance
 * @response 403 { success: false, error: string } - Scout role required or wallet mismatch
 * @auth Bearer (scout role required)
 *
 * DELETE /api/scouts/:wallet/subscribe
 *
 * Cancel an active subscription. Records cancellation on-chain and locally.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @response 200 { success: true, data: { transactionId, cancelledAt, wallet } }
 * @response 403 { success: false, error: string } - Scout role required or wallet mismatch
 * @response 404 { success: false, error: string } - No active subscription found
 * @auth Bearer (scout role required)
 */
router.route('/:wallet/subscribe')
  .post(requireRole('scout'), requireWalletOwner({ validateAddress: false }), requireApiKeyScope('write:subscriptions'), walletRateLimit(), idempotency, validateBody(subscribeSchema), subscribe)
  .put(requireRole('scout'), requireWalletOwner({ validateAddress: false }), requireApiKeyScope('write:subscriptions'), walletRateLimit(), validateBody(subscribeSchema), renewSubscription)
  .delete(requireRole('scout'), requireWalletOwner({ validateAddress: false }), requireApiKeyScope('write:subscriptions'), cancelSubscription)
  .all(methodNotAllowed(['POST', 'PUT', 'DELETE']));

/**
 * GET /api/scouts/:wallet/contacts
 *
 * List all players this scout has unlocked contact details for. Supports an
 * optional `?playerId=` filter to check a single player.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @query playerId {string} - Optional — restrict to a single player
 * @response 200 { success: true, data: Array<{ playerId, contact_status: 'unlocked', unlockedAt }> }
 * @response 401 { success: false, error: string } - Wallet mismatch or missing token
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/contacts')
  .get(requireRole('scout'), requireWalletOwner({ mismatchStatus: 401 }), getUnlockedContacts)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/scouts/:wallet/contacts/:playerId
 *
 * Return full contact details for a player this scout has already unlocked.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @response 200 { success: true, data: ContactDetails }
 * @response 401 { success: false, error: string } - Wallet mismatch or missing token
 * @response 403 { success: false, error: string } - Contact not unlocked
 * @response 404 { success: false, error: string } - Player not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/contacts/:playerId')
  .get(requireRole('scout'), requireWalletOwner({ mismatchStatus: 401, validateAddress: false }), getContactDetails)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/scouts/:wallet/contacts/:playerId/unlock
 *
 * Pay-to-contact XLM micro-fee flow (#761): the idempotency middleware is
 * configured with a request fingerprint (wallet + playerId) so replaying the
 * same Idempotency-Key with a materially different request is rejected with
 * 409 instead of reusing the cached response, and duplicate requests with the
 * same key never submit a second blockchain transaction. Already-unlocked
 * players are returned without a second charge (`alreadyUnlocked: true`).
 *
 * @summary Pay the XLM micro-fee to unlock a player's contact details.
 * @param wallet {string} - Scout's Stellar public key
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @response 200 { success: true, data: { alreadyUnlocked?: true, transactionId?, status?, ...ContactDetails } }
 * @response 400 { success: false, error: string } - Missing params or scout trying to unlock their own profile
 * @response 401 { success: false, error: string } - Wallet mismatch or missing token
 * @response 402 { success: false, error: string, code } - Payment failed (see PaymentError code)
 * @response 404 { success: false, error: string } - Player not found
 * @response 409 { success: false, error: string } - Idempotency key reused with a different request
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route("/:wallet/contacts/:playerId/unlock")
  .post(
    requireRole("scout"),
    requireWalletOwner(),
    requireApiKeyScope('write:contacts'),
    walletRateLimit(),
    idempotency({
      requestFingerprint: (req) => `${req.params.wallet}:${req.params.playerId}`,
    }),
    validateBody(unlockContactSchema),
    unlockContact,
  )
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/scouts/:wallet/payments
 *
 * Combined payment history (contact unlocks + subscription purchases),
 * newest first. Supports `from`/`to` (ISO date), `type`
 * ('contact_unlock'|'subscription'), pagination, and `format=csv` for a
 * downloadable export.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @query from {string} - Optional ISO date lower bound
 * @query to {string} - Optional ISO date upper bound
 * @query type {string} - Optional filter: 'contact_unlock' | 'subscription'
 * @query page {integer} - Default 1
 * @query pageSize {integer} - Default 50, max 100
 * @query format {string} - 'json' (default) | 'csv'
 * @response 200 { success: true, data: PaymentRecord[], total, page, pageSize } (or text/csv when format=csv)
 * @response 400 { success: false, error: string } - Invalid query parameters or dates
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/payments')
  .get(requireRole('scout'), requireWalletOwner(), getPaymentHistory)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/scouts/:wallet/trial-offer
 *
 * DEPRECATED alias of POST /api/scouts/:wallet/trial-offers (#1034). It runs the
 * same handler, so it carries the same middleware chain — including walletRateLimit
 * and idempotency, which guard the on-chain submission this route now performs.
 *
 * @deprecated Use POST /api/scouts/:wallet/trial-offers instead.
 * @param wallet {string} - Scout's Stellar public key
 * @body { playerId: string, detailsUri: string }
 * @response 201 { success: true, data: { offerId, transactionId, scout, playerId, detailsUri, createdAt, tierPromoted: true, newTier: 3 } }
 * @response 400 { success: false, error: string } - Invalid body
 * @response 401 { success: false, error: string } - Wallet mismatch or missing token
 * @response 402 { success: false, error: string, code } - Scout lacks an active subscription or contact unlock for this player
 * @response 404 { success: false, error: string } - Player not found
 * @response 409 { success: false, error: string } - Idempotency key reused with a different request
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/trial-offer')
  .post(
    requireRole('scout'),
    requireWalletOwner({ validateAddress: false }),
    requireApiKeyScope('write:trial_offers'),
    walletRateLimit(),
    idempotency,
    validateBody(trialOfferSchema),
    createTrialOffer,
  )
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/scouts/:wallet/trial-offers
 *
 * On-chain trial-offer event history submitted by this scout.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @response 200 { success: true, data: TrialOfferEvent[] }
 * @auth Bearer (scout role required)
 *
 * POST /api/scouts/:wallet/trial-offers
 *
 * Canonical trial-offer submission (#285, #770): submits the offer on-chain,
 * indexes it locally by tx_hash, promotes the player's tier and broadcasts SSE.
 * The singular /trial-offer path above is a deprecated alias of this POST.
 * Distinct from the accept/reject workflow in trialOfferController.
 *
 * @summary Submit a trial offer on-chain and promote the player to Elite Tier.
 * @param wallet {string} - Scout's Stellar public key
 * @body { playerId: string, detailsUri: string }
 * @response 201 { success: true, data: { offerId, transactionId, scout, playerId, detailsUri, createdAt, tierPromoted: true, newTier: 3 } }
 * @response 400 { success: false, error: string } - Invalid body
 * @response 401 { success: false, error: string } - Wallet mismatch or missing token
 * @response 402 { success: false, error: string, code } - Scout lacks an active subscription or contact unlock for this player
 * @response 404 { success: false, error: string } - Player not found
 * @response 409 { success: false, error: string } - Idempotency key reused with a different request
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/trial-offers')
  .get(requireRole('scout'), listTrialOffers)
  .post(
    requireRole('scout'),
    requireWalletOwner({ validateAddress: false }),
    requireApiKeyScope('write:trial_offers'),
    walletRateLimit(),
    idempotency,
    validateBody(trialOfferSchema),
    createTrialOffer,
  )
  .all(methodNotAllowed(['GET', 'POST', 'HEAD']));

/**
 * DELETE /api/scouts/:wallet/trial-offers/:offerId
 *
 * Cancel (withdraw) a pending trial offer submitted by this scout.
 * Only the originating scout may cancel their own offer, and only while it is
 * still in 'pending' status — the player has not yet accepted or rejected it.
 *
 * After cancellation, the player's accept/reject attempts return 410 Gone.
 *
 * @param wallet  {string} - Scout's Stellar public key
 * @param offerId {string} - Trial offer ID to cancel
 * @response 200 { success: true, data: { offerId, status: 'cancelled', cancelledAt } }
 * @response 403 { success: false, error: string } - Wallet mismatch or offer belongs to another scout
 * @response 404 { success: false, error: string } - Trial offer not found
 * @response 409 { success: false, error: string } - Offer already accepted/rejected or already cancelled
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/trial-offers/:offerId')
  .delete(
    requireRole('scout'),
    requireWalletOwner({ validateAddress: false }),
    requireApiKeyScope('write:trial_offers'),
    cancelTrialOfferHandler,
  )
  .all(methodNotAllowed(['DELETE']));

/**
 * GET /api/scouts/:wallet/recommendations
 *
 * Weighted player recommendations derived from the scout's saved searches,
 * bookmarks, and past contact unlocks (falls back to top-tier players when
 * the scout has no history). Cursor-paginated; results cached 10 minutes.
 *
 * @summary Weighted, cursor-paginated player recommendations for this scout.
 * @param wallet {string} - Scout's Stellar public key
 * @query cursor {string} - Optional — last player_id of the previous page
 * @query pageSize {integer} - Optional — default 20
 * @response 200 { success: true, data: PlayerSummary[], nextCursor, meta: { preferredRegion, preferredPosition, minTier, totalCandidates } }
 * @response 400 { success: false, error: string } - Invalid query parameters
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/recommendations')
  .get(
    requireRole('scout'),
    requireWalletOwner(),
    getScoutRecommendations,
  )
  .all(methodNotAllowed(['GET', 'HEAD']));

// ─── Private scout notes (#488) ───────────────────────────────────────────────

/**
 * PUT /api/scouts/:wallet/notes/:playerId
 * Create or update (upsert) a private note on a player profile.
 * Only the authoring scout can read or write their notes.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @body { note: string } - 1-10 000 characters
 * @response 200 { success: true, data: { scout_wallet, player_id, note, updated_at } }
 * @response 400 { success: false, error: string } - Invalid or missing note
 * @auth Bearer (scout role required; wallet must match authenticated account)
 *
 * GET /api/scouts/:wallet/notes/:playerId
 * Retrieve the authenticated scout's note for a specific player.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @response 200 { success: true, data: { scout_wallet, player_id, note, updated_at } }
 * @response 404 { success: false, error: string } - No note exists yet
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/notes/:playerId')
  .put(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:notes'), validateBody(upsertNoteSchema), putScoutNote)
  .get(requireRole('scout'), requireWalletOwner(), getScoutNoteHandler)
  .all(methodNotAllowed(['PUT', 'GET', 'HEAD']));

/**
 * GET /api/scouts/:wallet/notes
 * List all private notes for the authenticated scout, ordered newest-first.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @response 200 { success: true, data: Array<{ scout_wallet, player_id, note, updated_at }> }
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/notes')
  .get(requireRole('scout'), requireWalletOwner(), listScoutNotesHandler)
  .all(methodNotAllowed(['GET', 'HEAD']));

// ─── Multi-note CRUD for scout-player notes ───────────────────────────────────

/**
 * POST /api/scouts/:wallet/players/:playerId/notes
 * Create a new private note for the authenticated scout on the given player.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @body { content: string } - 1-2 000 characters
 * @response 201 { success: true, data: { id, scout_wallet, player_id, content, created_at, updated_at } }
 * @response 400 { success: false, error: string } - Invalid or missing content
 * @response 403 { success: false, error: string } - Wallet mismatch
 * @auth Bearer (scout role required; wallet must match authenticated account)
 *
 * GET /api/scouts/:wallet/players/:playerId/notes
 * List all private notes for the scout-player pair, newest-first.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @response 200 { success: true, data: Array<{ id, scout_wallet, player_id, content, created_at, updated_at }> }
 * @response 403 { success: false, error: string } - Wallet mismatch
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/players/:playerId/notes')
  .post(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:notes'), validateBody(noteContentSchema), createPlayerNote)
  .get(requireRole('scout'), requireWalletOwner(), listPlayerNotes)
  .all(methodNotAllowed(['POST', 'GET', 'HEAD']));

/**
 * PUT /api/scouts/:wallet/players/:playerId/notes/:noteId
 * Update a note's content. Returns 404 when not found or owned by another scout.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @param noteId {integer} - Note row ID
 * @body { content: string } - 1-2 000 characters
 * @response 200 { success: true, data: { id, scout_wallet, player_id, content, updated_at } }
 * @response 400 { success: false, error: string } - Invalid note id or content
 * @response 403 { success: false, error: string } - Wallet mismatch
 * @response 404 { success: false, error: string } - Note not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 *
 * DELETE /api/scouts/:wallet/players/:playerId/notes/:noteId
 * Delete a note. Returns 404 when not found or owned by another scout.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @param noteId {integer} - Note row ID
 * @response 200 { success: true, data: { removed: true, id } }
 * @response 400 { success: false, error: string } - Invalid note id
 * @response 403 { success: false, error: string } - Wallet mismatch
 * @response 404 { success: false, error: string } - Note not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/players/:playerId/notes/:noteId')
  .put(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:notes'), validateBody(noteContentSchema), updatePlayerNote)
  .delete(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:notes'), deletePlayerNote)
  .all(methodNotAllowed(['PUT', 'DELETE']));

// ─── API key management (#490) ────────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/api-keys
 * Issue a new API key for server-to-server integrations. Returns the plaintext
 * key exactly once; only a salted hash is persisted.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @body { label: string, scopes?: string[] } - Omitted scopes = legacy/unrestricted key
 * @response 201 { success: true, data: { id, key, label, created_at, scopes } }
 * @response 400 { success: false, error: string } - Invalid body or unknown scope
 * @auth Bearer (scout role required; wallet must match authenticated account)
 *
 * GET /api/scouts/:wallet/api-keys
 * List existing API keys (metadata + hash prefix only — no plaintext).
 *
 * @param wallet {string} - Scout's Stellar public key
 * @response 200 { success: true, data: Array<{ id, label, key_prefix, created_at, last_used_at, revoked, revoked_at, scopes }> }
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/api-keys')
  .post(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:api_keys'), validateBody(issueKeySchema), issueApiKey)
  .get(requireRole('scout'), requireWalletOwner(), listApiKeys)
  .all(methodNotAllowed(['POST', 'GET', 'HEAD']));

/**
 * DELETE /api/scouts/:wallet/api-keys/:id
 * Revoke an existing API key by its row id. Revoked keys are rejected by the
 * auth middleware on subsequent requests.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param id {integer} - API key row ID
 * @response 200 { success: true, data: { id, revoked: true } }
 * @response 400 { success: false, error: string } - Invalid id
 * @response 404 { success: false, error: string } - API key not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/api-keys/:id')
  .delete(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:api_keys'), revokeApiKey)
  .all(methodNotAllowed(['DELETE']));

/**
 * POST /api/scouts/:wallet/api-keys/:id/rotate
 * Atomically issue a replacement key and schedule the old one for revocation
 * after a grace period, instead of issuing and revoking as two separate,
 * non-atomic requests (#676). The replacement inherits the old key's label
 * and scopes. The old key keeps authenticating until `oldKey.revokesAt`.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param id {integer} - API key row ID to rotate
 * @body { gracePeriodSeconds?: number } - How long the old key stays valid (default 24h, max 7d); 0 revokes it immediately
 * @response 201 { success: true, data: { newKey: { id, key, label, created_at, scopes }, oldKey: { id, revokesAt } } }
 * @response 400 { success: false, error: string } - Invalid id or gracePeriodSeconds
 * @response 404 { success: false, error: string } - API key not found (or already revoked)
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/api-keys/:id/rotate')
  .post(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:api_keys'), validateBody(rotateKeySchema), rotateApiKey)
  .all(methodNotAllowed(['POST']));

// ─── Scout bookmarks (#487) ───────────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/bookmarks
 * Bookmark a player with optional folder and note. Idempotent — no error if already bookmarked.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @body { playerId: string, folderId?: number, note?: string }
 * @response 200 { success: true, data: { scout_wallet, player_id, folder_id, note, created_at } }
 * @response 400 { success: false, error: string } - Missing playerId
 * @response 404 { success: false, error: string } - Player or folder not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 *
 * GET /api/scouts/:wallet/bookmarks
 * List all bookmarked players with full profile summaries.
 * Supports ?folderId= query parameter to filter by folder.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @query folderId {integer} - Optional — restrict to one folder
 * @response 200 { success: true, data: Array<PlayerSummary & { bookmarked_at, folder_id, note }> }
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/bookmarks')
  .post(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:bookmarks'), validateBody(addBookmarkSchema), addBookmark)
  .get(requireRole('scout'), requireWalletOwner(), listBookmarks)
  .all(methodNotAllowed(['POST', 'GET', 'HEAD']));

/**
 * DELETE /api/scouts/:wallet/bookmarks/:playerId
 * Remove a bookmark. Returns 404 when the bookmark does not exist.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @response 200 { success: true, data: { removed: true, player_id } }
 * @response 404 { success: false, error: string } - Bookmark not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/bookmarks/:playerId')
  .delete(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:bookmarks'), removeBookmark)
  .all(methodNotAllowed(['DELETE']));

/**
 * POST /api/scouts/:wallet/bookmark-folders
 * Create a new bookmark folder.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @body { name: string }
 * @response 201 { success: true, data: { id, scout_wallet, name, created_at } }
 * @response 400 { success: false, error: string } - Missing/invalid name
 * @auth Bearer (scout role required; wallet must match authenticated account)
 *
 * GET /api/scouts/:wallet/bookmark-folders
 * List all bookmark folders with bookmark counts.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @response 200 { success: true, data: Array<{ id, scout_wallet, name, created_at, bookmark_count }> }
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/bookmark-folders')
  .post(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:bookmarks'), validateBody(createBookmarkFolderSchema), createBookmarkFolder)
  .get(requireRole('scout'), requireWalletOwner(), listBookmarkFolders)
  .all(methodNotAllowed(['POST', 'GET', 'HEAD']));

/**
 * DELETE /api/scouts/:wallet/bookmark-folders/:folderId
 * Delete a bookmark folder. Bookmarks move to root (folder_id set to NULL), not deleted.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param folderId {integer} - Bookmark folder row ID
 * @response 200 { success: true, data: { deleted: true, folder_id } }
 * @response 400 { success: false, error: string } - Invalid folderId
 * @response 404 { success: false, error: string } - Folder not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/bookmark-folders/:folderId')
  .delete(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:bookmarks'), deleteBookmarkFolderHandler)
  .all(methodNotAllowed(['DELETE']));

// ─── Scout saved searches (#486) ──────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/saved-searches
 * Create a new named saved search.  The filter payload is validated against
 * the same Zod schema used by the live player-filter endpoint. Capped at 20
 * saved searches per scout.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @body { name: string, filters: { region?, position?, minTier? } }
 * @response 201 { success: true, data: { id, scout_wallet, name, filters, created_at } }
 * @response 400 { success: false, error: string } - Invalid request body
 * @response 403 { success: false, error: string } - Wallet mismatch or not the scout role
 * @response 422 { success: false, error: string } - Maximum of 20 saved searches per scout
 * @auth Bearer (scout role required; wallet must match authenticated account)
 *
 * GET /api/scouts/:wallet/saved-searches
 * List all saved searches for the authenticated scout, newest-first.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @response 200 { success: true, data: Array<{ id, scout_wallet, name, filters, created_at }> }
 * @response 403 { success: false, error: string } - Wallet mismatch or not the scout role
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/saved-searches')
  .post(requireRole('scout'), requireApiKeyScope('write:saved_searches'), requireFeatureFlag(FeatureFlags.SAVED_SEARCHES), requireWalletOwner(), validateBody(createSavedSearchSchema), createSavedSearch)
  .get(requireRole('scout'), requireApiKeyScope('write:saved_searches'), requireFeatureFlag(FeatureFlags.SAVED_SEARCHES), requireWalletOwner(), listSavedSearches)
  .all(methodNotAllowed(['POST', 'GET', 'HEAD']));

/**
 * PUT /api/scouts/:wallet/saved-searches/:id
 * Update a saved search's name and/or filters. Returns 404 when not found for this scout.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param id {integer} - Row id of the saved search to update
 * @body { name?: string, filters?: { region?, position?, minTier? } }
 * @response 200 { success: true, data: { id, scout_wallet, name, filters, created_at } }
 * @response 400 { success: false, error: string } - Invalid id or request body
 * @response 403 { success: false, error: string } - Wallet mismatch or not the scout role
 * @response 404 { success: false, error: string } - Saved search not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 *
 * DELETE /api/scouts/:wallet/saved-searches/:id
 * Delete a saved search by its row id.
 * A scout cannot delete another scout's saved searches.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param id {integer} - Row id of the saved search to delete
 * @response 200 { success: true, data: { removed: true, id } }
 * @response 400 { success: false, error: string } - Invalid id
 * @response 403 { success: false, error: string } - Wallet mismatch or not the scout role
 * @response 404 { success: false, error: string } - Saved search not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/saved-searches/:id')
  .put(requireRole('scout'), requireApiKeyScope('write:saved_searches'), requireFeatureFlag(FeatureFlags.SAVED_SEARCHES), requireWalletOwner(), validateBody(updateSavedSearchSchema), updateSavedSearchHandler)
  .delete(requireRole('scout'), requireApiKeyScope('write:saved_searches'), requireFeatureFlag(FeatureFlags.SAVED_SEARCHES), requireWalletOwner(), deleteSavedSearchHandler)
  .all(methodNotAllowed(['PUT', 'DELETE']));

/**
 * GET /api/scouts/:wallet/saved-searches/:id/run
 * Execute a saved search and return matching players (paginated).
 * Returns 404 when the saved search does not exist for this scout.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param id {integer} - Row id of the saved search to run
 * @query page {integer} - Default 1
 * @query pageSize {integer} - Default 20, max 100
 * @response 200 { success: true, data: { players: PlayerRow[], total, page, pageSize } }
 * @response 403 { success: false, error: string } - Wallet mismatch or not the scout role
 * @response 404 { success: false, error: string } - Saved search not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/saved-searches/:id/run')
  .get(requireRole('scout'), requireFeatureFlag(FeatureFlags.SAVED_SEARCHES), requireWalletOwner(), runSavedSearch)
  .all(methodNotAllowed(['GET', 'HEAD']));

// ─── Webhook subscription management (#806) ───────────────────────────────────

/**
 * POST /api/scouts/:wallet/webhooks
 * Register a webhook URL. Generates a per-subscription HMAC secret returned
 * once in plaintext (AES-256-GCM encrypted at rest); subsequent GETs show a
 * masked value only.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @body { url: string, eventTypes?: ContractEventType[] }
 * @response 201 { success: true, data: { id, url, secret, eventTypes, createdAt } }
 * @response 400 { success: false, error: string } - Invalid URL or unknown event type
 * @response 403 { success: false, error: string } - Wallet mismatch
 * @auth Bearer (scout role required; wallet must match authenticated account)
 *
 * GET /api/scouts/:wallet/webhooks
 * List all active subscriptions (secrets masked — only the last 4 hex chars visible).
 *
 * Registration is subject to the default per-wallet rate limit (#1037).
 *
 * @param wallet {string} - Scout's Stellar public key
 * @response 200 { success: true, data: Array<{ id, url, secret, eventTypes, createdAt }> }
 * @response 403 { success: false, error: string } - Wallet mismatch
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/webhooks')
  .post(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:webhooks'), walletRateLimit(), validateBody(registerWebhookSchema), registerWebhook)
  .get(requireRole('scout'), requireWalletOwner(), listWebhooks)
  .all(methodNotAllowed(['POST', 'GET', 'HEAD']));

/**
 * DELETE /api/scouts/:wallet/webhooks/:id
 * Delete a subscription. Returns 404 when not found or owned by another scout.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param id {integer} - Webhook subscription row ID
 * @response 200 { success: true, data: { removed: true, id } }
 * @response 400 { success: false, error: string } - Invalid id
 * @response 403 { success: false, error: string } - Wallet mismatch
 * @response 404 { success: false, error: string } - Subscription not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/webhooks/:id')
  .delete(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:webhooks'), deleteWebhook)
  .all(methodNotAllowed(['DELETE']));

/**
 * POST /api/scouts/:wallet/webhooks/:id/test
 * Send a test ping to the registered URL, signed with the subscription secret.
 * Returns 502 when the remote server does not respond with 2xx or is unreachable.
 *
 * Rate limited separately from — and more tightly than — other scout write
 * endpoints (#1037), since each call makes the backend issue an outbound
 * HTTP request to a caller-supplied URL. Default: 5 requests/minute per
 * wallet (WEBHOOK_TEST_RATE_LIMIT_MAX / WEBHOOK_TEST_RATE_LIMIT_WINDOW_MS).
 * Exceeding it returns 429 before any outbound request is attempted.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @param id {integer} - Webhook subscription row ID
 * @response 200 { success: true, data: { id, url, statusCode } }
 * @response 400 { success: false, error: string } - Invalid subscription id
 * @response 403 { success: false, error: string } - Wallet mismatch or subscription belongs to another scout
 * @response 404 { success: false, error: string } - Subscription not found
 * @response 429 { success: false, error: string } - Webhook-test rate limit exceeded
 * @response 502 { success: false, error: string, data: { id, url, statusCode? } } - Remote server returned non-2xx or was unreachable
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/webhooks/:id/test')
  .post(requireRole('scout'), requireWalletOwner(), requireApiKeyScope('write:webhooks'), webhookTestRateLimit, validateBody(emptyBodySchema), testWebhook)
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/scouts/:wallet/dashboard
 *
 * Consolidated home-screen dashboard for a scout. Returns four independently
 * bounded sections in a single authenticated call:
 *   - subscription: current subscription status
 *   - contacts:     first 10 unlocked contacts (with `_links.full` for pagination)
 *   - bookmarks:    first 10 bookmarked players (with `_links.full` for pagination)
 *   - savedSearches: first 10 saved searches (with `_links.full` for pagination)
 *
 * Each section is fetched via the existing per-resource service functions —
 * no duplicated queries.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @response 200 { success: true, data: { wallet, subscription, contacts, bookmarks, savedSearches } }
 * @response 401 { success: false, error: string } - Missing or invalid token
 * @response 403 { success: false, error: string } - Wallet mismatch
 * @auth Bearer (scout role required; own wallet or admin)
 */
router.route('/:wallet/dashboard')
  .get(requireRole('scout', 'admin'), requireWalletOwner(), getScoutDashboard)
  .all(methodNotAllowed(['GET', 'HEAD']));

export default router;
