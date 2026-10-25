/**
 * EXAMPLE: Updated export controller to check request signal in loops.
 * 
 * This shows how to integrate cancellation checks into long-running
 * batch operations like CSV streaming.
 */

import { Request, Response } from 'express';
import { checkRequestCancelled, isRequestCancelled } from '../middleware/requestSignal';

/**
 * EXAMPLE: Stream CSV export with cancellation checks.
 * 
 * When a request times out or client disconnects, abort early instead of
 * continuing to render a response nobody will read.
 */
export async function exportPlayersCSV(req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="players.csv"');

  const batchSize = 100;
  let offset = 0;
  let rowCount = 0;

  try {
    // Write header
    res.write('id,wallet,tier,createdAt\n');

    // Stream in batches
    while (true) {
      // Check if request was cancelled before fetching next batch
      checkRequestCancelled();

      // Fetch batch from DB
      const players = await db.query(
        'SELECT id, wallet, tier, createdAt FROM players ORDER BY id LIMIT ? OFFSET ?',
        [batchSize, offset],
      );

      if (players.length === 0) break;

      // Write rows to CSV
      for (const player of players) {
        // Check again before writing each row (for very large batches)
        if (isRequestCancelled()) {
          res.destroy(); // Close the connection
          return;
        }

        res.write(
          `${player.id},${player.wallet},${player.tier},${player.createdAt}\n`,
        );
        rowCount++;
      }

      offset += batchSize;

      // Allow Node to process other operations
      await new Promise(resolve => setImmediate(resolve));
    }

    res.end();
    console.log(`[export] Streamed ${rowCount} players to CSV`);
  } catch (err) {
    if (err instanceof Error && err.message === 'Request cancelled') {
      console.info('[export] CSV stream cancelled by client or timeout');
      res.destroy();
    } else {
      throw err;
    }
  }
}

/**
 * EXAMPLE: Batch processing with signal checks.
 */
export async function processMilestones(players: any[]): Promise<void> {
  for (const player of players) {
    checkRequestCancelled(); // Throws if aborted

    // Process milestone for this player
    await processSingleMilestone(player);
  }
}

async function processSingleMilestone(player: any): Promise<void> {
  // Simulated work
  return new Promise(resolve => setTimeout(resolve, 10));
}
