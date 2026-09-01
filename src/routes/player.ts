import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";

import {
  registerPlayer,
  getPlayer,
  filterPlayers,
  getPlayerMilestones,
  updatePlayer,
  getPlayerAnalytics,
  registerSchema,
  filterSchema,
  updatePlayerSchema,
  deactivatePlayerEndpoint,
  reactivatePlayerEndpoint,
} from "../controllers/playerController";
import { getPlayerHistory, getPlayerHistoryVersion, getPlayerHistoryDiff } from "../controllers/playerHistoryController";
import { anonymizePlayer } from "../controllers/playerAnonymizationController";
import { acceptTrialOffer, rejectTrialOffer, rejectOfferSchema } from "../controllers/trialOfferController";
import { getPlayerTokenHolders, buyPlayerToken, buyTokenSchema } from "../controllers/playerTokenController";

import { validateBody, validateQuery } from "../middleware/validate";
import { requireRole, optionalAuth, requireApiKeyScope } from "../middleware/auth";
import { requireOwner } from "../middleware/requireOwner";
import { methodNotAllowed } from "../middleware/methodNotAllowed";
import { emptyBodySchema } from "../validators/emptyBody";

const router = Router();

/**
 * GET /api/players
 * optionalAuth so req.account is set when a Bearer token is present (for audit logging)
 * Supports conditional GET (If-None-Match / If-Modified-Since → 304) and HEAD.
 *
 * @response 200 { success: true, data: PlayerSummary[], total, page, pageSize, pages }
 * @response 304 Not Modified
 * @response 400 { success: false, error: string } - Invalid query parameters
 * @response 422 { success: false, error: string } - minTier out of range
 */
router.route("/")
  .get(optionalAuth, validateQuery(filterSchema), filterPlayers)
  .head(optionalAuth, validateQuery(filterSchema), filterPlayers)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/players/register
 *
 * Register a new player profile. `wallet` must match the authenticated
 * account. Metadata is pinned to IPFS on the caller's behalf unless a
 * pre-pinned `metadataUri` is supplied instead.
 *
 * @body { wallet: string, position: string, region: string, metadata?: object } | { wallet, position, region, metadataUri: string }
 * @response 201 { success: true, data: { playerId, metadataUri, gatewayUrl } }
 * @response 400 { success: false, error: string } - Invalid body
 * @response 403 { success: false, error: string } - wallet does not match authenticated account
 * @auth Bearer (player role required)
 */
