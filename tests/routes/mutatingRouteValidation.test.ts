/**
 * Meta-test (#1145): every POST/PUT/PATCH route must include validateBody
 * (or validateJsonBodyOrPassThrough) tagged with `__validateBody`.
 *
 * Walks `app._router.stack` recursively (same approach as
 * tests/scripts/apiVersionParity.test.ts) and fails if any mutating route
 * lacks body validation middleware.
 *
 * Inventory: see docs/mutating-route-validation.md
 */
import app from '../../src/app';

const MUTATING = new Set(['post', 'put', 'patch']);

/** Non-REST mounts that handle their own body parsing (e.g. GraphQL Yoga). */
function isExemptPath(fullPath: string): boolean {
  return fullPath === '/graphql' || fullPath.startsWith('/graphql/');
}

type Layer = {
  name?: string;
  path?: string | unknown;
  regexp?: RegExp & { fast_slash?: boolean };
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: Array<{ handle?: { __validateBody?: boolean; name?: string } }>;
  };
  handle?: { stack?: Layer[] };
};

function splitPath(thing: string | RegExp | undefined): string[] {
  if (!thing) return [];
  if (typeof thing === 'string') {
    return thing.split('/').filter(Boolean);
  }
  if ((thing as RegExp & { fast_slash?: boolean }).fast_slash) {
    return [];
  }
  const match = thing
    .toString()
    .replace('\\/?', '')
    .replace('(?=\\/|$)', '$')
    .match(/^\/\^((?:\\[.*+?^${}()|[\]\\\/]|[^.*+?^${}()|[\]\\\/])*)\$\//);
  if (!match) return [];
  return match[1].replace(/\\(.)/g, '$1').split('/').filter(Boolean);
}

function joinPath(parts: string[]): string {
  return '/' + parts.filter(Boolean).join('/');
}

/** Normalize /api and /api/v1|/api/v2 to a relative path for dedupe. */
function relativeMutatingKey(method: string, fullPath: string): string {
  let path = fullPath;
  if (path.startsWith('/api/v2')) path = path.slice('/api/v2'.length) || '/';
  else if (path.startsWith('/api/v1')) path = path.slice('/api/v1'.length) || '/';
  else if (path.startsWith('/api')) path = path.slice('/api'.length) || '/';
  return `${method.toUpperCase()} ${path}`;
}

function hasValidateBody(route: NonNullable<Layer['route']>): boolean {
  return route.stack.some((layer) => {
    const handle = layer.handle;
    if (!handle) return false;
    return handle.__validateBody === true || handle.name === 'validateBody';
  });
}

function collectMissing(stack: Layer[] | undefined, prefix: string[], missing: string[]): void {
  if (!stack) return;
  for (const layer of stack) {
    if (layer.route) {
      const routePaths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const routePath of routePaths) {
        const full = joinPath([...prefix, ...splitPath(routePath)]);
        if (isExemptPath(full)) continue;
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (!enabled || !MUTATING.has(method)) continue;
          if (!hasValidateBody(layer.route)) {
            missing.push(`${method.toUpperCase()} ${full}`);
          }
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const mountParts =
        typeof layer.path === 'string'
          ? splitPath(layer.path)
          : splitPath(layer.regexp);
      collectMissing(layer.handle.stack, [...prefix, ...mountParts], missing);
    }
  }
}

describe('mutating route body validation (#1145)', () => {
  it('requires validateBody (or tagged pass-through) on every POST/PUT/PATCH', () => {
    const stack: Layer[] =
      (app as { _router?: { stack?: Layer[] }; router?: { stack?: Layer[] } })._router?.stack ??
      (app as { router?: { stack?: Layer[] } }).router?.stack ??
      [];

    const missingRaw: string[] = [];
    collectMissing(stack, [], missingRaw);

    // Dedupe /api vs /api/v1 vs /api/v2 — assert each unique relative path once.
    const seen = new Set<string>();
    const missing: string[] = [];
    for (const entry of missingRaw) {
      const [method, ...pathParts] = entry.split(' ');
      const key = relativeMutatingKey(method, pathParts.join(' '));
      if (seen.has(key)) continue;
      seen.add(key);
      missing.push(entry);
    }

    expect(missing).toEqual([]);
  });
});
