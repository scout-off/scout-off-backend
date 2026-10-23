import crypto from 'crypto';
import {
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  Operation,
  Account,
  Transaction,
} from '@stellar/stellar-sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';

const tracer = trace.getTracer('scout-off-backend');

/**
 * Error codes for SEP-10 authentication failures.
 * Each code maps to a specific failure mode and determines the HTTP status
 * and ErrorCode returned to clients.
 */
export enum Sep10ErrorCode {
  /** Challenge signature verification failed */
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',
  /** Challenge source account is not the server account */
  WRONG_SOURCE = 'WRONG_SOURCE',
  /** Challenge sequence number must be 0 */
  BAD_SEQUENCE = 'BAD_SEQUENCE',
  /** Challenge must have time bounds */
  MISSING_TIMEBOUNDS = 'MISSING_TIMEBOUNDS',
  /** Challenge minTime is in the future (beyond grace window) */
  FUTURE_MIN_TIME = 'FUTURE_MIN_TIME',
  /** Challenge maxTime has passed */
  CHALLENGE_EXPIRED = 'CHALLENGE_EXPIRED',
  /** Challenge must have at least one operation */
  NO_OPERATIONS = 'NO_OPERATIONS',
  /** First operation must be manageData */
  WRONG_OPERATION_TYPE = 'WRONG_OPERATION_TYPE',
  /** Operation name must be 'scoutoff auth' */
  WRONG_OPERATION_NAME = 'WRONG_OPERATION_NAME',
  /** Missing or invalid nonce value */
  INVALID_NONCE = 'INVALID_NONCE',
  /** Missing source account in operation */
  MISSING_SOURCE_ACCOUNT = 'MISSING_SOURCE_ACCOUNT',
  /** Challenge not signed by the server */
  NOT_SIGNED_BY_SERVER = 'NOT_SIGNED_BY_SERVER',
  /** Additional operations must be sourced by the server */
  CLIENT_SOURCED_OPERATION = 'CLIENT_SOURCED_OPERATION',
  /** Challenge has already been used (replay protection) */
  ALREADY_USED = 'ALREADY_USED',
  /** XDR parsing failed - malformed input */
  MALFORMED_XDR = 'MALFORMED_XDR',
}

/**
 * Custom error class for SEP-10 authentication failures.
 * 
 * Usage:
 *   throw new Sep10Error(Sep10ErrorCode.CHALLENGE_EXPIRED, 'Challenge has expired');
 * 
 * The error code determines:
 *   - HTTP status (401 for auth failures, 400 for malformed input)
 *   - ErrorCode mapping (TOKEN_EXPIRED, TOKEN_INVALID, VALIDATION_ERROR, etc.)
 *   - Client-facing message (generic, stable text)
 *   - Server-side logging (includes detailed reason)
 */
export class Sep10Error extends Error {
  constructor(
    public code: Sep10ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'Sep10Error';
  }
}

/**
 * Resolve the SEP-10 server signing keypair.
 *
 * Priority:
 *   1. `config.sep10ServerSecret` — the persisted secret loaded from the
 *      SEP10_SERVER_SECRET environment variable.  All backend instances in a
 *      horizontally-scaled deployment **must** share this value so that a
 *      challenge issued by one instance can be verified by any other.
 *   2. Ephemeral fallback — generated once at module load when the secret is
 *      absent.  This is intentionally tolerated only in development and test
 *      environments (production and staging emit a warning / error at config
 *      load time before reaching this point).  The fallback is acceptable for
 *      single-process local dev but will cause cross-instance failures under a
 *      load balancer, which is exactly the scenario SEP10_SERVER_SECRET solves.
 */
function resolveServerKeypair(): Keypair {
  if (config.sep10ServerSecret) {
    try {
      return Keypair.fromSecret(config.sep10ServerSecret);
    } catch (err) {
      throw new Sep10Error(
        Sep10ErrorCode.MALFORMED_XDR,
        `SEP10_SERVER_SECRET is not a valid Stellar secret key (strkey starting with 'S'). Original error: ${(err as Error).message}`,
      );
    }
  }
  // Ephemeral fallback for development / test only.
  return Keypair.random();
}

const SERVER_KEYPAIR = resolveServerKeypair();
const CHALLENGE_TTL_SECONDS = 300; // 5 min to sign the challenge
const TIME_GRACE_WINDOW_SECONDS = 60; // Allow minTime to be up to 60 seconds in the future