router.route("/register")
  .post(
    requireRole("player"),
    validateBody(registerSchema, { context: "player_registration" }),
    registerPlayer,
  )
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/players/:playerId
 *
 * Fetch a single player profile, including a live `offerCount`. Deactivated
 * profiles return 404 to non-owners/non-admins. Supports conditional
 * requests via ETag (304 when `If-None-Match` matches). The same ETag is the
 * version token for optimistic concurrency — echo it as `If-Match` on PUT.
 *
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @response 200 { success: true, data: PlayerDetail }
 * @response 304 Not Modified (when If-None-Match matches the current ETag)
 * @response 400 { success: false, error: string } - Invalid playerId
 * @response 404 { success: false, error: string } - Player not found or not visible to caller
 * @auth optional (public read)
 *
 * PUT /api/players/:playerId
 *
 * Update a player's profile metadata. Owner-only. Accepts either a raw
 * `metadata` object (pinned to IPFS by the backend) or a pre-pinned
 * `metadataUri`. Optimistic concurrency (#1151): the ETag returned by GET
 * must be echoed in the `If-Match` header. A missing header is rejected with
 * 428, a stale one with 412 (no write happens); `If-Match: *` is the
 * documented override.
 *
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @header If-Match {string} - ETag from GET /api/players/:playerId (required; "*" to override)
 * @body { metadata: object } | { metadataUri: string }
 * @response 200 { success: true, data: { metadataUri, playerId } }
 * @response 400 { success: false, error: string } - Invalid playerId or body
 * @response 403 { success: false, error: string } - Not the profile owner
 * @response 404 { success: false, error: string } - Player not found
 * @response 412 { success: false, error: string } - If-Match does not match the current profile version
 * @response 428 { success: false, error: string } - If-Match header required
 * @auth Bearer (player role required, profile owner only)
 */
router.route("/:playerId")
  .get(optionalAuth, getPlayer)
  .put(
    requireRole("player"),
    requireOwner,
    validateBody(updatePlayerSchema),
    updatePlayer,
  )
  .all(methodNotAllowed(['GET', 'PUT', 'HEAD']));

/**
 * GET /api/players/:playerId/milestones
 *
 * List a player's milestones, merging on-chain milestone events with
 * pending/approved/rejected submission events. Supports `status`
 * (pending|approved|rejected; omit for all), `sortBy`, `order`/`sort`, and
 * `limit` (max 50) query params.
 *
 * Supports conditional GET via ETag / If-None-Match (returns 304 when the
 * list has not changed since the previous fetch). Cache-Control is set to
 * no-cache, matching the player-profile endpoint (#1139).
 *
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @response 200 { success: true, data: Milestone[] }
 * @response 304 Not Modified (when If-None-Match matches the current ETag)
 * @response 400 { success: false, error: string } - Invalid playerId, limit, or query params
 * @response 404 { success: false, error: string } - Player not found or not visible to caller
 */
router.route("/:playerId/milestones")
  .get(optionalAuth, getPlayerMilestones)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/players/:playerId/deactivate
 *
 * Self-service soft-delete of the caller's own player profile. Owner-only.
 *
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @response 200 { success: true, message: string }
 * @response 400 { success: false, error: string } - Invalid playerId
 * @response 404 { success: false, error: string } - Player not found
 * @auth Bearer (player role required, profile owner only)
 */
router.route("/:playerId/deactivate")
  .post(
    requireRole("player"),
    requireOwner,
    validateBody(emptyBodySchema),
    deactivatePlayerEndpoint,
  )
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/players/:playerId/reactivate
 *
 * Restore a previously self-deactivated player profile. Owner-only.
 *
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @response 200 { success: true, message: string }
 * @response 400 { success: false, error: string } - Invalid playerId
 * @response 404 { success: false, error: string } - Player not found
 * @auth Bearer (player role required, profile owner only)
 */
router.route("/:playerId/reactivate")
  .post(
    requireRole("player"),
    requireOwner,
    validateBody(emptyBodySchema),
    reactivatePlayerEndpoint,
  )
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/players/:playerId/anonymize
 *
 * GDPR right-to-erasure: scrubs PII from every off-chain store this backend
 * controls (profile fields, history, views, contact unlocks, trial offers),
 * unpins the player's IPFS content, and deactivates the profile. Does NOT
 * erase on-chain Soroban contract state, which is immutable by design — see
 * docs/data-privacy.md.
 *
 * @summary GDPR right-to-erasure: scrub all off-chain PII for this player.
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @response 200 { success: true, data: { playerId } }
 * @response 400 { success: false, error: string } - Invalid playerId
 * @response 404 { success: false, error: string } - Player not found
 * @auth Bearer (player role required, profile owner only)
 */
router.route("/:playerId/anonymize")
  .post(
    requireRole("player"),
    requireOwner,
    validateBody(emptyBodySchema),
    anonymizePlayer,
  )
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/players/:playerId/history
 * Admin or profile owner only.
 *
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @response 200 { success: true, data: PlayerProfileHistoryItem[] } - Newest first
 * @response 400 { success: false, error: string } - Invalid playerId
 * @response 404 { success: false, error: string } - Player not found
 */
router.route("/:playerId/history")
  .get(
    optionalAuth,
    (req: Request, res: Response, next: NextFunction) => {
      if (req.role === "admin") return next();
      return requireRole("player")(req, res, () => requireOwner(req, res, next));
    },
    getPlayerHistory,
  )
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/players/:playerId/history/:version
 * Returns the full profile snapshot at the given 1-based version number.
 * Admin or profile owner only.
 *
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @param version {integer} - 1-based version number (1 = oldest snapshot)
 * @response 200 { success: true, data: PlayerProfileHistoryItem }
 * @response 400 { success: false, error: string } - Invalid playerId or version
 * @response 404 { success: false, error: string } - Player not found or version out of range
 */
router.route("/:playerId/history/:version")
  .get(
    optionalAuth,
    (req: Request, res: Response, next: NextFunction) => {
      if (req.role === "admin") return next();
      return requireRole("player")(req, res, () => requireOwner(req, res, next));
    },
    getPlayerHistoryVersion,
  )
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/players/:playerId/history/:version/diff
 * Returns a field-level diff between version N and N-1.
 * Admin or profile owner only.
 *
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @param version {integer} - 1-based version number (1 = oldest snapshot, has no diff predecessor)
 * @response 200 { success: true, data: { version, previousVersion, diff: { field: { from, to } } } }
 * @response 400 { success: false, error: string } - Invalid playerId or version
 * @response 404 { success: false, error: string } - Player not found or version out of range
 */
router.route("/:playerId/history/:version/diff")
  .get(
    optionalAuth,
    (req: Request, res: Response, next: NextFunction) => {
      if (req.role === "admin") return next();
      return requireRole("player")(req, res, () => requireOwner(req, res, next));
    },
    getPlayerHistoryDiff,
  )
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/players/:playerId/analytics
 * Return profile view and contact unlock analytics (owner-only).
 *
 * @param playerId {string} - Player's unique identifier (cuid2)
 * @response 200 { success: true, data: { view_count, viewer_count, contact_unlock_count, lastUpdated } }
 * @response 400 { success: false, error: string } - Invalid playerId
 * @response 404 { success: false, error: string } - Player not found
 */
router.route("/:playerId/analytics")
  .get(
    requireRole("player"),
    requireOwner,
    getPlayerAnalytics,
  )
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/players/:playerId/trial-offers/:offerId/accept
 *
 * Accept a trial offer. Only the player who owns this playerId may respond.
 *
 * @param playerId {string} - The player's on-chain identifier
 * @param offerId  {string} - The trial offer identifier
 * @response 200 { success: true, data: { offerId, playerId, status: 'accepted', respondedAt } }
 * @response 403 { success: false, error: string } - Not the offer's target player
 * @response 404 { success: false, error: string } - Offer not found
 * @response 409 { success: false, error: string } - Offer already responded to
 * @auth Bearer (player role required)
 */
router.route("/:playerId/trial-offers/:offerId/accept")
  .post(requireRole("player"), validateBody(emptyBodySchema), acceptTrialOffer)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/players/:playerId/trial-offers/:offerId/reject
 *
 * Reject a trial offer with an optional reason. Only the player who owns this playerId may respond.
 *
 * @param playerId {string} - The player's on-chain identifier
 * @param offerId  {string} - The trial offer identifier
 * @body { reason?: string } - Optional rejection reason (max 500 chars)
 * @response 200 { success: true, data: { offerId, playerId, status: 'rejected', reason, respondedAt } }
 * @response 403 { success: false, error: string } - Not the offer's target player
 * @response 404 { success: false, error: string } - Offer not found
 * @response 409 { success: false, error: string } - Offer already responded to
 * @auth Bearer (player role required)
 */
router.route("/:playerId/trial-offers/:offerId/reject")
  .post(
    requireRole("player"),
    validateBody(rejectOfferSchema),
    rejectTrialOffer,
  )
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/players/:playerId/tokens
 *
 * Return the list of token holders and their balances for the given player.
 * Gated by the `player_tokens` feature flag — returns 404 when disabled.
 *
 * @param playerId {string} - The player's on-chain identifier
 * @response 200 { success: true, data: { playerId, holders: [{ holder, tokens }], meta } }
 * @response 404 { success: false, error: string } - Feature flag disabled
 * @auth Bearer (optional — public read)
 */
router.route("/:playerId/tokens")
  .get(optionalAuth, getPlayerTokenHolders)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/players/:playerId/tokens/buy
 *
 * Purchase Player Tokens for the given player (stub — no real XLM transfer).
 * Gated by the `player_tokens` feature flag — returns 404 when disabled.
 *
 * @param playerId {string} - The player's on-chain identifier
 * @body { amount: number, buyerWallet: string }
 * @response 200 { success: true, data: { playerId, buyerWallet, amount, newBalance } }
 * @response 400 { success: false, error: string } - Invalid amount
 * @response 404 { success: false, error: string } - Feature flag disabled or player not found
 * @auth Bearer (scout or player role required)
 */
router.route("/:playerId/tokens/buy")
  .post(requireRole("scout"), requireApiKeyScope("write:player_tokens"), validateBody(buyTokenSchema), buyPlayerToken)
  .all(methodNotAllowed(['POST']));

export default router;
