import { Request, Response, NextFunction } from "express";
import { getPlayerProfileHistory, getPlayerProfileHistoryVersioned, getPlayerById, getPlayerByWallet } from "../db";
import { sanitizeInput } from "../utils/sanitizer";
import { z } from "zod";
import { ApiResponse } from "../types";
import { ErrorCode } from "../utils/errorCodes";
import { playerIdSchema } from "../utils/playerIdValidator";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlayerProfileHistoryItem {
  version: number;
  metadataUri: string;
  changedAt: number;
  txHash: string;
}

/** A single field diff entry: the value it had before and after. */
export interface FieldDiff {
  from: unknown;
  to: unknown;
}

/** Map of field name → { from, to } for fields that changed between two versions. */
export type ProfileDiff = Record<string, FieldDiff>;

// ─── Schema ───────────────────────────────────────────────────────────────────

const versionParamSchema = z.coerce
  .number()
  .int()
  .min(1, "version must be a positive integer");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute a field-level diff between two plain objects.
 * Returns only the keys whose values changed (added, removed, or updated).
 * Format: { fieldName: { from: oldValue, to: newValue } }
 */
function diffObjects(
  prev: Record<string, unknown>,
  curr: Record<string, unknown>,
): ProfileDiff {
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  const diff: ProfileDiff = {};

  for (const key of allKeys) {
    const fromVal = Object.prototype.hasOwnProperty.call(prev, key)
      ? prev[key]
      : undefined;
    const toVal = Object.prototype.hasOwnProperty.call(curr, key)
      ? curr[key]
      : undefined;

    // Use JSON comparison so nested objects/arrays are compared by value
    if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
      diff[key] = { from: fromVal ?? null, to: toVal ?? null };
    }
  }

  return diff;
}

/**
 * Convert a history row's metadata_uri into a plain key-value object suitable
 * for diffing. The only field tracked at the DB level is `metadata_uri`; this
 * wrapper makes the diff output uniform and extensible if more fields are
 * added to the history table in the future.
 */
function rowToSnapshot(metadataUri: string): Record<string, unknown> {
  return { metadataUri };
}

/**
 * These history routes are owner-gated by requireOwner, which compares the
 * authenticated wallet directly against :playerId — so self-service callers
 * address their profile by wallet. Admin callers, however, typically arrive
 * with the profile's actual player_id (e.g. from an events/audit listing).
 * Try both so either caller's identifier resolves to the same profile.
 */
function findPlayerByIdOrWallet(playerId: string) {
  return getPlayerById(playerId) ?? getPlayerByWallet(playerId);
}

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * GET /api/players/:playerId/history
 *
 * Returns all historical profile snapshots for a player, ordered newest-first.
 * Each entry includes a stable 1-based version number.
 *
 * @response 200 { success: true, data: PlayerProfileHistoryItem[] }
 * @response 404 player not found
 */
