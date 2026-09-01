#!/usr/bin/env node
/**
 * generate-openapi-json.js
 *
 * THE canonical OpenAPI generator. Produces src/openapi.yaml AND
 * src/openapi.json directly from the route source files
 * (src/routes/*.ts, src/routes/v2/*.ts) — specifically:
 *
 *   - path + method + path params: parsed from each `router.route(path)` /
 *     `router.<verb>(path, ...)` registration (scripts/lib/docgen/parseRoutes.js)
 *   - auth requirement: derived from the real middleware chain
 *     (requireRole/optionalAuth/requireApiKeyScope/...), never from a
 *     comment (scripts/lib/docgen/security.js) — this is what makes a
 *     JSDoc auth note structurally unable to drift from the actual
 *     requirement the way a hand-written OpenAPI spec could
 *   - request body / query schema: derived from the Zod schema passed to
 *     validateBody()/validateQuery(), resolved via static analysis across
 *     files (scripts/lib/docgen/zodSchema.js, tsProject.js) — never
 *     hand-typed, so it cannot drift from what the server actually accepts
 *   - summary/description/response shapes: parsed from the route's leading
 *     JSDoc comment (scripts/lib/docgen/jsdocTags.js) — this is the one
 *     part of an operation that must still be human-authored (no runtime
 *     signal captures "what does a 409 mean here"), which is exactly why
 *     scripts/check-route-docs.js exists: it fails CI when a route has no
 *     such comment at all.
 *
 * Everything NOT specific to one route (security schemes, common
 * parameters, reusable envelope schemas, info/servers/tags) lives in the
 * one hand-maintained file, src/openapi.components.yaml — see the comment
 * at the top of that file for why that's safe to hand-maintain while the
 * per-route content below is not.
 *
 * Usage:
 *   node scripts/generate-openapi-json.js
 *
 * Wired into `npm run build:openapi`. Run this whenever a route file
 * changes; scripts/validate-openapi.js (run in CI) fails the build if the
 * committed spec is out of sync with what this script would produce.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseRouteFile } = require('./lib/docgen/parseRoutes');

let yaml;
try {
  yaml = require('js-yaml');
} catch {
  console.error('js-yaml is not installed. Run: npm install --save-dev js-yaml');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const COMPONENTS_PATH = path.join(ROOT, 'src', 'openapi.components.yaml');
const YAML_PATH = path.join(ROOT, 'src', 'openapi.yaml');
const JSON_PATH = path.join(ROOT, 'src', 'openapi.json');

/**
 * The mount-point manifest. This mirrors the `app.use(prefix, router)`
 * calls in src/app.ts. It is the one place route→mount-path knowledge is
 * hand-maintained — adding a new *resource* (a new router file) is a rare,
 * deliberate architectural change, unlike adding an *endpoint* to an
 * existing router, which is the drift this generator exists to prevent.
 * scripts/check-route-docs.js cross-checks this list against src/app.ts so
 * a forgotten entry here fails CI instead of silently producing an
 * incomplete spec.
 */
const ROUTE_FILES = [
  { file: 'src/routes/auth.ts', mount: '/auth', tag: 'auth' },
  { file: 'src/routes/player.ts', mount: '/players', tag: 'players' },
  { file: 'src/routes/scout.ts', mount: '/scouts', tag: 'scouts' },
  { file: 'src/routes/validator.ts', mount: '/validators', tag: 'validators' },
  { file: 'src/routes/admin.ts', mount: '/admin', tag: 'admin' },
  { file: 'src/routes/events.ts', mount: '/events', tag: 'events' },
  { file: 'src/routes/docs.ts', mount: '/docs', tag: 'docs' },
  // v2 mounts player/scout/validator/admin/events routers unchanged (see
  // src/routes/v2/index.ts) — those are already covered by the entries
  // above via the shared `servers` list. Only genuinely v2-only routers
  // need a separate entry, with v2Only so they don't imply availability on
  // /api or /api/v1.
  { file: 'src/routes/v2/versioning.ts', mount: '/versioning', tag: 'v2', v2Only: true },
];

