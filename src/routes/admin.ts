import { Router } from 'express';
import express from 'express';
import {
  getStats,
  getAllEvents,
  getFeeSummary,
  listValidators,
  registerValidator,
  revokeValidator,
  pauseContract,
  unpauseContract,
  withdrawFeesController,
  withdrawFeesV2Controller,
  introspectToken,
  revokeTokenController,
  reindex,
  getValidatorStatsEndpoint,
  getAuditLog,
  getAuditChainVerification,
  importValidators,
  getPendingActions,
  getPendingActionById,
  approvePendingAction,
  getAuditTrail,
  withdrawFeesSchema,
  withdrawFeesV2Schema,
  revokeTokenSchema,
  reindexSchema,
  importValidatorsBodySchema,
} from '../controllers/adminController';
import { importPlayers, importPlayersBodySchema } from '../controllers/adminPlayerImportController';
import { adminDeactivatePlayer, adminReactivatePlayer, deactivateBodySchema } from '../controllers/adminPlayerDeactivationController';
import { getFeatureFlags, updateFeatureFlag, toggleFeatureFlag, updateFeatureFlagBodySchema, toggleFlagBodySchema } from '../controllers/featureFlagsController';
import { exportEvents } from '../controllers/exportController';
import { listDeadLetters, replayDeadLetter, purgeOldDeadLetters, requeueDeadLetter, purgeDeadLetter } from '../controllers/webhookAdminController';
import { setIpReputationController, getIpReputationController, setIpReputationSchema } from '../controllers/ipReputationController';
import { triggerReindex, reindexStatusHandler, reindexBodySchema, cancelReindexHandler } from '../controllers/reindexController';
import { triggerReplay, replayStatusHandler, replayBodySchema } from '../controllers/replayController';
import { requireRole } from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';
import { ipAllowlistMiddleware } from '../middleware/ipAllowlist';
import { methodNotAllowed } from '../middleware/methodNotAllowed';
import { rateLimit } from '../middleware/rateLimit';
import { createTimeout } from '../middleware/timeout';
import { validateBody, validateJsonBodyOrPassThrough } from '../middleware/validate';
import { validatorWalletSchema } from '../validators/admin';
import { emptyBodySchema } from '../validators/emptyBody';
import config from '../config';

/** Stricter rate limit for bulk import — 5 requests per minute per IP (relaxed in tests). */
const importRateLimit = rateLimit({
  name: 'admin-import',
  windowMs: config.playerImportRateLimit.windowMs,
  max: config.playerImportRateLimit.max,
});

const router = Router();

// Enforce IP allowlist for all admin endpoints (no-op when ADMIN_IP_ALLOWLIST is unset)
router.use(ipAllowlistMiddleware);

/**
 * GET /api/admin/stats
 *
 * Returns aggregate platform counts: players, milestones, subscriptions, and total events.
 *
 * @response 200 { success: true, data: { players, milestones, subscriptions, events } }
 * @auth Bearer (admin role required)
 */
router.route('/stats')
  .get(requireRole('admin'), getStats)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/admin/events
 *
 * Returns all indexed Soroban contract events in insertion order.
 * Query params: startDate, endDate (ISO 8601), eventType, fromLedger, toLedger, page, pageSize
 *
 * @response 200 { success: true, data: AdminEvent[] }
 * @response 400 { success: false, error: string } - Invalid date range
 * @auth Bearer (admin role required)
 */
