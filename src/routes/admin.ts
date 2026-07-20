import { Router } from 'express';
import express from 'express';
import { getStats, getAllEvents, getFeeSummary, listValidators, registerValidator, revokeValidator, pauseContract, unpauseContract, withdrawFeesController, introspectToken, revokeTokenController, reindex, getValidatorStatsEndpoint, getAuditLog, importValidators, getDbDiagnostics } from '../controllers/adminController';
import { exportEvents } from '../controllers/exportController';
import { requireRole } from '../middleware/auth';
import { ipAllowlistMiddleware } from '../middleware/ipAllowlist';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

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
 * Query params: startDate, endDate (ISO 8601), eventType
 *
 * @response 200 { success: true, data: AdminEvent[] }
 * @response 400 { success: false, error: string } - Invalid date range
 * @auth Bearer (any authenticated user)
 */
router.route('/events')
  .get(requireRole('admin'), getAllEvents)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/admin/events/export
 *
 * Exports all indexed Soroban contract events as CSV format.
 * Useful for data analysis, reporting, and external system integration.
 *
 * @response 200 CSV file with columns: event_type, ledger, timestamp, payload
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.route('/events/export')
  .get(requireRole('admin'), exportEvents)
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
  .post(requireRole('admin'), withdrawFeesController)
  .all(methodNotAllowed(['GET', 'POST', 'HEAD']));

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
 * GET /api/admin/validators
 *
 * Returns the full list of registered validator wallets from the local DB,
 * including their registration timestamp, revocation timestamp (if any), and tx_hash.
 *
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
  .post(requireRole('admin'), registerValidator)
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
  .post(requireRole('admin'), revokeValidator)
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
  importValidators,
);

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
  .post(requireRole('admin'), pauseContract)
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
  .post(requireRole('admin'), unpauseContract)
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
  .post(requireRole('admin'), introspectToken)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/admin/tokens/revoke
 *
 * Adds a JWT's jti claim to the revocation blocklist so requireAuth/requireRole
 * reject it on subsequent requests, even if it has not yet expired.
 *
 * @body { jti?: string, token?: string } - Provide either the jti directly or a
 *   full token to extract it from.
 * @response 200 { success: true, data: { jti } }
 * @response 400 { success: false, error: string } - Neither jti nor token provided, or token has no jti
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.route('/tokens/revoke')
  .post(requireRole('admin'), revokeTokenController)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/admin/indexer/reindex
 *
 * Resets the indexer's stored last_ledger to the given fromLedger value,
 * causing the next poll cycle to replay all events from that ledger onward.
 *
 * @body fromLedger {number} - Ledger sequence number to replay from
 * @response 200 { success: true, data: { fromLedger, previous } }
 * @response 400 { success: false, error: string } - Invalid fromLedger
 * @auth Bearer (admin role required)
 */
router.route('/indexer/reindex')
  .post(requireRole('admin'), reindex)
  .all(methodNotAllowed(['POST']));

router.route('/validators/:wallet/stats')
  .get(requireRole('admin'), getValidatorStatsEndpoint)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/admin/db-diagnostics
 *
 * Returns database diagnostics: file size, last applied migration, and full PRAGMA integrity_check output.
 *
 * @response 200 { success: true, data: { fileSize, lastMigration, integrityCheck } }
 * @auth Bearer (admin role required)
 */
router.route('/db-diagnostics')
  .get(requireRole('admin'), getDbDiagnostics)
  .all(methodNotAllowed(['GET', 'HEAD']));

export default router;
