import { rpc, Contract, Address, nativeToScVal } from '@stellar/stellar-sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import {
  PaymentError,
  createTxBuilder,
  isContractPausedError,
  sendTransactionWithCorrelation,
  server,
} from './stellarCore';
import { extractContractErrorCode } from '../utils/contractErrors';

const tracer = trace.getTracer('scout-off-backend');

export interface UpdatePlatformFeeResult {
  transactionId: string;
  newFeeBps: number;
}

export type UpdatePlatformFeeErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'CONTRACT_PAUSED'
  | 'NOT_INITIALIZED'
  | 'NETWORK_ERROR';

export class UpdatePlatformFeeError extends Error {
  constructor(
    message: string,
    public readonly code: UpdatePlatformFeeErrorCode,
  ) {
    super(message);
    this.name = 'UpdatePlatformFeeError';
  }
}

/**
 * Invoke `set_platform_fee_bps(admin: Address, platform_fee_bps: u32)` on the
 * Soroban subscription contract via the platform keypair.
 *
 * The subscription contract is the single authoritative source for the
 * platform fee — the register contract's setter was removed in #1314.
 *
 * Flow: getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash and the new fee bps.
 * Throws UpdatePlatformFeeError with code:
 *   'INVALID_INPUT'    — newFeeBps out of range 0–10000
 *   'UNAUTHORIZED'     — platform keypair lacks FEE_MANAGER
 *   'CONTRACT_PAUSED'  — contract error #10
 *   'NOT_INITIALIZED'  — contract has not been initialized
 *   'NETWORK_ERROR'    — RPC/transport failure or on-chain rejection
 */
