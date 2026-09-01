import crypto from 'crypto';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  Operation,
  Account,
  Transaction,
} from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';

const tracer = trace.getTracer('scout-off-backend');

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
      throw new Error(
        `SEP10_SERVER_SECRET is set but is not a valid Stellar secret key (strkey starting with 'S'). ` +
        `Generate a valid keypair with \`stellar keys generate\`. Original error: ${(err as Error).message}`,
      );
    }
  }
  // Ephemeral fallback for development / test only.
  return Keypair.random();
}

const SERVER_KEYPAIR = resolveServerKeypair();
const CHALLENGE_TTL_SECONDS = 300; // 5 min to sign the challenge
const TOKEN_TTL_SECONDS = 86400;   // 24 h JWT validity

/**
 * Tracks nonces (the base64-encoded manageData value) of SEP-10 challenges
 * that have already been redeemed for a token, so a captured signed
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
 */
export function buildChallenge(accountId: string): string {
  const span = tracer.startSpan('sep10.buildChallenge', { attributes: { 'sep10.account': accountId } });
  try {
  const serverAccount = new Account(SERVER_KEYPAIR.publicKey(), '-1');
  const tx = new TransactionBuilder(serverAccount, {
    fee: BASE_FEE,
    networkPassphrase:
      config.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
  })
    .addOperation(
      Operation.manageData({
        name: 'scoutoff auth',
        value: crypto.randomBytes(48).toString('base64'),
        source: accountId,
      })
    )
    .setTimeout(CHALLENGE_TTL_SECONDS)
    .build();

  tx.sign(SERVER_KEYPAIR);
  return tx.toXdr();
  } catch (err) {
    // Normalise to a plain Error before re-throwing. The SDK can throw
    // DOMException or XdrError which in some JS sandbox environments (e.g.
    // Jest's vm context) may not satisfy `instanceof Error`. Wrapping here
    // ensures callers always receive a genuine Error instance.
    const normalised = err instanceof Error
      ? err
      : new Error(String((err as { message?: string })?.message ?? err));
    span.recordException(normalised);
    span.setStatus({ code: SpanStatusCode.ERROR, message: normalised.message });
    throw normalised;
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
    const network =
      config.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
    const tx = new Transaction(xdr, network);
    return tx.operations[0].source ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify the client-signed challenge XDR and issue a JWT.
 *
 * This implements SEP-10 authentication by:
 * 1. Validating the challenge transaction structure
 * 2. Cryptographically verifying the client's signature using Keypair.verify()
 * 3. Issuing a JWT with client account and role claim
 *
 * Note: The role parameter is expected to be pre-validated by the caller.
 * Role enforcement (e.g., enum validation) is handled in the auth controller.
 * Authorized routes use requireRole() or requireRoles() middleware to enforce access.
 *
 * @param xdr - The signed challenge transaction in XDR format
 * @param role - Optional role claim for the JWT (defaults to 'player'). Must be validated by caller.
 * @returns JWT token and authenticated account ID
 * @throws Error if challenge structure is invalid or signature verification fails
 */
export function verifyAndIssueToken(xdr: string, role?: string): { token: string; account: string } {
  const span = tracer.startSpan('sep10.verifyAndIssueToken');
  try {
  const network =
    config.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

  const tx = new Transaction(xdr, network);

  // Enforce challenge TTL — reject expired challenges to prevent replay attacks
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (maxTime > 0 && Math.floor(Date.now() / 1000) > maxTime) {
    throw new Error('Challenge has expired');
  }

  // Validate challenge transaction structure
  if (!tx.operations || tx.operations.length === 0) {
    throw new Error('Invalid challenge: no operations found');
  }

  const op = tx.operations[0];

  // 1. Verify the first operation is manageData
  if (op.type !== 'manageData') {
    throw new Error('Invalid challenge: expected manageData operation');
  }

  // 2. Verify the operation name matches the expected server string
  const manageDataOp = op as Operation.ManageData;
  if (manageDataOp.name !== 'scoutoff auth') {
    throw new Error('Invalid challenge: wrong operation name');
  }

  // 3. Verify the nonce value is present and properly formatted (64 bytes)
  if (!manageDataOp.value) {
    throw new Error('Invalid challenge: missing nonce value');
  }

  // Validate the nonce is exactly 64 bytes by checking the raw buffer length
  if (manageDataOp.value.length !== 64) {
    throw new Error('Invalid challenge: nonce must be exactly 64 bytes');
  }

  // 4. Verify the operation's source is the client account
  const clientAccountId = manageDataOp.source;
  if (!clientAccountId) {
    throw new Error('Missing source account in challenge');
  }

  // 5. Verify the server signed the challenge (proves it was built by this server)
  // Per SEP-10, the challenge must originate from the server keypair
  const serverSigned = tx.signatures.some((sig) => {
    try {
      // In @stellar/stellar-sdk v16+, sig.signature is a Signature object
      // with a .value (Uint8Array) property rather than a callable function.
      const sigBytes = sig.signature instanceof Uint8Array
        ? sig.signature
        : (sig.signature as unknown as { value: Uint8Array }).value;
      return SERVER_KEYPAIR.verify(tx.hash(), sigBytes);
    } catch {
      return false;
    }
  });
  if (!serverSigned) throw new Error('Challenge not signed by server');

  // 6. Cryptographically verify the client signed the transaction
  // Using Keypair.verify() for proper ECDSA signature validation per SEP-10
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
  if (!clientSigned) throw new Error('Invalid challenge signature');

  // 7. Reject replay of an already-redeemed challenge. SEP-10 intends each
  // challenge to be single-use; without this check, a captured signed
  // challenge can be resubmitted for a fresh token as many times as desired
  // within its TTL window.
  const nowSeconds = Math.floor(Date.now() / 1000);
  pruneConsumedChallengeNonces(nowSeconds);
  // value is Uint8Array in @stellar/stellar-sdk v16+; wrap in Buffer for base64
  const nonceKey = Buffer.from(manageDataOp.value).toString('base64');
  if (consumedChallengeNonces.has(nonceKey)) {
    throw new Error('Challenge has already been used');
  }
  consumedChallengeNonces.set(nonceKey, maxTime > 0 ? maxTime : nowSeconds + CHALLENGE_TTL_SECONDS);

  // Issue JWT with client account, role, and a unique JTI for revocation support
  const jti = crypto.randomUUID();
  const token = jwt.sign({ sub: clientAccountId, role: role ?? 'player', jti }, config.jwtSecret, {
    expiresIn: TOKEN_TTL_SECONDS,
  });

  span.setAttribute('sep10.account', clientAccountId);
  return { token, account: clientAccountId };
  } catch (err) {
    // Normalise to a plain Error before re-throwing. The SDK can throw
    // DOMException or XdrError which in some JS sandbox environments (e.g.
    // Jest's vm context) may not satisfy `instanceof Error`. Wrapping here
    // ensures callers always receive a genuine Error instance.
    const normalised = err instanceof Error
      ? err
      : new Error(String((err as { message?: string })?.message ?? err));
    span.recordException(normalised);
    span.setStatus({ code: SpanStatusCode.ERROR, message: normalised.message });
    throw normalised;
  } finally {
    span.end();
  }
}
