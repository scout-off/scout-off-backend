import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createId } from '@paralleldrive/cuid2';
import { sanitizeInput } from '../utils/sanitizer';
import { pinJson } from '../services/ipfs';
import { getDriver, insertOrUpdatePlayer } from '../db';
import { dispatchEventWebhook } from '../services/webhooks';
import { invalidatePlayerCache } from '../services/cache';
import { registerSchema } from './playerController';
import { logger } from '../utils/logger';
import { logAuditEvent } from '../services/audit';
import { ErrorCode } from '../utils/errorCodes';
import { isValidCid } from '../utils/cidValidator';
import config from '../config';

/**
 * Envelope schema for the JSON body variant of POST /api/admin/players/import.
 *
 * Only validates the outer shape and batch size — each entry is deliberately
 * left as `unknown` here and validated individually (against `registerSchema`)
 * in processPlayerImportBatch, so one malformed row is reported per-row rather
 * than rejecting the whole batch.
 */
export const importPlayersBodySchema = z.object({
  players: z
    .array(z.unknown())
    .min(1, 'players array must contain at least one entry')
    .max(
      config.playerImport.maxBatchSize,
      `players array exceeds maximum size of ${config.playerImport.maxBatchSize}`,
    ),
});

export type ImportPlayerResultStatus = 'success' | 'error';

export interface ImportPlayerResult {
  /** 1-based position of this entry within the submitted batch. */
  row: number;
  status: ImportPlayerResultStatus;
  playerId?: string;
  wallet?: string;
  metadataUri?: string;
  error?: string;
}

/**
 * Parse a CSV text body into raw row objects for player import.
 *
 * Columns: wallet,position,region,metadataUri[,progress_level]
 *
 * Lines beginning with # or empty lines are ignored. A header row whose
 * first token is the literal "wallet" (case-insensitive) is silently skipped.
 */
export function parsePlayerCsvBody(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(',').map((c) => c.trim());
    if (cols[0].toLowerCase() === 'wallet') continue;
    const [wallet, position, region, metadataUri, progress_level] = cols;
    const row: Record<string, string> = {
      wallet: wallet ?? '',
      position: position ?? '',
      region: region ?? '',
      metadataUri: metadataUri ?? '',
    };
    if (progress_level !== undefined) row.progress_level = progress_level;
    rows.push(row);
  }
  return rows;
}

// ─── Internal types for two-phase processing ─────────────────────────────────

interface PreparedRow {
  row: number;
  playerId: string;
  wallet: string;
  metadataUri: string;
  position: string;
  region: string;
}

interface FailedRow {
  row: number;
  wallet?: string;
  error: string;
}

type PhaseOneResult = PreparedRow | FailedRow;

function isFailed(r: PhaseOneResult): r is FailedRow {
  return 'error' in r;
}

/**
 * Validate + resolve metadataUri for a single entry (outside any DB transaction).
 * IPFS deduplication: skips pinning when metadataUri is already a valid CID.
 */
async function prepareEntry(
  entry: unknown,
  rowIndex: number,
): Promise<PhaseOneResult> {
  const row = rowIndex + 1;
  const parsed = registerSchema.safeParse(entry);
  if (!parsed.success) {
    const rawWallet =
      entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>).wallet as string | undefined
        : undefined;
    return { row, wallet: rawWallet, error: parsed.error.errors[0]?.message ?? 'Invalid entry' };
  }

  const { wallet } = parsed.data;
  const position = sanitizeInput(parsed.data.position);
  const region = sanitizeInput(parsed.data.region);

  let metadataUri: string;
  try {
    if ('metadataUri' in parsed.data) {
      metadataUri = parsed.data.metadataUri;
    } else {
      // IPFS deduplication: if the raw value already is a CID, skip pinning.
      const rawUri = (parsed.data as Record<string, unknown>).metadataUri as string | undefined;
      if (rawUri && isValidCid(rawUri)) {
        metadataUri = rawUri;
      } else {
        metadataUri = await pinJson({
          wallet,
          position,
          region,
          ...(parsed.data as Record<string, unknown>).metadata as object,
        });
      }
    }
  } catch (err) {
    return { row, wallet, error: (err as Error).message };
  }

  return { row, playerId: createId(), wallet, metadataUri, position, region };
}

