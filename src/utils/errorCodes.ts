/**
 * Machine-readable snake_case error codes for all API error responses.
 *
 * Usage:
 *   import { ErrorCode } from '../utils/errorCodes';
 *   res.status(400).json({ success: false, error: '...', code: ErrorCode.VALIDATION_ERROR });
 *
 * Existing PaymentError / FeeWithdrawalError codes are included so controllers
 * can reference them from one place.
 *
 * Each code includes a doc comment describing:
 *   - When the error occurs (HTTP status and trigger condition)
 *   - What the client should do (recommended action)
 */
export const ErrorCode = {
  // ── Generic ───────────────────────────────────────────────────────────────
  /**
   * HTTP 500 — An unexpected error occurred on the server.
   * Client should: Retry with exponential backoff; contact support if persists.
   */
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',

  /**
   * HTTP 404 — The requested resource was not found.
   * Client should: Verify the resource ID/path is correct; check if it was deleted.
   */
  NOT_FOUND: 'NOT_FOUND',

  /**
   * HTTP 400 — Request validation failed (Zod schema, required fields, etc.).
   * Client should: Fix the request payload; check field names and types against API docs.
   */
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  /**
   * HTTP 400 — Request body contains invalid JSON syntax (not parseable).
   * Client should: Verify JSON syntax; ensure Content-Type is application/json.
   */
  MALFORMED_JSON: 'MALFORMED_JSON',

  /**
   * HTTP 413 — Request body size exceeds the server limit (~100KB).
   * Client should: Reduce payload size; split into multiple requests if needed.
   */
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  /**
   * HTTP 415 — Request Content-Type is not supported (e.g., text/plain instead of application/json).
   * Client should: Set Content-Type: application/json in request headers.
   */
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',

  // ── Auth ──────────────────────────────────────────────────────────────────
  /**
   * HTTP 401 — Request lacks valid authentication (missing/invalid JWT or API key).
   * Client should: Provide a valid Bearer token or X-API-Key header; refresh expired tokens.
   */
  UNAUTHORIZED: 'UNAUTHORIZED',

  /**
   * HTTP 403 — Request is authenticated but lacks permission for this resource/action.
   * Client should: Verify your account role/scope; contact support to request access.
   */
  FORBIDDEN: 'FORBIDDEN',

  /**
   * HTTP 401 — JWT token is invalid (malformed, signed with wrong key, etc.).
   * Client should: Re-authenticate and obtain a fresh token.
   */
  TOKEN_INVALID: 'TOKEN_INVALID',

  /**
   * HTTP 401 — JWT token has expired.
   * Client should: Refresh the token or re-authenticate.
   */
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',

  // ── Payment (preserve existing PaymentError codes) ────────────────────────
  /**
   * HTTP 402 / 400 — Account balance is insufficient to complete the payment.
   * Client should: Check account balance; deposit funds or reduce transaction amount.
   */
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',

  /**
   * HTTP 400 — The specified account does not exist or is invalid.
   * Client should: Verify the account identifier is valid and exists.
   */
  INVALID_ACCOUNT: 'INVALID_ACCOUNT',

  /**
   * HTTP 503 — A network error occurred (blockchain RPC unreachable, etc.).
   * Client should: Retry after a short delay; check if the blockchain is operational.
   */
  NETWORK_ERROR: 'NETWORK_ERROR',

  /**
   * HTTP 500 — A payment operation failed for an unknown reason.
   * Client should: Retry; if it persists, contact support with transaction details.
   */
  PAYMENT_UNKNOWN: 'UNKNOWN',

  // ── Fee withdrawal (preserve existing FeeWithdrawalError codes) ───────────
  /**
   * HTTP 400 — No accumulated fees are available to withdraw.
   * Client should: Check again after platform fees accrue from transactions.
   */
  NO_FEES: 'NO_FEES',

  /**
   * HTTP 400 — The withdrawal recipient address is invalid or not supported.
   * Client should: Verify the recipient wallet/account format.
   */
  INVALID_RECIPIENT: 'INVALID_RECIPIENT',

  /**
   * HTTP 503 — The subscription contract is paused (emergency maintenance).
   * Client should: Retry after a delay; operations will resume when unpaused.
   */
  CONTRACT_PAUSED: 'CONTRACT_PAUSED',

  // ── Subscription ──────────────────────────────────────────────────────────
  /**
   * HTTP 402 — Scout has no active subscription (required for this operation).
   * Maps to Soroban contract error code 8 (NotSubscribed).
   * Returned by cancel_subscription when the scout has no active subscription,
   * and by any access-guard that requires a live subscription.
   * Client should: Subscribe first via /api/scouts/:wallet/subscribe.
   */
  NOT_SUBSCRIBED: 'NOT_SUBSCRIBED',

  // ── Resource ──────────────────────────────────────────────────────────────
  /**
   * HTTP 404 — The specified player was not found (or is hidden from this user).
   * Client should: Verify the player_id is correct; check if the player is deactivated.
   */
  PLAYER_NOT_FOUND: 'PLAYER_NOT_FOUND',

  /**
   * HTTP 403 — An active subscription is required to perform this action.
   * Client should: Subscribe first via /api/scouts/:wallet/subscribe.
   */
  SUBSCRIPTION_REQUIRED: 'SUBSCRIPTION_REQUIRED',

  /**
   * HTTP 409 — A resource conflict occurred (duplicate key, state mismatch, etc.).
   * Client should: Check the current state; retry with updated data or a different key.
   */
  CONFLICT: 'CONFLICT',

  /**
   * HTTP 400 — The wallet/account in the request does not match the authenticated user.
   * Client should: Use your own wallet address in the request path.
   */
  WALLET_MISMATCH: 'WALLET_MISMATCH',

  /**
   * HTTP 403 — A requested feature is disabled (feature flag not enabled).
   * Client should: Contact support to enable the feature; check docs for availability.
   */
  FEATURE_DISABLED: 'FEATURE_DISABLED',

  // ── Conditional requests / optimistic concurrency ─────────────────────────
  /**
   * HTTP 412 — An If-Match header was supplied but does not match the current resource version.
   * Occurs when a PUT/PATCH request includes an ETag that no longer matches (resource was updated).
   * Client should: Fetch the current resource, get the new ETag, and retry with the new ETag.
   */
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',

  /**
   * HTTP 428 — Request requires an If-Match header (conditional request) that was not supplied.
   * Occurs on PUT/PATCH endpoints that demand optimistic locking.
   * Client should: Include the If-Match header with the current ETag from a prior GET request.
   */
  PRECONDITION_REQUIRED: 'PRECONDITION_REQUIRED',

  // ── Multi-sig administration ───────────────────────────────────────────────
  /**
   * HTTP 410 — A multi-sig admin action has expired and can no longer be approved.
   * Client should: Propose the action again to create a fresh request.
   */
  EXPIRED_ACTION: 'EXPIRED_ACTION',

  /**
   * HTTP 409 — A multi-sig admin action has already been executed.
   * Client should: Check the action status; cannot re-approve completed actions.
   */
  ACTION_EXECUTED: 'ACTION_EXECUTED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Mapping from Soroban contract numeric error codes (as defined in
 * contracts/shared/src/errors.rs) to machine-readable backend error codes.
 *
 * Used by the XDR error parser and any code that pattern-matches on '#N'
 * substrings in simulation/result error strings.
 *
 * | Code | Contract variant  | Backend code         |
 * |------|-------------------|----------------------|
 * |  1   | AlreadyInitialized| CONFLICT             |
 * |  2   | NotInitialized    | INTERNAL_SERVER_ERROR|
 * |  3   | PlayerNotFound    | PLAYER_NOT_FOUND     |
 * |  4   | NotFound          | NOT_FOUND            |
 * |  5   | InvalidInput      | VALIDATION_ERROR     |
 * |  6   | AlreadyVerified   | CONFLICT             |
 * |  7   | InsufficientFee   | INSUFFICIENT_FUNDS   |
 * |  8   | NotSubscribed     | NOT_SUBSCRIBED       |
 * |  9   | Unauthorized      | UNAUTHORIZED         |
 * | 10   | ContractPaused    | CONTRACT_PAUSED      |
 * | 11   | Overflow          | INTERNAL_SERVER_ERROR|
 */
export const SOROBAN_ERROR_CODE_MAP: Record<number, ErrorCode> = {
  1:  ErrorCode.CONFLICT,
  2:  ErrorCode.INTERNAL_SERVER_ERROR,
  3:  ErrorCode.PLAYER_NOT_FOUND,
  4:  ErrorCode.NOT_FOUND,
  5:  ErrorCode.VALIDATION_ERROR,
  6:  ErrorCode.CONFLICT,
  7:  ErrorCode.INSUFFICIENT_FUNDS,
  8:  ErrorCode.NOT_SUBSCRIBED,
  9:  ErrorCode.UNAUTHORIZED,
  10: ErrorCode.CONTRACT_PAUSED,
  11: ErrorCode.INTERNAL_SERVER_ERROR,
} as const;
