import fs from 'fs';
import path from 'path';
import { DbDriver, DbTxHandle } from './driver';
import { PostgresDriver } from './postgres-driver';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db');

export type MigrationDirection = 'up' | 'down';

export interface MigrationResult {
  filename: string;
  sql: string;
  applied: boolean;
  error?: string;
}

export interface RunMigrationsOptions {
  direction?: MigrationDirection;
  steps?: number;
  dryRun?: boolean;
}

/**
 * Dialect selection is derived from the `driver` instance actually passed
 * in, not from the process-wide config.dbDriver — callers (notably tests)
 * legitimately construct a SqliteDriver directly regardless of what
 * DB_DRIVER is set to for the rest of the process, and applying
 * PostgreSQL-dialect migration SQL against a real SQLite connection in
 * that case throws a syntax error (e.g. "near EXISTS").
 */
function isPostgresDriver(driver: DbDriver): boolean {
  return driver instanceof PostgresDriver;
}

export async function runMigrations(
  driver: DbDriver,
  options: RunMigrationsOptions = {},
): Promise<MigrationResult[]> {
  const { direction = 'up', steps, dryRun = false } = options;
  return processMigrations(driver, { direction, steps, dryRun });
}

async function processMigrations(
  driver: DbDriver,
  options: RunMigrationsOptions,
): Promise<MigrationResult[]> {
  const { direction = 'up', steps, dryRun = false } = options;

  await ensureMigrationHistoryTable(driver, dryRun);

  const allFiles = fs.readdirSync(MIGRATIONS_DIR).sort();

  const migrationFiles = allFiles.filter(
    (f) => f.endsWith('.sql') && !f.endsWith('.down.sql')
  );

  if (direction === 'up') {
    return processUpMigrations(driver, migrationFiles, allFiles, steps, dryRun);
  } else {
    return processDownMigrations(driver, migrationFiles, allFiles, steps, dryRun);
  }
}

