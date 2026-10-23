#!/usr/bin/env ts-node
/**
 * Database migration CLI
 *
 * Usage: npm run db:migrate [command]
 *        ts-node --project tsconfig.scripts.json scripts/migrate.ts [command]
 *
 * Commands:
 *   up       Run all pending migrations
 *   status   Show migration status (exit 0 if up-to-date, 2 if behind)
 *   version  Print current schema version (file id of last applied migration)
 *
 * Examples:
 *   npm run db:migrate              # apply all pending migrations
 *   npm run db:migrate:status       # check migration status
 *   npm run db:migrate:version      # show current schema version
 *
 * Exit codes:
 *   0  Success
 *   1  Error (including failed migration)
 *   2  Migrations are behind expected schema (only for status)
 *
 * Logs are emitted as JSON to stdout.
 */

import { runMigrations, getAppliedMigrations, getExpectedSchemaVersion } from '../src/db/migrate';
import Database from 'better-sqlite3';
import { DbDriver } from '../src/db/driver';
import { SqliteDriver } from '../src/db/sqlite-driver';
import { PostgresDriver } from '../src/db/postgres-driver';
import config from '../src/config';
import { logger } from '../src/utils/logger';

interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

function log(level: string, message: string, extra: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...extra
  };
  console.log(JSON.stringify(entry));
}

async function getDriver(): Promise<DbDriver> {
  if (config.dbDriver === 'postgres') {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
    }
    const driver = new PostgresDriver(config.databaseUrl, config.databaseSsl);
    await driver.connect();
    return driver;
  } else {
    const sqliteDriver = new SqliteDriver(new Database(config.dbPath));
    return sqliteDriver;
  }
}

async function cmdUp(): Promise<number> {
  log('info', 'Starting database migrations');
  
  let driver: DbDriver | null = null;
  
  try {
    driver = await getDriver();
    
    const results = await runMigrations(driver);
    const newlyApplied = results.filter((r) => r.applied).map((r) => r.filename);
    
    log('info', `Migration complete. Applied ${newlyApplied.length} migration(s)`);
    
    if (newlyApplied.length > 0) {
      log('info', 'Applied migrations:', { migrations: newlyApplied });
    }
    
    return 0;
  } catch (err) {
    log('error', 'Migration failed', { error: err instanceof Error ? err.message : String(err) });
    return 1;
  } finally {
    if (driver) {
      try {
        await driver.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

async function cmdStatus(): Promise<number> {
  log('info', 'Checking migration status');
  
  let driver: DbDriver | null = null;
  
  try {
    driver = await getDriver();
    
    const applied = [...(await getAppliedMigrations(driver)).keys()].sort();
    const expected = getExpectedSchemaVersion();
    
    log('info', 'Migration status', { 
      appliedCount: applied.length, 
      expectedVersion: expected,
      lastApplied: applied[applied.length - 1] ?? 'none'
    });
    
    if (applied.length < expected.migrations.length) {
      log('warn', 'Schema is behind - pending migrations detected');
      return 2;
    }
    
    log('info', 'Schema is up to date');
    return 0;
  } catch (err) {
    log('error', 'Failed to check migration status', { 
      error: err instanceof Error ? err.message : String(err) 
    });
    return 1;
  } finally {
    if (driver) {
      try {
        await driver.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

async function cmdVersion(): Promise<number> {
  log('info', 'Checking current schema version');
  
  let driver: DbDriver | null = null;
  
  try {
    driver = await getDriver();
    
    const applied = [...(await getAppliedMigrations(driver)).keys()].sort();
    const expected = getExpectedSchemaVersion();
    
    const currentVersion = applied.length > 0 ? applied[applied.length - 1] : 'none';
    const expectedVersion = expected.migrations.length > 0 ? expected.migrations[expected.migrations.length - 1] : 'none';
    
    log('info', 'Schema version info', {
      currentVersion,
      expectedVersion,
      migrationsBehind: Math.max(0, expected.migrations.length - applied.length)
    });
    
    return 0;
  } catch (err) {
    log('error', 'Failed to get schema version', { 
      error: err instanceof Error ? err.message : String(err) 
    });
    return 1;
  } finally {
    if (driver) {
      try {
        await driver.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

// Exported for use in app.ts
export { getAppliedMigrations, getExpectedSchemaVersion };

// Main entry point
const command = process.argv[2] || 'up';

const commands: Record<string, () => Promise<number>> = {
  up: cmdUp,
  status: cmdStatus,
  version: cmdVersion,
};

switch (command) {
  case 'up':
  case 'status':
  case 'version':
    void commands[command]().then((code) => {
      process.exitCode = code;
    });
    break;
  default:
    console.error(JSON.stringify({
      level: 'error',
      message: 'Unknown command. Use "up", "status", or "version"',
      command
    }));
    process.exitCode = 1;
    break;
}
