/**
 * Tests for PostgresDriver SSL configuration (#721).
 *
 * Verifies that the ssl option is correctly passed to the underlying pg.Pool
 * constructor for each value of DATABASE_SSL / the PostgresSslOption type.
 *
 * The pg.Pool itself is mocked so no real database connection is required.
 * The mock is registered via jest.doMock() + a fresh require() per test
 * (rather than a top-level jest.mock() + import) because tests/setup.ts
 * (setupFilesAfterEnv) already imports src/db — which statically imports the
 * real `pg` module — before this file's own top-level code runs. A top-level
 * jest.mock('pg', factory) would register too late to affect the
 * already-cached src/db/postgres-driver module, so PostgresDriver must be
 * re-required fresh (jest.resetModules()) after the mock is in place.
 */

type PostgresDriverModule = typeof import('../../src/db/postgres-driver');

function loadWithMockedPool(): {
  PostgresDriver: PostgresDriverModule['PostgresDriver'];
  mockPoolConstructor: jest.Mock;
} {
  jest.resetModules();
  const mockPoolConstructor = jest.fn();
  jest.doMock('pg', () => ({
    types: { setTypeParser: jest.fn() },
    Pool: jest.fn().mockImplementation((config: object) => {
      mockPoolConstructor(config);
      return {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn(),
        end: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
      };
    }),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../../src/db/postgres-driver') as PostgresDriverModule;
  return { PostgresDriver: mod.PostgresDriver, mockPoolConstructor };
}


// ─── SSL option: false (default) ─────────────────────────────────────────────

describe('ssl: false (no TLS)', () => {
  it('does not set an ssl property on the pool config when ssl=false', () => {
    const { PostgresDriver, mockPoolConstructor } = loadWithMockedPool();
    new PostgresDriver('postgresql://localhost/test', false);
    expect(mockPoolConstructor).toHaveBeenCalled();
    const config = mockPoolConstructor.mock.calls[0][0] as Record<string, unknown>;
    expect(config).not.toHaveProperty('ssl');
  });

  it('does not set an ssl property when ssl is omitted (default)', () => {
    const { PostgresDriver, mockPoolConstructor } = loadWithMockedPool();
    new PostgresDriver('postgresql://localhost/test');
    const config = mockPoolConstructor.mock.calls[0][0] as Record<string, unknown>;
    expect(config).not.toHaveProperty('ssl');
  });

  it('passes the connectionString through regardless of ssl option', () => {
    const { PostgresDriver, mockPoolConstructor } = loadWithMockedPool();
    const url = 'postgresql://user:pass@db.example.com:5432/mydb';
    new PostgresDriver(url, false);
    const config = mockPoolConstructor.mock.calls[0][0] as Record<string, unknown>;
    expect(config.connectionString).toBe(url);
  });
});

// ─── SSL option: true (full verification) ────────────────────────────────────

describe('ssl: true (full certificate verification)', () => {
  it('sets ssl.rejectUnauthorized=true when ssl=true', () => {
    const { PostgresDriver, mockPoolConstructor } = loadWithMockedPool();
    new PostgresDriver('postgresql://localhost/test', true);
    const config = mockPoolConstructor.mock.calls[0][0] as Record<string, unknown>;
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
  });
});

// ─── SSL option: 'no-verify' (skip cert verification) ────────────────────────

describe('ssl: no-verify (transport only, no cert check)', () => {
  it('sets ssl.rejectUnauthorized=false when ssl="no-verify"', () => {
    const { PostgresDriver, mockPoolConstructor } = loadWithMockedPool();
    new PostgresDriver('postgresql://localhost/test', 'no-verify');
    const config = mockPoolConstructor.mock.calls[0][0] as Record<string, unknown>;
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('has ssl property present (TLS transport enabled) when ssl="no-verify"', () => {
    const { PostgresDriver, mockPoolConstructor } = loadWithMockedPool();
    new PostgresDriver('postgresql://localhost/test', 'no-verify');
    const config = mockPoolConstructor.mock.calls[0][0] as Record<string, unknown>;
    expect(config).toHaveProperty('ssl');
  });
});

// ─── Contrast: true vs no-verify ─────────────────────────────────────────────

describe('ssl option contrast', () => {
  it('ssl=true and ssl="no-verify" both enable TLS but differ in cert verification', () => {
    const { PostgresDriver, mockPoolConstructor } = loadWithMockedPool();
    new PostgresDriver('postgresql://localhost/test', true);
    const fullVerify = mockPoolConstructor.mock.calls[0][0].ssl as Record<string, unknown>;

    new PostgresDriver('postgresql://localhost/test', 'no-verify');
    const noVerify = mockPoolConstructor.mock.calls[1][0].ssl as Record<string, unknown>;

    expect(fullVerify.rejectUnauthorized).toBe(true);
    expect(noVerify.rejectUnauthorized).toBe(false);
  });
});

// ─── Pool sizing ──────────────────────────────────────────────────────────────

describe('connection pool sizing', () => {
  it('passes the poolSize argument through as max', () => {
    const { PostgresDriver, mockPoolConstructor } = loadWithMockedPool();
    new PostgresDriver('postgresql://localhost/test', false, 25);
    const config = mockPoolConstructor.mock.calls[0][0] as Record<string, unknown>;
    expect(config.max).toBe(25);
  });

  it('defaults to a max of 10 connections when poolSize is omitted', () => {
    const { PostgresDriver, mockPoolConstructor } = loadWithMockedPool();
    new PostgresDriver('postgresql://localhost/test');
    const config = mockPoolConstructor.mock.calls[0][0] as Record<string, unknown>;
    expect(config.max).toBe(10);
  });
});

// ─── Type safety: all valid PostgresSslOption values compile and behave correctly ──

describe('valid PostgresSslOption values', () => {
  it.each([true, false, 'no-verify'] as const)('constructs without throwing for ssl=%p', (ssl) => {
    const { PostgresDriver } = loadWithMockedPool();
    expect(() => new PostgresDriver('postgresql://localhost/test', ssl)).not.toThrow();
  });
});
