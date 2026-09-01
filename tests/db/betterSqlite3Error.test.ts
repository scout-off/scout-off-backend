import {
  createBetterSqlite3LoadError,
  isBetterSqlite3LoadFailure,
} from '../../src/db/betterSqlite3Error';

describe('better-sqlite3 load error (#1149)', () => {
  it('formats a clear error naming Node version, ABI, rebuild, and troubleshooting', () => {
    const cause = new Error(
      'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 137.',
    );
    const err = createBetterSqlite3LoadError(cause);

    expect(err.name).toBe('BetterSqlite3LoadError');
    expect(err.message).toContain('Failed to load better-sqlite3 native binding');
    expect(err.message).toContain(process.version);
    expect(err.message).toContain(`ABI ${process.versions.modules}`);
    expect(err.message).toContain('ABI 115');
    expect(err.message).toContain('Node 20.x');
    expect(err.message).toContain('npm rebuild better-sqlite3');
    expect(err.message).toContain('README.md#troubleshooting-local-setup');
    expect(err.message).toContain(cause.message);
  });

  it('detects native-binding failure shapes', () => {
    expect(
      isBetterSqlite3LoadFailure(
        new Error("Cannot find module '../build/Release/better_sqlite3.node'"),
      ),
    ).toBe(true);
    expect(isBetterSqlite3LoadFailure(new Error('NODE_MODULE_VERSION mismatch'))).toBe(true);
    expect(isBetterSqlite3LoadFailure(new Error('disk full'))).toBe(false);
  });
});
