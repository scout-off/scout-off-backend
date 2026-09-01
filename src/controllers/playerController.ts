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
  getPlayerProfileHistory,
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
import { cacheGet, cacheSet, invalidatePlayerCache, getPlayerListLastModified } from "../services/cache";
import { ApiResponse } from "../types";
import { ErrorCode } from "../utils/errorCodes";
import { getTierMeta, tierName } from "../utils/tier";
import { validateMinTier } from "../utils/minTierValidator";
import { normalizePositionOrFallback } from "../utils/positionAliases";
import { dispatchEventWebhook } from "../services/webhooks";
import { enrichPlayerResult } from "../utils/searchEnrichment";
import { playerIdSchema } from "../utils/playerIdValidator";
import { recordAudit } from "../utils/audit";
import { canAccessPlayer } from "../utils/playerAccess";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "../utils/pagination";

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
  baseRegistrationSchema.extend({ metadata: metadataSchema }).strict(),
  baseRegistrationSchema.extend({ metadataUri: metadataUriSchema }).strict(),
]);

export type RegisterPlayerRequest = z.infer<typeof registerSchema>;

export const filterSchema = z.object({
  region: z.string().optional(),
  position: z.string().optional(),
  minTier: z.coerce.number().int().min(0).max(3).optional(),
  sortBy: z.enum(['relevance', 'tier', 'region', 'created_at']).default('relevance'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
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
  await insertOrUpdatePlayer({
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
}

/**
 * Build the profile detail object served by GET /api/players/:playerId.
 * Key order is significant: the ETag digest is a hash of this exact JSON,
 * so GET (which may serve from cache) and PUT (which reads fresh from the
 * DB) must construct identical objects for the same stored row.
 */
function buildPlayerDetail(row: PlayerRow): Record<string, unknown> {
  const { tierName: tierNameMeta, tierDescription } = getTierMeta(row.progress_level as number);
  return {
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
}

/**
 * Version token for a player profile (#1151). One token serves both caching
 * (If-None-Match → 304) and optimistic concurrency (If-Match on PUT): it is
 * a hash of the profile payload plus the profile-history version (the count
 * of recorded metadata updates, which the profile-history feature already
 * tracks and which bumps on every successful PUT).
 */
function playerEtag(detail: Record<string, unknown>, profileVersion: number): string {
  return `"${createHash("sha1").update(JSON.stringify({ ...detail, profileVersion })).digest("hex")}"`;
}

/** GET /api/players/:playerId */
export async function getPlayer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const idResult = playerIdSchema.safeParse(req.params.playerId as string);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: idResult.error.errors[0]?.message ?? "Invalid playerId", code: ErrorCode.VALIDATION_ERROR });
    return;
  }
  const playerId = sanitizeInput(req.params.playerId as string);
  const cacheKey = `players:${playerId}`;
  let data = await cacheGet<Record<string, unknown>>(cacheKey);
  if (!data) {
    const row = await getPlayerById(playerId);
    if (!row) {
      res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
      return;
    }
    data = buildPlayerDetail(row);
    await cacheSet(cacheKey, data);
  }

  // Deactivated profiles are only visible to the owner or an admin — same
  // shared decision as GraphQL and the milestones endpoints (#1019).
  if (!canAccessPlayer(data as { player_id: string; wallet: string; is_active?: number }, { account: req.account, role: req.role })) {
    res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
    return;
  }

  // The profile-history version is part of the ETag so a profile update that
  // does not change the cached row payload still moves the version token.
  const profileHistory = await getPlayerProfileHistory(playerId);
  const etag = playerEtag(data, profileHistory.length);
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  res.set("ETag", etag);
  // offerCount is computed fresh on every request and merged in below, but
  // deliberately excluded from the ETag digest above so submitting a new
  // offer doesn't bust the cache / invalidate conditional GETs for the
  // rest of the (slower-changing) profile fields.
  const offerCount = await countTrialOffersByPlayer(String(data.player_id));
  res.json({ success: true, data: { ...data, offerCount } });

  // Record profile view (non-blocking, after response is sent)
  recordProfileViewForRequest(req).catch(() => {});
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

/** Short CDN/client revalidation window — cheap validators, not long staleness. */
const PLAYER_LIST_CACHE_CONTROL = 'public, max-age=10, must-revalidate';

/**
 * Apply Cache-Control / Last-Modified / ETag for the player list and honour
 * conditional request headers. Returns true when a 304 was sent.
 */
function maybeNotModifiedPlayerList(
  req: Request,
  res: Response,
  cacheKey: string,
): boolean {
  const listVersion = getPlayerListLastModified();
  // Truncate to seconds — HTTP Last-Modified has second resolution.
  const lastModifiedSec = Math.floor(listVersion / 1000) * 1000;
  const etag = `"${createHash('sha1').update(`${cacheKey}:${lastModifiedSec}`).digest('hex')}"`;
  const lastModifiedHttp = new Date(lastModifiedSec).toUTCString();

  res.set('Cache-Control', PLAYER_LIST_CACHE_CONTROL);
  res.set('Last-Modified', lastModifiedHttp);
  res.set('ETag', etag);

  const ifNoneMatch = req.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch === etag) {
    res.status(304).end();
    return true;
  }

  // If-None-Match takes precedence over If-Modified-Since when both are sent.
  if (ifNoneMatch) {
    return false;
  }

  const ims = req.headers['if-modified-since'];
  if (typeof ims === 'string') {
    const imsMs = Date.parse(ims);
    if (!Number.isNaN(imsMs) && lastModifiedSec <= imsMs) {
      res.status(304).end();
      return true;
    }
  }

  return false;
}

/** GET /api/players?region=&position=&minTier=&sortBy=&sortOrder=&cursor= */
export async function filterPlayers(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
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

  if (maybeNotModifiedPlayerList(req, res, cacheKey)) {
    return;
  }

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
    const searchResult = await searchPlayers({
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
    const searchResult = await searchPlayers({
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

  const total = await countPlayers({
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
  await recordAudit(scoutWallet, 'player_search', {
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
}

/** PUT /api/players/:playerId — profile owner only */
export const updatePlayerSchema = z.union([
  z.object({ metadata: z.record(z.unknown()) }).strict(),
  z.object({ metadataUri: metadataUriSchema }).strict(),
]);

export async function updatePlayer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const playerId = sanitizeInput(req.params.playerId as string);

  // Optimistic concurrency (#1151): the ETag returned by GET doubles as the
  // version token. Compare against the *current* stored state (fresh read —
  // the GET path may serve from cache) so a client editing a stale profile
  // can never silently clobber a newer update.
  const row = await getPlayerById(playerId);
  if (!row) {
    res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
    return;
  }
  const profileHistory = await getPlayerProfileHistory(playerId);
  const currentEtag = playerEtag(buildPlayerDetail(row), profileHistory.length);

  const ifMatch = req.headers["if-match"];
  if (ifMatch === undefined) {
    res.status(428).json({
      success: false,
      error: "If-Match header required — echo the ETag from GET /api/players/:playerId (or send \"*\" to override)",
      code: ErrorCode.PRECONDITION_REQUIRED,
    });
    return;
  }
  // "*" is the standard override: the request proceeds as long as the
  // resource exists (which the row lookup above already confirmed).
  if (ifMatch !== "*" && ifMatch !== currentEtag) {
    res.status(412).json({
      success: false,
      error: "Precondition Failed — the profile changed since it was last fetched; re-fetch and retry",
      code: ErrorCode.PRECONDITION_FAILED,
    });
    return;
  }

  const parsed = updatePlayerSchema.parse(req.body);
  const metadataUri =
    "metadata" in parsed
      ? await pinJson({ playerId, ...parsed.metadata })
      : parsed.metadataUri;
  const result = await updateProfile(playerId, metadataUri);

  // Append a profile version history row after the on-chain update succeeds.
  await insertPlayerProfileHistory({
    player_id: playerId,
    metadata_uri: result.metadataUri,
    changed_at: Date.now(),
    tx_hash: result.transactionId,
  });

  // Bust the single-player cache so the next GET reflects the update.
  await invalidatePlayerCache(playerId);

  // The version has moved (one more history row) — return the new token so
  // the client can chain another PUT without a round-trip GET.
  res.set("ETag", playerEtag(buildPlayerDetail(row), profileHistory.length + 1));

  res.status(200).json({
    success: true,
    data: {
      transactionId: result.transactionId,
      metadataUri: result.metadataUri,
    },
  });
}

export const milestonesQuerySchema = z.object({
  sortBy: z.enum(["submittedAt", "approvedAt"]).default("submittedAt"),
  order: z.enum(["asc", "desc"]).default("asc"),
  // `sort` is an accepted alias for `order` — the task spec uses `sort`
  sort: z.enum(["asc", "desc"]).optional(),
  // Omit status to include approved + pending + on-chain (all). No "all" value.
  status: z.enum(["pending", "approved", "rejected"]).optional(),
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
  const idResult = playerIdSchema.safeParse(req.params.playerId as string);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: idResult.error.errors[0]?.message ?? "Invalid playerId", code: ErrorCode.VALIDATION_ERROR });
    return;
  }
  const playerId = sanitizeInput(req.params.playerId as string);

  const player = await getPlayerById(playerId);
  if (!player) {
    res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
    return;
  }
  // Deactivated players are only accessible to the owner or an admin — the
  // same shared decision used by GraphQL root/nested milestone queries (#1019).
  if (!canAccessPlayer(player, { account: req.account, role: req.role })) {
    res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
    return;
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
  // omitted     → approved + pending + all on-chain (normalized with status)
  // "approved"  → milestone_approved + on-chain where approved===true
  // "pending"   → milestone_submitted + on-chain where approved===false
  // "rejected"  → milestone_rejected only (on-chain has no rejected flag)
  const includeApproved = status === undefined || status === "approved";
  const includePending = status === undefined || status === "pending";
  const includeRejected = status === "rejected";

  const approvedEvents = includeApproved
    ? queryEvents("milestone_approved")
        .filter((e) => e.payload.player_id === playerId)
        .map((e) => ({ ...e.payload, status: "approved" as const }))
    : [];

  const pendingEvents = includePending
    ? queryEvents("milestone_submitted")
        .filter((e) => e.payload.player_id === playerId)
        .map((e) => ({ ...e.payload, status: "pending" as const }))
    : [];

  const rejectedEvents = includeRejected
    ? queryEvents("milestone_rejected")
        .filter((e) => e.payload.player_id === playerId)
        .map((e) => ({ ...e.payload, status: "rejected" as const }))
    : [];

  const onChainMilestones = await queryMilestones(playerId);
  const filteredOnChain =
    status === "rejected"
      ? []
      : onChainMilestones
          .filter((m) => {
            if (status === "approved") return m.approved === true;
            if (status === "pending") return m.approved === false;
            return true; // omitted → all on-chain
          })
          .map((m) => ({
            ...m,
            status: (m.approved ? "approved" : "pending") as "approved" | "pending",
          }));

  const combined = [
    ...approvedEvents,
    ...pendingEvents,
    ...rejectedEvents,
    ...filteredOnChain,
  ];

  combined.sort((a, b) => {
    const av = Number((a as Record<string, unknown>)[sortBy] ?? 0);
    const bv = Number((b as Record<string, unknown>)[sortBy] ?? 0);
    return order === "asc" ? av - bv : bv - av;
  });

  // Apply limit (parameterised, no interpolation)
  const paginated = combined.slice(0, limit);

  // ── ETag / conditional GET (#1139) ─────────────────────────────────────────
  // Derive a weak ETag from the count of milestones and the latest event
  // timestamp so the tag changes exactly when the list changes.  This mirrors
  // the playerEtag() pattern used by GET /api/players/:playerId.
  const milestoneEtag = playerEtag(
    { count: paginated.length, items: paginated },
    paginated.length,
  );
  if (req.headers["if-none-match"] === milestoneEtag) {
    res.status(304).end();
    return;
  }
  res.set("ETag", milestoneEtag);
  res.set("Cache-Control", "no-cache");

  res.json({ success: true, data: paginated });
}

// ─── Profile Analytics ─────────────────────────────────────────────────────

/**
 * Record a profile view from an authenticated scout.
 * Checks for self-views and deduplicates rapid consecutive views within a 5-minute window.
 * Errors are logged but do not interfere with the response.
 */
async function recordProfileViewForRequest(req: Request): Promise<void> {
try {
    // Only record views from authenticated scouts
    if (!req.account) {
      return;
    }

    const playerId = req.params.playerId as string;
    const scoutWallet = req.account as string;

    // Get player to check for self-view
    const player = await getPlayerById(playerId);
    if (!player) {
      // Player doesn't exist, skip recording
      return;
    }

    // Exclude self-views
    if (scoutWallet === player.wallet) {
      return;
    }

    // Check dedup window: 5 minutes (300 seconds)
    const lastViewAt = await getLastProfileView(scoutWallet, playerId);
    const now = Math.floor(Date.now() / 1000);

    if (lastViewAt !== null && (now - lastViewAt) < 300) {
      // View within dedup window, skip recording
      return;
    }

    // Record the view
    await recordProfileView({
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
      playerId: req.params.playerId as string,
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
  const idResult = playerIdSchema.safeParse(req.params.playerId as string);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: idResult.error.errors[0]?.message ?? "Invalid playerId", code: ErrorCode.VALIDATION_ERROR });
    return;
  }
  const playerId = sanitizeInput(req.params.playerId as string);
  const row = await getPlayerById(playerId);
  if (!row) {
    res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
    return;
  }
  await deactivatePlayer(playerId);
  await invalidatePlayerCache(playerId);
  res.json({ success: true, message: "Player profile deactivated successfully" });
}

/** POST /api/players/:playerId/reactivate */
export async function reactivatePlayerEndpoint(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const idResult = playerIdSchema.safeParse(req.params.playerId as string);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: idResult.error.errors[0]?.message ?? "Invalid playerId", code: ErrorCode.VALIDATION_ERROR });
    return;
  }
  const playerId = sanitizeInput(req.params.playerId as string);
  const row = await getPlayerById(playerId);
  if (!row) {
    res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
    return;
  }
  await reactivatePlayer(playerId);
  await invalidatePlayerCache(playerId);
  res.json({ success: true, message: "Player profile reactivated successfully" });
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
  const idResult = playerIdSchema.safeParse(req.params.playerId as string);
  if (!idResult.success) {
    res.status(400).json({
      success: false,
      error: idResult.error.errors[0]?.message ?? "Invalid playerId",
      code: ErrorCode.VALIDATION_ERROR,
    });
    return;
  }

  const playerId = sanitizeInput(req.params.playerId as string);

  const player = await getPlayerById(playerId);
  if (!player) {
    res.status(404).json({
      success: false,
      error: "Player not found",
      code: ErrorCode.PLAYER_NOT_FOUND,
    });
    return;
  }

  const viewCount = await getProfileViewCount(playerId);
  const viewerCount = await getUniqueViewerCount(playerId);
  const contactUnlockCount = await getContactUnlockCount(playerId);
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
}
