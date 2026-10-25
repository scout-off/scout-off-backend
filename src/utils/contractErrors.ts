/**
 * Contract → backend error mapping (#1530).
 *
 * `contracts/shared/src/errors.rs` is the source of truth for numeric Soroban
 * error codes. This table maps every discriminant to a backend `ErrorCode`, an
 * HTTP status and a client-facing message, so a contract failure can be
 * reported specifically ("milestone already approved") instead of as a generic
 * 500 or `CONFLICT`.
 *
 * Keep this table aligned with the Rust enum: `tests/utils/contractErrors.test.ts`
 * parses `errors.rs` and fails when a discriminant is unmapped or an existing
 * value changed. New variants must be appended to both sides (never renumbered
 * — the discriminants are part of the on-chain ABI).
 */
import { ErrorCode } from './errorCodes';

/**
 * Thrown when a contract call fails with a contract-level (not network) error.
 * Carries the numeric Soroban code so the API layer can map it to a specific
 * `ErrorCode` and HTTP status (#1530).
 */
export class ContractExecutionError extends Error {
  /** Numeric Soroban contract error code, when one can be extracted. */
  readonly contractErrorCode: number | null;

  constructor(message: string, contractErrorCode?: number | null) {
    super(message);
    this.name = 'ContractExecutionError';
    this.contractErrorCode =
      contractErrorCode !== undefined
        ? contractErrorCode
        : extractContractErrorCode(message);
  }
}

export interface ContractErrorMapping {
  errorCode: ErrorCode;
  /** HTTP status the API should return for this contract failure. */
  status: number;
  /** Short, client-safe message. Never contains internal/XDR detail. */
  message: string;
}

export const CONTRACT_ERRORS: Readonly<Record<number, ContractErrorMapping>> = {
  1: { errorCode: ErrorCode.CONFLICT, status: 409, message: 'Contract is already initialized' },
  2: { errorCode: ErrorCode.INTERNAL_SERVER_ERROR, status: 500, message: 'Contract is not initialized' },
  3: { errorCode: ErrorCode.PLAYER_NOT_FOUND, status: 404, message: 'Player not found on-chain' },
  4: { errorCode: ErrorCode.NOT_FOUND, status: 404, message: 'Contract resource not found' },
  5: { errorCode: ErrorCode.VALIDATION_ERROR, status: 400, message: 'Contract rejected the input as invalid' },
  6: { errorCode: ErrorCode.CONFLICT, status: 409, message: 'Resource is already verified' },
  7: { errorCode: ErrorCode.INSUFFICIENT_FUNDS, status: 402, message: 'Insufficient funds for this contract call' },
  8: { errorCode: ErrorCode.NOT_SUBSCRIBED, status: 402, message: 'Scout has no active subscription' },
  9: { errorCode: ErrorCode.UNAUTHORIZED, status: 403, message: 'Caller is not authorized for this contract action' },
  10: { errorCode: ErrorCode.CONTRACT_PAUSED, status: 503, message: 'Contract is paused' },
  11: { errorCode: ErrorCode.INTERNAL_SERVER_ERROR, status: 500, message: 'Contract arithmetic overflow' },
  12: { errorCode: ErrorCode.INSUFFICIENT_SUPPLY, status: 409, message: 'Not enough unsold tokens remain' },
  13: { errorCode: ErrorCode.VALIDATOR_NOT_REGISTERED, status: 403, message: 'Validator is not registered on-chain' },
  14: { errorCode: ErrorCode.VALIDATOR_REVOKED, status: 403, message: 'Validator has been revoked' },
  15: { errorCode: ErrorCode.MILESTONE_NOT_FOUND, status: 404, message: 'Milestone not found' },
  16: { errorCode: ErrorCode.MILESTONE_ALREADY_APPROVED, status: 409, message: 'Milestone is already approved' },
  17: { errorCode: ErrorCode.SELF_APPROVAL_FORBIDDEN, status: 403, message: 'A validator cannot approve their own milestone' },
  18: { errorCode: ErrorCode.SUBSCRIPTION_EXPIRED, status: 402, message: 'Subscription has expired' },
  19: { errorCode: ErrorCode.CONTACT_ALREADY_PAID, status: 409, message: 'Contact with this player is already paid' },
  20: { errorCode: ErrorCode.FEE_BPS_OUT_OF_RANGE, status: 400, message: 'Platform fee must be between 0 and 10000 bps' },
  21: { errorCode: ErrorCode.CONNECTION_NOT_FOUND, status: 404, message: 'Connection not found' },
  22: { errorCode: ErrorCode.CONNECTION_ALREADY_CLOSED, status: 409, message: 'Connection is already closed' },
};

/** Backwards-compatible numeric → ErrorCode view of the table above. */
export const SOROBAN_ERROR_CODE_MAP: Readonly<Record<number, ErrorCode>> = Object.fromEntries(
  Object.entries(CONTRACT_ERRORS).map(([code, mapping]) => [Number(code), mapping.errorCode]),
) as Record<number, ErrorCode>;

/** Maps a contract error code, falling back to a generic 500 for unknown codes. */
export function mapContractError(code: number): ContractErrorMapping {
  return (
    CONTRACT_ERRORS[code] ?? {
      errorCode: ErrorCode.INTERNAL_SERVER_ERROR,
      status: 500,
      message: `Unknown contract error (code ${code})`,
    }
  );
}

/**
 * Extracts the numeric contract error code from the formats Soroban RPC and
 * the SDK produce, e.g.:
 *   "HostError: Error(Contract, #15)"
 *   "simulation failed: contract error 15"
 *   "Error(Contract, 15)"
 * Returns null when no plausible code is present.
 */
export function extractContractErrorCode(message: string): number | null {
  if (!message) return null;
  const patterns = [
    /#(\d{1,4})\b/,
    /Error\(Contract,\s*#?(\d{1,4})\)/,
    /contract\s+error\s+#?(\d{1,4})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (!match) continue;
    const code = Number.parseInt(match[1], 10);
    if (Number.isInteger(code) && code > 0 && code <= 999) return code;
  }
  return null;
}