export async function updatePlatformFee(newFeeBps: number): Promise<UpdatePlatformFeeResult> {
  if (!Number.isInteger(newFeeBps) || newFeeBps < 0 || newFeeBps > 10000) {
    throw new UpdatePlatformFeeError('newFeeBps must be an integer between 0 and 10000', 'INVALID_INPUT');
  }

  return tracer.startActiveSpan('stellar.updatePlatformFee', async (span) => {
    span.setAttribute('stellar.contract_function', 'set_platform_fee_bps');
    span.setAttribute('stellar.new_fee_bps', newFeeBps);
    try {
      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      let account;
      try {
        account = await server.getAccount(keypair.publicKey());
      } catch (err) {
        throw new UpdatePlatformFeeError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      const contract = new Contract(config.subscriptionContractId);

      const tx = createTxBuilder(account)
        .addOperation(
          contract.call(
            'set_platform_fee_bps',
            Address.fromString(keypair.publicKey()).toScVal(),
            nativeToScVal(newFeeBps, { type: 'u32' }),
          ),
        )
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(tx);
      } catch (err) {
        throw new UpdatePlatformFeeError(`Simulation request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (isContractPausedError(errMsg)) {
          throw new UpdatePlatformFeeError('Contract is paused; fee updates are unavailable', 'CONTRACT_PAUSED');
        }
        if (/#9\b/.test(errMsg) || /unauthorized/i.test(errMsg)) {
          throw new UpdatePlatformFeeError('Platform keypair is not authorized to set fee', 'UNAUTHORIZED');
        }
        if (/#2\b/.test(errMsg) || /not.?initialized/i.test(errMsg)) {
          throw new UpdatePlatformFeeError('Contract is not initialized', 'NOT_INITIALIZED');
        }
        if (/#5\b/.test(errMsg) || /invalid.?input/i.test(errMsg)) {
          throw new UpdatePlatformFeeError('Invalid fee value rejected by contract', 'INVALID_INPUT');
        }
        throw new UpdatePlatformFeeError(`Simulation failed: ${errMsg}`, 'NETWORK_ERROR');
      }

      const preparedTx = rpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(keypair);

      let sendResult;
      try {
        sendResult = await sendTransactionWithCorrelation(preparedTx);
      } catch (err) {
        throw new UpdatePlatformFeeError(`Submit request failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }
      if (sendResult.status === 'ERROR') {
        throw new UpdatePlatformFeeError(`Submit failed: ${sendResult.errorResult}`, 'NETWORK_ERROR');
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
        throw new UpdatePlatformFeeError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new UpdatePlatformFeeError('set_platform_fee_bps transaction failed on-chain', 'NETWORK_ERROR');
      }

      span.setAttribute('stellar.status', 'success');
      return { transactionId: hash, newFeeBps };
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
        .addOperation(contract.call('unpause', Address.fromString(keypair.publicKey()).toScVal()))
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (errMsg.includes('ContractPaused') || errMsg.includes('contract_paused') || errMsg.includes('#10')) {
          throw new ContractActionError('Contract is not currently paused', 'CONTRACT_NOT_PAUSED');
        }
        if (/#9\b/.test(errMsg) || /unauthorized/i.test(errMsg)) {
          throw new ContractActionError('Platform signer requires the PAUSER role', 'UNAUTHORIZED');
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
          contract.call('register_validator_as', Address.fromString(keypair.publicKey()).toScVal(), Address.fromString(validatorWallet).toScVal()),
        )
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        // Best-effort contract error mapping — see NOTE above.
        const code = extractContractErrorCode(errMsg);
        if (code === 13) {
          throw new ValidatorActionError('Validator is not registered on-chain', 'NOT_REGISTERED');
        }
        if (/already.?registered/i.test(errMsg)) {
          throw new ValidatorActionError('Validator is already registered on-chain', 'ALREADY_REGISTERED');
        }
        if (/#9\b/.test(errMsg) || /unauthorized/i.test(errMsg)) {
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
        const code = extractContractErrorCode(resultMeta);
        if (code === 13) {
          throw new ValidatorActionError('Validator is not registered on-chain', 'NOT_REGISTERED');
        }
        if (/already.?registered/i.test(resultMeta)) {
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
        .addOperation(contract.call('pause', Address.fromString(keypair.publicKey()).toScVal()))
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (errMsg.includes('ContractPaused') || errMsg.includes('contract_paused') || errMsg.includes('#10')) {
          throw new ContractActionError('Contract is already paused', 'CONTRACT_ALREADY_PAUSED');
        }
        if (/#9\b/.test(errMsg) || /unauthorized/i.test(errMsg)) {
          throw new ContractActionError('Platform signer requires the PAUSER role', 'UNAUTHORIZED');
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
          contract.call('revoke_validator_as', Address.fromString(keypair.publicKey()).toScVal(), Address.fromString(validatorWallet).toScVal()),
        )
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simResult)) {
        const errMsg = simResult.error ?? '';
        if (extractContractErrorCode(errMsg) === 14 || /already.?revoked/i.test(errMsg)) {
          throw new ValidatorActionError('Validator is already revoked on-chain', 'ALREADY_REVOKED');
        }
        if (extractContractErrorCode(errMsg) === 13 || /not.?registered/i.test(errMsg)) {
          throw new ValidatorActionError('Wallet is not a registered validator on-chain', 'NOT_REGISTERED');
        }
        if (/#9\b/.test(errMsg) || /unauthorized/i.test(errMsg)) {
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
        if (extractContractErrorCode(resultMeta) === 14 || /already.?revoked/i.test(resultMeta)) {
          throw new ValidatorActionError('Validator is already revoked on-chain', 'ALREADY_REVOKED');
        }
        if (extractContractErrorCode(resultMeta) === 13 || /not.?registered/i.test(resultMeta)) {
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

export const CONTRACT_ROLES = ['DEFAULT_ADMIN', 'PAUSER', 'FEE_MANAGER', 'VALIDATOR_MANAGER', 'UPDATER_MANAGER', 'MIGRATOR'] as const;
export type ContractRole = typeof CONTRACT_ROLES[number];

/** Submit a role change with the platform signer; on-chain role-admin auth remains authoritative. */
export async function changeContractRole(
  contractId: string,
  action: 'grant_role' | 'revoke_role',
  role: ContractRole,
  accountWallet: string,
): Promise<ContractActionResult> {
  if (!CONTRACT_ROLES.includes(role) || !['grant_role', 'revoke_role'].includes(action)) {
    throw new ContractActionError('Unknown contract role or action', 'NETWORK_ERROR');
  }
  const { getPlatformKeypair } = await import('../utils/signer');
  const keypair = getPlatformKeypair();
  const account = await server.getAccount(keypair.publicKey());
  const tx = createTxBuilder(account).addOperation(new Contract(contractId).call(
    action,
    Address.fromString(keypair.publicKey()).toScVal(),
    nativeToScVal(role, { type: 'symbol' }),
    Address.fromString(accountWallet).toScVal(),
  )).setTimeout(30).build();
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    const message = simulation.error ?? '';
    throw new ContractActionError(`Role change rejected: ${message}`,
      /#9\b|unauthorized/i.test(message) ? 'UNAUTHORIZED' : 'NETWORK_ERROR');
  }
  const prepared = rpc.assembleTransaction(tx, simulation).build();
  prepared.sign(keypair);
  const sent = await sendTransactionWithCorrelation(prepared);
  if (sent.status === 'ERROR') throw new ContractActionError('Role change submission failed', 'NETWORK_ERROR');
  // Bound confirmation polling; returning an unconfirmed hash would misrepresent success.
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return { transactionId: sent.hash };
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new ContractActionError('Role change failed on-chain', 'NETWORK_ERROR');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new ContractActionError(`Role change confirmation timed out: ${sent.hash}`, 'NETWORK_ERROR');
}