/**
 * Tracks nonces (the base64-encoded manageData value) of SEP-10 challenges
 * that have already been redeemed, so a captured signed
 * challenge can't be replayed against POST /auth/token for as long as its
 * TTL window remains valid (#693).
 *
 * Keyed by nonce, valued by the challenge's own `maxTime` (epoch seconds) —
 * entries are pruned once that time has passed, since an expired challenge
 * is already rejected by the TTL check and doesn't need tracking anymore.
 */
const consumedChallengeNonces = new Map<string, number>();

function pruneConsumedChallengeNonces(nowSeconds: number): void {
  for (const [nonce, expiresAt] of consumedChallengeNonces) {
    if (expiresAt <= nowSeconds) {
      consumedChallengeNonces.delete(nonce);
    }
  }
}

/**
 * Returns the server keypair used for signing challenges.
 * Exposed for verification logic and testing.
 */
export function getServerKeypair(): Keypair {
  return SERVER_KEYPAIR;
}

/**
 * Build a SEP-10 challenge transaction.
 * The client must sign it with their Stellar keypair and return the XDR.
 *
 * Optionally includes the web_auth_domain operation if WEB_AUTH_DOMAIN is configured.
 * Per SEP-10, the first operation must be manageData with name 'scoutoff auth',
 * and any additional operations (like web_auth_domain) must be sourced by the server.
 */
export function buildChallenge(accountId: string): string {
  const span = tracer.startSpan('sep10.buildChallenge', { attributes: { 'sep10.account': accountId } });
  try {
    const serverAccount = new Account(SERVER_KEYPAIR.publicKey(), '-1');
    const txBuilder = new TransactionBuilder(serverAccount, {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase,
    });

    // Add the mandatory first operation: manageData with 'scoutoff auth'
    txBuilder.addOperation(
      Operation.manageData({
        name: 'scoutoff auth',
        value: crypto.randomBytes(48).toString('base64'),
        source: accountId,
      })
    );

    // Optionally add web_auth_domain operation if configured
    // This is per SEP-10 optional requirement for web authentication domains
    if (config.webAuthDomain) {
      txBuilder.addOperation(
        Operation.manageData({
          name: 'web_auth_domain',
          value: Buffer.from(config.webAuthDomain),
          source: SERVER_KEYPAIR.publicKey(), // Server-sourced per SEP-10
        })
      );
    }

    const tx = txBuilder
      .setTimeout(CHALLENGE_TTL_SECONDS)
      .build();

    tx.sign(SERVER_KEYPAIR);
    return tx.toXdr();
  } catch (err) {
    // Wrap any SDK errors as MALFORMED_XDR
    const message = err instanceof Error ? err.message : String(err);
    const normalized = new Sep10Error(Sep10ErrorCode.MALFORMED_XDR, message);
    span.recordException(normalized);
    span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message });
    throw normalized;
  } finally {
    span.end();
  }
}

/**
 * Extract the client account from a challenge XDR without verifying signatures.
 * Used to determine the effective role before issuing a token.
 */
