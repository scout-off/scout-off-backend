import { rpc, Contract, nativeToScVal } from '@stellar/stellar-sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import {
  PaymentError,
  createTxBuilder,
  isPlayerNotFoundError,
  sendTransactionWithCorrelation,
  server,
} from './stellarCore';

const tracer = trace.getTracer('scout-off-backend');

export interface UpdateProfileResult {
  transactionId: string;
  metadataUri: string;
}

/**
 * Invoke `update_profile(player_id, metadata_uri)` on the Soroban contract
 * via the platform keypair.
 *
 * Flow mirrors logTrialOffer() / cancelSubscriptionOnChain():
 *   getAccount → build tx → simulateTransaction → assembleTransaction
 *   → sign → sendTransaction → poll getTransaction until final status.
 *
 * On success returns the confirmed transaction hash and the metadataUri
 * that was submitted. Throws PaymentError('MISSING_PLAYER') if the
 * contract simulation reports the player id is unknown (the register
 * contract's update_profile returns PlayerNotFound (#3) for that case).
 */
export async function updateProfile(
  playerId: string,
  metadataUri: string,
): Promise<UpdateProfileResult> {
  return tracer.startActiveSpan('stellar.updateProfile', async (span) => {
    span.setAttribute('stellar.contract_function', 'update_profile');
    span.setAttribute('stellar.player_id', playerId);
    try {
      if (!playerId || !metadataUri) {
        throw new PaymentError('playerId and metadataUri are required', 'INVALID_ACCOUNT');
      }

      const { getPlatformKeypair } = await import('../utils/signer');
      const keypair = getPlatformKeypair();

      let account;
      try {
        account = await server.getAccount(keypair.publicKey());
      } catch (err) {
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
      }

      const contract = new Contract(config.registerContractId);

      const tx = createTxBuilder(account)
        .addOperation(
          contract.call(
            'update_profile',
            nativeToScVal(playerId, { type: 'string' }),
            nativeToScVal(metadataUri, { type: 'string' }),
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
        if (isPlayerNotFoundError(errMsg)) {
          throw new PaymentError('Player not found on-chain', 'MISSING_PLAYER');
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
        if (isPlayerNotFoundError(resultMeta)) {
          throw new PaymentError('Player not found on-chain', 'MISSING_PLAYER');
        }
        throw new PaymentError('update_profile transaction failed on-chain', 'NETWORK_ERROR');
      }

      return { transactionId: hash, metadataUri };
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
