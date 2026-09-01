#!/usr/bin/env npx ts-node

import 'dotenv/config';
import path from 'path';
import Database from 'better-sqlite3';
import { discoverMigrationFiles, getAppliedMigrations, generateStatusReport, formatStatusReport } from '../src/db/migration-status';

/**
 * Main entry point for the migration status script.
 * Connects to the configured database and reports which migrations have been applied vs pending.
 */
async function main(): Promise<void> {
  try {
    // Load or default DB_PATH
    const dbPath = process.env.DB_PATH || 'scout-off.db';

    // Open database connection
    const db = new Database(dbPath);

    // Discover migration files from db/ directory
    const migrationsDir = path.resolve(__dirname, '../db');
    const discoveredFiles = discoverMigrationFiles(migrationsDir);

    // Query applied migrations from the database
    const appliedMigrations = getAppliedMigrations(db);

    // Generate status report
    const report = generateStatusReport(discoveredFiles, appliedMigrations);

    // Format and print output
    const formattedOutput = formatStatusReport(report);
    // eslint-disable-next-line no-console
    console.log(formattedOutput);

    // Close database connection
    db.close();

    process.exit(0);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : JSON.stringify(error);
    // eslint-disable-next-line no-console
    console.error('✗ Error:', message);
    process.exit(1);
  }
}

main();
