import Database from 'better-sqlite3';
import fs from 'fs';

/**
 * Represents a discovered migration file in the db/ directory.
 */
export interface MigrationFile {
  /** The filename (e.g., "001_initial.sql") */
  filename: string;
  /** The full filesystem path to the migration file */
  path: string;
  /** The sequence number parsed from the filename prefix (e.g., 1 for "001_initial.sql") */
  sequence: number;
}

/**
 * Represents a migration with its discovered and applied status.
 * Extends MigrationFile with status information from the database.
 */
export interface DiscoveredMigration extends MigrationFile {
  /** The Unix timestamp (milliseconds) when this migration was applied, or null if pending */
  appliedAt: number | null;
  /** The status of the migration: "applied" if in the database, "pending" if not */
  status: 'applied' | 'pending';
}

/**
 * A complete status report combining discovered migration files with their applied status.
 */
export interface StatusReport {
  /** Total count of discovered migration files in the db/ directory */
  totalDiscovered: number;
  /** Count of migrations that have been applied to the database */
  appliedCount: number;
  /** Count of migrations that are pending (not yet applied) */
  pendingCount: number;
  /** Array of all discovered migrations with their status, sorted alphabetically by filename */
  migrations: DiscoveredMigration[];
  /** Unix timestamp (milliseconds) when this report was generated */
  timestamp: number;
}

/**
 * Discovers all .sql files in the migration directory.
 * Returns filenames sorted alphabetically, consistent with src/db/migrate.ts.
 *
 * @param migrationsDir - The directory path to scan for migration files
 * @returns Array of discovered migration filenames, sorted alphabetically
 * @throws Error if the directory cannot be read
 */
export function discoverMigrationFiles(migrationsDir: string): string[] {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files;
}

/**
 * Queries the migrations table for all applied migrations.
 * Returns a Map keyed by migration filename with the applied_at timestamp as the value.
 * Handles the case when the migrations table doesn't exist by returning an empty Map.
 *
 * @param db - The better-sqlite3 database connection
 * @returns Map<filename, appliedAt timestamp>, or empty Map if no migrations applied or table doesn't exist
 */
export function getAppliedMigrations(
  db: Database.Database
): Map<string, number> {
  const result = new Map<string, number>();

  try {
    const stmt = db.prepare('SELECT id, applied_at FROM migrations');
    const rows = stmt.all() as Array<{ id: string; applied_at: number }>;

    for (const row of rows) {
      result.set(row.id, row.applied_at);
    }
  } catch (error) {
    // If the migrations table doesn't exist, catch the error and return empty Map
    // This handles fresh databases where runMigrations() hasn't been called yet.
    //
    // NOTE: deliberately duck-type on `.message` instead of gating with
    // `error instanceof Error`. better-sqlite3's SqliteError is a native-addon
    // error class; under test runners (e.g. Jest) that isolate each test file
    // in its own VM realm, an error constructed against one realm's Error
    // prototype can legitimately fail `instanceof Error` when observed from
    // another realm, even though it is a bona fide error with a `.message`.
    const message =
      typeof (error as { message?: unknown })?.message === 'string'
        ? (error as { message: string }).message
        : undefined;
    if (
      message !== undefined &&
      (message.includes('no such table') ||
        message.includes('SQLITE_NOTFOUND'))
    ) {
      return result;
    }
    // Re-throw unexpected errors
    throw error;
  }

  return result;
}

/**
 * Generates a status report by comparing discovered migration files
 * against applied migrations from the database.
 *
 * @param discoveredFiles - Array of discovered migration filenames
 * @param appliedMigrations - Map of filename -> appliedAt timestamp for applied migrations
 * @returns StatusReport with computed status and counts
 */
export function generateStatusReport(
  discoveredFiles: string[],
  appliedMigrations: Map<string, number>
): StatusReport {
  const migrations: DiscoveredMigration[] = [];
  let appliedCount = 0;

  // Process each discovered file
  for (const filename of discoveredFiles) {
    const appliedAt = appliedMigrations.get(filename);
    const isApplied = appliedAt !== undefined;

    if (isApplied) {
      appliedCount++;
    }

    const migration: DiscoveredMigration = {
      filename,
      path: filename, // Note: path will be set to filename here; full path not needed for status report
      sequence: extractSequence(filename),
      appliedAt: appliedAt ?? null,
      status: isApplied ? 'applied' : 'pending',
    };

    migrations.push(migration);
  }

  const pendingCount = discoveredFiles.length - appliedCount;

  return {
    totalDiscovered: discoveredFiles.length,
    appliedCount,
    pendingCount,
    migrations,
    timestamp: Date.now(),
  };
}

/**
 * Extracts the sequence number from a migration filename.
 * For example, "001_initial.sql" returns 1, "002_audit_log.sql" returns 2.
 *
 * @param filename - The migration filename
 * @returns The sequence number, or 0 if unable to extract
 */
function extractSequence(filename: string): number {
  const match = filename.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Formats a status report as a human-readable string with summary and table.
 * Includes summary line showing applied/pending counts and a formatted table
 * with Migration ID, Status, and Applied Timestamp columns.
 *
 * @param report - The StatusReport to format
 * @returns Formatted string suitable for console output
 */
export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = [];

  // Header
  lines.push('Migration Status Report');
  lines.push('═════════════════════════════════════════════════════════════════════');
  lines.push('');

  // Summary line
  lines.push(
    `Status: ${report.appliedCount} applied, ${report.pendingCount} pending`
  );
  lines.push('');

  // Table header
  const colMigration = 'Migration';
  const colStatus = 'Status';
  const colTimestamp = 'Applied At';

  const colWidths = {
    migration: Math.max(32, colMigration.length),
    status: Math.max(12, colStatus.length),
    timestamp: Math.max(20, colTimestamp.length),
  };

  // Build table
  lines.push(
    `┌─${'-'.repeat(colWidths.migration)}─┬─${'-'.repeat(colWidths.status)}─┬─${'-'.repeat(colWidths.timestamp)}─┐`
  );
  lines.push(
    `│ ${colMigration.padEnd(colWidths.migration)} │ ${colStatus.padEnd(colWidths.status)} │ ${colTimestamp.padEnd(colWidths.timestamp)} │`
  );
  lines.push(
    `├─${'-'.repeat(colWidths.migration)}─┼─${'-'.repeat(colWidths.status)}─┼─${'-'.repeat(colWidths.timestamp)}─┤`
  );

  // Table rows
  for (const migration of report.migrations) {
    const statusIcon =
      migration.status === 'applied' ? '✓ Applied' : '⧬ Pending';
    const timestamp =
      migration.appliedAt !== null
        ? new Date(migration.appliedAt).toISOString().replace('T', ' ').slice(0, 19)
        : '—';

    lines.push(
      `│ ${migration.filename.padEnd(colWidths.migration)} │ ${statusIcon.padEnd(colWidths.status)} │ ${timestamp.padEnd(colWidths.timestamp)} │`
    );
  }

  lines.push(
    `└─${'-'.repeat(colWidths.migration)}─┴─${'-'.repeat(colWidths.status)}─┴─${'-'.repeat(colWidths.timestamp)}─┘`
  );

  return lines.join('\n');
}