export function extractAccount(xdr: string): string | null {
  try {
    const tx = new Transaction(xdr, config.networkPassphrase);
    return tx.operations[0].source ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify the client-signed challenge XDR.
 *
 * This implements SEP-10 authentication by:
 * 1. Validating the challenge transaction structure per SEP-10 requirements
 * 2. Cryptographically verifying the server and client signatures
 * 3. Rejecting replayed challenges
 *
 * @param xdr - The signed challenge transaction in XDR format
 * @returns Authenticated account ID
 * @throws Sep10Error if challenge structure is invalid or signature verification fails
 */
export function verifyChallenge(xdr: string): { account: string } {
  const span = tracer.startSpan('sep10.verifyChallenge');
  try {
    let tx: Transaction;
    try {
      tx = new Transaction(xdr, config.networkPassphrase);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Sep10Error(Sep10ErrorCode.MALFORMED_XDR, message);
    }

    // 1. Verify transaction source account is the server account
    if (tx.source !== SERVER_KEYPAIR.publicKey()) {
      throw new Sep10Error(Sep10ErrorCode.WRONG_SOURCE, 'Challenge source account is not the server account');
    }

    // 2. Verify sequence number is 0
    if (tx.sequence !== '0') {
      throw new Sep10Error(Sep10ErrorCode.BAD_SEQUENCE, 'Challenge sequence number must be 0');
    }

    // 3. Verify time bounds are present and valid
    if (!tx.timeBounds || !tx.timeBounds.minTime || !tx.timeBounds.maxTime) {
      throw new Sep10Error(Sep10ErrorCode.MISSING_TIMEBOUNDS, 'Challenge must have time bounds');
    }

    const minTime = Number(tx.timeBounds.minTime);
    const maxTime = Number(tx.timeBounds.maxTime);
    if (maxTime === 0) {
      throw new Sep10Error(Sep10ErrorCode.MISSING_TIMEBOUNDS, 'Challenge must have time bounds');
    }
    const now = Math.floor(Date.now() / 1000);

    // minTime must not be in the future (with a small grace window for clock skew)
    if (minTime > now + TIME_GRACE_WINDOW_SECONDS) {
      throw new Sep10Error(Sep10ErrorCode.FUTURE_MIN_TIME, 'Challenge minTime is in the future');
    }

    // maxTime must not be too far in the past (challenge expired)
    if (maxTime > 0 && now > maxTime) {
      throw new Sep10Error(Sep10ErrorCode.CHALLENGE_EXPIRED, 'Challenge has expired');
    }

    // 4. Validate challenge transaction structure
    if (!tx.operations || tx.operations.length === 0) {
      throw new Sep10Error(Sep10ErrorCode.NO_OPERATIONS, 'Invalid challenge: no operations found');
    }

    // 5. Verify all operations are manageData operations
    for (let i = 0; i < tx.operations.length; i++) {
      const op = tx.operations[i];
      if (op.type !== 'manageData') {
        throw new Sep10Error(Sep10ErrorCode.WRONG_OPERATION_TYPE, `Invalid challenge: operation ${i} must be manageData`);
      }
    }

    const op = tx.operations[0];
    const manageDataOp = op as Operation.ManageData;

    // 6. Verify the operation name matches the expected server string
    if (manageDataOp.name !== 'scoutoff auth') {
      throw new Sep10Error(Sep10ErrorCode.WRONG_OPERATION_NAME, 'Invalid challenge: wrong operation name');
    }

    // 7. Verify the nonce value is present and properly formatted (64 bytes)
    if (!manageDataOp.value) {
      throw new Sep10Error(Sep10ErrorCode.INVALID_NONCE, 'Invalid challenge: missing nonce value');
    }

    // Validate the nonce is exactly 64 bytes by checking the raw buffer length
    if (manageDataOp.value.length !== 64) {
      throw new Sep10Error(Sep10ErrorCode.INVALID_NONCE, 'Invalid challenge: nonce must be exactly 64 bytes');
    }

    // 8. Verify the first operation's source is the client account
    const clientAccountId = manageDataOp.source;
    if (!clientAccountId) {
      throw new Sep10Error(Sep10ErrorCode.MISSING_SOURCE_ACCOUNT, 'Missing source account in challenge');
    }

    // 9. Verify the server signed the challenge (proves it was built by this server)
    const serverSigned = tx.signatures.some((sig) => {
      try {
        const sigBytes = sig.signature instanceof Uint8Array
          ? sig.signature
          : (sig.signature as unknown as { value: Uint8Array }).value;
        return SERVER_KEYPAIR.verify(tx.hash(), sigBytes);
      } catch {
        return false;
      }
    });
    if (!serverSigned) {
      throw new Sep10Error(Sep10ErrorCode.NOT_SIGNED_BY_SERVER, 'Challenge not signed by server');
    }

    // 10. Verify all additional operations (beyond the first) have server as source
    for (let i = 1; i < tx.operations.length; i++) {
      const extraOp = tx.operations[i];
      const extraOpSource = extraOp.source;
      if (extraOpSource !== SERVER_KEYPAIR.publicKey()) {
        throw new Sep10Error(
          Sep10ErrorCode.CLIENT_SOURCED_OPERATION,
          `Operation ${i} must be sourced by the server account`,
        );
      }
    }

    // 11. Cryptographically verify the client signed the transaction
    const clientKeypair = Keypair.fromPublicKey(clientAccountId);
    const clientSigned = tx.signatures.some((sig) => {
      try {
        const sigBytes = sig.signature instanceof Uint8Array
          ? sig.signature
          : (sig.signature as unknown as { value: Uint8Array }).value;
        return clientKeypair.verify(tx.hash(), sigBytes);
      } catch {
        return false;
      }
    });
    if (!clientSigned) {
      throw new Sep10Error(Sep10ErrorCode.INVALID_SIGNATURE, 'Invalid challenge signature');
    }

    // 12. Reject replay of an already-redeemed challenge
    const nowSeconds = Math.floor(Date.now() / 1000);
    pruneConsumedChallengeNonces(nowSeconds);
    // value is Uint8Array in @stellar/stellar-sdk v16+; wrap in Buffer for base64
    const nonceKey = Buffer.from(manageDataOp.value).toString('base64');
    if (consumedChallengeNonces.has(nonceKey)) {
      throw new Sep10Error(Sep10ErrorCode.ALREADY_USED, 'Challenge has already been used');
    }
    consumedChallengeNonces.set(nonceKey, maxTime > 0 ? maxTime : nowSeconds + CHALLENGE_TTL_SECONDS);

    span.setAttribute('sep10.account', clientAccountId);
    return { account: clientAccountId };
  } catch (err) {
    // Ensure all errors are Sep10Error instances
    if (err instanceof Sep10Error) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    }
    // Any non-Sep10Error (unexpected SDK error) should be wrapped as MALFORMED_XDR
    const message = err instanceof Error ? err.message : String(err);
    const normalized = new Sep10Error(Sep10ErrorCode.MALFORMED_XDR, message);
    span.recordException(normalized);
    span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message });
    throw normalized;
  } finally {
    span.end();
  }
}