export function getPlayerHistory(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    const idResult = playerIdSchema.safeParse(req.params.playerId);
    if (!idResult.success) {
      res.status(400).json({
        success: false,
        error: idResult.error.errors[0]?.message ?? "Invalid playerId",
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    const playerId = sanitizeInput(req.params.playerId);

    const player = findPlayerByIdOrWallet(playerId);
    if (!player) {
      res.status(404).json({
        success: false,
        error: "Player not found",
        code: ErrorCode.PLAYER_NOT_FOUND,
      });
      return;
    }

    // Newest-first for list view (DESC by changed_at)
    const rows = getPlayerProfileHistory(playerId);

    // Build version numbers: version = total - index (so oldest = v1, newest = vN)
    const total = rows.length;
    const data: PlayerProfileHistoryItem[] = rows.map((r, idx) => ({
      version: total - idx, // newest row gets the highest version
      metadataUri: r.metadata_uri,
      changedAt: r.changed_at,
      txHash: r.tx_hash,
    }));

    const body: ApiResponse<PlayerProfileHistoryItem[]> = { success: true, data };
    res.json(body);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/players/:playerId/history/:version
 *
 * Returns the full profile snapshot at the given 1-based version number.
 * Version 1 = the first (oldest) recorded snapshot.
 *
 * @response 200 { success: true, data: PlayerProfileHistoryItem }
 * @response 400 invalid version param
 * @response 404 player not found or version out of range
 */
export function getPlayerHistoryVersion(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    const idResult = playerIdSchema.safeParse(req.params.playerId);
    if (!idResult.success) {
      res.status(400).json({
        success: false,
        error: idResult.error.errors[0]?.message ?? "Invalid playerId",
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    const versionResult = versionParamSchema.safeParse(req.params.version);
    if (!versionResult.success) {
      res.status(400).json({
        success: false,
        error: versionResult.error.errors[0]?.message ?? "Invalid version",
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    const playerId = sanitizeInput(req.params.playerId);
    const version = versionResult.data;

    const player = findPlayerByIdOrWallet(playerId);
    if (!player) {
      res.status(404).json({
        success: false,
        error: "Player not found",
        code: ErrorCode.PLAYER_NOT_FOUND,
      });
      return;
    }

    // Fetch oldest-first so index 0 = version 1
    const rows = getPlayerProfileHistoryVersioned(playerId);
    const row = rows[version - 1];

    if (!row) {
      res.status(404).json({
        success: false,
        error: `Version ${version} not found — player has ${rows.length} history entry(s)`,
        code: ErrorCode.NOT_FOUND,
      });
      return;
    }

    const data: PlayerProfileHistoryItem = {
      version: row.version,
      metadataUri: row.metadata_uri,
      changedAt: row.changed_at,
      txHash: row.tx_hash,
    };

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/players/:playerId/history/:version/diff
 *
 * Returns a field-level diff between version N and version N-1.
 * Version 1 has no predecessor — its diff is empty (initial snapshot).
 *
 * Diff format: { field: { from: oldValue, to: newValue } }
 *
 * @response 200 { success: true, data: { version, diff: ProfileDiff } }
 * @response 400 invalid params
 * @response 404 player not found or version out of range
 */
export function getPlayerHistoryDiff(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    const idResult = playerIdSchema.safeParse(req.params.playerId);
    if (!idResult.success) {
      res.status(400).json({
        success: false,
        error: idResult.error.errors[0]?.message ?? "Invalid playerId",
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    const versionResult = versionParamSchema.safeParse(req.params.version);
    if (!versionResult.success) {
      res.status(400).json({
        success: false,
        error: versionResult.error.errors[0]?.message ?? "Invalid version",
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    const playerId = sanitizeInput(req.params.playerId);
    const version = versionResult.data;

    const player = findPlayerByIdOrWallet(playerId);
    if (!player) {
      res.status(404).json({
        success: false,
        error: "Player not found",
        code: ErrorCode.PLAYER_NOT_FOUND,
      });
      return;
    }

    // Fetch oldest-first so index 0 = version 1
    const rows = getPlayerProfileHistoryVersioned(playerId);
    const currRow = rows[version - 1];

    if (!currRow) {
      res.status(404).json({
        success: false,
        error: `Version ${version} not found — player has ${rows.length} history entry(s)`,
        code: ErrorCode.NOT_FOUND,
      });
      return;
    }

    const prevRow = version > 1 ? rows[version - 2] : null;

    const prevSnapshot = prevRow
      ? rowToSnapshot(prevRow.metadata_uri)
      : {};
    const currSnapshot = rowToSnapshot(currRow.metadata_uri);

    const diff = diffObjects(prevSnapshot, currSnapshot);

    res.json({
      success: true,
      data: {
        version,
        previousVersion: prevRow ? version - 1 : null,
        diff,
      },
    });
  } catch (err) {
    next(err);
  }
}
