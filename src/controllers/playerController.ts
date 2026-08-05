import { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { sanitizeInput } from "../utils/sanitizer";
import { createId } from "@paralleldrive/cuid2";
import { z } from "zod";
import { isValidMetadataUri, URI_VALIDATION_ERROR } from "../utils/uriValidator";
import { pinJson } from "../services/ipfs";
import { serializeIpfsResult } from "../utils/ipfsSerializer";
import {
  queryEvents,
  getPlayerById,
  insertPlayerProfileHistory,
  countPlayers,
  searchPlayers,
  PlayerRow,
  recordProfileView,
  getLastProfileView,
  getProfileViewCount,
  getUniqueViewerCount,
  getContactUnlockCount,
  insertOrUpdatePlayer,
  deactivatePlayer,
  reactivatePlayer,
  countTrialOffersByPlayer,
} from "../db";

import { queryMilestones, updateProfile } from "../services/stellar";
import { cacheGet, cacheSet, invalidatePlayerCache } from "../services/cache";
import { ApiResponse } from "../types";
import { ErrorCode } from "../utils/errorCodes";
import { getTierMeta, tierName } from "../utils/tier";
import { validateMinTier } from "../utils/minTierValidator";
import { normalizePositionOrFallback } from "../utils/positionAliases";
import { dispatchEventWebhook } from "../services/webhooks";
import { enrichPlayerResult } from "../utils/searchEnrichment";
import { playerIdSchema } from "../utils/playerIdValidator";
import { recordAudit } from "../utils/audit";

const baseRegistrationSchema = z.object({
  wallet: z.string().min(56).max(56),
  position: z.string().min(1),
  region: z.string().min(1),
});

const metadataSchema = z.record(z.unknown());
const metadataUriSchema = z
  .string()
  .min(1)
  .refine(isValidMetadataUri, URI_VALIDATION_ERROR);

export const registerSchema = z.union([
  baseRegistrationSchema.extend({ metadata: metadataSchema }),
  baseRegistrationSchema.extend({ metadataUri: metadataUriSchema }),
]);

export type RegisterPlayerRequest = z.infer<typeof registerSchema>;

export const filterSchema = z.object({
  region: z.string().optional(),
  position: z.string().optional(),
  minTier: z.coerce.number().int().min(0).max(3).optional(),
  sortBy: z.enum(['relevance', 'tier', 'region', 'created_at']).default('relevance'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  /**
   * Comma-separated list of field names to include in each player object.
   * Unknown field names are silently ignored.
   * When omitted, all fields are returned (backwards-compatible).
   * Example: ?fields=player_id,position,region
   */
  fields: z.string().optional(),
});

/** POST /api/players/register */
export async function registerPlayer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = registerSchema.parse(req.body);

    // Ensure the wallet in the request body belongs to the authenticated account.
    // Without this check a player could register a profile under another player's address.
    if (parsed.wallet !== req.account) {
      res.status(403).json({ success: false, error: 'wallet must match authenticated account' });
      return;
    }

    const sanitizedPosition = sanitizeInput(parsed.position);
    const canonicalPosition = normalizePositionOrFallback(sanitizedPosition);
    const sanitizedRegion = sanitizeInput(parsed.region);
    const metadataUri =
      "metadataUri" in parsed
        ? parsed.metadataUri
        : await pinJson({
            wallet: parsed.wallet,
            position: canonicalPosition,
            region: sanitizedRegion,
            ...parsed.metadata,
          });

    // Invalidate player search cache so new profile appears in results
    await invalidatePlayerCache();

    // Write to DB immediately so GET /players/:playerId returns 200 without
    // waiting for the indexer to process the blockchain event (#282).
    const playerId = createId();
    const now = Date.now();
    insertOrUpdatePlayer({
      player_id: playerId,
      wallet: parsed.wallet,
      position: canonicalPosition,
      region: sanitizedRegion,
      metadata_uri: metadataUri,
      created_at: now,
      registered_at: now,
    });

    await dispatchEventWebhook("player_registered", {
      player_id: playerId,
      wallet: parsed.wallet,
      position: canonicalPosition,
      region: sanitizedRegion,
      metadataUri,
    });

    const ipfsResult = serializeIpfsResult(metadataUri, {
      wallet: parsed.wallet,
      position: canonicalPosition,
      region: sanitizedRegion,
    });
    const body: ApiResponse<
      typeof ipfsResult & { playerId: string; metadataUri: string; gatewayUrl: string }
    > = {
      success: true,
      data: { ...ipfsResult, playerId, metadataUri, gatewayUrl: ipfsResult.uri },
    };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/players/:playerId */
export async function getPlayer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idResult = playerIdSchema.safeParse(req.params.playerId);
    if (!idResult.success) {
      res.status(400).json({ success: false, error: idResult.error.errors[0]?.message ?? "Invalid playerId", code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const playerId = sanitizeInput(req.params.playerId);
    const cacheKey = `players:${playerId}`;
    let data = await cacheGet<Record<string, unknown>>(cacheKey);
    if (!data) {
      const row = getPlayerById(playerId);
      if (!row) {
        res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
        return;
      }
      const { tierName: tierNameMeta, tierDescription } = getTierMeta(row.progress_level as number);
      data = {
        player_id: row.player_id,
        wallet: row.wallet,
        position: row.position,
        region: row.region,
        metadataUri: row.metadata_uri,
        progress_level: row.progress_level,
        created_at: row.created_at,
        is_active: row.is_active,
        tierName: tierNameMeta,
        tierDescription,
        progress_tier_name: tierName(row.progress_level as number),
      };
      await cacheSet(cacheKey, data);
    }

    if (data.is_active === 0) {
      const isOwner = req.account && (req.account === data.player_id || req.account === data.wallet);
      const isAdmin = req.role === 'admin';
      if (!isOwner && !isAdmin) {
        res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
        return;
      }
    }

    const etag = `"${createHash("sha1").update(JSON.stringify(data)).digest("hex")}"`;
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }
    res.set("ETag", etag);
    // offerCount is computed fresh on every request and merged in below, but
    // deliberately excluded from the ETag digest above so submitting a new
    // offer doesn't bust the cache / invalidate conditional GETs for the
    // rest of the (slower-changing) profile fields.
    const offerCount = countTrialOffersByPlayer(String(data.player_id));
    res.json({ success: true, data: { ...data, offerCount } });

    // Record profile view (non-blocking, after response is sent)
    // This is synchronous but happens after the response is queued
    recordProfileViewForRequest(req);
  } catch (err) {
    next(err);
  }
}

interface FilterPlayersResult {
  data: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

/**
 * Return a copy of `obj` containing only the keys present in `allowedFields`.
 * If `allowedFields` is null/empty the original object is returned unchanged.
 */
function projectFields(
  obj: Record<string, unknown>,
  allowedFields: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = obj[key];
    }
  }
  return result;
}

/** GET /api/players?region=&position=&minTier=&sortBy=&sortOrder=&cursor= */
export async function filterPlayers(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tierResult = validateMinTier(req.query.minTier);
    if (!tierResult.valid) {
      const isRangeError = typeof tierResult.error === 'string' && tierResult.error.includes('out of range');
      res.status(isRangeError ? 422 : 400).json({ success: false, error: tierResult.error, code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const minTier = tierResult.tier;
    const { region, position, sortBy, sortOrder, page, pageSize, cursor, fields } = filterSchema.parse(req.query);
    const sanitizedRegion = region ? sanitizeInput(region) : undefined;
    const sanitizedPosition = position ? sanitizeInput(position) : undefined;
    const normalizedPosition = sanitizedPosition
      ? normalizePositionOrFallback(sanitizedPosition)
      : undefined;

    const requestedFields = fields
      ? new Set(fields.split(',').map((f) => f.trim()).filter(Boolean))
      : null;

    const cacheKey = `players:list:${JSON.stringify({
      region: sanitizedRegion ?? null,
      position: normalizedPosition ?? null,
      minTier: minTier ?? null,
      sortBy,
      sortOrder,
      page: page ?? null,
      cursor: cursor ?? null,
      pageSize,
    })}`;

    const cached = await cacheGet<FilterPlayersResult>(cacheKey);
    if (cached) {
      const responseData = requestedFields
        ? cached.data.map((p) => projectFields(p, requestedFields))
        : cached.data;
      res.json({ success: true, ...cached, data: responseData });
      return;
    }

    const resolvedPage = page ?? 1;

    let rows: PlayerRow[];
    let nextCursor: string | null;

    if (cursor) {
      const searchResult = searchPlayers({
        region: sanitizedRegion,
        position: normalizedPosition,
        minTier,
        sortBy,
        sortOrder,
        limit: pageSize,
        cursor,
      });
      rows = searchResult.data;
      nextCursor = searchResult.nextCursor;
    } else {
      const searchResult = searchPlayers({
        region: sanitizedRegion,
        position: normalizedPosition,
        minTier,
        sortBy,
        sortOrder,
        limit: pageSize,
        offset: (resolvedPage - 1) * pageSize,
      });
      rows = searchResult.data;
      nextCursor = searchResult.nextCursor;
    }

    const total = countPlayers({
      region: sanitizedRegion,
      position: normalizedPosition,
      minTier,
    });

    const pages = Math.ceil(total / pageSize);
    const enriched = rows.map((row) => ({
      player_id: row.player_id,
      wallet: row.wallet,
      position: row.position,
      region: row.region,
      metadataUri: row.metadata_uri,
      progress_level: row.progress_level,
      created_at: row.created_at,
      registered_at: row.registered_at,
      progress_tier_name: tierName(row.progress_level as number),
      ...enrichPlayerResult(row.progress_level),
    }));

    const result: FilterPlayersResult & { nextCursor: string | null } = {
      data: enriched,
      total,
      page: resolvedPage,
      pageSize,
      pages,
      nextCursor,
    };
    await cacheSet(cacheKey, result);

    const scoutWallet = req.account ?? 'anonymous';
    recordAudit(scoutWallet, 'player_search', {
      region: sanitizedRegion ?? null,
      position: normalizedPosition ?? null,
      minTier: minTier ?? null,
      sortBy,
      sortOrder,
      page: resolvedPage,
      pageSize,
      cursor: cursor ?? null,
      resultCount: total,
    });

    const responseData = requestedFields
      ? enriched.map((p) => projectFields(p, requestedFields))
      : enriched;
    res.json({ success: true, ...result, data: responseData });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/players/:playerId — profile owner only */
export const updatePlayerSchema = z.union([
  z.object({ metadata: z.record(z.unknown()) }),
  z.object({ metadataUri: metadataUriSchema }),
]);

export async function updatePlayer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const playerId = sanitizeInput(req.params.playerId);
    const parsed = updatePlayerSchema.parse(req.body);
    const metadataUri =
      "metadata" in parsed
        ? await pinJson({ playerId, ...parsed.metadata })
        : parsed.metadataUri;
    const result = await updateProfile(playerId, metadataUri);

    // Append a profile version history row after the on-chain update succeeds.
    insertPlayerProfileHistory({
      player_id: playerId,
      metadata_uri: result.metadataUri,
      changed_at: Date.now(),
      tx_hash: result.transactionId,
    });

    // Bust the single-player cache so the next GET reflects the update.
    await invalidatePlayerCache(playerId);

    res.status(200).json({
      success: true,
      data: {
        transactionId: result.transactionId,
        metadataUri: result.metadataUri,
      },
    });
  } catch (err) {
    next(err);
  }
}

const milestonesQuerySchema = z.object({
  sortBy: z.enum(["submittedAt", "approvedAt"]).default("submittedAt"),
  order: z.enum(["asc", "desc"]).default("asc"),
  // `sort` is an accepted alias for `order` — the task spec uses `sort`
  sort: z.enum(["asc", "desc"]).optional(),
  status: z.enum(["approved", "pending", "all"]).default("all"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50, { message: "limit must not exceed 50" })
    .default(20),
});

/** GET /api/players/:playerId/milestones */
export async function getPlayerMilestones(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idResult = playerIdSchema.safeParse(req.params.playerId);
    if (!idResult.success) {
      res.status(400).json({ success: false, error: idResult.error.errors[0]?.message ?? "Invalid playerId", code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const playerId = sanitizeInput(req.params.playerId);

    const player = getPlayerById(playerId);
    if (!player) {
      res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
      return;
    }
    if (player.is_active === 0) {
      const isOwner = req.account && (req.account === player.player_id || req.account === player.wallet);
      const isAdmin = req.role === 'admin';
      if (!isOwner && !isAdmin) {
        res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
        return;
      }
    }

    // Validate limit separately first so we can return 400 before parsing the rest
    const rawLimit = req.query.limit;
    if (rawLimit !== undefined) {
      const limitNum = Number(rawLimit);
      if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 50) {
        res.status(400).json({
          success: false,
          error: "limit must not exceed 50",
          code: ErrorCode.VALIDATION_ERROR,
        });
        return;
      }
    }

    const parsed = milestonesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? "Invalid query parameters",
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    // `sort` is an alias for `order`; explicit `sort` takes precedence
    const { sortBy, status, limit } = parsed.data;
    const order = parsed.data.sort ?? parsed.data.order;

    // Map status to the event type filter used by queryEvents.
    // "pending"  → milestone_submitted events
    // "approved" → milestone_approved events
    // "all"      → both (fetch approved then layer in submitted)
    const approvedEvents =
      status !== "pending"
        ? queryEvents("milestone_approved")
            .filter((e) => e.payload.player_id === playerId)
            .map((e) => ({ ...e.payload, status: "approved" as const }))
        : [];

    const pendingEvents =
      status !== "approved"
        ? queryEvents("milestone_submitted")
            .filter((e) => e.payload.player_id === playerId)
            .map((e) => ({ ...e.payload, status: "pending" as const }))
        : [];

    const onChainMilestones = await queryMilestones(playerId);

    const combined = [
      ...approvedEvents,
      ...pendingEvents,
      ...(onChainMilestones as unknown as Record<string, unknown>[]),
    ];

    combined.sort((a, b) => {
      const av = Number(a[sortBy] ?? 0);
      const bv = Number(b[sortBy] ?? 0);
      return order === "asc" ? av - bv : bv - av;
    });

    // Apply limit (parameterised, no interpolation)
    const paginated = combined.slice(0, limit);

    res.json({ success: true, data: paginated });
  } catch (err) {
    next(err);
  }
}

// ─── Profile Analytics ─────────────────────────────────────────────────────

/**
 * Record a profile view from an authenticated scout.
 * Checks for self-views and deduplicates rapid consecutive views within a 5-minute window.
 * Errors are logged but do not interfere with the response.
 */
function recordProfileViewForRequest(req: Request): void {
  try {
    // Only record views from authenticated scouts
    if (!req.account) {
      return;
    }

    const playerId = req.params.playerId;
    const scoutWallet = req.account as string;

    // Get player to check for self-view
    const player = getPlayerById(playerId);
    if (!player) {
      // Player doesn't exist, skip recording
      return;
    }

    // Exclude self-views
    if (scoutWallet === player.wallet) {
      return;
    }

    // Check dedup window: 5 minutes (300 seconds)
    const lastViewAt = getLastProfileView(scoutWallet, playerId);
    const now = Math.floor(Date.now() / 1000);

    if (lastViewAt !== null && (now - lastViewAt) < 300) {
      // View within dedup window, skip recording
      return;
    }

    // Record the view
    recordProfileView({
      scout_wallet: scoutWallet,
      player_id: playerId,
      viewed_at: now,
      created_at: now,
    });
  } catch (err) {
    // Log error but don't re-throw; profile view recording is non-critical
    const message = err instanceof Error ? err.message : JSON.stringify(err);
    // eslint-disable-next-line no-console
    console.error(`[Profile View Recording Error] ${message}`, {
      playerId: req.params.playerId,
      scoutWallet: req.account,
    });
  }
}

/** POST /api/players/:playerId/deactivate */
export async function deactivatePlayerEndpoint(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idResult = playerIdSchema.safeParse(req.params.playerId);
    if (!idResult.success) {
      res.status(400).json({ success: false, error: idResult.error.errors[0]?.message ?? "Invalid playerId", code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const playerId = sanitizeInput(req.params.playerId);
    const row = getPlayerById(playerId);
    if (!row) {
      res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
      return;
    }
    deactivatePlayer(playerId);
    await invalidatePlayerCache(playerId);
    res.json({ success: true, message: "Player profile deactivated successfully" });
  } catch (err) {
    next(err);
  }
}

/** POST /api/players/:playerId/reactivate */
export async function reactivatePlayerEndpoint(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idResult = playerIdSchema.safeParse(req.params.playerId);
    if (!idResult.success) {
      res.status(400).json({ success: false, error: idResult.error.errors[0]?.message ?? "Invalid playerId", code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const playerId = sanitizeInput(req.params.playerId);
    const row = getPlayerById(playerId);
    if (!row) {
      res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
      return;
    }
    reactivatePlayer(playerId);
    await invalidatePlayerCache(playerId);
    res.json({ success: true, message: "Player profile reactivated successfully" });
  } catch (err) {
    next(err);
  }
}

// ─── Profile Analytics ──────────────────────────────────────────────────────

/**
 * GET /api/players/:playerId/analytics
 * Return aggregated profile view and contact unlock analytics for the player (owner-only).
 */
export async function getPlayerAnalytics(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
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

    const player = getPlayerById(playerId);
    if (!player) {
      res.status(404).json({
        success: false,
        error: "Player not found",
        code: ErrorCode.PLAYER_NOT_FOUND,
      });
      return;
    }

    const viewCount = getProfileViewCount(playerId);
    const viewerCount = getUniqueViewerCount(playerId);
    const contactUnlockCount = getContactUnlockCount(playerId);
    const lastUpdated = Math.floor(Date.now() / 1000);

    res.json({
      success: true,
      data: {
        view_count: viewCount,
        viewer_count: viewerCount,
        contact_unlock_count: contactUnlockCount,
        lastUpdated,
      },
    });
  } catch (err) {
    next(err);
  }
}