/**
 * Process a batch of raw player entries.
 *
 * allowPartial=true (default, per #483):
 *   Valid rows are committed row-by-row; a failing row is reported but does
 *   not abort the batch or block the other rows.
 *
 * allowPartial=false:
 *   All-or-nothing. If any row fails validation, zero rows are inserted
 *   and HTTP 422 is returned. If all rows are valid, they are inserted in
 *   a single DB transaction; any DB error also rolls everything back.
 *
 * IPFS pin calls happen BEFORE the DB transaction to avoid holding the
 * write lock during network I/O. Pinned CIDs are content-addressed and
 * immutable — leftover pins from a rolled-back batch are harmless.
 */
export async function processPlayerImportBatch(
  entries: unknown[],
  allowPartial = true,
): Promise<ImportPlayerResult[]> {
  const now = Math.floor(Date.now() / 1000);

  // ── Phase 1: validate + IPFS (outside DB transaction) ───────────────────
  const phaseOne: PhaseOneResult[] = await Promise.all(
    entries.map((e, i) => prepareEntry(e, i)),
  );

  // ── Phase 2: DB writes ────────────────────────────────────────────────────
  if (!allowPartial) {
    // Any validation failure → rollback the whole batch (zero inserts).
    const failures = phaseOne.filter(isFailed);
    if (failures.length > 0) {
      return phaseOne.map((p) => {
        if (isFailed(p)) {
          return { row: p.row, status: 'error' as const, wallet: p.wallet, error: p.error };
        }
        return {
          row: p.row, status: 'error' as const,
          wallet: (p as PreparedRow).wallet,
          error: 'Batch rolled back due to another row failure',
        };
      });
    }

    // All valid — insert inside one transaction.
    const goodRows = phaseOne as PreparedRow[];
    try {
      getDriver().transaction(() => {
        for (const p of goodRows) {
          insertOrUpdatePlayer({
            player_id: p.playerId,
            wallet: p.wallet,
            position: p.position,
            region: p.region,
            metadata_uri: p.metadataUri,
            created_at: now,
            registered_at: now,
          });
        }
      });
    } catch (err) {
      // DB error → report every row as failed.
      return goodRows.map((p) => ({
        row: p.row, status: 'error' as const,
        wallet: p.wallet, error: (err as Error).message,
      }));
    }

    // Fire webhooks after the transaction commits.
    for (const p of goodRows) {
      dispatchEventWebhook('player_registered', {
        player_id: p.playerId, wallet: p.wallet,
        position: p.position, region: p.region, metadataUri: p.metadataUri,
      }).catch((e: unknown) => {
        logger.warn(`[import] webhook failed player=${p.playerId}: ${(e as Error).message}`);
      });
    }

    return goodRows.map((p) => ({
      row: p.row, status: 'success' as const,
      playerId: p.playerId, wallet: p.wallet, metadataUri: p.metadataUri,
    }));
  }

  // ── Partial-success mode ─────────────────────────────────────────────────
  const results: ImportPlayerResult[] = [];
  for (const p of phaseOne) {
    if (isFailed(p)) {
      results.push({ row: p.row, status: 'error', wallet: p.wallet, error: p.error });
      continue;
    }
    try {
      insertOrUpdatePlayer({
        player_id: p.playerId, wallet: p.wallet,
        position: p.position, region: p.region,
        metadata_uri: p.metadataUri, created_at: now, registered_at: now,
      });
      dispatchEventWebhook('player_registered', {
        player_id: p.playerId, wallet: p.wallet,
        position: p.position, region: p.region, metadataUri: p.metadataUri,
      }).catch((e: unknown) => {
        logger.warn(`[import] webhook failed player=${p.playerId}: ${(e as Error).message}`);
      });
      results.push({ row: p.row, status: 'success', playerId: p.playerId, wallet: p.wallet, metadataUri: p.metadataUri });
    } catch (err) {
      results.push({ row: p.row, status: 'error', wallet: p.wallet, error: (err as Error).message });
    }
  }
  return results;
}

