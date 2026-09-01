/**
 * Live PostgreSQL integration tests (#1014).
 *
 * These exercise the *real* PostgresDriver against a real Postgres instance
 * — no mocked `pg` module — covering exactly the acceptance criteria the
 * issue calls out that a mock cannot prove:
 *
 *   1. PostgresDriver's query execution must never be able to hang the
 *      event loop, and 50+ concurrent queries must show real parallel
 *      (pool-bounded) latency, not serialized waits.
 *   2. audit_log.hash / event_source must be schema-equivalently non-nullable
 *      on Postgres, matching SQLite (see tests/db/auditLog.test.ts for the
 *      SQLite side of this).
 *   3. A concurrency stress test issuing 100+ simultaneous logAuditEvent-style
 *      writes must show zero silently-lost rows — every write lands in the
 *      chain, verified end-to-end, or is an explicit rejection.
 *
 * Requires a reachable PostgreSQL 14+ instance. Set POSTGRES_TEST_URL (or
 * DATABASE_URL) to point at it — e.g.
 *   docker run --rm -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=scout_test -p 5433:5432 postgres:16-alpine
 *   POSTGRES_TEST_URL=postgres://postgres:postgres@localhost:5433/scout_test npm test -- postgresIntegration
 * The CI postgres job (.github/workflows/ci.yml) sets this automatically.
 * The suite is skipped (not failed) when no URL is configured, so the
 * default `npm test` run — which uses DB_DRIVER=sqlite — is unaffected.
 */

import fs from 'fs';
import path from 'path';
import { PostgresDriver } from '../../src/db/postgres-driver';
import { DbDriver } from '../../src/db/driver';
import { computeChainHash, auditChainContent, GENESIS_HASH } from '../../src/utils/hashChain';

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL || '';

/**
 * Applies every db/*_postgres.sql (or its SQLite-file fallback, mirroring
 * src/db/migrate.ts's own file-selection rule) directly against `driver`.
 *
 * This intentionally does NOT call src/db/migrate.ts's runMigrations(),
 * which decides sqlite-vs-postgres file selection from `config.dbDriver` —
 * a value src/config.ts computes once from process.env.DB_DRIVER the first
 * time it's imported and then freezes. Since this test file also runs in
 * suites where DB_DRIVER is unset (plain `npm test` picks up sqlite as the
 * default) and Jest can reuse a worker's module registry across test files,
 * flipping DB_DRIVER here to steer that shared, cached config value would be
 * fragile and could leak into unrelated test files. Reimplementing the tiny
 * bit of file-selection logic locally avoids that entirely.
 */
async function applyPostgresMigrations(driver: DbDriver): Promise<void> {
  const migrationsDir = path.resolve(__dirname, '../../db');
  await driver.exec('CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.includes('_postgres'))
    .sort();

  for (const file of files) {
    const already = await driver.get<{ id: string }>('SELECT id FROM migrations WHERE id = ?', [file]);
    if (already) continue;

    const postgresFile = file.replace('.sql', '_postgres.sql');
    const postgresPath = path.join(migrationsDir, postgresFile);
    const sqlPath = fs.existsSync(postgresPath) ? postgresPath : path.join(migrationsDir, file);
    const sql = fs.readFileSync(sqlPath, 'utf8');

    await driver.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.run('INSERT INTO migrations (id, applied_at) VALUES (?, ?)', [file, Date.now()]);
    });
  }
}

const describePg = POSTGRES_TEST_URL ? describe : describe.skip;

if (!POSTGRES_TEST_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[postgresIntegration.test.ts] Skipping — set POSTGRES_TEST_URL (or DATABASE_URL) to a live ' +
      'PostgreSQL instance to run these tests.',
  );
}

