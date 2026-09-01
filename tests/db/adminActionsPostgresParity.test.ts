/**
 * Dual-driver parity tests for the admin multi-signature subsystem (#1017).
 *
 * db/011_pending_admin_actions.sql (SQLite) and
 * db/011_pending_admin_actions_postgres.sql (Postgres) must describe
 * equivalent tables, and the exact SQL statements src/db/index.ts issues for
 * pending_admin_actions / admin_action_signatures must be valid — after
 * `?` → `$n` placeholder conversion (see src/db/postgres-driver.ts's
 * `convertPlaceholders`) — Postgres syntax that behaves the same way as the
 * SQLite originals (duplicate-signer detection via
 * INSERT ... ON CONFLICT DO NOTHING vs. INSERT OR IGNORE, in particular).
 *
 * The static schema-equivalence test always runs. The live-flow test
 * exercises a real Postgres instance and is opt-in via POSTGRES_TEST_URL —
 * it is skipped (not failed) when that isn't set, since CI does not run a
 * Postgres service for this suite. To run it locally:
 *
 *   docker run -d -e POSTGRES_PASSWORD=test -e POSTGRES_DB=scoutoff_test \
 *     -p 15432:5432 postgres:16-alpine
 *   POSTGRES_TEST_URL=postgres://postgres:test@127.0.0.1:15432/scoutoff_test \
 *     npx jest tests/db/adminActionsPostgresParity.test.ts
 *
 * Note: this test talks to Postgres with a plain `pg.Client` (awaited
 * normally) rather than going through `PostgresDriver`, because
 * `PostgresDriver`'s synchronous call surface is implemented as a busy-wait
 * over an async `pg` query (see its `querySync`) — a pattern that can never
 * observe the query's Promise settle, since Node only drains microtasks
 * between synchronous turns and a busy `while` loop never yields one. That
 * is a pre-existing, deeper defect in the driver's sync-emulation strategy
 * (it hangs for *every* query, not just ours) and is out of scope for
 * #1017's "pending_admin_actions/admin_action_signatures schema parity"
 * mandate — it affects the generic Postgres query layer for every table.
 * This test instead validates the two things #1017 actually owns: that the
 * schemas are equivalent, and that the SQL text + placeholder conversion
 * this subsystem relies on is correct Postgres syntax with correct
 * duplicate-signer semantics.
 */

import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import { convertPlaceholders } from '../../src/db/postgres-driver';

const SQLITE_MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../../db/011_pending_admin_actions.sql'),
  'utf8',
);
const POSTGRES_MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../../db/011_pending_admin_actions_postgres.sql'),
  'utf8',
);

function extractColumns(sql: string, table: string): string[] {
  const tableRe = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`);
  const match = sql.match(tableRe);
  if (!match) throw new Error(`Could not find table ${table} in migration SQL`);
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('--'))
    .map((line) => line.split(/\s+/)[0].replace(/,$/, ''))
    .filter((token) => !['PRIMARY', 'FOREIGN'].includes(token));
}

describe('pending_admin_actions / admin_action_signatures — schema parity (static)', () => {
  test('pending_admin_actions has the same columns in both dialects', () => {
    const sqliteCols = extractColumns(SQLITE_MIGRATION, 'pending_admin_actions');
    const pgCols = extractColumns(POSTGRES_MIGRATION, 'pending_admin_actions');
    expect(pgCols).toEqual(sqliteCols);
    // The columns #1017 explicitly required were missing from Postgres before this fix.
    expect(pgCols).toEqual(
      expect.arrayContaining(['id', 'action_type', 'proposer', 'payload', 'required_signatures', 'collected_signatures', 'status', 'expires_at', 'created_at']),
    );
  });

  test('admin_action_signatures exists with the same columns in both dialects', () => {
    const sqliteCols = extractColumns(SQLITE_MIGRATION, 'admin_action_signatures');
    const pgCols = extractColumns(POSTGRES_MIGRATION, 'admin_action_signatures');
    expect(pgCols).toEqual(sqliteCols);
    expect(pgCols).toEqual(expect.arrayContaining(['action_id', 'signer', 'signed_at']));
  });

  test('both dialects enforce one signature per (action_id, signer) via a composite primary key', () => {
    expect(SQLITE_MIGRATION).toMatch(/PRIMARY KEY \(action_id, signer\)/);
    expect(POSTGRES_MIGRATION).toMatch(/PRIMARY KEY \(action_id, signer\)/);
  });
});

describe('admin-action SQL — placeholder conversion', () => {
  // Mirrors the literal SQL strings issued by src/db/index.ts for this
  // subsystem — kept in sync manually since that file has no exported
  // "list of SQL statements" to iterate over.
  const statements = [
    `INSERT INTO pending_admin_actions (id, action_type, proposer, payload, required_signatures, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    `SELECT * FROM pending_admin_actions WHERE id = ?`,
    `SELECT * FROM pending_admin_actions WHERE status = ? ORDER BY created_at DESC`,
    `UPDATE pending_admin_actions SET status = ? WHERE id = ?`,
    `UPDATE pending_admin_actions SET collected_signatures = collected_signatures + 1 WHERE id = ?`,
    `UPDATE pending_admin_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`,
    `INSERT INTO admin_action_signatures (action_id, signer, signed_at) VALUES (?, ?, ?) ON CONFLICT(action_id, signer) DO NOTHING`,
    `SELECT signed_at FROM admin_action_signatures WHERE action_id = ? AND signer = ?`,
    `SELECT signer, signed_at FROM admin_action_signatures WHERE action_id = ? ORDER BY signed_at ASC`,
  ];

  test('every admin-action statement converts to sequential $n placeholders with no bare ? left', () => {
    for (const sql of statements) {
      const converted = convertPlaceholders(sql);
      expect(converted).not.toMatch(/\?/);
      const placeholderCount = (sql.match(/\?/g) || []).length;
      const dollarNumbers = [...converted.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      expect(dollarNumbers).toEqual(Array.from({ length: placeholderCount }, (_, i) => i + 1));
    }
  });

  test("the string literal 'expired' and 'pending' inside the expiry sweep survive conversion untouched", () => {
    const sql = `UPDATE pending_admin_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`;
    const converted = convertPlaceholders(sql);
    expect(converted).toBe(`UPDATE pending_admin_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= $1`);
  });
});

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;
const describeLive = POSTGRES_TEST_URL ? describe : describe.skip;