function toOpenApiPath(mount, subPath) {
  const raw = `${mount}${subPath === '/' ? '' : subPath}` || '/';
  return raw.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function pathParamNames(openApiPath) {
  const names = [];
  const re = /\{([A-Za-z0-9_]+)\}/g;
  let m;
  while ((m = re.exec(openApiPath))) names.push(m[1]);
  return names;
}

function guessOperationId(route, openApiPath) {
  if (route.handlerName) return route.handlerName;
  const slug = openApiPath
    .replace(/[{}]/g, '')
    .split('/')
    .filter(Boolean)
    .map((seg, i) => (i === 0 ? seg : seg[0].toUpperCase() + seg.slice(1)))
    .join('');
  return `${route.method.toLowerCase()}${slug[0] ? slug[0].toUpperCase() + slug.slice(1) : ''}`;
}

function buildParameters(route, openApiPath) {
  const params = [];
  const docParamByName = new Map(route.doc.params.map((p) => [p.name, p]));
  const docQueryByName = new Map(route.doc.query.map((q) => [q.name, q]));
  const docHeaderByName = new Map(route.doc.headers.map((h) => [h.name, h]));

  for (const name of pathParamNames(openApiPath)) {
    const docParam = docParamByName.get(name);
    params.push({
      name,
      in: 'path',
      required: true,
      schema: { type: docParam ? zodLikeType(docParam.type) : 'string' },
      description: docParam ? docParam.description : undefined,
    });
  }

  // Query params: prefer the mechanically-derived Zod schema (authoritative
  // — matches what validateQuery() actually accepts). Fall back to @query
  // JSDoc tags for routes that read req.query without a Zod schema.
  if (route.queryParams.length > 0) {
    for (const q of route.queryParams) {
      const docQuery = docQueryByName.get(q.name);
      params.push({
        name: q.name,
        in: 'query',
        required: q.required,
        schema: q.schema,
        description: docQuery ? docQuery.description : q.schema.description,
      });
    }
  } else {
    for (const q of route.doc.query) {
      params.push({
        name: q.name,
        in: 'query',
        required: false,
        schema: { type: zodLikeType(q.type) },
        description: q.description,
      });
    }
  }

  for (const h of route.doc.headers) {
    params.push({
      name: h.name,
      in: 'header',
      required: false,
      schema: { type: zodLikeType(h.type) },
      description: h.description,
    });
  }

  return params;
}

function zodLikeType(typeText) {
  const t = (typeText || 'string').toLowerCase();
  if (t.includes('int')) return 'integer';
  if (t.includes('number')) return 'number';
  if (t.includes('bool')) return 'boolean';
  return 'string';
}

function buildRequestBody(route) {
  if (!route.requestBody) return undefined;
  const schema = route.requestBody.schema;
  return {
    required: true,
    description: route.doc.body || undefined,
    content: {
      'application/json': { schema },
    },
  };
}

function buildResponses(route) {
  const responses = {};
  for (const r of route.doc.responses) {
    responses[r.status] = { description: r.description || 'No description provided.' };
  }
  if (Object.keys(responses).length === 0) {
    // Guarded against by scripts/check-route-docs.js in CI, but the spec
    // must stay structurally valid (OpenAPI requires >=1 response) even if
    // that check is bypassed locally.
    responses['200'] = { description: 'Successful response (undocumented — see source).' };
  }
  return responses;
}

function buildOperation(route, openApiPath) {
  const op = {
    tags: [route.doc.tagOverride].filter(Boolean),
    summary: route.doc.summary || `${route.method} ${openApiPath}`,
    operationId: guessOperationId(route, openApiPath),
  };

  if (route.doc.description) op.description = route.doc.description;
  if (route.doc.deprecated) {
    op.deprecated = true;
    op.description = [op.description, route.doc.deprecated].filter(Boolean).join('\n\n');
  }

  const parameters = buildParameters(route, openApiPath);
  if (parameters.length) op.parameters = parameters;

  const requestBody = buildRequestBody(route);
  if (requestBody) op.requestBody = requestBody;

  op.responses = buildResponses(route);
  op.security = route.security;

  for (const [key, value] of Object.entries(route.extensions || {})) {
    op[key] = value;
  }

  return op;
}

function generateSpec() {
  const raw = fs.readFileSync(COMPONENTS_PATH, 'utf8');
  const spec = yaml.load(raw);
  spec.paths = {};

  for (const entry of ROUTE_FILES) {
    if (!entry.tag) continue;
    if (!spec.tags.some((t) => t.name === entry.tag)) {
      spec.tags.push({ name: entry.tag, description: entry.tag });
    }

    const absPath = path.join(ROOT, entry.file);
    const routes = parseRouteFile(absPath);

    for (const route of routes) {
      const openApiPath = toOpenApiPath(entry.mount, route.subPath);
      if (!route.doc.tagOverride) route.doc.tagOverride = entry.tag;

      if (!spec.paths[openApiPath]) spec.paths[openApiPath] = {};
      if (entry.v2Only) {
        spec.paths[openApiPath].servers = [
          { url: '/api/v2', description: 'API v2 only — not available on /api or /api/v1' },
        ];
      }

      spec.paths[openApiPath][route.method.toLowerCase()] = buildOperation(route, openApiPath);
    }
  }

  // Stable key order: sort paths, and within each path sort HTTP methods in
  // a conventional order, so regenerating with no source changes produces a
  // byte-identical file (required for validate-openapi.js's drift check).
  const methodOrder = ['get', 'post', 'put', 'patch', 'delete'];
  const sortedPaths = {};
  for (const key of Object.keys(spec.paths).sort()) {
    const pathItem = spec.paths[key];
    const sortedItem = {};
    if (pathItem.servers) sortedItem.servers = pathItem.servers;
    for (const method of methodOrder) {
      if (pathItem[method]) sortedItem[method] = pathItem[method];
    }
    sortedPaths[key] = sortedItem;
  }
  spec.paths = sortedPaths;

  return spec;
}

function main() {
  const spec = generateSpec();

  const yamlOut = yaml.dump(spec, { lineWidth: 100, noRefs: true, sortKeys: false });
  fs.writeFileSync(YAML_PATH, `${yamlOut.trimEnd()}\n`, 'utf8');
  fs.writeFileSync(JSON_PATH, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

  const pathCount = Object.keys(spec.paths).length;
  const opCount = Object.values(spec.paths).reduce(
    (n, item) => n + Object.keys(item).filter((k) => k !== 'servers').length,
    0,
  );
  console.log(
    `[generate-openapi] Wrote ${YAML_PATH} and ${JSON_PATH} — ${pathCount} paths, ${opCount} operations`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { generateSpec, ROUTE_FILES };
