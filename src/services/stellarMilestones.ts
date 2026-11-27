import {
  rpc,
  Contract,
  nativeToScVal,
  scValToNative,
  Keypair,
  Account,
} from '@stellar/stellar-sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import {
  PaymentError,
  createTxBuilder,
  isPlayerNotFoundError,
  resolveOnChainPlayerId,
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

export interface PageResult<T> {
  items: T[];
  next: number | null;
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
 * `get_milestones_page(player_id, start, limit) -> Page<Milestone>` on the Soroban contract via
 * simulateTransaction. Read-only — no transaction is signed or submitted.
 *
 * Returns a tamper-proof page of milestones (pending and approved)
 * associated with the given player. The `next` field in the page indicates
 * if more results are available.
 *
 * @param playerId - The player ID to query
 * @param start - Zero-based index of the first milestone to return (default: 0)
 * @param limit - Maximum number of milestones to return (default: 50, max: 50)
 */
export async function queryMilestonesPage(
  playerId: string,
  start?: number,
  limit: number = 50,
): Promise<PageResult<OnChainMilestone>> {
  return tracer.startActiveSpan('stellar.queryMilestonesPage', async (span) => {
    span.setAttribute('stellar.contract_function', 'get_milestones_page');
    span.setAttribute('stellar.player_id', playerId);
    span.setAttribute('stellar.start', start ?? 0);
    span.setAttribute('stellar.limit', limit);
    try {
      if (!playerId) {
        throw new PaymentError('Missing playerId', 'INVALID_ACCOUNT');
      }

      if (start !== undefined && start < 0) {
        throw new PaymentError('Invalid start index', 'INVALID_ACCOUNT');
      }

      // Cap at max page size
      const effectiveLimit = Math.min(limit, 50);
      if (effectiveLimit <= 0) {
        throw new PaymentError('Invalid limit', 'INVALID_ACCOUNT');
      }
      const onChainPlayerId = await resolveOnChainPlayerId(playerId);
      if (onChainPlayerId === null) return { items: [], next: null };

      try {
        const contract = new Contract(config.progressContractId);
        // Use a random ephemeral keypair as the simulation source — no on-chain
        // auth is required for this view-only call, and we never submit the tx.
        const ephemeral = Keypair.random();
        const sourceAccount = new Account(ephemeral.publicKey(), '0');

        const tx = createTxBuilder(sourceAccount)
          .addOperation(
            contract.call(
              'get_milestones_page',
              nativeToScVal(onChainPlayerId, { type: 'u64' }),
              nativeToScVal(start ?? 0, { type: 'u32' }),
              nativeToScVal(effectiveLimit, { type: 'u32' }),
            ),
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
          span.setAttribute('stellar.milestone_count', 0);
          return { items: [], next: null };
        }

        const page = scValToNative(retval) as { items: unknown[]; next: number | null };
        const milestones = parseMilestonesFromNative(playerId, page.items);
        span.setAttribute('stellar.milestone_count', milestones.length);
        span.setAttribute('stellar.next_cursor', page.next ?? 'null');
        return { items: milestones, next: page.next };
      } catch (err) {
        if (err instanceof PaymentError) throw err;
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
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
 * Query milestones for a player with pagination support.
 *
 * @param playerId - The player ID to query
 * @param start - Zero-based index of the first milestone to return (default: 0)
 * @param limit - Maximum number of milestones to return (default: 50, max: 50)
 * @returns Promise resolving to an array of milestones for this page
 */
export async function queryMilestones(
  playerId: string,
  start?: number,
  limit: number = 50,
): Promise<OnChainMilestone[]> {
  return tracer.startActiveSpan('stellar.queryMilestones', async (span) => {
    span.setAttribute('stellar.contract_function', 'get_milestones_page');
    span.setAttribute('stellar.player_id', playerId);
    span.setAttribute('stellar.start', start ?? 0);
    span.setAttribute('stellar.limit', limit);
    try {
      if (!playerId) {
        throw new PaymentError('Missing playerId', 'INVALID_ACCOUNT');
      }

      if (start !== undefined && start < 0) {
        throw new PaymentError('Invalid start index', 'INVALID_ACCOUNT');
      }

      // Cap at max page size
      const effectiveLimit = Math.min(limit, 50);
      if (effectiveLimit <= 0) {
        throw new PaymentError('Invalid limit', 'INVALID_ACCOUNT');
      }
      const onChainPlayerId = await resolveOnChainPlayerId(playerId);
      if (onChainPlayerId === null) return [];

      try {
        const contract = new Contract(config.progressContractId);
        // Use a random ephemeral keypair as the simulation source — no on-chain
        // auth is required for this view-only call, and we never submit the tx.
        const ephemeral = Keypair.random();
        const sourceAccount = new Account(ephemeral.publicKey(), '0');

        const tx = createTxBuilder(sourceAccount)
          .addOperation(
            contract.call(
              'get_milestones_page',
              nativeToScVal(onChainPlayerId, { type: 'u64' }),
              nativeToScVal(start ?? 0, { type: 'u32' }),
              nativeToScVal(effectiveLimit, { type: 'u32' }),
            ),
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
          span.setAttribute('stellar.milestone_count', 0);
          return [];
        }

        const milestones = parseMilestonesFromNative(playerId, scValToNative(retval));
        span.setAttribute('stellar.milestone_count', milestones.length);
        return milestones;
      } catch (err) {
        if (err instanceof PaymentError) throw err;
        throw new PaymentError(`RPC call failed: ${(err as Error).message}`, 'NETWORK_ERROR');
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