describeLive('propose → duplicate-detect → quorum flow against real Postgres', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: POSTGRES_TEST_URL });
    await client.connect();
    await client.query('DROP TABLE IF EXISTS admin_action_signatures');
    await client.query('DROP TABLE IF EXISTS pending_admin_actions');
    await client.query(POSTGRES_MIGRATION);
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS admin_action_signatures');
    await client.query('DROP TABLE IF EXISTS pending_admin_actions');
    await client.end();
  });

  async function run(sql: string, params: unknown[]): Promise<{ rowCount: number; rows: Record<string, unknown>[] }> {
    const result = await client.query(convertPlaceholders(sql), params);
    return { rowCount: result.rowCount ?? 0, rows: result.rows };
  }

  test('propose (insert + auto-sign), duplicate re-sign is a no-op, second distinct signer reaches quorum', async () => {
    const actionId = 'pg-parity-action-1';
    const proposer = 'GPROPOSERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const signer2 = 'GSIGNER2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const now = Date.now();

    await run(
      `INSERT INTO pending_admin_actions (id, action_type, proposer, payload, required_signatures, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [actionId, 'pause_contract', proposer, '{}', 2, now + 3_600_000, now],
    );

    // Proposer counts as the first signer.
    const insert1 = await run(
      `INSERT INTO admin_action_signatures (action_id, signer, signed_at) VALUES (?, ?, ?) ON CONFLICT(action_id, signer) DO NOTHING`,
      [actionId, proposer, now],
    );
    expect(insert1.rowCount).toBe(1);
    await run(`UPDATE pending_admin_actions SET collected_signatures = collected_signatures + 1 WHERE id = ?`, [actionId]);

    // Same signer re-approving is a no-op under ON CONFLICT DO NOTHING —
    // this is the exact mechanism approveAction() relies on to detect
    // duplicates without a racy prior SELECT.
    const duplicate = await run(
      `INSERT INTO admin_action_signatures (action_id, signer, signed_at) VALUES (?, ?, ?) ON CONFLICT(action_id, signer) DO NOTHING`,
      [actionId, proposer, Date.now()],
    );
    expect(duplicate.rowCount).toBe(0);

    const afterDuplicate = await run(`SELECT * FROM pending_admin_actions WHERE id = ?`, [actionId]);
    expect(afterDuplicate.rows[0].collected_signatures).toBe(1);

    // A distinct second signer reaches quorum.
    const insert2 = await run(
      `INSERT INTO admin_action_signatures (action_id, signer, signed_at) VALUES (?, ?, ?) ON CONFLICT(action_id, signer) DO NOTHING`,
      [actionId, signer2, Date.now()],
    );
    expect(insert2.rowCount).toBe(1);
    await run(`UPDATE pending_admin_actions SET collected_signatures = collected_signatures + 1 WHERE id = ?`, [actionId]);

    const final = await run(`SELECT * FROM pending_admin_actions WHERE id = ?`, [actionId]);
    expect(final.rows[0].collected_signatures).toBe(2);
    expect(final.rows[0].collected_signatures).toBeGreaterThanOrEqual(final.rows[0].required_signatures as number);

    const signers = await run(`SELECT signer, signed_at FROM admin_action_signatures WHERE action_id = ? ORDER BY signed_at ASC`, [actionId]);
    expect(signers.rows.map((r) => r.signer)).toEqual([proposer, signer2]);

    await run(`UPDATE pending_admin_actions SET status = ? WHERE id = ?`, ['executed', actionId]);
    const executed = await run(`SELECT * FROM pending_admin_actions WHERE id = ?`, [actionId]);
    expect(executed.rows[0].status).toBe('executed');
  });

  test('expiry sweep matches the SQLite dialect semantics', async () => {
    const actionId = 'pg-parity-action-expired';
    const past = Date.now() - 1000;
    await run(
      `INSERT INTO pending_admin_actions (id, action_type, proposer, payload, required_signatures, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [actionId, 'pause_contract', 'GPROPOSERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', '{}', 2, past, past],
    );

    await run(`UPDATE pending_admin_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`, [Date.now()]);

    const result = await run(`SELECT * FROM pending_admin_actions WHERE id = ?`, [actionId]);
    expect(result.rows[0].status).toBe('expired');
  });
});
