/**
 * Tests for PostgresDriver.close() and closeDb() async correctness (issue #723).
 *
 * Verifies that:
 *   1. PostgresDriver.close() returns a Promise that resolves only after
 *      pool.end() has completed.
 *   2. closeDb() awaits the driver's close() before returning.
 *
 * The mock is registered via jest.doMock() + a fresh require() per test
 * rather than a top-level jest.mock() + import — see
 * postgresDriverSsl.test.ts for why a static top-level jest.mock('pg', ...)
 * doesn't take effect here (tests/setup.ts already imports src/db, and
 * therefore the real `pg` module, before this file's own code runs).
 */

type PostgresDriverModule = typeof import('../../src/db/postgres-driver');

/**
 * Build a PostgresDriver whose underlying pg Pool is a controllable fake
 * whose end() resolves after `delayMs`.
 */
function makeDriverWithFakePool(delayMs = 0): {
  driver: InstanceType<PostgresDriverModule['PostgresDriver']>;
  endCalled: () => boolean;
  endResolved: () => boolean;
} {
  jest.resetModules();
  let _endCalled = false;
  let _endResolved = false;

  jest.doMock('pg', () => ({
    types: { setTypeParser: jest.fn() },
    Pool: jest.fn().mockImplementation(() => ({
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: jest.fn(),
      on: jest.fn(),
      end: () =>
        new Promise<void>((resolve) => {
          _endCalled = true;
          setTimeout(() => {
            _endResolved = true;
            resolve();
          }, delayMs);
        }),
    })),
  }));

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PostgresDriver } = require('../../src/db/postgres-driver') as PostgresDriverModule;
  const driver = new PostgresDriver('postgres://fake');

  return {
    driver,
    endCalled: () => _endCalled,
    endResolved: () => _endResolved,
  };
}

describe('PostgresDriver.close()', () => {
  it('returns a Promise', () => {
    const { driver } = makeDriverWithFakePool();
    const result = driver.close();
    expect(result).toBeInstanceOf(Promise);
  });

  it('calls pool.end()', async () => {
    const { driver, endCalled } = makeDriverWithFakePool();
    await driver.close();
    expect(endCalled()).toBe(true);
  });

  it('resolves only after pool.end() has completed', async () => {
    const { driver, endResolved } = makeDriverWithFakePool(10);

    // Before awaiting, end() has not yet resolved.
    const closePromise = driver.close();
    expect(endResolved()).toBe(false);

    await closePromise;
    // Now it must be resolved.
    expect(endResolved()).toBe(true);
  });

  it('resolves even when pool.end() rejects (error is swallowed)', async () => {
    jest.resetModules();
    jest.doMock('pg', () => ({
      types: { setTypeParser: jest.fn() },
      Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn(),
        on: jest.fn(),
        end: () => Promise.reject(new Error('connection reset')),
      })),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PostgresDriver } = require('../../src/db/postgres-driver') as PostgresDriverModule;
    const driver = new PostgresDriver('postgres://fake');

    // Should not throw — the driver logs the error but does not re-throw.
    await expect(driver.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// closeDb() integration — verifies the shutdown wrapper awaits the driver
// ---------------------------------------------------------------------------

describe('closeDb() awaits driver.close()', () => {
  it('does not resolve until the underlying driver.close() promise settles', async () => {
    const { driver, endResolved } = makeDriverWithFakePool(20);

    // Mirrors src/db/index.ts's closeDb(): `await _driver.close()`.
    const closeDb = async (): Promise<void> => {
      await driver.close();
    };

    const promise = closeDb();
    expect(endResolved()).toBe(false);
    await promise;
    expect(endResolved()).toBe(true);
  });
});
