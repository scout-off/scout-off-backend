#!/usr/bin/env npx ts-node

import 'dotenv/config';
import { closeDb, getPlayersMissingOnChainId, initDb, setPlayerOnChainId } from '../src/db';
import { queryOnChainPlayerId } from '../src/services/stellar';

const BATCH_SIZE = 100;

export interface BackfillPlayer {
  player_id: string;
  wallet: string;
}

export interface BackfillDb {
  getPlayersMissingOnChainId(afterPlayerId: string, limit: number): Promise<BackfillPlayer[]>;
  setPlayerOnChainId(playerId: string, onChainPlayerId: string): Promise<void>;
}

export type OnChainPlayerIdLookup = (wallet: string) => Promise<string | null>;

export interface BackfillResult {
  linked: number;
  pending: number;
}

/**
 * Walks every player missing an on-chain ID in keyset-paginated batches and
 * links the ones the lookup resolves. Pure orchestration: no DB or network
 * setup, so it can be unit tested with fakes.
 */
export async function backfillPlayerOnChainIds(
  db: BackfillDb,
  lookup: OnChainPlayerIdLookup,
  batchSize: number = BATCH_SIZE,
): Promise<BackfillResult> {
  let afterPlayerId = '';
  let linked = 0;
  let pending = 0;

  for (;;) {
    const players = await db.getPlayersMissingOnChainId(afterPlayerId, batchSize);
    if (players.length === 0) break;

    for (const player of players) {
      const onChainPlayerId = await lookup(player.wallet);
      if (onChainPlayerId === null) {
        pending += 1;
      } else {
        await db.setPlayerOnChainId(player.player_id, onChainPlayerId);
        linked += 1;
      }
    }
    afterPlayerId = players[players.length - 1].player_id;
  }

  return { linked, pending };
}

async function main(): Promise<void> {
  await initDb();

  try {
    const { linked, pending } = await backfillPlayerOnChainIds(
      { getPlayersMissingOnChainId, setPlayerOnChainId },
      queryOnChainPlayerId,
    );

    // eslint-disable-next-line no-console
    console.info(`Player ID backfill complete: linked=${linked} pending=${pending}`);
  } finally {
    await closeDb();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`Player ID backfill failed: ${message}`);
    process.exitCode = 1;
  });
}
