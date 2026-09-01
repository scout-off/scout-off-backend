import 'ts-jest';
// Minimal env defaults are set by tests/setup-shell.ts
import app from '../../src/app';
import allowlist from '../../src/config/apiVersioning';

function collectMountPaths(a: any): string[] {
  const paths = new Set<string>();
  const stack = a._router && a._router.stack ? a._router.stack : [];
  for (const layer of stack) {
    if (layer && layer.route && layer.route.path) {
      paths.add(layer.route.path);
    } else if (layer && layer.name === 'router' && layer.regexp && layer.regexp.source) {
      const src = layer.regexp.source;
      const firstSlash = src.indexOf('\\/');
      if (firstSlash >= 0) {
        const rest = src.slice(firstSlash + 2);
        const endIdx = rest.search(/\\\\\/|\\\(|\$|\?/);
        const part = endIdx === -1 ? rest : rest.slice(0, endIdx);
        const cleaned = part.replace(/\\\//g, '/');
        if (cleaned) paths.add('/' + cleaned);
      }
    }
  }
  return Array.from(paths);
}

function normalize(p: string): string {
  return p.replace(/\/+$/, '');
}

function isAllowlisted(path: string): boolean {
  return allowlist.some(a => a === path || a.startsWith(path + '/') || path.startsWith(a + '/'));
}

test('api v1/v2 parity (router introspection)', () => {
  const mountPaths = collectMountPaths(app).map(normalize);

  const findMountedUnder = (prefix: string) => {
    const pref = normalize(prefix);
    return mountPaths
      .filter(p => {
        if (p === pref) return true;
        if (!p.startsWith(pref + '/')) return false;
        if (pref === '/api' && p.startsWith('/api/v2/')) return false;
        return true;
      })
      .map(p => {
        if (pref === '/api') {
          if (p === '/api') return '/';
          if (p.startsWith('/api/v1/')) return p.slice('/api/v1'.length) || '/';
          return p.slice('/api'.length) || '/';
        }
        return p.slice(pref.length) || '/';
      })
      .map(normalize);
  };

  const v1 = new Set(findMountedUnder('/api'));
  const v1_alt = new Set(findMountedUnder('/api/v1'));
  for (const p of v1_alt) v1.add(p);
  const v2 = new Set(findMountedUnder('/api/v2'));

  const missingInV2: string[] = [];
  const missingInV1: string[] = [];

  for (const p of v1) if (!v2.has(p) && !isAllowlisted(p)) missingInV2.push(p);
  for (const p of v2) if (!v1.has(p) && !isAllowlisted(p)) missingInV1.push(p);

  expect(missingInV2).toEqual([]);
  expect(missingInV1).toEqual([]);
});
