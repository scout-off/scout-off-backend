import { rpc, Contract, Address, nativeToScVal, scValToNative, Keypair, Account } from '@stellar/stellar-sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import {
  createTxBuilder,
  isContractPausedError,
  isInsufficientFeeError,
  sendTransactionWithCorrelation,
  server,
} from './stellarCore';

const tracer = trace.getTracer('scout-off-backend');

export interface FeeWithdrawalResult {
  transactionId: string;
  recipient: string;
  amount: string; // u128 as string to avoid precision loss
  token: string;
}

export type FeeWithdrawalErrorCode =
  | 'NO_FEES'
  | 'INVALID_RECIPIENT'
  | 'NETWORK_ERROR'
  | 'CONTRACT_PAUSED'
  | 'INSUFFICIENT_FEES';

/** Non-retryable codes — the caller should not retry without corrective action. */
const NON_RETRYABLE_CODES: ReadonlySet<FeeWithdrawalErrorCode> = new Set([
  'NO_FEES',
  'INVALID_RECIPIENT',
  'CONTRACT_PAUSED',
  'INSUFFICIENT_FEES',
]);

export class FeeWithdrawalError extends Error {
  /** Whether the operation may succeed if retried (e.g. transient network blip). */
  public readonly retryable: boolean;

  constructor(
    message: string,
    public readonly code: FeeWithdrawalErrorCode,
  ) {
    super(message);
    this.name = 'FeeWithdrawalError';
    this.retryable = !NON_RETRYABLE_CODES.has(code);
  }
}

/**
 * Invoke `withdraw_fees(recipient: Address, amount: i128) -> i128` on the
 * Soroban contract via the platform keypair.
 *
 * Flow mirrors pauseContractOnChain() / cancelSubscriptionOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * `amountStroops` is the caller-validated withdrawal amount in stroops and
 * is encoded as an i128 argument in the contract call, so the on-chain
 * `withdraw_fees` enforces the exact requested amount (rejecting anything
 * above the available balance) instead of silently draining the vault.
 * When `amountStroops` is omitted (the legacy endpoint), the full available
 * balance is fetched first and withdrawn — that endpoint's historical
 * "withdraw everything" behaviour.
 *
 * On success, parses the confirmed transaction's i128 return value — the
 * actual amount withdrawn — and throws FeeWithdrawalError('No fees
 * available', 'NO_FEES') if it is zero rather than returning a zero-amount
 * result. Throws FeeWithdrawalError(..., 'CONTRACT_PAUSED') if the
 * contract's paused-state guard (error #10) rejects the call,
 * (..., 'INSUFFICIENT_FEES') if the contract's balance guard (error #7)
 * rejects the amount, and (..., 'NETWORK_ERROR') for any RPC/transport
 * failure.
 */
