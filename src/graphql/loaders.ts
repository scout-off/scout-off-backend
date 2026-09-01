/**
 * DataLoader instances for the GraphQL layer.
 *
 * A new set of loaders is created per request (inside createContext) so that
 * the per-request batch window is correctly scoped and there are no stale-data
 * issues across requests.
 *
 * MilestonesLoader batches all milestone lookups that arrive within a single
 * tick into one DB+RPC call, eliminating N+1 queries when a `players` query
 * returns a list and each player resolves its `milestones` field.
 */

import DataLoader from 'dataloader';
import { queryEvents } from '../db';
import { queryMilestones } from '../services/stellar';
import { withConcurrencyLimit } from '../utils/concurrency';

export interface GqlMilestone {
  milestoneId: string | null;
  playerId: string;
  milestoneType: string | null;
  evidenceUri: string | null;
  approved: boolean | null;
  approvedBy: string | null;
  submittedAt: number | null;
  approvedAt: number | null;
}

/**
 * Batch-loads milestones for multiple playerIds in a single call.
 *
 * Strategy:
 *   1. Pull all indexed `milestone_approved` events from the local DB (one
 *      scan, already in memory after the first call thanks to SQLite WAL).
 *   2. For each requested playerId, also fire a Soroban on-chain query in
 *      parallel (Promise.all) to pick up milestones not yet indexed locally.
 *   3. Merge and de-duplicate by milestoneId, preferring indexed rows.
 *
 * This runs once per request tick regardless of how many players were
 * requested, satisfying the DataLoader contract.
 */
async function batchLoadMilestones(
  playerIds: readonly string[],
): Promise<GqlMilestone[][]> {
  // ── Step 1: index-based milestones (synchronous, very cheap) ──────────────
  const allIndexed = queryEvents('milestone_approved');

  const indexedByPlayer = new Map<string, GqlMilestone[]>();
  for (const ev of allIndexed) {
    const pid = String(ev.payload.player_id ?? '');
    if (!pid) continue;
    if (!indexedByPlayer.has(pid)) indexedByPlayer.set(pid, []);
    indexedByPlayer.get(pid)!.push({
      milestoneId: String(ev.payload.milestone_id ?? ''),
      playerId: pid,
      milestoneType: String(ev.payload.milestone_type ?? ''),
      evidenceUri: String(ev.payload.evidence_uri ?? ''),
      approved: true,
      approvedBy: String(ev.payload.approvedBy ?? ev.payload.validator ?? ''),
      submittedAt: typeof ev.payload.submittedAt === 'number' ? ev.payload.submittedAt : null,
      approvedAt: typeof ev.payload.approvedAt === 'number' ? ev.payload.approvedAt : null,
    });
  }

  // ── Step 2: on-chain milestones — bounded concurrency pool ───────────────
  //
  // Without a concurrency cap a `players(pageSize: 100) { milestones }` query
  // fires 100 simultaneous Soroban RPC calls, competing with the indexer and
  // every other request for the shared RPC client and circuit-breaker budget.
  //
  // MILESTONE_LOADER_CONCURRENCY caps the number of in-flight RPC calls.
  // Default: 8.  Configurable via the MILESTONE_LOADER_CONCURRENCY env var.
  const concurrencyLimit = parseInt(
    process.env.MILESTONE_LOADER_CONCURRENCY ?? '8',
    10,
  );

  const onChainResults = await withConcurrencyLimit(
    playerIds.map((pid) => () => queryMilestones(pid)),
    concurrencyLimit,
  );

  // ── Step 3: merge, preserving DataLoader key order ────────────────────────
  return playerIds.map((pid, idx) => {
    const indexed = indexedByPlayer.get(pid) ?? [];

    const onChainRaw = onChainResults[idx];
    const onChain: GqlMilestone[] =
      onChainRaw.status === 'fulfilled'
        ? ((onChainRaw.value as unknown) as Record<string, unknown>[]).map((m) => ({
            milestoneId: String(m.milestoneId ?? ''),
            playerId: pid,
            milestoneType: String(m.milestoneType ?? ''),
            evidenceUri: String(m.evidenceUri ?? ''),
            approved: Boolean(m.approved),
            approvedBy: m.approvedBy ? String(m.approvedBy) : null,
            submittedAt: typeof m.submittedAt === 'number' ? m.submittedAt : null,
            approvedAt: typeof m.approvedAt === 'number' ? m.approvedAt : null,
          }))
        : [];

    // De-duplicate: indexed rows are authoritative; on-chain fills gaps.
    const seenIds = new Set(indexed.map((m) => m.milestoneId).filter(Boolean));
    const merged = [
      ...indexed,
      ...onChain.filter((m) => !m.milestoneId || !seenIds.has(m.milestoneId)),
    ];

    return merged;
  });
}

export interface RequestLoaders {
  milestones: DataLoader<string, GqlMilestone[]>;
}

/** Creates a fresh set of DataLoaders scoped to a single HTTP request. */
export function createLoaders(): RequestLoaders {
  return {
    milestones: new DataLoader<string, GqlMilestone[]>(batchLoadMilestones, {
      // Each playerId is unique — no need for a custom cache key function.
      cache: true,
    }),
  };
}
