import { apiDocsConfig } from '../../src/config.apiDocs';
import { filterAdminPathsFromSpec, isAdminPath } from '../../src/middleware/docs.guard';

jest.mock('../../src/middleware/auth', () => ({
  requireRole: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

const config = apiDocsConfig as { mode: string; hideAdminPaths: boolean };

function buildSpec(): Record<string, unknown> {
  return {
    openapi: '3.0.0',
    paths: {
      '/admin': { get: {} },
      '/admin/players': { get: {} },
      '/admin/players/{id}': { get: {} },
      '/administrators': { get: {} },
      '/administrators/{id}': { get: {} },
      '/players': { get: {} },
      '/players/{id}': { get: {} },
    },
  };
}

function pathKeys(spec: Record<string, unknown>): string[] {
  return Object.keys((spec.paths as Record<string, unknown>) ?? {});
}

describe('isAdminPath', () => {
  it('matches the bare /admin path', () => {
    expect(isAdminPath('/admin')).toBe(true);
  });

  it('matches paths nested under /admin/', () => {
    expect(isAdminPath('/admin/players')).toBe(true);
    expect(isAdminPath('/admin/players/{id}')).toBe(true);
  });

  it('does not match the /administrators prefix', () => {
    expect(isAdminPath('/administrators')).toBe(false);
    expect(isAdminPath('/administrators/{id}')).toBe(false);
  });

  it('does not match unrelated paths', () => {
    expect(isAdminPath('/players')).toBe(false);
    expect(isAdminPath('/')).toBe(false);
    expect(isAdminPath('')).toBe(false);
  });
});

describe('filterAdminPathsFromSpec', () => {
  const originalMode = config.mode;
  const originalHideAdminPaths = config.hideAdminPaths;

  afterEach(() => {
    config.mode = originalMode;
    config.hideAdminPaths = originalHideAdminPaths;
  });

  it('removes /admin and /admin/* paths in public mode with hideAdminPaths enabled', () => {
    config.mode = 'public';
    config.hideAdminPaths = true;

    const filtered = filterAdminPathsFromSpec(buildSpec());

    expect(pathKeys(filtered)).toEqual([
      '/administrators',
      '/administrators/{id}',
      '/players',
      '/players/{id}',
    ]);
  });

  it('keeps /administrators paths (prefix ambiguity resolved)', () => {
    config.mode = 'public';
    config.hideAdminPaths = true;

    const filtered = filterAdminPathsFromSpec(buildSpec());
    const keys = pathKeys(filtered);

    expect(keys).toContain('/administrators');
    expect(keys).toContain('/administrators/{id}');
    expect(keys).not.toContain('/admin');
    expect(keys).not.toContain('/admin/players');
  });

  it('does not mutate the input spec', () => {
    config.mode = 'public';
    config.hideAdminPaths = true;

    const spec = buildSpec();
    filterAdminPathsFromSpec(spec);

    expect(pathKeys(spec)).toContain('/admin');
    expect(pathKeys(spec)).toContain('/admin/players');
  });

  it('returns the spec unchanged when hideAdminPaths is disabled', () => {
    config.mode = 'public';
    config.hideAdminPaths = false;

    const spec = buildSpec();
    expect(filterAdminPathsFromSpec(spec)).toBe(spec);
  });

  it('returns the spec unchanged when mode is not public', () => {
    config.mode = 'admin';
    config.hideAdminPaths = true;

    const spec = buildSpec();
    expect(filterAdminPathsFromSpec(spec)).toBe(spec);
  });

  it('handles specs without a paths object', () => {
    config.mode = 'public';
    config.hideAdminPaths = true;

    const filtered = filterAdminPathsFromSpec({ openapi: '3.0.0' });
    expect(filtered).toEqual({ openapi: '3.0.0' });
  });
});
