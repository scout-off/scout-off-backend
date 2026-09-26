import { rpc, Contract, Address } from '@stellar/stellar-sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import {
  PaymentError,
  createTxBuilder,
  sendTransactionWithCorrelation,
  server,
} from './stellarCore';

const tracer = trace.getTracer('scout-off-backend');

export interface UpdatePlatformFeeResult {
  transactionId: string;
  newFeeBps: number;
}

/**
 * Stub for the admin-only `set_platform_fee_bps(new_bps: u32)` contract call.
 * Valid range: 0–10000 bps.
 */
export async function updatePlatformFee(newFeeBps: number): Promise<UpdatePlatformFeeResult> {
  if (newFeeBps < 0 || newFeeBps > 10000) {
    throw new Error('newFeeBps must be between 0 and 10000');
  }
  return { transactionId: `stub-fee-txid-${Date.now()}`, newFeeBps };
}

export interface ContractActionResult {
  transactionId: string;
}

export class ContractActionError extends Error {
  constructor(
    message: string,
    public readonly code: 'CONTRACT_NOT_PAUSED' | 'CONTRACT_ALREADY_PAUSED' | 'NETWORK_ERROR' | 'UNAUTHORIZED',
  ) {
    super(message);
    this.name = 'ContractActionError';
  }
}

/**
 * Invoke the contract's `unpause()` function via the platform keypair.
 * Returns the transaction hash on success.
 * Throws ContractActionError with code 'CONTRACT_NOT_PAUSED' if the simulation
 * indicates the contract is not currently paused (Soroban error code 10).
 */
