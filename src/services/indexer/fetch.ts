/**
 * indexer/fetch.ts
 *
 * RPC polling for the indexer (split out of services/indexer.ts).
 *
 * Responsibilities:
 *   - Enumerate the contracts the indexer listens to (`getIndexedContractIds`).
 *   - Chunk those contract IDs into Soroban-sized filter groups and poll the
 *     RPC for events at/after a given ledger (`fetchIndexerEvents`).
 *
 * No decoding and no database access — this module owns the RPC edge only.
 */

import { server } from '../stellar';
import config from '../../config';

/**
 * Returns the list of contract IDs to fetch events from.
 * This is shared between the live indexer, reindex, and replay to ensure
 * they all process the same set of contracts.
 *
 * The list includes all five contract IDs with deduplication:
 *   - contractId (legacy monolith)
 *   - registerContractId
 *   - progressContractId
 *   - subscriptionContractId
 *   - connectionContractId
 *
 * Empty contract IDs are filtered out.
 */
export function getIndexedContractIds(): string[] {
  return [
    config.contractId,
    config.registerContractId,
    config.progressContractId,
    config.subscriptionContractId,
    config.connectionContractId,
    config.playerTokenContractId,
  ].filter((id, i, arr) => Boolean(id) && arr.indexOf(id) === i);
}

/**
 * Poll the RPC for contract events from `fromLedger` (or the first ledger when
 * `fromLedger` is 0). Soroban accepts at most five contract IDs per filter, so
 * the configured contract IDs are chunked into groups of five.
 *
 * Returns the raw `getEvents` response so the caller keeps full control over
 * cursor arithmetic, reorg detection, ordering and persistence.
 */
export async function fetchIndexerEvents(fromLedger: number) {
  const contractIds = getIndexedContractIds();

  // Soroban accepts at most five contract IDs per filter.
  const indexedContracts = contractIds.length ? contractIds : [config.contractId];
  const filters = [];
  for (let i = 0; i < indexedContracts.length; i += 5) {
    filters.push({ type: 'contract' as const, contractIds: indexedContracts.slice(i, i + 5) });
  }

  return server.getEvents({
    startLedger: fromLedger > 0 ? fromLedger : 1,
    filters,
  });
}
