import fs from 'fs';
import path from 'path';
import { DbDriver } from './driver';
import config from '../config';

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

export function runMigrations(driver: DbDriver, options: RunMigrationsOptions = {}): MigrationResult[] {
  const { direction = 'up', steps, dryRun = false } = options;

  const results: MigrationResult[] = [];

  const processed = processMigrations(driver, { direction, steps, dryRun });
  results.push(...processed);

  return results;
}

function processMigrations(
  driver: DbDriver,
  options: RunMigrationsOptions
): MigrationResult[] {
  const { direction = 'up', steps, dryRun = false } = options;

  ensureMigrationHistoryTable(driver, dryRun);

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

function ensureMigrationHistoryTable(driver: DbDriver, dryRun: boolean): void {
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `;

  if (!dryRun) {
    driver.exec(createTableSql);
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

function processUpMigrations(
  driver: DbDriver,
  migrationFiles: string[],
  allFiles: string[],
  steps?: number,
  dryRun: boolean = false
): MigrationResult[] {
  const results: MigrationResult[] = [];

  const appliedMigrations = getAppliedMigrations(driver);
  const pendingFiles = migrationFiles.filter((f) => !appliedMigrations.has(f));

  const maxSteps = steps !== undefined ? steps : pendingFiles.length;
  const filesToApply = pendingFiles.slice(0, maxSteps);

  for (const filename of filesToApply) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    const isPostgresFile = filename.includes('_postgres');
    let finalSql: string;

    if (config.dbDriver === 'postgres') {
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
      driver.transaction(() => {
        driver.exec(finalSql);
        driver.run(
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
      // already exists, so treat "duplicate column" as success.
      const message = error instanceof Error ? error.message : String(error);
      const isDuplicateColumn = /duplicate column name|already exists/i.test(message);
      const isCrossDriverFile = isPostgresFile && config.dbDriver !== 'postgres';
      if (isCrossDriverFile || isDuplicateColumn) {
        driver.run(
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

function processDownMigrations(
  driver: DbDriver,
  migrationFiles: string[],
  allFiles: string[],
  steps?: number,
  dryRun: boolean = false
): MigrationResult[] {
  const results: MigrationResult[] = [];

  const appliedMigrations = getAppliedMigrations(driver);
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

    if (config.dbDriver === 'postgres') {
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
      driver.transaction(() => {
        driver.exec(finalSql);
        driver.run('DELETE FROM migrations WHERE id = ?', [filename]);
      });

      results.push({
        filename: downFile,
        sql: finalSql,
        applied: true,
      });
    } catch (error) {
      const isCrossDriverFile = isPostgresFile && config.dbDriver !== 'postgres';
      if (isCrossDriverFile) {
        driver.run('DELETE FROM migrations WHERE id = ?', [filename]);
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

function getAppliedMigrations(driver: DbDriver): Map<string, number> {
  const result = new Map<string, number>();

  try {
    const rows = driver.all<{ id: string; applied_at: number }>(
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