export async function unpauseContractOnChain(adminWallet: string): Promise<ContractActionResult> {
  return tracer.startActiveSpan('stellar.unpauseContractOnChain', async (span) => {
    span.setAttribute('stellar.contract_function', 'unpause');
    try {
      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      const account = await server.getAccount(keypair.publicKey());
      // The subscription contract is the primary lifecycle entrypoint; each
      // deployed contract exposes its own pause(admin)/unpause(admin) — route
      // to subscriptionContractId which is the contract the admin manages for
      // subscription-related pausing. The register contract exposes the same
      // entrypoints for player-profile operations.
      const contract = new Contract(config.subscriptionContractId);

      const tx = createTxBuilder(account)
        .addOperation(contract.call('unpause', Address.fromString(adminWallet).toScVal()))
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (errMsg.includes('ContractPaused') || errMsg.includes('contract_paused') || errMsg.includes('#10')) {
          throw new ContractActionError('Contract is not currently paused', 'CONTRACT_NOT_PAUSED');
        }
        throw new ContractActionError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = rpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      const sendResult = await sendTransactionWithCorrelation(preparedTx);
      if (sendResult.status === 'ERROR') {
        throw new ContractActionError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult = await server.getTransaction(hash);
      while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
        await new Promise((r) => setTimeout(r, 1000));
        getResult = await server.getTransaction(hash);
      }

      if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new ContractActionError('Transaction failed on-chain', 'NETWORK_ERROR');
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

// ─── Validator registration ───────────────────────────────────────────────────

export interface RegisterValidatorResult {
  transactionId: string;
}

export type ValidatorActionErrorCode =
  | 'ALREADY_REGISTERED'
  // 'ALREADY_REVOKED' / 'NOT_REGISTERED' belong to revokeValidatorOnChain's
  // half of this same error type (see adminController.ts's revokeValidator
  // handler) — included here so ValidatorActionError stays a single shared
  // type across both validator admin actions rather than forking per-action
  // error classes.
  | 'ALREADY_REVOKED'
  | 'NOT_REGISTERED'
  | 'UNAUTHORIZED'
  | 'NETWORK_ERROR';

/**
 * Thrown when a validator admin action (register/revoke) contract call
 * cannot proceed due to a known on-chain state, or fails for network/
 * transport reasons. Known-state codes map to 4xx HTTP responses in the
 * controller; NETWORK_ERROR maps to 5xx.
 */
export class ValidatorActionError extends Error {
  constructor(
    message: string,
    public readonly code: ValidatorActionErrorCode,
  ) {
    super(message);
    this.name = 'ValidatorActionError';
  }
}

/**
 * Invoke `register_validator(validator: Address)` on the Soroban contract
 * via the platform keypair.
 *
 * Flow mirrors unpauseContractOnChain() / cancelSubscriptionOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash.
 *
 * NOTE on error codes: the contract's register_validator call is currently
 * idempotent (re-registering an already-registered wallet succeeds
 * silently), so ALREADY_REGISTERED is unlikely to surface today. The
 * string matching below is best-effort — mirroring the #8/#9 pattern
 * cancelSubscriptionOnChain() uses for the subscription contract — so
 * callers still get a typed error to branch on if the contract's error
 * enum grows a dedicated code for this case later. Any simulation/
 * submission/poll failure that doesn't match a known pattern falls
 * through to a generic NETWORK_ERROR rather than crashing.
 */
export async function registerValidatorOnChain(
  validatorWallet: string,
): Promise<RegisterValidatorResult> {
  return tracer.startActiveSpan('stellar.registerValidatorOnChain', async (span) => {
    span.setAttribute('stellar.contract_function', 'register_validator');
    try {
      if (!validatorWallet) {
        throw new PaymentError('Missing validatorWallet', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      const account = await server.getAccount(keypair.publicKey());
      const contract = new Contract(config.progressContractId);

      const tx = createTxBuilder(account)
        .addOperation(
          contract.call('register_validator', Address.fromString(validatorWallet).toScVal()),
        )
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        // Best-effort contract error mapping — see NOTE above.
        if (errMsg.includes('#13') || /already.?registered/i.test(errMsg)) {
          throw new ValidatorActionError('Validator is already registered on-chain', 'ALREADY_REGISTERED');
        }
        if (/unauthorized/i.test(errMsg)) {
          throw new ValidatorActionError('Unauthorized: platform account cannot register this validator', 'UNAUTHORIZED');
        }
        throw new ValidatorActionError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = rpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      const sendResult = await sendTransactionWithCorrelation(preparedTx);
      if (sendResult.status === 'ERROR') {
        throw new ValidatorActionError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
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
        if (resultMeta.includes('#13') || /already.?registered/i.test(resultMeta)) {
          throw new ValidatorActionError('Validator is already registered on-chain', 'ALREADY_REGISTERED');
        }
        throw new ValidatorActionError('register_validator transaction failed on-chain', 'NETWORK_ERROR');
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

/**
 * Invoke the contract's `pause()` function via the platform keypair.
 * Returns the transaction hash on success.
 * Throws ContractActionError with code 'CONTRACT_ALREADY_PAUSED' if the simulation
 * indicates the contract is already paused (Soroban error code 10).
 *
 * Note: the shared contract error enum (contracts/shared/src/errors.rs) only
 * defines a single generic `ContractPaused` (#10) variant for paused-state
 * preconditions — there is no distinct "already paused" vs "not paused"
 * error code. pause()/unpause() reuse that same variant for whichever
 * precondition fails, so the client interprets the code based on which
 * action was invoked (mirrors unpauseContractOnChain's string matching).
 */
export async function pauseContractOnChain(adminWallet: string): Promise<ContractActionResult> {
  return tracer.startActiveSpan('stellar.pauseContractOnChain', async (span) => {
    span.setAttribute('stellar.contract_function', 'pause');
    try {
      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      const account = await server.getAccount(keypair.publicKey());
      const contract = new Contract(config.subscriptionContractId);

      const tx = createTxBuilder(account)
        .addOperation(contract.call('pause', Address.fromString(adminWallet).toScVal()))
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (errMsg.includes('ContractPaused') || errMsg.includes('contract_paused') || errMsg.includes('#10')) {
          throw new ContractActionError('Contract is already paused', 'CONTRACT_ALREADY_PAUSED');
        }
        throw new ContractActionError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = rpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      const sendResult = await sendTransactionWithCorrelation(preparedTx);
      if (sendResult.status === 'ERROR') {
        throw new ContractActionError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult = await server.getTransaction(hash);
      while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
        await new Promise((r) => setTimeout(r, 1000));
        getResult = await server.getTransaction(hash);
      }

      if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new ContractActionError('Transaction failed on-chain', 'NETWORK_ERROR');
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


export async function revokeValidatorOnChain(
  validatorWallet: string,
): Promise<RegisterValidatorResult> {
  return tracer.startActiveSpan('stellar.revokeValidatorOnChain', async (span) => {
    span.setAttribute('stellar.contract_function', 'revoke_validator');
    try {
      if (!validatorWallet) {
        throw new PaymentError('Missing validatorWallet', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      const account = await server.getAccount(keypair.publicKey());
      const contract = new Contract(config.progressContractId);

      const tx = createTxBuilder(account)
        .addOperation(
          contract.call('revoke_validator', Address.fromString(validatorWallet).toScVal()),
        )
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (errMsg.includes('#14') || /already.?revoked/i.test(errMsg)) {
          throw new ValidatorActionError('Validator is already revoked on-chain', 'ALREADY_REVOKED');
        }
        if (errMsg.includes('#15') || /not.?registered/i.test(errMsg)) {
          throw new ValidatorActionError('Wallet is not a registered validator on-chain', 'NOT_REGISTERED');
        }
        if (/unauthorized/i.test(errMsg)) {
          throw new ValidatorActionError('Unauthorized: platform account cannot revoke this validator', 'UNAUTHORIZED');
        }
        throw new ValidatorActionError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = rpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      const sendResult = await sendTransactionWithCorrelation(preparedTx);
      if (sendResult.status === 'ERROR') {
        throw new ValidatorActionError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
      }

      const hash = sendResult.hash;
      span.setAttribute('stellar.tx_hash', hash);

      let getResult = await server.getTransaction(hash);
      while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
        await new Promise((r) => setTimeout(r, 1000));
        getResult = await server.getTransaction(hash);
      }

      if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        const resultMeta = ((getResult as unknown) as { resultMetaXdr?: string }).resultMetaXdr ?? '';
        if (resultMeta.includes('#14') || /already.?revoked/i.test(resultMeta)) {
          throw new ValidatorActionError('Validator is already revoked on-chain', 'ALREADY_REVOKED');
        }
        if (resultMeta.includes('#15') || /not.?registered/i.test(resultMeta)) {
          throw new ValidatorActionError('Wallet is not a registered validator on-chain', 'NOT_REGISTERED');
        }
        throw new ValidatorActionError('revoke_validator transaction failed on-chain', 'NETWORK_ERROR');
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