/**
 * Map a Sep10ErrorCode to HTTP status and ErrorCode for the controller layer.
 * 
 * Usage in controllers:
 *   try { verifyChallenge(xdr); } catch (err) {
 *     if (err instanceof Sep10Error) {
 *       const mapping = getErrorMapping(err.code);
 *       res.status(mapping.httpStatus).json({ success: false, error: mapping.clientMessage, code: mapping.errorCode });
 *     } else {
 *       next(err);
 *     }
 *   }
 */
export function getErrorMapping(code: Sep10ErrorCode): {
  httpStatus: number;
  errorCode: string;
  clientMessage: string;
} {
  switch (code) {
    case Sep10ErrorCode.CHALLENGE_EXPIRED:
      // 401 with TOKEN_EXPIRED for expired challenges
      return {
        httpStatus: 401,
        errorCode: 'TOKEN_EXPIRED',
        clientMessage: 'Challenge has expired',
      };

    case Sep10ErrorCode.INVALID_SIGNATURE:
    case Sep10ErrorCode.WRONG_SOURCE:
    case Sep10ErrorCode.BAD_SEQUENCE:
    case Sep10ErrorCode.MISSING_TIMEBOUNDS:
    case Sep10ErrorCode.FUTURE_MIN_TIME:
    case Sep10ErrorCode.NO_OPERATIONS:
    case Sep10ErrorCode.WRONG_OPERATION_TYPE:
    case Sep10ErrorCode.WRONG_OPERATION_NAME:
    case Sep10ErrorCode.INVALID_NONCE:
    case Sep10ErrorCode.MISSING_SOURCE_ACCOUNT:
    case Sep10ErrorCode.NOT_SIGNED_BY_SERVER:
    case Sep10ErrorCode.CLIENT_SOURCED_OPERATION:
    case Sep10ErrorCode.ALREADY_USED:
      // 401 with TOKEN_INVALID for authentication failures
      return {
        httpStatus: 401,
        errorCode: 'TOKEN_INVALID',
        clientMessage: 'Invalid challenge',
      };

    case Sep10ErrorCode.MALFORMED_XDR:
      // 400 with VALIDATION_ERROR for malformed input
      return {
        httpStatus: 400,
        errorCode: 'VALIDATION_ERROR',
        clientMessage: 'Invalid transaction format',
      };

    default:
      // Fallback - this should never happen
      return {
        httpStatus: 500,
        errorCode: 'INTERNAL_SERVER_ERROR',
        clientMessage: 'An unexpected error occurred',
      };
  }
}