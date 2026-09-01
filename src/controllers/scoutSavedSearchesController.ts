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
 * Ownership of the :wallet path parameter is enforced by the shared
 * requireWalletOwner() middleware at the route level (see src/routes/scout.ts).
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  insertSavedSearch,
  getSavedSearchesByScout,
  deleteSavedSearch,
  getSavedSearchById,
  updateSavedSearch,
  countSavedSearchesByScout,
  queryPlayers,
  countPlayers,
  type SavedSearchRow,
} from '../db';
import { logger } from '../utils/logger';
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../utils/pagination';

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
}).strict();

export type CreateSavedSearchRequest = z.infer<typeof createSavedSearchSchema>;

/**
 * Schema for the PUT body: optional name and/or filters.
 */
export const updateSavedSearchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  filters: savedSearchFilterSchema.optional(),
}).strict();

export type UpdateSavedSearchRequest = z.infer<typeof updateSavedSearchSchema>;

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
  const parsed = createSavedSearchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid request body',
    });
    return;
  }

  const { name, filters } = parsed.data;
  const wallet = req.params.wallet as string;

  // Enforce 20 saved searches limit
  const currentCount = await countSavedSearchesByScout(wallet);
  if (currentCount >= 20) {
    res.status(422).json({
      success: false,
      error: 'Maximum of 20 saved searches per scout',
    });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const filtersJson = JSON.stringify(filters);

  const id = await insertSavedSearch({
    scout_wallet: wallet,
    name,
    filters: filtersJson,
    created_at: now,
  });

  logger.info({ scout: wallet, id, name, action: 'saved_search_created' });

  res.status(201).json({
    success: true,
    data: {
      id,
      scout_wallet: wallet,
      name,
      filters,
      created_at: now,
    },
  });
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
  const rows = await getSavedSearchesByScout(req.params.wallet as string);

  const data = rows.map((row) => ({
    id:           row.id,
    scout_wallet: row.scout_wallet,
    name:         row.name,
    filters:      JSON.parse(row.filters) as SavedSearchFilters,
    created_at:   row.created_at,
  }));

  res.json({ success: true, data });
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
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid saved search id' });
    return;
  }

  const removed = await deleteSavedSearch(id, req.params.wallet as string);
  if (!removed) {
    res.status(404).json({ success: false, error: 'Saved search not found' });
    return;
  }

  logger.info({ scout: req.params.wallet as string, id, action: 'saved_search_deleted' });

  res.json({ success: true, data: { removed: true, id } });
}

/**
 * PUT /api/scouts/:wallet/saved-searches/:id
 *
 * Update a saved search's name and/or filters.
 * Returns 404 when no matching saved search is found for this scout.
 *
 * @param id  {number} - Row id of the saved search to update
 * @body { name?: string, filters?: { region?, position?, minTier? } }
 * @response 200 { success: true, data: { id, scout_wallet, name, filters, created_at } }
 * @response 400 Invalid request body
 * @response 403 Wallet mismatch or not the scout role
 * @response 404 Saved search not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function updateSavedSearchHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid saved search id' });
    return;
  }

  const parsed = updateSavedSearchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid request body',
    });
    return;
  }

  const { name, filters } = parsed.data;
  const wallet = req.params.wallet as string;

  // Build updates object
  const updates: { name?: string; filters?: string } = {};
  if (name !== undefined) {
    updates.name = name;
  }
  if (filters !== undefined) {
    updates.filters = JSON.stringify(filters);
  }

  const updated = await updateSavedSearch(id, wallet, updates);
  if (!updated) {
    res.status(404).json({ success: false, error: 'Saved search not found' });
    return;
  }

  // Fetch the updated row to return
  const row = await getSavedSearchById(id, wallet);
  if (!row) {
    res.status(404).json({ success: false, error: 'Saved search not found' });
    return;
  }

  logger.info({ scout: wallet, id, action: 'saved_search_updated' });

  res.json({
    success: true,
    data: {
      id: row.id,
      scout_wallet: row.scout_wallet,
      name: row.name,
      filters: JSON.parse(row.filters) as SavedSearchFilters,
      created_at: row.created_at,
    },
  });
}

/**
 * GET /api/scouts/:wallet/saved-searches/:id/run
 *
 * Execute a saved search and return matching players (paginated).
 * Returns 404 when the saved search does not exist for this scout.
 *
 * @param id  {number} - Row id of the saved search to run
 * @query page {number} - Page number (default 1)
 * @query pageSize {number} - Page size (default 20, max 100)
 * @response 200 { success: true, data: { players: PlayerRow[], total: number, page: number, pageSize: number } }
 * @response 403 Wallet mismatch or not the scout role
 * @response 404 Saved search not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function runSavedSearch(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid saved search id' });
    return;
  }

  const wallet = req.params.wallet as string;
  const row = await getSavedSearchById(id, wallet);
  if (!row) {
    res.status(404).json({ success: false, error: 'Saved search not found' });
    return;
  }

  // Parse filters from saved search
  const filters = JSON.parse(row.filters) as SavedSearchFilters;

  // Parse pagination params
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize as string, 10) || DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * pageSize;

  // Query players with the saved filters
  const players = await queryPlayers({
    region: filters.region,
    position: filters.position,
    minTier: filters.minTier,
    limit: pageSize,
    offset,
  });

  // Get total count for pagination
  const total = await countPlayers({
    region: filters.region,
    position: filters.position,
    minTier: filters.minTier,
  });

  res.json({
    success: true,
    data: {
      players,
      total,
      page,
      pageSize,
    },
  });
}
