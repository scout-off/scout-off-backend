#!/usr/bin/env node
/**
 * check-route-docs.js
 *
 * CI gate for issue #1047: fails the build if a route exists in the
 * codebase with no corresponding canonical-source documentation. This is
 * what makes the "one source of truth" claim durable rather than a
 * one-time cleanup — the next engineer who adds an endpoint and forgets to
 * document it fails CI immediately, on that PR, instead of silently
 * reintroducing the three-way drift this issue was filed to fix.
 *
 * A route counts as documented when scripts/lib/docgen/parseRoutes.js finds
 * a leading JSDoc comment that yields:
 *   - a summary (explicit @summary, or a derivable first sentence), AND
 *   - at least one @response tag
 *
 * (Auth requirements and request/query schemas are exempt from this check
 * because they are mechanically derived from the route's real middleware
 * and Zod schemas — see scripts/lib/docgen/security.js and zodSchema.js —
 * so they cannot be "undocumented": either they're correct because they're
 * generated from the code, or the code itself is wrong, which is a bug,
 * not a docs gap.)
 *
 * Also cross-checks scripts/generate-openapi-json.js's ROUTE_FILES manifest
 * against the routers actually mounted in src/app.ts, so a new resource
 * router that nobody wired into the generator fails CI too.
 *
 * Usage (CI):
 *   node scripts/check-route-docs.js
 * Exit 0 = every route documented, Exit 1 = gaps found (listed on stderr).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseRouteFile } = require('./lib/docgen/parseRoutes');
const { ROUTE_FILES } = require('./generate-openapi-json');

const ROOT = path.join(__dirname, '..');

function checkRouteDocs() {
  const gaps = [];

  for (const entry of ROUTE_FILES) {
    const absPath = path.join(ROOT, entry.file);
    const routes = parseRouteFile(absPath);

    for (const route of routes) {
      const missing = [];
      if (!route.doc.summary) missing.push('summary');
      if (route.doc.responses.length === 0) missing.push('@response');

      if (missing.length > 0) {
        gaps.push({
          file: entry.file,
          method: route.method,
          path: route.subPath,
          missing,
        });
      }
    }
  }

  return gaps;
}

/**
 * Cross-check that every resource router mounted in src/app.ts has an entry
 * in ROUTE_FILES (scripts/generate-openapi-json.js) — otherwise its routes
 * would silently never make it into the generated spec at all.
 */
function checkRouteFileManifestCoverage() {
  const appTsPath = path.join(ROOT, 'src', 'app.ts');
  const appSource = fs.readFileSync(appTsPath, 'utf8');

  // Router import specifiers actually mounted via app.use(prefix, X) in
  // app.ts, e.g. `import playerRoutes from './routes/player';`
  const mountedRouterNames = new Set();
  const useRe = /app\.use\(\s*[^,]+,\s*([A-Za-z0-9_]+)\s*\)/g;
  let m;
  while ((m = useRe.exec(appSource))) {
    mountedRouterNames.add(m[1]);
  }

  const importRe = /import\s+([A-Za-z0-9_]+)\s+from\s+['"](\.\/routes\/[^'"]+)['"]/g;
  const routerFileByName = new Map();
  while ((m = importRe.exec(appSource))) {
    const [, localName, importPath] = m;
    const relFile = `src/${importPath.replace(/^\.\//, '')}.ts`;
    routerFileByName.set(localName, relFile);
  }

  const manifestFiles = new Set(ROUTE_FILES.map((e) => e.file));
  const missingFromManifest = [];

  for (const routerName of mountedRouterNames) {
    const file = routerFileByName.get(routerName);
    // v2 aliases (playerRoutesV2, etc.) re-export the same v1 router — only
    // routers with their own source file under src/routes need a manifest
    // entry; v2-only routers (versioning) are already listed explicitly.
    if (!file) continue;
    if (!manifestFiles.has(file) && fs.existsSync(path.join(ROOT, file))) {
      missingFromManifest.push(file);
    }
  }

  return Array.from(new Set(missingFromManifest));
}

function main() {
  const gaps = checkRouteDocs();
  const manifestGaps = checkRouteFileManifestCoverage();

  if (gaps.length === 0 && manifestGaps.length === 0) {
    console.log('[check-route-docs] OK — every route has canonical-source documentation');
    process.exit(0);
  }

  if (gaps.length > 0) {
    console.error(`[check-route-docs] ${gaps.length} route(s) missing documentation:\n`);
    for (const gap of gaps) {
      console.error(`  ${gap.method.padEnd(6)} ${gap.path.padEnd(45)} missing: ${gap.missing.join(', ')}  (${gap.file})`);
    }
    console.error(
      '\nAdd a leading JSDoc comment above the route with at least @summary ' +
      '(or a descriptive first sentence) and one @response tag. ' +
      'See docs/API_DOCUMENTATION.md for the format.',
    );
  }

  if (manifestGaps.length > 0) {
    console.error(`\n[check-route-docs] ${manifestGaps.length} router(s) mounted in src/app.ts but missing from ROUTE_FILES:\n`);
    for (const file of manifestGaps) {
      console.error(`  ${file}`);
    }
    console.error(
      '\nAdd an entry to ROUTE_FILES in scripts/generate-openapi-json.js so its ' +
      'routes are included in the generated spec.',
    );
  }

  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { checkRouteDocs, checkRouteFileManifestCoverage };
