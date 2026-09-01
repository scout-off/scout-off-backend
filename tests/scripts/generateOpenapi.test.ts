/**
 * Integration tests for the canonical OpenAPI generator (#1047).
 *
 * Runs the real generator against the real route source files (no fixtures,
 * no mocking) and asserts the structural invariants the whole pipeline
 * depends on: every route makes it into the spec, every operation has a
 * response and a resolvable auth requirement, and no Zod construct in the
 * codebase falls through to "unmapped".
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const { generateSpec, ROUTE_FILES } = require('../../scripts/generate-openapi-json');
const { checkRouteDocs, checkRouteFileManifestCoverage } = require('../../scripts/check-route-docs');
const { parseRouteFile } = require('../../scripts/lib/docgen/parseRoutes');
/* eslint-enable @typescript-eslint/no-var-requires */
import path from 'path';

const ROOT = path.join(__dirname, '..', '..');

describe('generate-openapi-json.generateSpec (real route sources)', () => {
  const spec = generateSpec();

  it('includes every route from every manifest entry', () => {
    let expectedOps = 0;
    for (const entry of ROUTE_FILES) {
      expectedOps += parseRouteFile(path.join(ROOT, entry.file)).length;
    }
    const actualOps = Object.values(spec.paths as Record<string, Record<string, unknown>>).reduce(
      (n, item) => n + Object.keys(item).filter((k) => k !== 'servers').length,
      0,
    );
    expect(actualOps).toBe(expectedOps);
    expect(actualOps).toBeGreaterThan(90); // sanity floor — catches a manifest entry silently dropping out
  });

  it('gives every operation at least one response', () => {
    for (const item of Object.values(spec.paths as Record<string, any>)) {
      for (const [method, op] of Object.entries(item)) {
        if (method === 'servers') continue;
        expect(Object.keys((op as any).responses).length).toBeGreaterThan(0);
      }
    }
  });

  it('gives every operation an explicit security requirement (possibly empty = public)', () => {
    for (const item of Object.values(spec.paths as Record<string, any>)) {
      for (const [method, op] of Object.entries(item)) {
        if (method === 'servers') continue;
        expect(Array.isArray((op as any).security)).toBe(true);
      }
    }
  });

  it('never falls back to an unmapped Zod schema for a real route', () => {
    const serialized = JSON.stringify(spec);
    expect(serialized).not.toContain('x-unmapped');
  });

  it('is idempotent — regenerating twice with no source changes produces identical output', () => {
    const again = generateSpec();
    expect(JSON.stringify(again)).toBe(JSON.stringify(spec));
  });
});

describe('check-route-docs (real route sources)', () => {
  it('finds zero documentation gaps in the committed route files', () => {
    const gaps = checkRouteDocs();
    expect(gaps).toEqual([]);
  });

  it('finds zero routers mounted in app.ts but missing from the generator manifest', () => {
    const missing = checkRouteFileManifestCoverage();
    expect(missing).toEqual([]);
  });
});
