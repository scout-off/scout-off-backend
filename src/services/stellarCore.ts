import {
  rpc,
  Networks,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  Account,
  Address,
  scValToNative,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import { correlationMemoFromContext, recordTxCorrelation } from './txCorrelation';

import { stellarBreaker } from '../utils/circuitBreaker';

const tracer = trace.getTracer('scout-off-backend');

const rawServer = new rpc.Server(config.sorobanRpcUrl, {
  allowHttp: config.sorobanRpcUrl.startsWith('http://'),
  timeout: config.stellarRpcTimeoutMs,
});

// Ensure the underlying HTTP client also respects the RPC timeout when the
// SDK exposes it (version-dependent; optional chaining keeps this safe).
if ((rawServer as { httpClient?: { defaults?: { timeout?: number } } }).httpClient?.defaults) {
  (rawServer as { httpClient: { defaults: { timeout: number } } }).httpClient.defaults.timeout =
    config.stellarRpcTimeoutMs;
}

const server = new Proxy(rawServer, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value === 'function') {
      return (...args: any[]) => stellarBreaker.execute(() => value.apply(target, args));
    }
    return value;
  }
});

export { server, stellarBreaker };

export function networkPassphrase(): string {
  return config.network === 'mainnet'
    ? Networks.PUBLIC
    : Networks.TESTNET;
}

/**
 * Build a TransactionBuilder with an optional short correlation memo (#1113).
 * Memo is omitted when no request correlation context is active (background jobs).
 */
export function createTxBuilder(sourceAccount: Account): TransactionBuilder {
  const opts: ConstructorParameters<typeof TransactionBuilder>[1] = {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  };
  const memo = correlationMemoFromContext();
  if (memo) {
    opts.memo = memo;
  }
  return new TransactionBuilder(sourceAccount, opts);
}

/**
 * Submit a prepared transaction and bridge the current correlation id to the
 * resulting tx hash for later indexer / webhook re-attachment.
 */
export async function sendTransactionWithCorrelation(
  preparedTx: ReturnType<TransactionBuilder['build']>,
) {
  const sendResult = await server.sendTransaction(preparedTx);
  if (sendResult.hash) {
    recordTxCorrelation(sendResult.hash);
  }
  return sendResult;
}


export async function getLatestLedger(): Promise<number> {
  const ledger = await server.getLatestLedger();
  return ledger.sequence;
}

export type PaymentStatus = 'pending' | 'submitted' | 'failed';

export interface ContactPaymentResult {
  transactionId: string;
  status: PaymentStatus;
}

export type PaymentErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_ACCOUNT'
  | 'NETWORK_ERROR'
  | 'MISSING_PLAYER'
  | 'EXPIRED_TRUSTLINE'
  | 'CONTRACT_PAUSED'
  | 'CONTRACT_ERROR'
  | 'UNKNOWN';

export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly code: PaymentErrorCode,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

/** Matches the contract's ContractPaused (#10) error in a simulation/result error string. */
export function isContractPausedError(message: string): boolean {
  return /#10\b/.test(message) || /contract.?paused/i.test(message);
}

/** Matches the contract's PlayerNotFound (#3) error in a simulation/result error string. */
export function isPlayerNotFoundError(message: string): boolean {
  return /#3\b/.test(message) || /player.?not.?found/i.test(message);
}

/** Matches Soroban contract error #7 (InsufficientFee) in a simulation/result error string. */
export function isInsufficientFeeError(message: string): boolean {
  return /#7\b/.test(message) || /insufficient.?fee/i.test(message);
}

/**
 * Classify a contract error message (from simulation, submission, or the
 * confirmed transaction XDR) into the matching PaymentError, or null when the
 * message is unrecognised.
 */
export function contractErrorToPaymentError(message: string): PaymentError | null {
  if (isInsufficientFeeError(message)) {
    return new PaymentError('Insufficient funds to unlock contact', 'INSUFFICIENT_FUNDS');
  }
  if (isContractPausedError(message)) {
    return new PaymentError('Contract is paused; contact unlocks are unavailable', 'CONTRACT_PAUSED');
  }
  if (isPlayerNotFoundError(message)) {
    return new PaymentError('Player not found on-chain', 'MISSING_PLAYER');
  }
  return null;
}

