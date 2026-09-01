import Database from 'better-sqlite3';
import { timedQuery } from '../../src/db';
import { logger } from '../../src/utils/logger';
import { SqliteDriver } from '../../src/db/sqlite-driver';
import { runMigrations } from '../../src/db/migrate';

describe('timedQuery slow query logging', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => false);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.SLOW_QUERY_THRESHOLD_MS;
  });

  it('logs a warning when the query exceeds the threshold', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '0';
    const sql = 'SELECT 1';
    timedQuery(sql, () => 42);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0][0];
    expect(logged).toMatchObject({ query_name: sql });
  });

  it('includes duration_ms in the structured log object', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '0';
    timedQuery('SELECT slow', () => null);
    const logged = warnSpy.mock.calls[0][0];
    expect(typeof logged.duration_ms).toBe('number');
    expect(logged.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('includes row_count in the structured log object', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '0';
    timedQuery('SELECT rows', () => [{ id: 1 }, { id: 2 }]);
    const logged = warnSpy.mock.calls[0][0];
    expect(logged.row_count).toBe(2);
  });

  it('does not log when the query is faster than the threshold', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '999999';
    timedQuery('SELECT fast', () => 'ok');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns the query result unchanged', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '999999';
    const result = timedQuery('SELECT 1', () => [{ id: 1 }]);
    expect(result).toEqual([{ id: 1 }]);
  });

  it('sets row_count to -1 for null results', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '0';
    timedQuery('SELECT null', () => null);
    const logged = warnSpy.mock.calls[0][0];
    expect(logged.row_count).toBe(-1);
  });

  it('sets row_count to the changes count for RunResult-like objects', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '0';
    timedQuery('UPDATE x SET y=1', () => ({ changes: 3, lastInsertRowid: 0 }));
    const logged = warnSpy.mock.calls[0][0];
    expect(logged.row_count).toBe(3);
  });

  it('sets row_count to 1 for scalar results', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '0';
    timedQuery('SELECT COUNT(*)', () => 42);
    const logged = warnSpy.mock.calls[0][0];
    expect(logged.row_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Slow-query detection via a real SQLite query that takes > threshold
// ---------------------------------------------------------------------------
//
// sqlite_sleep(N) is a loadable extension and may not be available; we use
// a tight busy-loop instead to guarantee the query function takes >= 100 ms.
//
describe('timedQuery slow query detection with a deliberately slow operation', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => false);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.SLOW_QUERY_THRESHOLD_MS;
  });

  it('triggers a warning when the operation takes longer than the threshold', () => {
    process.env.SLOW_QUERY_THRESHOLD_MS = '50';

    // Simulate a slow DB call that takes ~100 ms by busy-waiting inside the
    // timedQuery callback.  This avoids any dependency on sqlite_sleep
    // loadable extension availability.
    timedQuery('SELECT /* slow */ 1', () => {
      const deadline = Date.now() + 100;
      while (Date.now() < deadline) { /* busy wait */ }
      return [{ value: 1 }];
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0][0];
    expect(logged).toMatchObject({
      query_name: 'SELECT /* slow */ 1',
      row_count: 1,
    });
    expect(logged.duration_ms).toBeGreaterThanOrEqual(50);
  });

  it('triggers a warning when a real SQLite query on a migrated in-memory DB is slow', async () => {
    // Build a real in-memory SQLite DB and run migrations so we have real tables.
    const db = new Database(':memory:');
    await runMigrations(new SqliteDriver(db));

    process.env.SLOW_QUERY_THRESHOLD_MS = '50';

    // Run a real query whose callback we stretch past the threshold.
    const rows = timedQuery('SELECT * FROM players', () => {
      // Artificially delay past the threshold while still executing a real query.
      const deadline = Date.now() + 100;
      while (Date.now() < deadline) { /* busy wait */ }
      return db.prepare('SELECT * FROM players').all();
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0][0];
    expect(logged.query_name).toBe('SELECT * FROM players');
    expect(logged.duration_ms).toBeGreaterThanOrEqual(50);
    expect(typeof logged.row_count).toBe('number');
    // rows is an array so row_count should equal rows.length
    expect(logged.row_count).toBe(rows.length);

    db.close();
  });
});