async function ensureMigrationHistoryTable(driver: DbDriver, dryRun: boolean): Promise<void> {
  // applied_at stores Date.now() (a millisecond epoch, ~1.7e12) — Postgres's
  // 32-bit INTEGER tops out at ~2.1e9, so every migration's tracking INSERT
  // would overflow and roll back the whole transaction (including the
  // schema changes it was wrapped with), leaving every migration silently
  // unapplied. SQLite's INTEGER is dynamically 64-bit regardless, so this
  // only matters for Postgres, but BIGINT is correct for both.
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    );
  `;

  if (!dryRun) {
    await driver.exec(createTableSql);
  } else {
    console.log('[DRY RUN] Would execute:', createTableSql);
  }
}

function getDownMigrationFile(allFiles: string[], upFilename: string): string | null {
  const downFilename = upFilename.replace('.sql', '.down.sql');
  if (allFiles.includes(downFilename)) {
    return downFilename;
  }
  return null;
}

/**
 * Find the dialect counterpart of a migration file (e.g. `021_foo.sql` ↔
 * `021_foo_postgres.sql`), if one exists on disk.
 *
 * Used to avoid running a wrong-dialect file through the regex-based
 * convertSqlToPostgres/convertPostgresToSqlite converters when a dedicated,
 * hand-written file for the current driver's dialect already exists — that
 * converter only handles simple syntax substitution (types, INSERT OR
 * IGNORE, datetime()) and cannot translate real dialect-specific logic
 * (e.g. SQLite's json_extract() vs Postgres's ->> operator), so forcing it
 * to run the "shadow" file anyway is both redundant (the real work is
 * already covered by the dedicated file) and fragile (it can fail outright
 * on anything beyond trivial syntax differences).
 */
function getDialectCounterpart(filename: string, allFiles: string[]): string | null {
  const counterpart = filename.includes('_postgres')
    ? filename.replace('_postgres.sql', '.sql')
    : filename.replace('.sql', '_postgres.sql');
  return allFiles.includes(counterpart) ? counterpart : null;
}

async function processUpMigrations(
  driver: DbDriver,
  migrationFiles: string[],
  allFiles: string[],
  steps?: number,
  dryRun: boolean = false
): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];
  const isPostgres = isPostgresDriver(driver);

  const appliedMigrations = await getAppliedMigrations(driver);
  const pendingFiles = migrationFiles.filter((f) => !appliedMigrations.has(f));

  const maxSteps = steps !== undefined ? steps : pendingFiles.length;
  const filesToApply = pendingFiles.slice(0, maxSteps);

  for (const filename of filesToApply) {
    const isPostgresFile = filename.includes('_postgres');
    const dialectMismatch = isPostgresFile !== isPostgres;

    // A dedicated, correctly-dialected file for this migration already
    // exists — skip running this one through the best-effort regex
    // converter (see getDialectCounterpart) and just record it as applied
    // so it isn't retried on every future startup.
    if (dialectMismatch && getDialectCounterpart(filename, allFiles)) {
      if (dryRun) {
        console.log('[DRY RUN] Would skip (dialect counterpart exists):', filename);
        results.push({ filename, sql: '', applied: true });
        continue;
      }
      await driver.run(
        'INSERT INTO migrations (id, applied_at) VALUES (?, ?)',
        [filename, Date.now()]
      );
      results.push({ filename, sql: '', applied: true });
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    let finalSql: string;

    if (isPostgres) {
      finalSql = isPostgresFile ? sql : convertSqlToPostgres(sql);
    } else {
      finalSql = isPostgresFile ? convertPostgresToSqlite(sql) : sql;
    }

    if (dryRun) {
      console.log('[DRY RUN] Would apply migration:', filename);
      console.log('[DRY RUN] SQL:', finalSql);

      results.push({
        filename,
        sql: finalSql,
        applied: true,
      });
      continue;
    }

    try {
      await driver.transaction(async (tx: DbTxHandle) => {
        await tx.exec(finalSql);
        await tx.run(
          'INSERT INTO migrations (id, applied_at) VALUES (?, ?)',
          [filename, Date.now()]
        );
      });

      results.push({
        filename,
        sql: finalSql,
        applied: true,
      });
    } catch (error) {
      // Some migration files ADD COLUMN a column that a later change to the
      // inline schema in initDb() started creating from the start (e.g.
      // 014_indexer_reorgs.sql's `ledger_hash` is already part of the
      // `events` table definition). On a fresh :memory: test DB the column
      // already exists, so treat "duplicate column" as success. Also covers
      // the base/`_postgres` pair for the same logical migration both being
      // applied (each is tracked as its own id in `migrations`) — the
      // second one hits "already exists" on its CREATE TABLE/ADD COLUMN and
      // is likewise treated as a no-op success.
      const message = error instanceof Error ? error.message : String(error);
      const isDuplicateColumn = /duplicate column name|already exists/i.test(message);
      const isCrossDriverFile = isPostgresFile && !isPostgres;
      if (isCrossDriverFile || isDuplicateColumn) {
        await driver.run(
          'INSERT INTO migrations (id, applied_at) VALUES (?, ?)',
          [filename, Date.now()]
        );
        results.push({
          filename,
          sql: finalSql,
          applied: true,
        });
      } else {
        results.push({
          filename,
          sql: finalSql,
          applied: false,
          error: message,
        });
      }
    }
  }

  return results;
}

async function processDownMigrations(
  driver: DbDriver,
  migrationFiles: string[],
  allFiles: string[],
  steps?: number,
  dryRun: boolean = false
): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];
  const isPostgres = isPostgresDriver(driver);

  const appliedMigrations = await getAppliedMigrations(driver);
  const appliedUpFiles = migrationFiles.filter((f) => appliedMigrations.has(f));

  const maxSteps = steps !== undefined ? steps : appliedUpFiles.length;
  const filesToRevert = appliedUpFiles.slice(-maxSteps).reverse();

  for (const filename of filesToRevert) {
    const downFile = getDownMigrationFile(allFiles, filename);

    if (!downFile) {
      results.push({
        filename: filename.replace('.sql', '.down.sql'),
        sql: '',
        applied: false,
        error: `No down-migration file found for ${filename}`,
      });
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, downFile), 'utf8');
    const isPostgresFile = downFile.includes('_postgres');
    let finalSql: string;

    if (isPostgres) {
      finalSql = isPostgresFile ? sql : convertSqlToPostgres(sql);
    } else {
      finalSql = isPostgresFile ? convertPostgresToSqlite(sql) : sql;
    }

    if (dryRun) {
      console.log('[DRY RUN] Would revert migration:', filename);
      console.log('[DRY RUN] SQL:', finalSql);

      results.push({
        filename: downFile,
        sql: finalSql,
        applied: true,
      });
      continue;
    }

    try {
      await driver.transaction(async (tx: DbTxHandle) => {
        await tx.exec(finalSql);
        await tx.run('DELETE FROM migrations WHERE id = ?', [filename]);
      });

      results.push({
        filename: downFile,
        sql: finalSql,
        applied: true,
      });
    } catch (error) {
      const isCrossDriverFile = isPostgresFile && !isPostgres;
      if (isCrossDriverFile) {
        await driver.run('DELETE FROM migrations WHERE id = ?', [filename]);
        results.push({
          filename: downFile,
          sql: finalSql,
          applied: true,
        });
      } else {
        results.push({
          filename: downFile,
          sql: finalSql,
          applied: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return results;
}

async function getAppliedMigrations(driver: DbDriver): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  try {
    const rows = await driver.all<{ id: string; applied_at: number }>(
      'SELECT id, applied_at FROM migrations'
    );

    for (const row of rows) {
      result.set(row.id, row.applied_at);
    }
  } catch (error) {
    if (isNoSuchTableError(error)) {
      return result;
    }
    throw error;
  }

  return result;
}

function isNoSuchTableError(error: unknown): boolean {
  // Deliberately duck-type on `.message` instead of gating with
  // `error instanceof Error` — see the identical note in
  // migration-status.ts's getAppliedMigrations(). Native-addon error classes
  // (e.g. better-sqlite3's SqliteError) can fail `instanceof Error` across
  // VM realms (as Jest creates per test file) despite being real errors.
  const message = (error as { message?: unknown })?.message;

  return (
    typeof message === 'string' &&
    (message.includes('no such table') ||
      message.includes('SQLITE_NOTFOUND') ||
      message.includes('relation "migrations" does not exist') ||
      message.includes('undefined table "migrations"'))
  );
}

/**
 * Convert SQLite SQL to PostgreSQL SQL.
 * Handles common dialect differences.
 */
function convertSqlToPostgres(sql: string): string {
  let converted = sql;

  converted = converted.replace(
    /INTEGER PRIMARY KEY AUTOINCREMENT/gi,
    'SERIAL PRIMARY KEY'
  );

  converted = converted.replace(
    /INSERT OR IGNORE INTO/gi,
    'INSERT INTO'
  );

  if (!converted.includes('ON CONFLICT')) {
    converted = converted.replace(
      /INSERT INTO ([a-z_]+) \(([^)]+)\) VALUES/gi,
      (match, table, columns) => {
        if (sql.includes('INSERT OR IGNORE')) {
          return match + ' ON CONFLICT DO NOTHING ';
        }
        return match;
      }
    );
  }

  converted = converted.replace(/datetime\('now'\)/gi, "now()");

  return converted;
}

function convertPostgresToSqlite(sql: string): string {
  let converted = sql;

  converted = converted.replace(
    /SERIAL\s+PRIMARY\s+KEY/gi,
    'INTEGER PRIMARY KEY AUTOINCREMENT'
  );

  converted = converted.replace(/\bBIGINT\b/gi, 'INTEGER');

  converted = converted.replace(/\bBOOLEAN\b/gi, 'INTEGER');
  converted = converted.replace(/DEFAULT\s+FALSE/gi, 'DEFAULT 0');
  converted = converted.replace(/DEFAULT\s+TRUE/gi, 'DEFAULT 1');

  converted = converted.replace(/ALTER\s+TABLE\s+IF\s+EXISTS/gi, 'ALTER TABLE');
  converted = converted.replace(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/gi, 'ADD COLUMN');

  return converted;
}