router.route('/events')
  .get(requireRole('admin'), getAllEvents)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/admin/events/export
 *
 * Streams indexed Soroban contract events as CSV. Rows are fetched from the
 * database in bounded pages and written to the response as they arrive, so
 * memory usage stays constant regardless of table size.
 * Useful for data analysis, reporting, and external system integration.
 *
 * Query params (same semantics as GET /api/admin/events): startDate, endDate (ISO 8601), eventType
 *
 * Timeout: 120 s (overrides the 30 s default — large exports can take up to 60 s).
 *
 * @response 200 CSV file with columns: event_type, ledger, timestamp, payload
 * @response 400 { success: false, error: string } - Invalid date range
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.route('/events/export')
  .get(createTimeout(120_000), requireRole('admin'), exportEvents)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/admin/fees
 *
 * Returns a list of fee withdrawal events from the contract.
 * Query params: startDate, endDate (ISO 8601)
 *
 * @response 200 { success: true, data: FeeHistoryItem[] }
 * @auth Bearer (admin role required)
 *
 * POST /api/admin/fees
 *
 * Withdraws accumulated platform fees from the Soroban contract to a specified recipient.
 *
 * @body recipient {string} - Stellar public key of the withdrawal recipient
 * @response 200 { success: true, data: { transactionId, recipient, amount, token } }
 * @response 400 { success: false, error: string } - Invalid recipient address
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @response 409 { success: false, error: string } - No fees available
 * @auth Bearer (admin role required)
 */
router.route('/fees')
  .get(requireRole('admin'), getFeeSummary)
  .post(requireRole('admin'), validateBody(withdrawFeesSchema), withdrawFeesController)
  .all(methodNotAllowed(['GET', 'POST', 'HEAD']));

/**
 * POST /api/admin/fees/withdraw
 *
 * Withdraw accumulated platform fees from the Soroban contract to a treasury
 * address. This is the fully-specified replacement for POST /api/admin/fees.
 *
 * @body treasuryAddress {string} — valid Stellar public key (G…)
 * @body amountStroops   {string|number} — positive integer ≤ contract fee balance
 *
 * Optional header: Idempotency-Key — prevents double-submission; cached result
 * is returned on repeat requests with the same key (24-hour TTL).
 *
 * @response 200 { success: true, data: { transactionId, treasuryAddress, amountStroops, recipient, amount, token } }
 * @response 202 { success: true, message, data: { actionId, collectedSignatures, requiredSignatures, … } }
 *               — when ADMIN_THRESHOLD > 1 (multi-sig required)
 * @response 400 { success: false, error } — invalid treasuryAddress or amountStroops
 * @response 401 { success: false, error } — missing/expired token
 * @response 403 { success: false, error } — non-admin role
 * @response 409 { success: false, error } — no fees / contract paused / concurrent withdrawal
 * @response 422 { success: false, error } — amountStroops exceeds contract fee balance
 * @response 503 { success: false, error } — transient network error (retryable)
 * @auth Bearer (admin role required)
 */
router.route('/fees/withdraw')
  .post(requireRole('admin'), idempotency, validateBody(withdrawFeesV2Schema), withdrawFeesV2Controller)
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/admin/audit
 *
 * Returns paginated audit log entries. Supports `startDate`, `endDate` (ISO 8601),
 * `action` filters, and `limit`/`offset` pagination.
 *
 * @response 200 { success: true, data: AuditLogRow[], total, limit, offset }
 * @auth Bearer (admin role required)
 */
