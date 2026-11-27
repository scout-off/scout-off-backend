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
import config from '../config';
import { requireRole } from './auth';

export function guardApiDocs(req: Request, res: Response, next: NextFunction): void {
  const { mode } = config.apiDocs;

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
 * Returns true when the given OpenAPI path belongs to the admin surface,
 * i.e. it is exactly `/admin` or starts with `/admin/`.
 * Paths such as `/administrators` are NOT considered admin paths.
 */
export function isAdminPath(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/');
}

/**
 * Optional middleware to filter the OpenAPI spec and remove /admin/* paths
 * when serving publicly. Applied before the spec is returned.
 *
 * This is only relevant when API_DOCS_MODE=public and API_DOCS_HIDE_ADMIN=true.
 * Without this, public-mode deployments expose admin endpoint shapes and parameters.
 */
export function filterAdminPathsFromSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const { mode, hideAdminPaths } = config.apiDocs;

  if (mode !== 'public' || !hideAdminPaths) {
    return spec;
  }

  // Deep clone to avoid mutating the cached spec
  const filtered = JSON.parse(JSON.stringify(spec));

  // Remove /admin and /admin/* paths only. A bare startsWith('/admin') would
  // also match unrelated prefixes such as /administrators.
  const paths = filtered.paths as Record<string, unknown>;
  if (paths) {
    for (const path of Object.keys(paths)) {
      if (isAdminPath(path)) {
        delete paths[path];
      }
    }
  }

  // Collect reachable $refs from remaining paths
  const reachable = new Set<string>();
  function walk(obj: unknown) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') {
        reachable.add(v);
      } else {
        walk(v);
      }
    }
  }
  walk(filtered.paths);
  // expand refs recursively through components
  const components = filtered.components as Record<string, Record<string, unknown>> | undefined;
  if (components) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const type of Object.keys(components)) {
        if (type === 'securitySchemes') continue;
        const bucket = components[type] as Record<string, unknown>;
        for (const name of Object.keys(bucket)) {
          const ref = `#/components/${type}/${name}`;
          if (reachable.has(ref)) {
            // walk its contents to add nested refs
            const before = reachable.size;
            walk(bucket[name]);
            if (reachable.size > before) changed = true;
          }
        }
      }
    }
    for (const type of Object.keys(components)) {
      if (type === 'securitySchemes') continue;
      const bucket = components[type] as Record<string, unknown>;
      for (const name of Object.keys(bucket)) {
        const ref = `#/components/${type}/${name}`;
        if (!reachable.has(ref)) delete bucket[name];
      }
    }
  }

  // Filter tags with no operations
  const usedTags = new Set<string>();
  if (paths) {
    for (const p of Object.values(paths)) {
      if (p && typeof p === 'object') {
        for (const op of Object.values(p as Record<string, unknown>)) {
          if (op && typeof op === 'object' && Array.isArray((op as any).tags)) {
            (op as any).tags.forEach((t: string) => usedTags.add(t));
          }
        }
      }
    }
  }
  if (Array.isArray(filtered.tags)) {
    filtered.tags = (filtered.tags as any[]).filter((t: any) => usedTags.has(t.name));
  }

  return filtered;
}
