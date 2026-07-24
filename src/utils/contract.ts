import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  nativeToScVal,
  scValToNative,
  Keypair,
  Transaction,
  FeeBumpTransaction,
} from '@stellar/stellar-sdk';
import { server, networkPassphrase } from '../services/stellar';
import config from '../config';

export interface SorobanTransactionBuilderOptions {
  server?: SorobanRpc.Server;
  networkPassphrase?: string;
}

export interface BuildOptions {
  fee?: string;
  timeout?: number;
  sponsorKeypair?: Keypair;
}

export interface SubmitOptions {
  maxPollAttempts?: number;
  pollIntervalMs?: number;
  maxTryAgainRetries?: number;
  tryAgainDelayMs?: number;
  autoRefreshSequenceOnConflict?: boolean;
}

export interface SimulationResult {
  simResult: SorobanRpc.Api.SimulateTransactionResponse;
  preparedTx: Transaction;
  authEntries?: xdr.SorobanAuthorizationEntry[];
}

export class SorobanTransactionBuilder {
  private rpcServer: SorobanRpc.Server;
  private passphrase: string;

  constructor(options?: SorobanTransactionBuilderOptions) {
    this.rpcServer = options?.server || server;
    this.passphrase = options?.networkPassphrase || networkPassphrase();
  }