router.route('/audit')
  .get(requireRole('admin'), getAuditLog)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/admin/audit/trail
 *
 * Returns a paginated, event-type-filtered audit trail in the canonical
 * AuditEntry shape { id, event_type, actor_wallet, target_id, metadata,
 * created_at, hash }. Accepts ?eventType=, ?from=, ?to= (ISO 8601),
 * ?page=, ?pageSize= (#832).
 *
 * @summary Returns a paginated, event-type-filtered audit trail.
 * @response 200 { success: true, data: AuditEntry[], total, page, pageSize }
 * @response 400 { success: false, error: string } - Invalid eventType or date range
 * @auth Bearer (admin role required)
 */
router.route('/audit/trail')
  .get(requireRole('admin'), getAuditTrail)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/admin/audit/verify
 *
 * Walks the audit_log hash chain and reports whether it is intact (#464).
 *
 * @response 200 { success: true, data: { valid, brokenAtId, reason?, rowsChecked } }
 * @auth Bearer (admin role required)
 */
router.route('/audit/verify')
  .get(requireRole('admin'), getAuditChainVerification)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/admin/validators
 *
 * Returns the full list of registered validator wallets from the local DB,
 * including their registration timestamp, revocation timestamp (if any), and tx_hash.
 *
 * @summary Returns the full list of registered validator wallets.
 * @response 200 { success: true, data: ValidatorRow[] }
 * @auth Bearer (admin role required)
 */
router.route('/validators')
  .get(requireRole('admin'), listValidators)
  .all(methodNotAllowed(['GET', 'HEAD']));

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
router.route('/validators/register')
  .post(requireRole('admin'), validateBody(validatorWalletSchema), registerValidator)
  .all(methodNotAllowed(['POST']));

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
router.route('/validators/revoke')
  .post(requireRole('admin'), validateBody(validatorWalletSchema), revokeValidator)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/admin/validators/import
 *
 * Bulk-onboards validators from a CSV or JSON batch.
 * Accepts either:
 *   - JSON body: { validators: [{ wallet, label?, region? }, …] }
 *   - CSV body (Content-Type: text/csv): rows of wallet[,label[,region]]
 *
 * Each entry is validated and processed through the same single-registration
 * path. Invalid addresses and already-registered (non-revoked) validators are
 * skipped per-entry rather than failing the whole batch.
 *
 * @body { validators: ValidatorEntry[] } | CSV text
 * @response 200 { success: true, data: { results, summary } }
 * @response 400 { success: false, error: string } - Empty or unparseable body
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.post(
  '/validators/import',
  requireRole('admin'),
  // Parse text/csv and text/plain bodies as raw strings so the controller
  // can handle CSV formatting. JSON bodies are already parsed by the global
  // express.json() middleware in app.ts.
  express.text({ type: ['text/csv', 'text/plain'], limit: '1mb' }),
  validateJsonBodyOrPassThrough(importValidatorsBodySchema),
  importValidators,
);

/**
 * POST /api/admin/players/import
 *
 * Bulk-onboards players from a CSV or JSON batch (e.g. migrating an
 * academy's existing roster), reusing the same validation and IPFS pinning
 * logic as POST /api/players/register.
 * Accepts either:
 *   - JSON body: { players: [{ wallet, position, region, metadata|metadataUri }, …] }
 *   - CSV body (Content-Type: text/csv): rows of wallet,position,region,metadataUri
 *
 * Each entry is validated against the single-registration schema and
 * processed independently — one invalid or failing row doesn't abort the
 * batch. Batch size is capped by config.playerImport.maxBatchSize.
 *
 * @body { players: RegisterPlayerRequest[] } | CSV text
 * @response 200 { success: true, data: { results, summary } }
 * @response 400 { success: false, error: string } - Empty/unparseable body or batch too large
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.post(
  '/players/import',
  importRateLimit,
  requireRole('admin'),
  express.text({ type: ['text/csv', 'text/plain'], limit: '1mb' }),
  validateJsonBodyOrPassThrough(importPlayersBodySchema),
  importPlayers,
);

/**
 * POST /api/admin/players/:playerId/deactivate
 *
 * Admin soft-delete of a player. Requires { reason } in the request body.
 * Cancels all pending milestones and emits player_deactivated SSE events to
 * every scout who has unlocked the player's contact details.
 *
 * @body { reason: string } — required, max 500 chars
 * @response 200 { success: true, data: { playerId, cancelledMilestones, notifiedScouts } }
 * @response 400 { success: false, error } — missing/invalid reason or playerId
 * @response 404 { success: false, error } — player not found
 * @response 409 { success: false, error } — player already deactivated
 * @auth Bearer (admin role required)
 */
router.route('/players/:playerId/deactivate')
  .post(requireRole('admin'), validateBody(deactivateBodySchema), adminDeactivatePlayer)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/admin/players/:playerId/reactivate
 *
 * Restore a previously deactivated player. Clears deactivated_at and
 * deactivation_reason, emits a player_reactivated SSE event, and writes
 * a player_reactivated audit entry.
 *
 * @response 200 { success: true, data: { playerId } }
 * @response 404 { success: false, error } — player not found
 * @response 409 { success: false, error } — player already active
 * @auth Bearer (admin role required)
 */
router.route('/players/:playerId/reactivate')
  .post(requireRole('admin'), validateBody(emptyBodySchema), adminReactivatePlayer)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/admin/contract/pause
 *
 * Stub endpoint that simulates pausing the Soroban smart contract.
 * Contract-level behavior is simulated — no real on-chain transaction is issued.
 *
 * @response 202 { success: true, message: string, transactionId: string }
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.route('/contract/pause')
  .post(requireRole('admin'), validateBody(emptyBodySchema), pauseContract)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/admin/contract/unpause
 *
 * Stub endpoint that simulates unpausing the Soroban smart contract.
 * Contract-level behavior is simulated — no real on-chain transaction is issued.
 *
 * @response 202 { success: true, message: string, transactionId: string }
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.route('/contract/unpause')
  .post(requireRole('admin'), validateBody(emptyBodySchema), unpauseContract)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/admin/introspect
 *
 * Decodes the caller's own bearer token and returns its payload metadata.
 * The token is extracted from the Authorization header only — no body input is accepted.
 * Useful for admins to inspect their own token claims (subject, role, expiry).
 *
 * @response 200 { success: true, data: { sub, role, iat, exp } }
 * @response 401 { success: false, error: string } - Missing or invalid bearer token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.route('/introspect')
  .post(requireRole('admin'), validateBody(emptyBodySchema), introspectToken)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/admin/tokens/revoke
 *
 * Adds a JWT's jti claim to the revocation blocklist so requireAuth/requireRole
 * reject it on subsequent requests, even if it has not yet expired.
 *
 * @summary Revoke a JWT by jti so it is rejected even before it expires.
 * @body { jti?: string, token?: string } - Provide either the jti directly or a
 *   full token to extract it from.
 * @response 200 { success: true, data: { jti } }
 * @response 400 { success: false, error: string } - Neither jti nor token provided, or token has no jti
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.route('/tokens/revoke')
  .post(requireRole('admin'), validateBody(revokeTokenSchema), revokeTokenController)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/admin/indexer/reindex
 *
 * Resets the indexer's stored last_ledger to the given fromLedger value,
 * causing the next poll cycle to replay all events from that ledger onward.
 *
 * @summary Reset the indexer's last_ledger so the next poll replays from fromLedger.
 * @body fromLedger {number} - Ledger sequence number to replay from
 * @response 200 { success: true, data: { fromLedger, previous } }
 * @response 400 { success: false, error: string } - Invalid fromLedger
 * @auth Bearer (admin role required)
 */
router.route('/indexer/reindex')
  .post(requireRole('admin'), validateBody(reindexSchema), reindex)
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/admin/validators/:wallet/stats
 *
 * Returns a validator's lifetime milestone approval/rejection counts.
 * Unknown wallets return zeroed counts rather than 404.
 *
 * @param wallet {string} - Validator's Stellar public key
 * @response 200 { success: true, data: { wallet, milestones_approved, milestones_rejected } }
 * @response 400 { success: false, error: string } - Invalid Stellar address
 * @auth Bearer (admin role required)
 */
router.route('/validators/:wallet/stats')
  .get(requireRole('admin'), getValidatorStatsEndpoint)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/admin/feature-flags
 *
 * Returns all runtime feature flags and their current enabled state.
 * Cache is cleared before reading so the response always reflects DB state.
 *
 * @response 200 { success: true, data: FeatureFlag[] }
 * @auth Bearer (admin role required)
 *
 * PUT /api/admin/feature-flags
 *
 * Updates a feature flag without restarting the process.
 * Writes a feature_flag_toggled audit entry on every change.
 *
 * @body { name: string, enabled: boolean }
 * @response 200 { success: true, data: FeatureFlag }
 * @auth Bearer (admin role required)
 */
router.route('/feature-flags')
  .get(requireRole('admin'), getFeatureFlags)
  .put(requireRole('admin'), validateBody(updateFeatureFlagBodySchema), updateFeatureFlag)
  .all(methodNotAllowed(['GET', 'PUT', 'HEAD']));

/**
 * PUT /api/admin/feature-flags/:name
 *
 * Toggle a specific feature flag by name. Body only needs { enabled: boolean }.
 * Returns 404 when the flag has not been seeded into the DB yet.
 * Writes a feature_flag_toggled audit entry on every change.
 *
 * @param name  {string} - snake_case flag name
 * @body { enabled: boolean }
 * @response 200 { success: true, data: { name, enabled, updated_by, updated_at } }
 * @response 400 Invalid flag name or body
 * @response 404 Flag not found
 * @auth Bearer (admin role required)
 */
router.route('/feature-flags/:name')
  .put(requireRole('admin'), validateBody(toggleFlagBodySchema), toggleFeatureFlag)
  .all(methodNotAllowed(['PUT']));

/**
 * GET /api/admin/actions/pending
 *
 * Returns all pending (non-expired, non-executed) multi-admin action proposals.
 * Results may be stale if an action expired between the listing and the next
 * sweep, but approval of an expired action is rejected at the service layer.
 *
 * @response 200 { success: true, data: PendingAction[] }
 * @auth Bearer (admin role required)
 */
router.route('/actions/pending')
  .get(requireRole('admin'), getPendingActions)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/admin/actions/:id
 *
 * Returns details of a specific action proposal including collected signers.
 *
 * @param id {string} - Action proposal ID
 * @response 200 { success: true, data: PendingActionDetail }
 * @response 404 { success: false, error: string } - Action not found
 * @auth Bearer (admin role required)
 */
router.route('/actions/:id')
  .get(requireRole('admin'), getPendingActionById)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/admin/actions/:id/approve
 *
 * Co-signs (approves) an existing pending action. Requires the caller to be
 * a distinct admin wallet that has not already signed. When the threshold of
 * distinct signatures is met, the action is executed automatically.
 *
 * @param id {string} - Action proposal ID
 * @response 200 { success: true, message, data } - Threshold met, action executed
 * @response 202 { success: true, message, data } - Signature recorded, more needed
 * @response 403 { success: false, error } - Not an admin wallet
 * @response 404 { success: false, error } - Action not found
 * @response 409 { success: false, error } - Duplicate signer
 * @response 410 { success: false, error } - Action expired
 * @auth Bearer (admin role required)
 */
router.route('/actions/:id/approve')
  .post(requireRole('admin'), validateBody(emptyBodySchema), approvePendingAction)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/admin/reindex
 *
 * Trigger a background event backfill for a specific ledger range.
 * The job fetches events in batches of 100 ledgers with a 50 ms inter-batch
 * delay. Duplicate events are silently discarded via the UNIQUE constraint on
 * tx_hash. The job status is available via GET /api/admin/reindex/status.
 *
 * Timeout: disabled (0). The endpoint returns 202 immediately — the actual
 * backfill runs as a background job and must never be killed by a network timeout.
 *
 * @body { fromLedger: number, toLedger: number }
 * @response 202 { success: true, data: { fromLedger, toLedger, status: 'running' } }
 * @response 409 { success: false, error: string } - job already running
 * @response 422 { success: false, error: string } - range > 10 000 ledgers or invalid range
 * @auth Bearer (admin role required)
 */
router.route('/reindex')
  .post(createTimeout(0), requireRole('admin'), validateBody(reindexBodySchema), triggerReindex)
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/admin/reindex/status
 *
 * Return the current state of the background reindex job (live progress).
 *
 * @response 200 {
 *   success: true,
 *   data: {
 *     status: 'idle' | 'running' | 'complete' | 'error' | 'cancelled',
 *     from_ledger, to_ledger,
 *     ledgers_processed, ledgers_total,
 *     events_inserted,
 *     started_at, completed_at, error_message
 *   }
 * }
 * @auth Bearer (admin role required)
 */
router.route('/reindex/status')
  .get(requireRole('admin'), reindexStatusHandler)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/admin/reindex/cancel
 *
 * Cooperatively cancel a running background reindex job. Sets a cancel flag
 * that the batch loop checks after each batch; the job transitions to
 * 'cancelled' within one batch iteration and persists the last-processed ledger.
 *
 * Returns 409 when no job is currently running.
 *
 * NOTE: process-local flag only — multi-instance support requires a shared
 * flag (e.g. Redis) and is tracked as a follow-up.
 *
 * @response 200 { success: true, data: { status: 'cancel_requested', message } }
 * @response 409 { success: false, error: string } - no job running
 * @auth Bearer (admin role required)
 */
router.route('/reindex/cancel')
  .post(requireRole('admin'), cancelReindexHandler)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/admin/events/replay
 *
 * Trigger a targeted event replay for a small ledger range without modifying
 * the main indexer cursor. This is a surgical tool for fixing narrow historical
 * gaps (e.g., "we think ledgers 500123-500130 were missed") while the indexer
 * is live near tip.
 *
 * Maximum range is 200 ledgers. Events are upserted using INSERT OR IGNORE,
 * so duplicates are silently skipped. Returns a count of newly inserted events.
 *
 * @body { fromLedger: number, toLedger: number }
 * @response 200 { success: true, data: { fromLedger, toLedger, eventsInserted } }
 * @response 409 { success: false, error: string } - job already running
 * @response 422 { success: false, error: string } - range ≥ 200 or invalid range
 * @auth Bearer (admin role required)
 */
router.route('/events/replay')
  .post(requireRole('admin'), validateBody(replayBodySchema), triggerReplay)
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/admin/events/replay/status
 *
 * Return the current state of the replay job.
 *
 * @response 200 {
 *   success: true,
 *   data: {
 *     status: 'idle' | 'running' | 'complete' | 'error',
 *     from_ledger: number,
 *     to_ledger: number,
 *     ledgers_processed: number,
 *     ledgers_total: number,
 *     events_inserted: number,
 *     started_at: string | null,
 *     completed_at: string | null,
 *     error_message: string | null
 *   }
 * }
 * @auth Bearer (admin role required)
 */
router.route('/events/replay/status')
  .get(requireRole('admin'), replayStatusHandler)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/admin/webhooks/dead-letters
 *
 * Paginated list of dead-lettered webhook deliveries.
 * Each entry includes url, payload_preview, retry_count, last_error, created_at.
 *
 * @response 200 { success: true, data: DeadLetterView[], total, page, pageSize }
 * @response 400 { success: false, error: string } - Invalid page/pageSize
 * @auth Bearer (admin role required)
 *
 * DELETE /api/admin/webhooks/dead-letters
 *
 * Purge all dead letters older than `olderThanDays` query param (default: 7 days).
 *
 * @query olderThanDays {integer} - Minimum age in days to purge (default: 7)
 * @response 200 { success: true, message: string, data: { deleted, olderThanDays } }
 * @response 400 { success: false, error: string } - Invalid olderThanDays
 * @auth Bearer (admin role required)
 */
router.route('/webhooks/dead-letters')
  .get(requireRole('admin'), listDeadLetters)
  .delete(requireRole('admin'), purgeOldDeadLetters)
  .all(methodNotAllowed(['GET', 'DELETE', 'HEAD']));

/**
 * POST /api/admin/webhooks/dead-letters/:id/requeue
 *
 * Manually trigger an immediate retry of a specific dead-lettered webhook,
 * re-signing the payload with the subscription's current secret.
 *
 * @param id {integer} - Dead letter row ID
 * @response 200 { success: true, message, data: { id, status: 'replayed' } }
 * @response 400 { success: false, error: string } - Invalid id
 * @response 404 { success: false, error } - Not found
 * @response 409 { success: false, error } - Already replayed
 * @response 502 { success: false, message, error, data: { id, status: 'pending', retryCount } } - Delivery failed
 * @auth Bearer (admin role required)
 */
router.route('/webhooks/dead-letters/:id/requeue')
  .post(requireRole('admin'), validateBody(emptyBodySchema), requeueDeadLetter)
  .all(methodNotAllowed(['POST']));

/**
 * DELETE /api/admin/webhooks/dead-letters/:id
 *
 * Purge a specific dead-letter row.
 *
 * @param id {integer} - Dead letter row ID
 * @response 200 { success: true, message: string, data: { id } }
 * @response 400 { success: false, error: string } - Invalid id
 * @response 404 { success: false, error: string } - Not found
 * @auth Bearer (admin role required)
 */
router.route('/webhooks/dead-letters/:id')
  .delete(requireRole('admin'), purgeDeadLetter)
  .all(methodNotAllowed(['DELETE']));

/**
 * POST /api/admin/webhooks/:id/replay
 *
 * Legacy alias — kept for backwards compatibility. Delegates to the same
 * handler as POST /api/admin/webhooks/dead-letters/:id/requeue.
 *
 * @deprecated Use POST /api/admin/webhooks/dead-letters/:id/requeue instead.
 * @param id {integer} - Dead letter row ID
 * @response 200 { success: true, message, data: { id, status: 'replayed' } }
 * @response 400 { success: false, error: string } - Invalid id
 * @response 404 { success: false, error } - Not found
 * @response 409 { success: false, error } - Already replayed
 * @response 502 { success: false, message, error, data: { id, status: 'pending', retryCount } } - Delivery failed
 * @auth Bearer (admin role required)
 */
router.route('/webhooks/:id/replay')
  .post(requireRole('admin'), validateBody(emptyBodySchema), replayDeadLetter)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/admin/ip-allowlist
 *
 * Manually set an IP's reputation score.
 * - body { ip, score: 0 }   → whitelist the IP (score pinned at 0, immune to decay)
 * - body { ip, score: 100 } → blacklist the IP (immediate 429 for all requests)
 * - body { ip, score: N }   → any 0–100 value (admin override)
 *
 * @body { ip: string, score: number }
 * @response 200 { success: true, data: { ip, score } }
 * @response 400 { success: false, error: string } - Validation error
 * @auth Bearer (admin role required)
 */
router.route('/ip-allowlist')
  .post(requireRole('admin'), validateBody(setIpReputationSchema), setIpReputationController)
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/admin/ip-reputation/:ip
 *
 * Returns the current reputation record (score, lastSeen, pinned) for a given IP.
 *
 * @response 200 { success: true, data: IpReputation | null }
 * @response 400 { success: false, error: string } - :ip is not a valid IPv4/IPv6 address
 * @auth Bearer (admin role required)
 */
router.route('/ip-reputation/:ip')
  .get(requireRole('admin'), getIpReputationController)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/admin/webhooks/:id/deliveries
 *
 * Returns paginated delivery-attempt records (success + failure) for a webhook
 * subscription. `:id` should be the URL-encoded subscription identifier
 * (typically the endpoint URL).
 *
 * @query limit  - Page size 1–100 (default 20)
 * @query offset - Row offset (default 0)
 * @response 200 { success: true, data: WebhookDeliveryRow[], total, limit, offset }
 * @auth Bearer (admin role required)
 */
router.get('/webhooks/:id/deliveries', requireRole('admin'), getWebhookDeliveriesEndpoint);

/**
 * GET /api/admin/webhooks/:id/summary
 *
 * Returns a rolled-up success-rate summary (total, successes, failures,
 * success_rate, last_success_at) for a subscription over a configurable window.
 *
 * @query windowMs - Window in milliseconds (default 86400000 = 24 h)
 * @response 200 { success: true, data: WebhookDeliverySummary }
 * @auth Bearer (admin role required)
 */
router.get('/webhooks/:id/summary', requireRole('admin'), getWebhookDeliverySummaryEndpoint);

/**
 * POST /api/admin/fees/config
 *
 * Propose and execute an update_platform_fee multi-sig action.
 * Updates the on-chain platform fee in basis points (0–10000).
 *
 * @body actionId {string} - Unique multi-sig action identifier
 * @body newFeeBps {number} - New fee in basis points (0–10000)
 * @response 202 { success: true, data: { actionId, transactionId, newFeeBps } }
 * @response 400 { success: false, error: string }
 * @auth Bearer (admin role required)
 */
router.post('/fees/config', requireRole('admin'), updatePlatformFeeController);

export default router;
