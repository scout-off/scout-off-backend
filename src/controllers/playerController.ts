import { sanitizeInput } from '../utils/sanitizer';
import { z } from 'zod';
import { pinJson, gatewayUrl } from '../services/ipfs';
import { getEvents } from '../services/indexer';
import { invalidatePlayerCache } from '../services/cache';
import { ApiResponse, ProgressLevel } from '../types';
import { getTierMeta } from '../utils/tier';

const baseRegistrationSchema = z.object({
  wallet: z.string().min(56).max(56),
  position: z.string().min(1),
  region: z.string().min(1),
});

const metadataSchema = z.record(z.unknown());
const metadataUriSchema = z.string().regex(CID_REGEX, 'metadataUri must be a valid CID');

export const registerSchema = z.union([
  baseRegistrationSchema.extend({ metadata: metadataSchema }),
  baseRegistrationSchema.extend({ metadataUri: metadataUriSchema }),
]);

export type RegisterPlayerRequest = z.infer<typeof registerSchema>;

export const filterSchema = z.object({
  region: z.string().optional(),
  position: z.string().optional(),
  minTier: z.coerce.number().int().min(0).max(3).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** POST /api/players/register */
export async function registerPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = registerSchema.parse(req.body);
    const sanitizedPosition = sanitizeInput(parsed.position);
    const sanitizedRegion = sanitizeInput(parsed.region);
    const metadataUri = 'metadataUri' in parsed
      ? parsed.metadataUri
      : await pinJson({
          wallet: parsed.wallet,
          position: sanitizedPosition,
          region: sanitizedRegion,
          ...parsed.metadata,
        });

    // Invalidate player search cache so new profile appears in results
    invalidatePlayerCache();
    await dispatchEventWebhook('player_registered', {
      wallet: parsed.wallet,
      position: sanitizedPosition,
      region: sanitizedRegion,
      metadataUri,
    });

    const body: ApiResponse<{ metadataUri: string; gatewayUrl: string }> = {
      success: true,
      data: { metadataUri, gatewayUrl: gatewayUrl(metadataUri) },
    };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/players/:playerId */
export async function getPlayer(req: Request, res: Response, next: NextFunction) {
  try {
    const playerId = sanitizeInput(req.params.playerId);
    const events = getEvents('player_registered').filter(
      (e) => e.payload.player_id === playerId
    );
    if (!events.length) {
      res.status(404).json({ success: false, error: 'Player not found' });
      return;
    }
    const payload = events[0].payload;
    const level = Number(payload.progress_level ?? 0);
    const { tierName, tierDescription } = getTierMeta(level);
    // updated_at is the timestamp of the most recent event for this player;
    // fall back to created_at (or now) when no explicit update timestamp exists.
    const updatedAt =
      typeof payload.updated_at === 'number'
        ? payload.updated_at
        : typeof payload.created_at === 'number'
        ? payload.created_at
        : Math.floor(Date.now() / 1000);
    res.json({ success: true, data: { ...payload, updated_at: updatedAt, tierName, tierDescription } });
  } catch (err) {
    next(err);
  }
}

/** GET /api/players?region=&position=&minTier= */
export async function filterPlayers(req: Request, res: Response, next: NextFunction) {
  try {
    const tierResult = validateMinTier(req.query.minTier);
    if (!tierResult.valid) {
      res.status(400).json({ success: false, error: tierResult.error });
      return;
    }
    const { region, position, page, pageSize } = filterSchema.parse(req.query);
    const sanitizedRegion = region ? sanitizeInput(region) : undefined;
    const sanitizedPosition = position ? sanitizeInput(position) : undefined;
    // Normalize position synonyms/aliases (e.g. "fw" -> "forward") if available.
    // If normalization yields undefined (unknown synonym), fallback to sanitizedPosition
    // to preserve stable API behavior.
    const normalizedPosition = sanitizedPosition ? normalizePosition(sanitizedPosition) : undefined;

    let players = getEvents('player_registered').map((e) => e.payload);
    if (sanitizedRegion) players = players.filter((p) => p.region === sanitizedRegion);
    if (normalizedPosition || sanitizedPosition) {
      const match = normalizedPosition ?? sanitizedPosition;
      players = players.filter((p) => p.position === match);
    }
    if (minTier !== undefined)
      players = players.filter((p) => Number(p.progress_level) >= minTier);
    const total = players.length;
    const pages = Math.ceil(total / pageSize);
    const paginated = players.slice((page - 1) * pageSize, page * pageSize);
    res.json({ success: true, data: paginated, total, page, pageSize, pages });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/players/:playerId
 * Required permissions: caller must be the profile owner (JWT sub === playerId).
 * Stub — returns 202 Accepted until on-chain update is wired.
 */
export const updatePlayerSchema = z.object({
  position: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function updatePlayer(req: Request, res: Response, next: NextFunction) {
  try {
    updatePlayerSchema.parse(req.body);
    const updatedAt = Math.floor(Date.now() / 1000);
    res.status(202).json({ success: true, message: 'Profile update accepted', updated_at: updatedAt });
  } catch (err) {
    next(err);
  }
}

/** GET /api/players/:playerId/milestones */
export async function getPlayerMilestones(req: Request, res: Response, next: NextFunction) {
  try {
    const milestones = getEvents('milestone_approved').filter(
      (e) => e.payload.player_id === req.params.playerId
    );
    res.json({ success: true, data: milestones });
  } catch (err) {
    next(err);
  }
}
