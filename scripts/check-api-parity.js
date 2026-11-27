// Lightweight parity checker that inspects the Express app router stack
// without invoking route handlers or Jest. Runs in Node and exits non-zero
// when parity violations are found.

function collectMountPaths(app) {
  const paths = new Set();
  const stack = app._router && app._router.stack ? app._router.stack : [];
  for (const layer of stack) {
    if (layer && layer.route && layer.route.path) {
      paths.add(layer.route.path);
    } else if (layer && layer.name === 'router' && layer.regexp && layer.regexp.source) {
      // Extract a best-effort mount path from layer.regexp.source
      const src = layer.regexp.source;
      const firstSlash = src.indexOf('\\/');
      if (firstSlash >= 0) {
        const rest = src.slice(firstSlash + 2);
        // take until next escaped slash, parenthesis or end
        const endIdx = rest.search(/\\\\\/|\\\(|\$|\?/);
        const part = endIdx === -1 ? rest : rest.slice(0, endIdx);
        const cleaned = part.replace(/\\\//g, '/');
        if (cleaned) paths.add('/' + cleaned);
      }
    }
  }
  return Array.from(paths);
}

function normalize(p) {
  return p.replace(/\/+$/, '');
}

function isAllowlisted(path, allowlist) {
  return allowlist.some((a) => a === path || a.startsWith(path + '/') || path.startsWith(a + '/'));
}

/**
 * Compare the routes mounted under /api (v1) and /api/v2.
 *
 * @param {object} app Express application (or any object exposing `_router.stack`).
 * @param {string[]} allowlist Paths intentionally allowed to diverge.
 * @returns {{ mountPaths: string[], missingInV2: string[], missingInV1: string[] }}
 */
function checkApiParity(app, allowlist = []) {
  const mountPaths = collectMountPaths(app).map(normalize);

  function findMountedUnder(prefix) {
    const pref = normalize(prefix);
    // For simplicity, consider paths that include the prefix at start
    return mountPaths
      .filter((p) => {
        if (p === pref) return true;
        if (!p.startsWith(pref + '/')) return false;
        // Treat '/api' as an alias for v1: exclude any /api/v2/* subpaths
        if (pref === '/api' && p.startsWith('/api/v2/')) return false;
        return true;
      })
      .map((p) => {
        if (pref === '/api') {
          if (p === '/api') return '/';
          if (p.startsWith('/api/v1/')) return p.slice('/api/v1'.length) || '/';
          return p.slice('/api'.length) || '/';
        }
        return p.slice(pref.length) || '/';
      })
      .map(normalize);
  }

  const v1 = new Set(findMountedUnder('/api'));
  const v1_alt = new Set(findMountedUnder('/api/v1'));
  for (const p of v1_alt) v1.add(p);
  const v2 = new Set(findMountedUnder('/api/v2'));

  const missingInV2 = [];
  const missingInV1 = [];

  for (const p of v1) {
    if (!v2.has(p) && !isAllowlisted(p, allowlist)) missingInV2.push(p);
  }
  for (const p of v2) {
    if (!v1.has(p) && !isAllowlisted(p, allowlist)) missingInV1.push(p);
  }

  return { mountPaths, missingInV2, missingInV1 };
}

/**
 * Run the parity check against the real app and exit with 0 (parity) or 2 (violations).
 */
function main() {
  // Minimal env defaults to satisfy src/config.ts without running tests/setup
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.DB_PATH = process.env.DB_PATH || ':memory:';
  process.env.ADMIN_WALLET =
    process.env.ADMIN_WALLET || 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';
  process.env.WEBHOOK_SECRET_ENCRYPTION_KEY =
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY || '0'.repeat(63) + '1';

  require('ts-node/register');
  const app = require('../src/app').default;
  const allowlist = require('../src/config/apiVersioning').default;

  const { mountPaths, missingInV2, missingInV1 } = checkApiParity(app, allowlist);
  console.log('Detected mount paths:', mountPaths.join(', '));

  if (missingInV2.length || missingInV1.length) {
    console.error('API parity violations:');
    if (missingInV2.length) console.error('  Missing in v2:', missingInV2.join(', '));
    if (missingInV1.length) console.error('  Missing in v1:', missingInV1.join(', '));
    process.exit(2);
  }

  console.log('API parity check passed (no unexpected divergences)');
  process.exit(0);
}

module.exports = { collectMountPaths, normalize, isAllowlisted, checkApiParity, main };

if (require.main === module) {
  main();
}
