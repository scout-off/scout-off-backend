import { Request, Response, NextFunction } from "express";
import { sanitizeInput } from "../utils/sanitizer";
import { z } from "zod";
import { CID_REGEX } from "../utils/cidValidator";
import { pinJson } from "../services/ipfs";
import { serializeIpfsResult } from "../utils/ipfsSerializer";
import {
  getEvents,
  getPlayerById,
  insertPlayerProfileHistory,
  queryPlayers,
  countPlayers,
} from "../db";

import { queryMilestones, updateProfile } from "../services/stellar";
import { invalidatePlayerCache } from "../services/cache";
import { ApiResponse } from "../types";
import { getTierMeta } from "../utils/tier";
import { validateMinTier } from "../utils/minTierValidator";
import { normalizePosition } from "../utils/positionAliases";
import { dispatchEventWebhook } from "../services/webhooks";
import { recordAudit } from "../utils/audit";
import { enrichPlayerResult } from "../utils/searchEnrichment";
import { buildPaginationLinks } from "../utils/paginationLinks";

const baseRegistrationSchema = z.object({
  wallet: z.string().min(56).max(56),
  position: z.string().min(1),
  region: z.string().min(1),
});

const metadataSchema = z.record(z.unknown());
const metadataUriSchema = z
  .string()
  .regex(CID_REGEX, "metadataUri must be a valid CID");

export const registerSchema = z.union([
  baseRegistrationSchema.extend({ metadata: metadataSchema }),
  baseRegistrationSchema.extend({ metadataUri: metadataUriSchema }),
]);

export type RegisterPlayerRequest = z.infer<typeof registerSchema>;

export const filterSchema = z.object({
  region: z.string().optional(),
  position: z.string().optional(),
  minTier: z.coerce.number().int().min(0).max(3).optional(),
  /** Keyword search — empty string is treated as no filter. */
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** POST /api/players/register */
export async function registerPlayer(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = registerSchema.parse(req.body);
    const sanitizedPosition = sanitizeInput(parsed.position);
    const sanitizedRegion = sanitizeInput(parsed.region);
    const metadataUri =
      "metadataUri" in parsed
        ? parsed.metadataUri
        : await pinJson({
            wallet: parsed.wallet,
            position: sanitizedPosition,
            region: sanitizedRegion,
            ...parsed.metadata,
          });

    // Invalidate player search cache so new profile appears in results
    invalidatePlayerCache();
    await dispatchEventWebhook("player_registered", {
      wallet: parsed.wallet,
      position: sanitizedPosition,
      region: sanitizedRegion,
      metadataUri,
    });

    const ipfsResult = serializeIpfsResult(metadataUri, {
      wallet: parsed.wallet,
      position: sanitizedPosition,
      region: sanitizedRegion,
    });
    const body: ApiResponse<
      typeof ipfsResult & { metadataUri: string; gatewayUrl: string }
    > = {
      success: true,
      data: { ...ipfsResult, metadataUri, gatewayUrl: ipfsResult.uri },
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
) {
  try {
    const playerId = sanitizeInput(req.params.playerId);
    const row = getPlayerById(playerId);
    if (!row) {
      res.status(404).json({ success: false, error: "Player not found" });
      return;
    }
    const { tierName, tierDescription } = getTierMeta(row.progress_level);
    res.json({
      success: true,
      data: {
        player_id: row.player_id,
        wallet: row.wallet,
        position: row.position,
        region: row.region,
        metadataUri: row.metadata_uri,
        progress_level: row.progress_level,
        created_at: row.created_at,
        tierName,
        tierDescription,
      },
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/players?region=&position=&minTier= */
export async function filterPlayers(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const tierResult = validateMinTier(req.query.minTier);
    if (!tierResult.valid) {
      res.status(400).json({ success: false, error: tierResult.error });
      return;
    }
    const minTier = tierResult.tier;
    const { region, position, q, page, pageSize } = filterSchema.parse(req.query);
    const sanitizedRegion = region ? sanitizeInput(region) : undefined;
    const sanitizedPosition = position ? sanitizeInput(position) : undefined;
    const normalizedPosition = sanitizedPosition
      ? normalizePosition(sanitizedPosition)
      : undefined;
    // Treat blank ?q= as no filter
    const keyword = q && q.trim() !== '' ? sanitizeInput(q.trim()) : undefined;

    const rows = queryPlayers({
      region: sanitizedRegion,
      position: normalizedPosition ?? sanitizedPosition,
      minTier,
      q: keyword,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    const total = countPlayers({
      region: sanitizedRegion,
      position: normalizedPosition ?? sanitizedPosition,
      minTier,
      q: keyword,
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
      ...enrichPlayerResult(row.progress_level),
    }));

    const scoutWallet = (req as any).account ?? 'anonymous';
    recordAudit(scoutWallet, 'player_search', {
      region: sanitizedRegion ?? null,
      position: normalizedPosition ?? sanitizedPosition ?? null,
      minTier: minTier ?? null,
      q: keyword ?? null,
      page,
      pageSize,
      resultCount: total,
    });

    const links = buildPaginationLinks(req, { page, pageSize, total });
    res.json({ success: true, data: enriched, total, page, pageSize, pages, links });
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
) {
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
});

/** GET /api/players/:playerId/milestones */
export async function getPlayerMilestones(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const playerId = sanitizeInput(req.params.playerId);

    const parsed = milestonesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? "Invalid query parameters",
      });
      return;
    }
    const { sortBy, order } = parsed.data;
    const indexedMilestones = getEvents("milestone_approved")
      .filter((e) => e.payload.player_id === playerId)
      .map((e) => ({ ...e.payload }));
    const onChainMilestones = await queryMilestones(playerId);
    const combined = [
      ...indexedMilestones,
      ...(onChainMilestones as unknown as Record<string, unknown>[]),
    ];
    combined.sort((a, b) => {
      const av = Number(a[sortBy] ?? 0);
      const bv = Number(b[sortBy] ?? 0);
      return order === "asc" ? av - bv : bv - av;
    });
    res.json({ success: true, data: combined });
  } catch (err) {
    next(err);
  }
}
