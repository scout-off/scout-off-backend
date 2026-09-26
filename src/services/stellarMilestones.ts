import { rpc, Contract, nativeToScVal, scValToNative, Keypair, Account } from '@stellar/stellar-sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import {
  PaymentError,
  createTxBuilder,
  isPlayerNotFoundError,
  server,
} from './stellarCore';

const tracer = trace.getTracer('scout-off-backend');

export interface OnChainMilestone {
  milestoneId: string;
  playerId: string;
  milestoneType: string;
  evidenceUri: string;
  approved: boolean;
  approvedBy: string | null;
  ledger: number | null;
}


export function parseMilestonesFromNative(playerId: string, native: unknown): OnChainMilestone[] {
  if (!Array.isArray(native)) {
    return [];
  }
  return native.map((entry, index) => {
    const rec = (entry ?? {}) as Record<string, unknown>;
    const approved = Boolean(rec.approved);
    const submittedAt = rec.submitted_at ?? rec.submittedAt ?? rec.ledger;
    return {
      milestoneId: String(rec.milestone_id ?? rec.milestoneId ?? index),
      playerId: String(rec.player_id ?? rec.playerId ?? playerId),
      milestoneType: String(rec.milestone_type ?? rec.milestoneType ?? ''),
      evidenceUri: String(rec.evidence_uri ?? rec.evidenceUri ?? ''),
      approved,
      approvedBy: approved ? String(rec.validator ?? rec.approvedBy ?? '') : null,
      ledger: submittedAt != null ? Number(submittedAt) : null,
    };
  });
}

/**
 * Query verified milestones for a player by invoking
 * `get_milestones(player_id) -> Vec<Milestone>` on the Soroban contract via
 * simulateTransaction. Read-only — no transaction is signed or submitted.
 *
 * Returns a tamper-proof list of all milestones (pending and approved)
 * associated with the given player, or an empty array if the player has
 * none. Throws PaymentError('MISSING_PLAYER') if the contract simulation
 * reports the player id is unknown.
 */
export async function queryMilestones(playerId: string): Promise<OnChainMilestone[]> {
  return tracer.startActiveSpan('stellar.queryMilestones', async (span) => {
    span.setAttribute('stellar.contract_function', 'get_milestones');
    try {
      if (!playerId) {
        throw new PaymentError('Missing playerId', 'INVALID_ACCOUNT');
      }

      try {
        const contract = new Contract(config.progressContractId);
        // Use a random ephemeral keypair as the simulation source — no on-chain
        // auth is required for this view-only call, and we never submit the tx.
        const ephemeral = Keypair.random();
        const sourceAccount = new Account(ephemeral.publicKey(), '0');

        const tx = createTxBuilder(sourceAccount)
          .addOperation(
            contract.call('get_milestones', nativeToScVal(playerId, { type: 'string' })),
          )
          .setTimeout(30)
          .build();

        const simResult = await server.simulateTransaction(tx);

        if (rpc.Api.isSimulationError(simResult)) {
          const errMsg = simResult.error ?? '';
          if (isPlayerNotFoundError(errMsg)) {
            throw new PaymentError('Player not found on-chain', 'MISSING_PLAYER');
          }
          throw new PaymentError(`Contract simulation failed: ${errMsg}`, 'NETWORK_ERROR');
        }

        const successSim = simResult as rpc.Api.SimulateTransactionSuccessResponse;
        const retval = successSim.result?.retval;
        if (!retval) {
          return [];
        }

        const milestones = parseMilestonesFromNative(playerId, scValToNative(retval));
        span.setAttribute('stellar.milestone_count', milestones.length);
        return milestones;
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
