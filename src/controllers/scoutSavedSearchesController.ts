/**
 * Scout Saved-Search Controller (#486)
 *
 * Allows scouts to persist named filter presets so they can re-run frequent
 * region/position/tier queries without re-entering them on every visit.
 *
 * Filter payloads are validated against the same Zod schema used by the live
 * player-filter endpoint (region, position, minTier — pagination fields are
 * excluded because they are not meaningful for a stored preset).
 *
 * Ownership is enforced inline via assertWalletOwnership(), consistent with
 * the bookmarks and notes controllers.
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  insertSavedSearch,
  getSavedSearchesByScout,
  deleteSavedSearch,
} from '../db';
import { isValidStellarAddress } from '../utils/stellarAddress';
import { sendForbidden } from '../utils/authError';
import { logger } from '../utils/logger';

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Schema for the filter payload of a saved search.
 * Deliberately omits pagination fields (page, pageSize, sortBy, sortOrder)
 * because those are not meaningful as a persistent preset.  They mirror the
 * filter fields from playerController's filterSchema.
 */
export const savedSearchFilterSchema = z.object({
  region:   z.string().optional(),
  position: z.string().optional(),
  minTier:  z.number().int().min(0).max(3).optional(),
});

export type SavedSearchFilters = z.infer<typeof savedSearchFilterSchema>;

/**
 * Schema for the POST body: name + optional filter fields.
 */
export const createSavedSearchSchema = z.object({
  name: z
    .string()
    .min(1, 'name is required')
    .max(100, 'name must be 100 characters or fewer'),
  filters: savedSearchFilterSchema,
});

export type CreateSavedSearchRequest = z.infer<typeof createSavedSearchSchema>;

// ─── Ownership guard ──────────────────────────────────────────────────────────

function assertWalletOwnership(req: Request, res: Response): boolean {
  const { wallet } = req.params;
  if (!isValidStellarAddress(wallet)) {
    res.status(400).json({ success: false, error: 'Invalid Stellar address' });
    return false;
  }
  if (req.account !== wallet) {
    sendForbidden(res, 'Forbidden: wallet mismatch');
    return false;
  }
  return true;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/saved-searches
 *
 * Create a new named saved search for the authenticated scout.
 * The filter payload is validated against savedSearchFilterSchema so it can
 * always be safely passed to the player-filter query builder.
 *
 * @body { name: string, filters: { region?, position?, minTier? } }
 * @response 201 { success: true, data: { id, scout_wallet, name, filters, created_at } }
 * @response 400 Invalid request body
 * @response 403 Wallet mismatch or not the scout role
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function createSavedSearch(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!assertWalletOwnership(req, res)) return;

    const parsed = createSavedSearchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? 'Invalid request body',
      });
      return;
    }

    const { name, filters } = parsed.data;
    const now = Math.floor(Date.now() / 1000);
    const filtersJson = JSON.stringify(filters);

    const id = insertSavedSearch({
      scout_wallet: req.params.wallet,
      name,
      filters: filtersJson,
      created_at: now,
    });

    logger.info({ scout: req.params.wallet, id, name, action: 'saved_search_created' });

    res.status(201).json({
      success: true,
      data: {
        id,
        scout_wallet: req.params.wallet,
        name,
        filters,
        created_at: now,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/scouts/:wallet/saved-searches
 *
 * List all saved searches for the authenticated scout, newest-first.
 * Filters are returned as parsed objects (not raw JSON strings) for
 * convenient client consumption.
 *
 * @response 200 { success: true, data: Array<{ id, scout_wallet, name, filters, created_at }> }
 * @response 403 Wallet mismatch or not the scout role
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function listSavedSearches(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!assertWalletOwnership(req, res)) return;

    const rows = getSavedSearchesByScout(req.params.wallet);

    const data = rows.map((row) => ({
      id:           row.id,
      scout_wallet: row.scout_wallet,
      name:         row.name,
      filters:      JSON.parse(row.filters) as SavedSearchFilters,
      created_at:   row.created_at,
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/scouts/:wallet/saved-searches/:id
 *
 * Delete a saved search by its row id.
 * Returns 404 when no matching saved search is found for this scout.
 * A scout cannot delete another scout's saved searches — the DB helper
 * scopes the DELETE to the scout's own wallet.
 *
 * @param id  {number} - Row id of the saved search to delete
 * @response 200 { success: true, data: { removed: true, id } }
 * @response 403 Wallet mismatch or not the scout role
 * @response 404 Saved search not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function deleteSavedSearchHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!assertWalletOwnership(req, res)) return;

    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid saved search id' });
      return;
    }

    const removed = deleteSavedSearch(id, req.params.wallet);
    if (!removed) {
      res.status(404).json({ success: false, error: 'Saved search not found' });
      return;
    }

    logger.info({ scout: req.params.wallet, id, action: 'saved_search_deleted' });

    res.json({ success: true, data: { removed: true, id } });
  } catch (err) {
    next(err);
  }
}
