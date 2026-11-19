/**
 * Unit tests for src/config.apiDocs.ts (#1868).
 *
 * The module evaluates API_DOCS_MODE / API_DOCS_HIDE_ADMIN at import time, so
 * every case re-imports it inside jest.isolateModules with the env set first.
 */

type ApiDocsConfig = { mode: string; hideAdminPaths: boolean };

const ORIGINAL_ENV = { ...process.env };

function loadConfig(env: Record<string, string | undefined>): ApiDocsConfig {
  let loaded: ApiDocsConfig | undefined;
  jest.isolateModules(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    loaded = require('../src/config.apiDocs').apiDocsConfig as ApiDocsConfig;
  });
  return loaded as ApiDocsConfig;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('apiDocsConfig.mode', () => {
  it('defaults to public in development', () => {
    expect(loadConfig({ NODE_ENV: 'development', API_DOCS_MODE: undefined }).mode).toBe('public');
  });

  it('defaults to public in test', () => {
    expect(loadConfig({ NODE_ENV: 'test', API_DOCS_MODE: undefined }).mode).toBe('public');
  });

  it('defaults to admin in staging', () => {
    expect(loadConfig({ NODE_ENV: 'staging', API_DOCS_MODE: undefined }).mode).toBe('admin');
  });

  it('defaults to admin in production', () => {
    expect(loadConfig({ NODE_ENV: 'production', API_DOCS_MODE: undefined }).mode).toBe('admin');
  });

  it('falls back to public when NODE_ENV is unset', () => {
    expect(loadConfig({ NODE_ENV: undefined, API_DOCS_MODE: undefined }).mode).toBe('public');
  });

  it('falls back to public for an unknown NODE_ENV', () => {
    expect(loadConfig({ NODE_ENV: 'qa', API_DOCS_MODE: undefined }).mode).toBe('public');
  });

  it('treats an empty API_DOCS_MODE as unset', () => {
    expect(loadConfig({ NODE_ENV: 'production', API_DOCS_MODE: '   ' }).mode).toBe('admin');
  });

  it.each(['public', 'admin', 'disabled'])('accepts explicit mode %s', (mode) => {
    expect(loadConfig({ NODE_ENV: 'production', API_DOCS_MODE: mode }).mode).toBe(mode);
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(loadConfig({ NODE_ENV: 'production', API_DOCS_MODE: '  ADMIN ' }).mode).toBe('admin');
  });

  it('throws on an invalid mode', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', API_DOCS_MODE: 'private' })).toThrow(
      /Invalid API_DOCS_MODE: "private"/
    );
  });
});

describe('apiDocsConfig.hideAdminPaths', () => {
  it('defaults to false when unset', () => {
    expect(loadConfig({ API_DOCS_HIDE_ADMIN: undefined }).hideAdminPaths).toBe(false);
  });

  it('defaults to false when empty', () => {
    expect(loadConfig({ API_DOCS_HIDE_ADMIN: '  ' }).hideAdminPaths).toBe(false);
  });

  it.each(['true', 'TRUE', '1', 'yes', ' Yes '])('is true for %p', (value) => {
    expect(loadConfig({ API_DOCS_HIDE_ADMIN: value }).hideAdminPaths).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', 'anything-else'])('is false for %p', (value) => {
    expect(loadConfig({ API_DOCS_HIDE_ADMIN: value }).hideAdminPaths).toBe(false);
  });
});
