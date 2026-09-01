import { getDb, getDriver, insertAuditLog, getAuditLogs, getAuditLogsCount, getAllAuditLogRows } from '../../src/db';
import { GENESIS_HASH } from '../../src/utils/hashChain';
import config from '../../src/config';

// The two describe blocks below use getDb() directly (SQLite's raw
// synchronous handle) to test SQLite-specific mechanics — better-sqlite3's
// own NOT NULL enforcement, and SqliteDriver's single-connection
// serialization. They're deliberately not portable to DB_DRIVER=postgres;
// tests/db/postgresIntegration.test.ts asserts the same guarantees there.
// Skipping (rather than leaving them to throw "Database not initialised —
// call initDb() first for SQLite") lets this whole file run safely in a CI
// job that runs the suite under both drivers.
const describeSqliteOnly = config.dbDriver === 'postgres' ? describe.skip : describe;

// This top-level describe block only exercises insertAuditLog/getAuditLogs/
// getAuditLogsCount/getAllAuditLogRows — all driver-agnostic — so its
// fixture cleanup goes through getDriver() to keep it runnable under
// DB_DRIVER=postgres too. The NOT NULL and concurrent-write blocks below are
// deliberately SQLite-specific (see their own comments) with a dedicated
// PostgreSQL equivalent in tests/db/postgresIntegration.test.ts.
describe('audit_log — persistence and hash chain (#464)', () => {
  beforeEach(async () => {
    await getDriver().run('DELETE FROM audit_log');
  });

  it('round-trips a row through insertAuditLog / getAuditLogs', async () => {
    await insertAuditLog({
      action: 'contract_state_change',
      adminWallet: 'GADMIN1',
      queryParams: { contractAction: 'pause_contract' },
      createdAt: '2025-01-01T00:00:00.000Z',
    });

    const rows = await getAuditLogs({});
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('contract_state_change');
    expect(rows[0].admin_wallet).toBe('GADMIN1');
    expect(JSON.parse(rows[0].query_params)).toEqual({ contractAction: 'pause_contract' });
    expect(await getAuditLogsCount({})).toBe(1);
  });

  it('chains the first row onto the genesis hash', async () => {
    const row = await insertAuditLog({ action: 'a', adminWallet: 'G1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    expect(row.prev_hash).toBe(GENESIS_HASH);
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('chains each subsequent row onto the previous row\'s hash', async () => {
    const r1 = await insertAuditLog({ action: 'a', adminWallet: 'G1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    const r2 = await insertAuditLog({ action: 'b', adminWallet: 'G2', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });
    const r3 = await insertAuditLog({ action: 'c', adminWallet: 'G3', queryParams: {}, createdAt: '2025-01-03T00:00:00.000Z' });

    expect(r2.prev_hash).toBe(r1.hash);
    expect(r3.prev_hash).toBe(r2.hash);
    // Distinct content/position -> distinct hashes.
    expect(new Set([r1.hash, r2.hash, r3.hash]).size).toBe(3);
  });

  it('defaults event_source to admin_action when not specified', async () => {
    const row = await insertAuditLog({ action: 'a', adminWallet: 'G1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    expect(row.event_source).toBe('admin_action');
  });

  it('stores a distinct event_source when specified (app_event)', async () => {
    const row = await insertAuditLog({
      action: 'player_search',
      adminWallet: 'GSCOUT',
      queryParams: {},
      createdAt: '2025-01-01T00:00:00.000Z',
      eventSource: 'app_event',
    });
    expect(row.event_source).toBe('app_event');
  });

  it('getAllAuditLogRows returns every row in id ASC (chain) order, unpaginated', async () => {
    for (let i = 0; i < 5; i++) {
      await insertAuditLog({ action: `a${i}`, adminWallet: 'G1', queryParams: {}, createdAt: `2025-01-0${i + 1}T00:00:00.000Z` });
    }
    const rows = await getAllAuditLogRows();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort((a, b) => a - b));
  });

  it('getAllAuditLogRows filters by eventSource', async () => {
    await insertAuditLog({ action: 'admin1', adminWallet: 'G1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    await insertAuditLog({ action: 'app1', adminWallet: 'G2', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z', eventSource: 'app_event' });

    expect(await getAllAuditLogRows({ eventSource: 'app_event' })).toHaveLength(1);
    expect(await getAllAuditLogRows({ eventSource: 'admin_action' })).toHaveLength(1);
    expect(await getAllAuditLogRows()).toHaveLength(2);
  });
});

// ─── Schema-level durability (#1014) ───────────────────────────────────────────
//
// db/012_audit_log_hash_chain_postgres.sql used to declare `hash` and
// `event_source` as nullable — silently weakening the tamper-evidence
// guarantee, since a NULL hash breaks the chain without being rejected as a
// write failure. 014_audit_log_hash_not_null_postgres.sql fixes that so both
// drivers enforce the same constraint. This asserts the SQLite side (always
// NOT NULL); tests/db/postgresIntegration.test.ts asserts the same against a
// live PostgreSQL instance.
describeSqliteOnly('audit_log NOT NULL enforcement — SQLite (#1014)', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM audit_log').run();
  });

  it('rejects an insert with a NULL hash', () => {
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO audit_log (action, admin_wallet, query_params, created_at, hash, event_source)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run('test', 'GADMIN', '{}', new Date().toISOString(), 'admin_action'),
    ).toThrow(/NOT NULL/i);
  });

  it('rejects an insert with a NULL event_source', () => {
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO audit_log (action, admin_wallet, query_params, created_at, hash, event_source)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run('test', 'GADMIN', '{}', new Date().toISOString(), 'f'.repeat(64)),
    ).toThrow(/NOT NULL/i);
  });
});

// ─── Concurrent-write durability (#1014) ───────────────────────────────────────
//
// insertAuditLog wraps the "read last hash, then insert" sequence in
// driver.transaction(), which SqliteDriver serializes on its single
// connection (see SqliteDriver's txQueue). This proves that under real
// concurrent load nothing is silently dropped: every write either lands in
// the chain (verified end-to-end, no gaps, no duplicates) or the caller's
// promise rejects.
describeSqliteOnly('audit_log concurrent writes — no silent loss (SQLite) (#1014)', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM audit_log').run();
  });

  it('100 simultaneous insertAuditLog calls: every row present and the hash chain is unbroken', async () => {
    const N = 100;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        insertAuditLog({
          action: `stress-${i}`,
          adminWallet: 'GSTRESS',
          queryParams: { i },
          createdAt: new Date().toISOString(),
        }),
      ),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(0);

    const rows = await getAllAuditLogRows({ actorWallet: 'GSTRESS' });
    expect(rows).toHaveLength(N);

    // Chain must be unbroken: each row's prev_hash matches the actual
    // previous row's hash, walking from the first row.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].prev_hash).toBe(rows[i - 1].hash);
    }

    // Every stress action present exactly once — no row silently dropped or
    // duplicated under concurrent contention.
    const actions = new Set(rows.map((r) => r.action));
    expect(actions.size).toBe(N);
  }, 20000);
});