/**
 * POST /api/admin/players/import
 *
 * Accepts:
 *   - JSON body:  { players: [...] }
 *   - CSV body:   Content-Type: text/csv or text/plain
 *
 * Query params:
 *   ?allowPartial=false  — opt into all-or-nothing rollback semantics instead
 *                          of the default per-row isolation (see #483)
 *
 * HTTP status codes:
 *   200  — request processed (per-row results report any individual failures)
 *   400  — empty/unparseable body
 *   413  — batch exceeds PLAYER_IMPORT_MAX_BATCH
 *   422  — allowPartial=false and at least one row failed (nothing inserted)
 *
 * @auth Bearer (admin role required)
 */
export async function importPlayers(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = req.account ?? 'unknown';
    const contentType = (req.headers['content-type'] ?? '').toLowerCase();
    const allowPartial = req.query['allowPartial'] !== 'false';

    let entries: unknown[];

    if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
      const rawBody = req.body as string;
      if (typeof rawBody !== 'string' || !rawBody.trim()) {
        res.status(400).json({ success: false, error: 'CSV body is empty', code: ErrorCode.VALIDATION_ERROR });
        return;
      }
      entries = parsePlayerCsvBody(rawBody);
      if (entries.length === 0) {
        res.status(400).json({ success: false, error: 'No player entries found in request', code: ErrorCode.VALIDATION_ERROR });
        return;
      }
      if (entries.length > config.playerImport.maxBatchSize) {
        res.status(400).json({
          success: false,
          error: `Batch exceeds maximum size of ${config.playerImport.maxBatchSize} entries`,
          code: ErrorCode.VALIDATION_ERROR,
        });
        return;
      }
    } else {
      const parsed = importPlayersBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: parsed.error.errors[0]?.message ?? 'Request body must contain a "players" array or use Content-Type: text/csv',
          code: ErrorCode.VALIDATION_ERROR,
        });
        return;
      }
      entries = parsed.data.players;
    }

    if (entries.length === 0) {
      res.status(400).json({ success: false, error: 'No player entries found in request', code: ErrorCode.VALIDATION_ERROR });
      return;
    }

    // HTTP 413 for oversized batches (spec requirement).
    if (entries.length > config.playerImport.maxBatchSize) {
      res.status(413).json({
        success: false,
        error: `Batch exceeds maximum size of ${config.playerImport.maxBatchSize} entries`,
        code: ErrorCode.PAYLOAD_TOO_LARGE,
      });
      return;
    }

    const results = await processPlayerImportBatch(entries, allowPartial);

    const succeeded = results.filter((r) => r.status === 'success').length;
    const failed = results.filter((r) => r.status === 'error').length;

    if (succeeded > 0) {
      await invalidatePlayerCache();
    }

    logger.info(
      `[admin] action=import_players admin=${adminWallet} total=${results.length} succeeded=${succeeded} failed=${failed} allowPartial=${allowPartial}`,
    );

    // Single audit event per import attempt — rows_attempted, rows_inserted, rows_failed.
    logAuditEvent({
      action: 'bulk_player_import',
      adminWallet,
      queryParams: { rows_attempted: results.length, rows_inserted: succeeded, rows_failed: failed, allowPartial },
      timestamp: new Date().toISOString(),
    });

    // HTTP status rules:
    //   allowPartial (default) → 200, regardless of per-row failures
    //   allowPartial=false + any failure → 422 Unprocessable Entity
    let httpStatus = 200;
    let overallSuccess = true;
    if (!allowPartial && failed > 0) {
      httpStatus = 422;
      overallSuccess = false;
    }

    res.status(httpStatus).json({
      success: overallSuccess,
      data: { results, summary: { total: results.length, succeeded, failed } },
    });
  } catch (err) {
    next(err);
  }
}