export async function withdrawFees(recipient: string, amountStroops?: string): Promise<FeeWithdrawalResult> {
  return tracer.startActiveSpan('stellar.withdrawFees', async (span) => {
    span.setAttribute('stellar.contract_function', 'withdraw_fees');
    try {
      if (!recipient) {
        throw new FeeWithdrawalError('Missing recipient', 'INVALID_RECIPIENT');
      }

      // Resolve the withdrawal amount. The fully-specified v2 endpoint passes
      // an explicit admin-validated amountStroops; the legacy endpoint omits
      // it, in which case the entire available balance is withdrawn (its
      // historical behaviour) — fetched first so the amount is still encoded
      // and enforced by the contract call.
      let requested: bigint;
      if (amountStroops === undefined) {
        const balance = await getFeeBalance();
        if (balance <= 0n) {
          throw new FeeWithdrawalError('No fees available to withdraw', 'NO_FEES');
        }
        requested = balance;
      } else {
        requested = BigInt(amountStroops);
        if (requested <= 0n) {
          throw new FeeWithdrawalError('No fees available to withdraw', 'NO_FEES');
        }
      }
      span.setAttribute('stellar.withdraw_amount', requested.toString());

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      let account;
      try {
        account = await server.getAccount(keypair.publicKey());
      } catch (err) {
        throw new FeeWithdrawalError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      const contract = new Contract(config.subscriptionContractId);

      const tx = createTxBuilder(account)
        .addOperation(
          contract.call(
            'withdraw_fees',
            Address.fromString(recipient).toScVal(),
            nativeToScVal(requested, { type: 'i128' }),
          ),
        )
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(tx);
      } catch (err) {
        throw new FeeWithdrawalError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (isContractPausedError(errMsg)) {
          throw new FeeWithdrawalError('Contract is paused; withdrawal not available', 'CONTRACT_PAUSED');
        }
        if (isInsufficientFeeError(errMsg)) {
          throw new FeeWithdrawalError(
            'Requested withdrawal amount exceeds the available fee balance',
            'INSUFFICIENT_FEES',
          );
        }
        throw new FeeWithdrawalError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = rpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      let sendResult;
      try {
        sendResult = await sendTransactionWithCorrelation(preparedTx);
      } catch (err) {
        throw new FeeWithdrawalError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }
      if (sendResult.status === 'ERROR') {
        const errMsg = String(sendResult.errorResult ?? '');
        if (isContractPausedError(errMsg)) {
          throw new FeeWithdrawalError('Contract is paused; withdrawal not available', 'CONTRACT_PAUSED');
        }
        if (isInsufficientFeeError(errMsg)) {
          throw new FeeWithdrawalError(
            'Requested withdrawal amount exceeds the available fee balance',
            'INSUFFICIENT_FEES',
          );
        }
        throw new FeeWithdrawalError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
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
        throw new FeeWithdrawalError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
        if (isContractPausedError(resultMeta)) {
          throw new FeeWithdrawalError('Contract is paused; withdrawal not available', 'CONTRACT_PAUSED');
        }
        if (isInsufficientFeeError(resultMeta)) {
          throw new FeeWithdrawalError(
            'Requested withdrawal amount exceeds the available fee balance',
            'INSUFFICIENT_FEES',
          );
        }
        throw new FeeWithdrawalError('withdraw_fees transaction failed on-chain', 'NETWORK_ERROR');
      }

      const success = getResult as rpc.Api.GetSuccessfulTransactionResponse;
      const amount = success.returnValue
        ? (scValToNative(success.returnValue) as bigint)
        : 0n;
      span.setAttribute('stellar.fee_amount', amount.toString());

      if (amount === 0n) {
        throw new FeeWithdrawalError('No fees available to withdraw', 'NO_FEES');
      }

      return {
        transactionId: hash,
        recipient,
        amount: amount.toString(),
        token: 'XLM',
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


export class FeeBalanceError extends Error {
  constructor(
    message: string,
    public readonly code: 'NETWORK_ERROR' | 'CONTRACT_PAUSED',
  ) {
    super(message);
    this.name = 'FeeBalanceError';
  }
}

/**
 * Read the current accumulated platform fee balance from the Soroban contract
 * by invoking `get_fee_balance() -> i128` via simulateTransaction.
 *
 * This is a read-only call — no transaction is signed or submitted.  Uses an
 * ephemeral keypair as the simulation source (same pattern as isSubscribed /
 * queryMilestones) so no platform key material is required.
 *
 * Returns the balance as a BigInt.  Returns 0n when the contract returns a
 * zero balance or when the return value is absent (treat as empty vault).
 * Throws FeeBalanceError with code 'CONTRACT_PAUSED' when the contract's
 * paused-state guard rejects the simulation, or 'NETWORK_ERROR' for any
 * RPC / transport failure.
 */
export async function getFeeBalance(): Promise<bigint> {
  return tracer.startActiveSpan('stellar.getFeeBalance', async (span) => {
    span.setAttribute('stellar.contract_function', 'get_fee_balance');
    try {
      const contract = new Contract(config.subscriptionContractId);
      const ephemeral = Keypair.random();
      const sourceAccount = new Account(ephemeral.publicKey(), '0');

      const tx = createTxBuilder(sourceAccount)
        .addOperation(contract.call('get_fee_balance'))
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(tx);
      } catch (err) {
        throw new FeeBalanceError(
          `Simulation request failed: ${(err as Error).message}`,
          'NETWORK_ERROR',
        );
      }

      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (isContractPausedError(errMsg)) {
          throw new FeeBalanceError('Contract is paused', 'CONTRACT_PAUSED');
        }
        throw new FeeBalanceError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const successSim = simResult as rpc.Api.SimulateTransactionSuccessResponse;
      const retval = successSim.result?.retval;
      if (!retval) {
        span.setAttribute('stellar.fee_balance', '0');
        return 0n;
      }

      const balance = scValToNative(retval) as bigint;
      span.setAttribute('stellar.fee_balance', balance.toString());
      return balance;
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
