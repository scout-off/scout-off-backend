/**
 * Tests for PostgresDriver.run() lastId extraction (issue #724).
 *
 * Verifies that the returned lastId reflects the actual inserted primary-key
 * value regardless of the column name, so tables with non-"id" primary keys
 * (e.g. player_id, wallet, composite) don't silently return 0.
 *
 * The underlying `pg` Pool is mocked (no real Postgres connection) — this
 * suite exercises PostgresDriver.run()'s result-parsing logic in isolation.
 * The mock is registered via jest.doMock() + a fresh require() per test
 * rather than a top-level jest.mock() + import, because tests/setup.ts
 * (setupFilesAfterEnv) already imports src/db — which statically imports the
 * real `pg` module — before this file's own top-level code runs; see
 * postgresDriverSsl.test.ts for the full explanation.
 *
 * The non-blocking-event-loop / real-concurrency behaviour of the driver is
 * covered separately by tests/db/postgresDriverIntegration.test.ts against a
 * live Postgres instance, since a mock cannot meaningfully prove that.
 */

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

type PostgresDriverModule = typeof import('../../src/db/postgres-driver');

function loadWithMockedPool(queryResult: QueryResult): {
  PostgresDriver: PostgresDriverModule['PostgresDriver'];
  mockQuery: jest.Mock;
} {
  jest.resetModules();
  const mockQuery = jest.fn().mockResolvedValue(queryResult);
  jest.doMock('pg', () => ({
    types: { setTypeParser: jest.fn() },
    Pool: jest.fn().mockImplementation(() => ({
      query: mockQuery,
      connect: jest.fn(),
      end: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    })),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../../src/db/postgres-driver') as PostgresDriverModule;
  return { PostgresDriver: mod.PostgresDriver, mockQuery };
}

function makeDriver(queryResult: QueryResult) {
  const { PostgresDriver, mockQuery } = loadWithMockedPool(queryResult);
  return { driver: new PostgresDriver('postgres://fake'), mockQuery };
}

describe('PostgresDriver.run() – lastId extraction', () => {
  it('returns the numeric id when the RETURNING column is named "id"', async () => {
    const { driver } = makeDriver({ rows: [{ id: 42 }], rowCount: 1 });
    const result = await driver.run('INSERT INTO items (name) VALUES (?) RETURNING id', ['foo']);
    expect(result.lastId).toBe(42);
    expect(result.changes).toBe(1);
  });

  it('returns changes correctly when the primary key is named "player_id" (not "id")', async () => {
    const { driver } = makeDriver({ rows: [{ player_id: 99 }], rowCount: 1 });
    const result = await driver.run(
      'INSERT INTO players (player_id) VALUES (?) RETURNING player_id',
      ['p-99'],
    );
    expect(result.changes).toBe(1);
  });

  it('returns the value when the primary key is numeric but named "wallet_id"', async () => {
    const { driver } = makeDriver({ rows: [{ wallet_id: 7 }], rowCount: 1 });
    const result = await driver.run(
      'INSERT INTO wallets (wallet_id) VALUES (?) RETURNING wallet_id',
      [7],
    );
    expect(result.lastId).toBe(7);
  });

  it('does NOT silently return 0 when the row has a non-"id" numeric PK', async () => {
    // The old implementation hardcoded `"id" in firstRow` so any other column
    // name produced lastId: 0 even for a successful insert.
    const { driver } = makeDriver({ rows: [{ record_num: 15 }], rowCount: 1 });
    const result = await driver.run('INSERT INTO records DEFAULT VALUES RETURNING record_num', []);
    expect(result.lastId).toBe(15);
    expect(result.lastId).not.toBe(0);
  });

  it('returns 0 when no RETURNING clause is used (rows array is empty)', async () => {
    const { driver } = makeDriver({ rows: [], rowCount: 1 });
    const result = await driver.run('INSERT INTO logs (msg) VALUES (?)', ['hello']);
    expect(result.lastId).toBe(0);
    expect(result.changes).toBe(1);
  });

  it('returns 0 for a string primary key that is not numeric', async () => {
    const { driver } = makeDriver({ rows: [{ wallet: 'GXYZ...' }], rowCount: 1 });
    const result = await driver.run(
      'INSERT INTO validators (wallet) VALUES (?) RETURNING wallet',
      ['GXYZ...'],
    );
    expect(result.lastId).toBe(0);
    expect(result.changes).toBe(1);
  });

  it('reflects rowCount correctly alongside lastId', async () => {
    const { driver } = makeDriver({ rows: [{ id: 3 }], rowCount: 1 });
    const result = await driver.run('INSERT INTO t (x) VALUES (?) RETURNING id', [1]);
    expect(result.changes).toBe(1);
    expect(result.lastId).toBe(3);
  });

  it('translates ? placeholders to $1, $2, ... before calling pg', async () => {
    const { driver, mockQuery } = makeDriver({ rows: [{ id: 1 }], rowCount: 1 });
    await driver.run('INSERT INTO t (a, b) VALUES (?, ?) RETURNING id', ['x', 'y']);
    expect(mockQuery).toHaveBeenLastCalledWith('INSERT INTO t (a, b) VALUES ($1, $2) RETURNING id', ['x', 'y']);
  });
});
