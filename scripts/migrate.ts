#!/usr/bin/env npx ts-node

import 'dotenv/config';
import path from 'path';
import Database from 'better-sqlite3';
import { PostgresDriver } from '../src/db/postgres-driver';
import { SqliteDriver } from '../src/db/sqlite-driver';
import { runMigrations, RunMigrationsOptions, MigrationDirection } from '../src/db/migrate';
import config from '../src/config';

interface CliOptions {
  direction?: MigrationDirection;
  steps?: number;
  dryRun?: boolean;
  dbPath?: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--direction' || arg === '-d') {
      const value = args[i + 1];
      if (value === 'up' || value === 'down') {
        options.direction = value;
        i++;
      }
    } else if (arg === '--steps' || arg === '-s') {
      const value = args[i + 1];
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed)) {
        options.steps = parsed;
        i++;
      }
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--db-path') {
      options.dbPath = args[i + 1];
      i++;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Usage: npm run migrate -- [options]

Options:
  -d, --direction <up|down>   Migration direction (default: up)
  -s, --steps <number>        Number of migrations to apply/revert (default: all)
  --dry-run                   Print SQL without executing
  --db-path <path>            SQLite database file path (default: scout-off.db)
  -h, --help                  Show this help message

Examples:
  npm run migrate -- --direction up
  npm run migrate -- --direction down --steps 1
  npm run migrate -- --dry-run
  npm run migrate -- --direction up --steps 3 --dry-run
`);
}

async function main(): Promise<void> {
  try {
    const options = parseArgs();

    const direction = options.direction || 'up';
    const steps = options.steps;
    const dryRun = options.dryRun || false;

    let driver: SqliteDriver | PostgresDriver;

    if (config.dbDriver === 'postgres') {
      if (!process.env.DATABASE_URL) {
        console.error('ERROR: DATABASE_URL environment variable is required for PostgreSQL');
        process.exit(1);
      }

      const ssl = process.env.DATABASE_SSL === 'true' 
        ? true 
        : process.env.DATABASE_SSL === 'no-verify' 
          ? 'no-verify' 
          : false;

      driver = new PostgresDriver(process.env.DATABASE_URL, ssl);
      await driver.connect();
    } else {
      const dbPath = options.dbPath || process.env.DB_PATH || 'scout-off.db';
      const db = new Database(dbPath);
      driver = new SqliteDriver(db);
    }

    console.log(`Running migrations: direction=${direction}${steps ? `, steps=${steps}` : ''}${dryRun ? ', dry-run=true' : ''}`);

    const results = await runMigrations(driver, { direction, steps, dryRun });

    if (results.length === 0) {
      console.log('No migrations to apply.');
    } else {
      for (const result of results) {
        if (result.applied) {
          console.log(`${dryRun ? '[DRY RUN] ' : ''}Applied: ${result.filename}`);
        } else {
          console.error(`FAILED: ${result.filename} - ${result.error}`);
        }
      }

      if (!dryRun) {
        console.log(`\nSuccessfully ${direction === 'up' ? 'applied' : 'reverted'} ${results.filter(r => r.applied).length} migration(s).`);
      }
    }

    await driver.close();
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Migration failed:', message);
    process.exit(1);
  }
}

main();