/**
 * Feature Flags Controller (#805)
 *
 * Admin endpoints for listing and toggling runtime feature flags.
 * Changes take effect immediately — the in-process cache is invalidated
 * on every toggle so the next request through requireFeatureFlag sees the
 * updated value without a service restart.
 *
 * Audit trail: every toggle writes a feature_flag_toggled entry with
 * { flag_name, old_value, new_value, admin_wallet } via logAuditEvent().
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getAllFeatureFlags, getFeatureFlag } from '../db';
import { setFeatureFlag, clearFeatureFlagCache } from '../services/featureFlags';

// ─── Validation ───────────────────────────────────────────────────────────────

/** Valid snake_case flag name: lowercase letter, then lowercase letters/digits/underscores. */
const flagNameRegex = /^[a-z][a-z0-9_]*$/;

export const updateFeatureFlagBodySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(flagNameRegex, 'Flag name must be snake_case starting with a letter'),
  enabled: z.boolean(),
}).strict();

export const toggleFlagBodySchema = z.object({
  enabled: z.boolean({ required_error: 'enabled is required' }),
}).strict();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function serializeFlag(row: { name: string; enabled: number; updated_at: number; updated_by: string }) {
  return {
    name: row.name,
    enabled: row.enabled === 1,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/feature-flags
 *
 * Returns all runtime feature flags with name, enabled state, and last-updated metadata.
 * Clears the in-process cache before reading so the response always reflects DB state.
 *
 * @response 200 { success: true, data: FeatureFlag[] }
 * @auth Bearer (admin role required)
 */
export async function getFeatureFlags(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Force re-read from DB by clearing cache first
  clearFeatureFlagCache();
  const rows = await getAllFeatureFlags();
  const flags = rows.map(serializeFlag);
  res.json({ success: true, data: flags });
}

/**
 * PUT /api/admin/feature-flags
 *
 * Toggle a feature flag by providing both name and enabled in the body.
 * Updates the DB, invalidates the in-process cache, and writes an audit entry.
 *
 * @body { name: string, enabled: boolean }
 * @response 200 { success: true, data: { name, enabled, updated_by } }
 * @response 400 Invalid name format or missing fields
 * @auth Bearer (admin role required)
 */
export async function updateFeatureFlag(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const parsed = updateFeatureFlagBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid request body',
    });
    return;
  }

  const { name, enabled } = parsed.data;
  const updatedBy = req.account ?? 'unknown';

  await setFeatureFlag(name, enabled, updatedBy);

  res.json({
    success: true,
    data: { name, enabled, updated_by: updatedBy },
  });
}

/**
 * PUT /api/admin/feature-flags/:name
 *
 * Toggle a specific feature flag identified by its name in the URL.
 * Body only needs { enabled: boolean }. Returns 404 when the flag does not
 * exist in the DB yet (flags must be seeded via migration before they can be toggled).
 * Updates the DB, invalidates the in-process cache, and writes an audit entry.
 *
 * @param name  {string} - snake_case flag name
 * @body { enabled: boolean }
 * @response 200 { success: true, data: { name, enabled, updated_by, updated_at } }
 * @response 400 Invalid flag name format or missing/invalid body
 * @response 404 Flag not found in DB
 * @auth Bearer (admin role required)
 */
export async function toggleFeatureFlag(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const {name} = req.params as {name: string};

  if (!flagNameRegex.test(name)) {
    res.status(400).json({
      success: false,
      error: 'Flag name must be snake_case starting with a letter',
    });
    return;
  }

  const parsed = toggleFlagBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid request body',
    });
    return;
  }

  const { enabled } = parsed.data;

  // Verify the flag exists in the DB before toggling
  const existing = await getFeatureFlag(name);
  if (!existing) {
    res.status(404).json({
      success: false,
      error: `Feature flag '${name}' not found`,
    });
    return;
  }

  const updatedBy = req.account ?? 'unknown';
  await setFeatureFlag(name, enabled, updatedBy);

  res.json({
    success: true,
    data: {
      name,
      enabled,
      updated_by: updatedBy,
      updated_at: Date.now(),
    },
  });
}
