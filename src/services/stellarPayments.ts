import { rpc, Contract, Address, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import {
  ContactPaymentResult,
  PaymentError,
  contractErrorToPaymentError,
  createTxBuilder,
  isInsufficientFeeError,
  sendTransactionWithCorrelation,
  server,
  waitForTransactionConfirmation,
} from './stellarCore';

const tracer = trace.getTracer('scout-off-backend');

export async function submitContactPayment(
  scoutWallet: string,
  playerId: string,
): Promise<ContactPaymentResult> {
  return tracer.startActiveSpan('stellar.submitContactPayment', async (span): Promise<ContactPaymentResult> => {
    span.setAttribute('stellar.contract_function', 'pay_to_contact');
    span.setAttribute('stellar.player_id', playerId);
    try {
      if (!scoutWallet || !playerId) {
        throw new PaymentError('Missing scoutWallet or playerId', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      let account;
      try {
        account = await server.getAccount(keypair.publicKey());
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      const contract = new Contract(config.subscriptionContractId);

      const tx = createTxBuilder(account)
        .addOperation(
          contract.call(
            'pay_to_contact',
            Address.fromString(scoutWallet).toScVal(),
            nativeToScVal(playerId, { type: 'string' }),
          ),
        )
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(tx);
      } catch (err) {
        throw new PaymentError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        const mapped = contractErrorToPaymentError(errMsg);
        if (mapped) throw mapped;
        throw new PaymentError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = rpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      let sendResult;
      try {
        sendResult = await sendTransactionWithCorrelation(preparedTx);
      } catch (err) {
        throw new PaymentError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }
      if (sendResult.status === 'ERROR') {
        const errMsg = String(sendResult.errorResult ?? '');
        const mapped = contractErrorToPaymentError(errMsg);
        if (mapped) throw mapped;
        throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      const getResult = await waitForTransactionConfirmation(hash);

      if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
        const mapped = contractErrorToPaymentError(resultMeta);
        if (mapped) throw mapped;
        throw new PaymentError('pay_to_contact transaction failed on-chain', 'NETWORK_ERROR');
      }

      span.setAttribute('stellar.status', 'submitted');
      return {
        transactionId: hash,
        status: 'submitted',
      };
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

// ─── Trial offer ──────────────────────────────────────────────────────────────

export interface TrialOfferResult {
  transactionId: string;
  playerId: string;
  detailsUri: string;
  playerTier: number;
}

/**
 * Invoke the contract's `log_trial_offer(scout, player_id, details_uri)` method.
 * Creates an immutable on-chain record of the offer; the contract promotes the
 * player's tier and returns the updated value.
 *
 * Flow mirrors cancelSubscriptionOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash and the player's
 * updated tier as reported by the contract's return value.
 */
export async function logTrialOffer(
  scoutWallet: string,
  playerId: string,
  detailsUri: string,
): Promise<TrialOfferResult> {
  return tracer.startActiveSpan('stellar.logTrialOffer', async (span) => {
    span.setAttribute('stellar.contract_function', 'log_trial_offer');
    span.setAttribute('stellar.player_id', playerId);
    try {
      if (!scoutWallet || !playerId || !detailsUri) {
        throw new PaymentError('Missing scoutWallet, playerId, or detailsUri', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      let account;
      try {
        account = await server.getAccount(keypair.publicKey());
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      const contract = new Contract(config.connectionContractId);

      const tx = createTxBuilder(account)
        .addOperation(
          contract.call(
            'log_trial_offer',
            Address.fromString(scoutWallet).toScVal(),
            nativeToScVal(playerId, { type: 'string' }),
            nativeToScVal(detailsUri, { type: 'string' }),
          ),
        )
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(tx);
      } catch (err) {
        throw new PaymentError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (rpc.Api.isSimulationError(simResult)) {
        throw new PaymentError(`Simulation failed: ${simResult.error}`, 'NETWORK_ERROR');
      }

      const preparedTx = rpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      let sendResult;
      try {
        sendResult = await sendTransactionWithCorrelation(preparedTx);
      } catch (err) {
        throw new PaymentError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }
      if (sendResult.status === 'ERROR') {
        throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult;
      try {
        getResult = await server.getTransaction(hash);
        while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
          await new Promise((r) => setTimeout(r, 1000));
          getResult = await server.getTransaction(hash);
        }
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new PaymentError('log_trial_offer transaction failed on-chain', 'NETWORK_ERROR');
      }

      const success = getResult as rpc.Api.GetSuccessfulTransactionResponse;
      const playerTier = success.returnValue
        ? (scValToNative(success.returnValue) as number)
        : 3;
      span.setAttribute('stellar.player_tier', playerTier);

      return {
        transactionId: hash,
        playerId,
        detailsUri,
        playerTier,
      };
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

// ─── Milestone query ──────────────────────────────────────────────────────────


export type SubscriptionTier = 'basic' | 'premium';

export interface SubscriptionResult {
  transactionId: string;
  tier: SubscriptionTier;
  expiresAt: number; // Unix timestamp
  status: 'active';
}

/**
 * Matches a missing/expired classic Stellar trustline in a simulation/result
 * error string. The contract's payment token may be a Stellar Asset Contract
 * wrapping a classic asset, whose trustline errors surface as diagnostic text
 * rather than a scout_off_shared::errors::Error code, so — like
 * isContractPausedError() above — this is a best-effort message match rather
 * than a numbered contract error.
 */
function isExpiredTrustlineError(message: string): boolean {
  return /trust.?line/i.test(message);
}

/**
 * Invoke `subscribe(scout, tier, duration)` on the Soroban contract.
 *
 * Flow mirrors cancelSubscriptionOnChain() / logTrialOffer():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash and the on-chain expiry
 * timestamp decoded from the contract's return value.
 * Throws PaymentError with code 'INSUFFICIENT_FUNDS' for contract error #7
 * (InsufficientFee).
 */
export async function purchaseSubscription(
  scoutWallet: string,
  tier: SubscriptionTier,
  duration: number,
): Promise<SubscriptionResult> {
  return tracer.startActiveSpan('stellar.purchaseSubscription', async (span): Promise<SubscriptionResult> => {
    span.setAttribute('stellar.contract_function', 'subscribe');
    span.setAttribute('stellar.tier', tier);
    try {
      if (!scoutWallet) {
        throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      let account;
      try {
        account = await server.getAccount(keypair.publicKey());
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      const contract = new Contract(config.subscriptionContractId);

      const tx = createTxBuilder(account)
        .addOperation(
          contract.call(
            'subscribe',
            Address.fromString(scoutWallet).toScVal(),
            nativeToScVal(tier, { type: 'string' }),
            nativeToScVal(duration, { type: 'u32' }),
          ),
        )
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(tx);
      } catch (err) {
        throw new PaymentError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (isInsufficientFeeError(errMsg)) {
          throw new PaymentError('Insufficient funds for subscription', 'INSUFFICIENT_FUNDS');
        }
        throw new PaymentError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = rpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      let sendResult;
      try {
        sendResult = await sendTransactionWithCorrelation(preparedTx);
      } catch (err) {
        throw new PaymentError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }
      if (sendResult.status === 'ERROR') {
        const errMsg = String(sendResult.errorResult ?? '');
        if (isInsufficientFeeError(errMsg)) {
          throw new PaymentError('Insufficient funds for subscription', 'INSUFFICIENT_FUNDS');
        }
        throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult;
      try {
        getResult = await server.getTransaction(hash);
        while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
          await new Promise((r) => setTimeout(r, 1000));
          getResult = await server.getTransaction(hash);
        }
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
        if (isInsufficientFeeError(resultMeta)) {
          throw new PaymentError('Insufficient funds for subscription', 'INSUFFICIENT_FUNDS');
        }
        throw new PaymentError('subscribe transaction failed on-chain', 'NETWORK_ERROR');
      }

      const success = getResult as rpc.Api.GetSuccessfulTransactionResponse;
      if (!success.returnValue) {
        throw new PaymentError('subscribe transaction returned no expiry value', 'NETWORK_ERROR');
      }
      const expiresAt = scValToNative(success.returnValue) as number;
      span.setAttribute('stellar.expires_at', expiresAt);

      return {
        transactionId: hash,
        tier,
        expiresAt,
        status: 'active',
      };
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
 * Re-invoke `subscribe(scout, tier, duration)` on the Soroban contract to renew
 * an existing subscription.
 *
 * The subscription contract has no dedicated renewal entry point (see
 * contracts/subscription/src/lib.rs) — its subscribe() is safely re-callable
 * while already active and simply overwrites the stored expiry with a fresh
 * one computed from the current ledger sequence (see its own
 * resubscribing_while_active_extends_expiry test), which is exactly the
 * behaviour a renewal needs.
 *
 * Flow mirrors purchaseSubscription() / cancelSubscriptionOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash and the on-chain expiry
 * timestamp decoded from the contract's return value — the contract is
 * authoritative for the new expiry, so currentExpiresAt is not used to
 * compute it (only recorded on the span for observability).
 *
 * Throws PaymentError with code:
 *   'INSUFFICIENT_FUNDS' — contract error #7 (InsufficientFee)
 *   'EXPIRED_TRUSTLINE'  — payment token trustline missing/expired
 *   'CONTRACT_ERROR'     — any other on-chain rejection (e.g. contract panic)
 *   'NETWORK_ERROR'      — RPC/transport failure, distinct from an on-chain rejection
 */
export async function renewSubscription(
  scoutWallet: string,
  tier: SubscriptionTier,
  duration: number,
  currentExpiresAt: number,
): Promise<SubscriptionResult> {
  return tracer.startActiveSpan('stellar.renewSubscription', async (span): Promise<SubscriptionResult> => {
    span.setAttribute('stellar.contract_function', 'subscribe');
    span.setAttribute('stellar.tier', tier);
    span.setAttribute('stellar.renewal', true);
    span.setAttribute('stellar.previous_expires_at', currentExpiresAt);
    try {
      if (!scoutWallet) {
        throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      let account;
      try {
        account = await server.getAccount(keypair.publicKey());
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      const contract = new Contract(config.subscriptionContractId);

      const tx = createTxBuilder(account)
        .addOperation(
          contract.call(
            'subscribe',
            Address.fromString(scoutWallet).toScVal(),
            nativeToScVal(tier, { type: 'string' }),
            nativeToScVal(duration, { type: 'u32' }),
          ),
        )
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(tx);
      } catch (err) {
        throw new PaymentError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (isInsufficientFeeError(errMsg)) {
          throw new PaymentError('Insufficient funds for subscription renewal', 'INSUFFICIENT_FUNDS');
        }
        if (isExpiredTrustlineError(errMsg)) {
          throw new PaymentError('Payment token trustline is missing or expired', 'EXPIRED_TRUSTLINE');
        }
        throw new PaymentError(`Simulation failed: ${errMsg}`, 'CONTRACT_ERROR');
      }

      const preparedTx = rpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      let sendResult;
      try {
        sendResult = await sendTransactionWithCorrelation(preparedTx);
      } catch (err) {
        throw new PaymentError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }
      if (sendResult.status === 'ERROR') {
        const errMsg = String(sendResult.errorResult ?? '');
        if (isInsufficientFeeError(errMsg)) {
          throw new PaymentError('Insufficient funds for subscription renewal', 'INSUFFICIENT_FUNDS');
        }
        if (isExpiredTrustlineError(errMsg)) {
          throw new PaymentError('Payment token trustline is missing or expired', 'EXPIRED_TRUSTLINE');
        }
        throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'CONTRACT_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult;
      try {
        getResult = await server.getTransaction(hash);
        while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
          await new Promise((r) => setTimeout(r, 1000));
          getResult = await server.getTransaction(hash);
        }
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
        if (isInsufficientFeeError(resultMeta)) {
          throw new PaymentError('Insufficient funds for subscription renewal', 'INSUFFICIENT_FUNDS');
        }
        if (isExpiredTrustlineError(resultMeta)) {
          throw new PaymentError('Payment token trustline is missing or expired', 'EXPIRED_TRUSTLINE');
        }
        throw new PaymentError('subscribe transaction failed on-chain', 'CONTRACT_ERROR');
      }

      const success = getResult as rpc.Api.GetSuccessfulTransactionResponse;
      // Check the *decoded* value, not just whether returnValue is present: a
      // contract function returning unit (no expiry) still yields a truthy
      // ScVal wrapping scvVoid, which scValToNative() decodes to `null` rather
      // than throwing — so `!success.returnValue` alone would silently accept
      // a null expiry here instead of surfacing the mismatch.
      const decoded = success.returnValue ? scValToNative(success.returnValue) : null;
      if (typeof decoded !== 'number') {
        throw new PaymentError('renew_subscription transaction returned no expiry value', 'CONTRACT_ERROR');
      }
      const expiresAt = decoded;
      span.setAttribute('stellar.expires_at', expiresAt);

      return {
        transactionId: hash,
        tier,
        expiresAt,
        status: 'active',
      };
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

export type SubscriptionErrorCode =
  | 'NOT_SUBSCRIBED'
  | 'ALREADY_CANCELLED'
  | 'UNAUTHORIZED'
  | 'NETWORK_ERROR';

/**
 * Thrown when a cancel_subscription contract call cannot proceed due to a
 * known on-chain state — e.g. the scout was never subscribed or the
 * subscription was already cancelled.  These map to 4xx HTTP responses, not
 * 5xx, so we keep them separate from PaymentError.
 */
export class SubscriptionError extends Error {
  constructor(
    message: string,
    public readonly code: SubscriptionErrorCode,
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

/**
 * Invoke `cancel_subscription(scout)` on the Soroban contract.
 *
 * Flow mirrors unpauseContractOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash.
 * Maps Soroban contract error codes to SubscriptionError:
 *   #8 NotSubscribed  → code: 'NOT_SUBSCRIBED'
 *   #9 Unauthorized   → code: 'UNAUTHORIZED'
 */
export async function cancelSubscriptionOnChain(
  scoutWallet: string,
): Promise<{ transactionId: string }> {
  return tracer.startActiveSpan('stellar.cancelSubscriptionOnChain', async (span) => {
    span.setAttribute('stellar.contract_function', 'cancel_subscription');
    try {
      if (!scoutWallet) {
        throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      const account = await server.getAccount(keypair.publicKey());
      const contract = new Contract(config.subscriptionContractId);

      const tx = createTxBuilder(account)
        .addOperation(
          contract.call('cancel_subscription', Address.fromString(scoutWallet).toScVal()),
        )
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        // Contract error #8 = NotSubscribed
        if (errMsg.includes('#8') || /not.?subscribed/i.test(errMsg)) {
          throw new SubscriptionError('Scout has no active on-chain subscription', 'NOT_SUBSCRIBED');
        }
        // Contract error #9 = Unauthorized
        if (errMsg.includes('#9') || /unauthorized/i.test(errMsg)) {
          throw new SubscriptionError('Unauthorized: wallet is not allowed to cancel this subscription', 'UNAUTHORIZED');
        }
        throw new PaymentError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = rpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      const sendResult = await sendTransactionWithCorrelation(preparedTx);
      if (sendResult.status === 'ERROR') {
        throw new PaymentError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult = await server.getTransaction(hash);
      while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
        await new Promise((r) => setTimeout(r, 1000));
        getResult = await server.getTransaction(hash);
      }

      if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        // Inspect the result XDR for contract-level error codes.
        // Cast through unknown because GetFailedTransactionResponse and
        // GetSuccessfulTransactionResponse share no overlapping status type.
        const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
        if (resultMeta.includes('#8') || /not.?subscribed/i.test(resultMeta)) {
          throw new SubscriptionError('Scout has no active on-chain subscription', 'NOT_SUBSCRIBED');
        }
        if (resultMeta.includes('#9') || /unauthorized/i.test(resultMeta)) {
          throw new SubscriptionError('Unauthorized: wallet is not allowed to cancel this subscription', 'UNAUTHORIZED');
        }
        throw new PaymentError('cancel_subscription transaction failed on-chain', 'NETWORK_ERROR');
      }

      return { transactionId: hash };
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