  /**
   * Fetches account sequence and creates an un-simulated Soroban contract call transaction.
   */
  async buildContractCall(
    contractId: string,
    functionName: string,
    args: xdr.ScVal[] = [],
    sourcePublicKey: string,
    options?: BuildOptions
  ): Promise<Transaction> {
    let account;
    try {
      account = await this.rpcServer.getAccount(sourcePublicKey);
    } catch (err: unknown) {
      throw new Error(`Failed to fetch account sequence for ${sourcePublicKey}: ${(err as Error).message}`);
    }

    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: options?.fee || BASE_FEE,
      networkPassphrase: this.passphrase,
    })
      .addOperation(contract.call(functionName, ...args))
      .setTimeout(options?.timeout ?? 30)
      .build();

    return tx;
  }

  /**
   * Simulates the transaction and assembles resource footprint and fee estimates.
   */
  async simulate(tx: Transaction): Promise<SimulationResult> {
    const simResult = await this.rpcServer.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();

    let authEntries: xdr.SorobanAuthorizationEntry[] | undefined;
    const simWithResults = simResult as unknown as { results?: Array<{ auth?: xdr.SorobanAuthorizationEntry[] }>; result?: { auth?: xdr.SorobanAuthorizationEntry[] } };
    if (simWithResults.results && simWithResults.results.length > 0 && simWithResults.results[0].auth) {
      authEntries = simWithResults.results[0].auth;
    } else if (simWithResults.result && simWithResults.result.auth) {
      authEntries = simWithResults.result.auth;
    }

    return {
      simResult,
      preparedTx,
      authEntries,
    };
  }

  /**
   * Signs transaction or fee bump transaction with provided Keypair or returns signed pre-signed XDR.
   */
  sign(
    tx: Transaction | FeeBumpTransaction,
    signerKeypair?: Keypair,
    sponsorKeypair?: Keypair
  ): Transaction | FeeBumpTransaction {
    let targetTx = tx;

    if (sponsorKeypair && !(targetTx instanceof FeeBumpTransaction)) {
      targetTx = TransactionBuilder.buildFeeBumpTransaction(
        sponsorKeypair.publicKey(),
        BASE_FEE,
        targetTx,
        this.passphrase
      );
      targetTx.sign(sponsorKeypair);
    }

    if (signerKeypair) {
      targetTx.sign(signerKeypair);
    }

    return targetTx;
  }

  /**
   * Submits a transaction to Soroban RPC, handling TRY_AGAIN_LATER retries,
   * sequence number conflict auto-refresh/retry, and polling for tx status.
   */
  async submit(
    signedTx: Transaction | FeeBumpTransaction,
    submitOptions?: SubmitOptions,
    contextInfo?: {
      contractId?: string;
      functionName?: string;
      args?: xdr.ScVal[];
      sourcePublicKey?: string;
      signerKeypair?: Keypair;
      sponsorKeypair?: Keypair;
      buildOptions?: BuildOptions;
    }
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
    const maxTryAgainRetries = submitOptions?.maxTryAgainRetries ?? 3;
    const tryAgainDelayMs = submitOptions?.tryAgainDelayMs ?? 2000;
    const maxPollAttempts = submitOptions?.maxPollAttempts ?? 10;
    const pollIntervalMs = submitOptions?.pollIntervalMs ?? 1000;
    const autoRefreshSequenceOnConflict = submitOptions?.autoRefreshSequenceOnConflict ?? true;

    let currentTx = signedTx;
    let sendResult: SorobanRpc.Api.SendTransactionResponse | undefined;

    let sendAttempts = 0;
    while (sendAttempts <= maxTryAgainRetries) {
      sendAttempts++;
      try {
        sendResult = await this.rpcServer.sendTransaction(currentTx);
      } catch (err: unknown) {
        const errObj = err as { response?: { status?: number; data?: unknown }; message?: string };
        const isSeqConflict =
          errObj?.response?.status === 400 ||
          (errObj?.message && errObj.message.includes('400'));

        if (isSeqConflict && autoRefreshSequenceOnConflict && contextInfo?.sourcePublicKey && contextInfo?.contractId && contextInfo?.functionName) {
          const newTx = await this.buildContractCall(
            contextInfo.contractId,
            contextInfo.functionName,
            contextInfo.args || [],
            contextInfo.sourcePublicKey,
            contextInfo.buildOptions
          );
          const sim = await this.simulate(newTx);
          currentTx = this.sign(sim.preparedTx, contextInfo.signerKeypair, contextInfo.sponsorKeypair);
          continue;
        }
        throw err;
      }

      if (sendResult.status === 'TRY_AGAIN_LATER') {
        if (sendAttempts > maxTryAgainRetries) {
          throw new Error(`Submit failed with TRY_AGAIN_LATER after ${maxTryAgainRetries} retries`);
        }
        await new Promise((resolve) => setTimeout(resolve, tryAgainDelayMs));
        continue;
      }

      if (sendResult.status === 'ERROR') {
        const errorResultStr = JSON.stringify(sendResult.errorResult || '');
        if (
          autoRefreshSequenceOnConflict &&
          (errorResultStr.includes('txBAD_SEQ') || errorResultStr.includes('400')) &&
          contextInfo?.sourcePublicKey &&
          contextInfo?.contractId &&
          contextInfo?.functionName
        ) {
          const newTx = await this.buildContractCall(
            contextInfo.contractId,
            contextInfo.functionName,
            contextInfo.args || [],
            contextInfo.sourcePublicKey,
            contextInfo.buildOptions
          );
          const sim = await this.simulate(newTx);
          currentTx = this.sign(sim.preparedTx, contextInfo.signerKeypair, contextInfo.sponsorKeypair);
          continue;
        }
        throw new Error(`Submit failed: ${JSON.stringify(sendResult.errorResult)}`);
      }

      break;
    }

    if (!sendResult || !sendResult.hash) {
      throw new Error('Submit failed: invalid response from sendTransaction');
    }

    const hash = sendResult.hash;

    let pollAttempts = 0;
    while (pollAttempts < maxPollAttempts) {
      pollAttempts++;
      const getResult = await this.rpcServer.getTransaction(hash);

      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      }

      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify((getResult as { resultXdr?: unknown }).resultXdr || getResult)}`);
      }

      if (pollAttempts < maxPollAttempts) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    throw new Error(`Transaction polling timed out after ${maxPollAttempts} attempts`);
  }

  /**
   * End-to-end execution helper: build -> simulate -> sign -> submit.
   */
  async executeContractCall(
    contractId: string,
    functionName: string,
    args: xdr.ScVal[] = [],
    signerKeypair: Keypair,
    options?: {
      buildOptions?: BuildOptions;
      submitOptions?: SubmitOptions;
      sponsorKeypair?: Keypair;
    }
  ): Promise<unknown> {
    const sourcePublicKey = signerKeypair.publicKey();
    const initialTx = await this.buildContractCall(
      contractId,
      functionName,
      args,
      sourcePublicKey,
      options?.buildOptions
    );

    const simulation = await this.simulate(initialTx);
    const signedTx = this.sign(simulation.preparedTx, signerKeypair, options?.sponsorKeypair);

    const result = await this.submit(signedTx, options?.submitOptions, {
      contractId,
      functionName,
      args,
      sourcePublicKey,
      signerKeypair,
      sponsorKeypair: options?.sponsorKeypair,
      buildOptions: options?.buildOptions,
    });

    return result.returnValue ? scValToNative(result.returnValue) : null;
  }
}

/**
 * Convenience backward-compatible invokeContract implementation utilizing SorobanTransactionBuilder.
 */
export async function invokeContract(
  sourceKeypair: Keypair,
  method: string,
  args: xdr.ScVal[] = []
): Promise<unknown> {
  const builder = new SorobanTransactionBuilder();
  return builder.executeContractCall(config.contractId, method, args, sourceKeypair);
}

/** Convenience: convert a plain string to ScVal */
export const strVal = (s: string) => nativeToScVal(s, { type: 'string' });

/** Convenience: convert a number to ScVal u32 */
export const u32Val = (n: number) => nativeToScVal(n, { type: 'u32' });
