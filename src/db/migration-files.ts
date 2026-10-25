import fs from 'fs';

export interface MigrationFiles {
  allFiles: string[];
  upFiles: string[];
}

/**
 * True for a Postgres-dialect migration (`NNN_name_postgres.sql` or
 * `NNN_name_postgres.down.sql`). Matches the suffix, not a substring, so a
 * base migration whose name merely contains "_postgres" (e.g.
 * `036_sqlite_postgres_parity.sql`) is still treated as SQLite.
 */
export function isPostgresDialectFile(filename: string): boolean {
  return /_postgres(\.down)?\.sql$/.test(filename);
}

export function getMigrationFiles(migrationsDir: string): MigrationFiles {
  const allFiles = fs
    .readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith('.sql'))
    .sort();

  return {
    allFiles,
    upFiles: allFiles.filter((filename) => !filename.endsWith('.down.sql')),
  };
}