/**
 * Poll `getTransaction(hash)` until the transaction reaches a final status
 * (SUCCESS or FAILED), bounded by `config.txConfirmationTimeoutMs`.
 *
 * A transaction that is still NOT_FOUND when the deadline passes is reported
 * as a PaymentError NETWORK_ERROR — a submitted-but-unconfirmed transaction
 * must never be treated as a completed unlock by the caller.
 */
const TX_CONFIRMATION_POLL_INTERVAL_MS = 1_000;

export async function waitForTransactionConfirmation(
  hash: string,
): Promise<rpc.Api.GetTransactionResponse> {
  const deadline = Date.now() + config.txConfirmationTimeoutMs;
  let getResult;
  try {
    getResult = await server.getTransaction(hash);
    while (
      getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, TX_CONFIRMATION_POLL_INTERVAL_MS));
      getResult = await server.getTransaction(hash);
    }
  } catch (err) {
    throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
  }

  if (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    throw new PaymentError('Transaction confirmation timed out', 'NETWORK_ERROR');
  }

  return getResult;
}

/**
 * Ping the Soroban RPC to verify network reachability.
 */
export async function stellarHealth(): Promise<boolean> {
  try {
    await server.getLatestLedger();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a scout has an active on-chain subscription by invoking
 * `is_subscribed(scout)` on the Soroban contract via simulateTransaction.
 *
 * The contract function returns a plain bool; the expiry ledger is not
 * exposed via this entry point, so expiresAt is '' for active and null
 * for inactive/absent subscriptions.
 */
export async function isSubscribed(
  scoutWallet: string,
): Promise<{ active: boolean; expiresAt: string | null }> {
  return tracer.startActiveSpan('stellar.isSubscribed', async (span) => {
    span.setAttribute('stellar.contract_function', 'is_subscribed');
    try {
      if (!scoutWallet) {
        throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
      }

      try {
        const contract = new Contract(config.subscriptionContractId);
        // Use a random ephemeral keypair as the simulation source — no on-chain
        // auth is required for this view-only call, and we never submit the tx.
        const ephemeral = Keypair.random();
        const sourceAccount = new Account(ephemeral.publicKey(), '0');

        const tx = createTxBuilder(sourceAccount)
          .addOperation(
            contract.call('is_subscribed', Address.fromString(scoutWallet).toScVal()),
          )
          .setTimeout(30)
          .build();

        const simResult = await server.simulateTransaction(tx);

        if (rpc.Api.isSimulationError(simResult)) {
          throw new PaymentError(
            `Contract simulation failed: ${simResult.error}`,
            'NETWORK_ERROR',
          );
        }

        const successSim = simResult as rpc.Api.SimulateTransactionSuccessResponse;
        const retval = successSim.result?.retval;
        if (!retval) {
          span.setAttribute('stellar.active', false);
          return { active: false, expiresAt: null };
        }

        const active = scValToNative(retval) as boolean;
        span.setAttribute('stellar.active', active);
        return { active, expiresAt: active ? '' : null };
      } catch (err) {
        if (err instanceof PaymentError) throw err;
        throw new PaymentError(
          `RPC call failed: ${(err as Error).message}`,
          'NETWORK_ERROR',
        );
      }
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.setAttribute('error.type', (err as Error).name);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Invoke `pay_to_contact(scout, player_id)` on the Soroban contract to unlock
 * direct contact with a player by paying the platform's micro-fee.
 *
 * Flow mirrors purchaseSubscription() / logTrialOffer():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * The fee is not supplied by the client — the contract computes it from its
 * own PLATFORM_FEE_BPS-derived configuration (`get_contact_fee()`), so the
 * backend never trusts a caller-supplied amount. Confirmation polling is
 * bounded by config.txConfirmationTimeoutMs: a submitted-but-unconfirmed
 * transaction is reported as an error, never as a completed unlock.
 *
 * On success returns the confirmed transaction hash and a 'submitted' status.
 * Throws PaymentError with code:
 *   'INSUFFICIENT_FUNDS' — contract error #7 (InsufficientFee)
 *   'CONTRACT_PAUSED'    — contract error #10 (ContractPaused)
 *   'MISSING_PLAYER'     — contract error #3 (PlayerNotFound)
 *   'NETWORK_ERROR'      — RPC/transport failure, on-chain rejection with an
 *                          unrecognised error, or confirmation timeout
 */
