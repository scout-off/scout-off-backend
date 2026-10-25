/**
 * Guard middleware for API documentation endpoints.
 * Routes are mounted conditionally or wrapped with this middleware based on API_DOCS_MODE.
 *
 * Modes:
 *   - public: Allow unrestricted access
 *   - admin: Require admin role
 *   - disabled: Return 404
 */

import { Request, Response, NextFunction } from 'express';
import { apiDocsConfig } from '../config.apiDocs';
import { requireRole } from './auth';

export function guardApiDocs(req: Request, res: Response, next: NextFunction): void {
  const { mode } = apiDocsConfig;

  if (mode === 'disabled') {
    res.status(404).json({ success: false, error: 'Not found' });
    return;
  }

  if (mode === 'admin') {
    // Require admin role — delegate to requireRole middleware
    Promise.resolve(requireRole('admin')(req, res, next)).catch(next);
    return;
  }

  // mode === 'public'
  next();
}

/**
 * Optional middleware to filter the OpenAPI spec and remove /admin/* paths
 * when serving publicly. Applied before the spec is returned.
 *
 * This is only relevant when API_DOCS_MODE=public and API_DOCS_HIDE_ADMIN=true.
 * Without this, public-mode deployments expose admin endpoint shapes and parameters.
 */
export function filterAdminPathsFromSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const { mode, hideAdminPaths } = apiDocsConfig;

  if (mode !== 'public' || !hideAdminPaths) {
    return spec;
  }

  // Deep clone to avoid mutating the cached spec
  const filtered = JSON.parse(JSON.stringify(spec));

  // Remove /admin/* paths
  const paths = filtered.paths as Record<string, unknown>;
  if (paths) {
    for (const path of Object.keys(paths)) {
      if (path.startsWith('/admin')) {
        delete paths[path];
      }
    }
  }

  // Remove admin-only components (TODO: parse component names from tags or x-admin marker)
  // For now, this is a placeholder; implementation depends on your component naming convention

  return filtered;
}