describePg('PostgresDriver — live integration (#1014)', () => {
  let driver: PostgresDriver;

  beforeAll(async () => {
    driver = new PostgresDriver(POSTGRES_TEST_URL, false, 20);
    await driver.connect();
    await applyPostgresMigrations(driver);
  }, 30000);

  afterAll(async () => {
    await driver.close();
  });

  beforeEach(async () => {
    await driver.exec('DELETE FROM audit_log');
  });

  describe('concurrency — the driver must never serialize or block the event loop', () => {
    it('60 concurrent queries complete in pool-bounded parallel time, not sequential time', async () => {
      const N = 60;
      const perQueryMs = 100;
      const start = Date.now();
      await Promise.all(
        Array.from({ length: N }, () => driver.get(`SELECT pg_sleep(${perQueryMs / 1000})`)),
      );
      const elapsed = Date.now() - start;

      // Fully serial (the old busy-wait querySync behaviour) would take
      // N * perQueryMs = 6000ms+. Pool-bounded parallel (pool size 20) should
      // take roughly ceil(N/20) * perQueryMs = 300ms, plus overhead. Assert
      // well under half the fully-serial time so this fails loudly if
      // concurrency regresses back to serialized execution.
      expect(elapsed).toBeLessThan((N * perQueryMs) / 2);
    }, 20000);

    it('does not block the Node event loop while a slow query is in flight', async () => {
      let timerFired = false;
      const timer = setTimeout(() => {
        timerFired = true;
      }, 20);

      await driver.get('SELECT pg_sleep(0.3)');

      clearTimeout(timer);
      expect(timerFired).toBe(true);
    }, 10000);

    it('a query issued from within another in-flight query resolves promptly (proves no busy-wait)', async () => {
      const slow = driver.get('SELECT pg_sleep(0.3)');
      const start = Date.now();
      await driver.get('SELECT 1');
      const fastElapsed = Date.now() - start;
      await slow;

      // The old querySync busy-wait implementation could never let a second
      // call resolve while the first was "in flight" on the same connection
      // (indeed it could never resolve *itself* — see postgres-driver.ts's
      // history). A pooled, genuinely async driver resolves the fast query
      // almost immediately regardless of the slow one.
      expect(fastElapsed).toBeLessThan(150);
    }, 10000);
  });

  describe('audit_log NOT NULL enforcement — PostgreSQL (#1014)', () => {
    it('rejects an insert with a NULL hash', async () => {
      await expect(
        driver.run(
          `INSERT INTO audit_log (action, admin_wallet, query_params, created_at, hash, event_source)
           VALUES (?, ?, ?, ?, NULL, ?)`,
          ['test', 'GADMIN', '{}', new Date().toISOString(), 'admin_action'],
        ),
      ).rejects.toThrow();
    });

    it('rejects an insert with a NULL event_source', async () => {
      await expect(
        driver.run(
          `INSERT INTO audit_log (action, admin_wallet, query_params, created_at, hash, event_source)
           VALUES (?, ?, ?, ?, ?, NULL)`,
          ['test', 'GADMIN', '{}', new Date().toISOString(), 'f'.repeat(64)],
        ),
      ).rejects.toThrow();
    });
  });

  describe('concurrent audit-log writes — no silent loss (PostgreSQL) (#1014)', () => {
    it('120 simultaneous transactional inserts: every row present, hash chain unbroken, zero silent loss', async () => {
      const N = 120;

      const results = await Promise.allSettled(
        Array.from({ length: N }, (_, i) =>
          driver.transaction(async (tx) => {
            await tx.lockForWrite('audit_log');
            const prevRow = await tx.get<{ hash: string }>(
              'SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1',
            );
            const prevHash = prevRow?.hash ?? GENESIS_HASH;
            const action = `stress-${i}`;
            const adminWallet = 'GSTRESS';
            const queryParams = '{}';
            const createdAt = new Date().toISOString();
            const hash = computeChainHash(
              auditChainContent({ action, adminWallet, queryParams, createdAt, eventSource: 'admin_action' }),
              prevHash,
            );
            await tx.run(
              `INSERT INTO audit_log (action, admin_wallet, query_params, created_at, prev_hash, hash, event_source)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [action, adminWallet, queryParams, createdAt, prevHash, hash, 'admin_action'],
            );
            return action;
          }),
        ),
      );

      // Every write must either land durably (verified below) or be an
      // explicit rejection the caller can see — never silently vanish.
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(0);

      const rows = await driver.all<{ id: number; action: string; prev_hash: string | null; hash: string }>(
        'SELECT id, action, prev_hash, hash FROM audit_log ORDER BY id ASC',
      );
      expect(rows).toHaveLength(N);

      // Hash chain must be unbroken end-to-end, starting from GENESIS_HASH —
      // this is only possible if every read-prev-then-insert sequence above
      // was genuinely atomic under concurrency (no interleaving).
      let expectedPrev = GENESIS_HASH;
      for (const row of rows) {
        expect(row.prev_hash).toBe(expectedPrev);
        expectedPrev = row.hash;
      }

      // All N distinct actions present exactly once.
      const actions = new Set(rows.map((r) => r.action));
      expect(actions.size).toBe(N);
    }, 30000);
  });
});
