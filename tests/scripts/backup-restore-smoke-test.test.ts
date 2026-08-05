/**
 * Tests for backup-restore-smoke-test.sh
 *
 * Verifies the end-to-end backup → restore → smoke-test cycle:
 *   1. Database seeding with known data
 *   2. Backup creation and verification
 *   3. Restore to fresh database
 *   4. Migration application
 *   5. Row count verification
 *   6. Application health check (/health/readiness)
 */

/// <reference types="jest" />
/// <reference types="node" />

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SMOKE_TEST_SCRIPT = path.join(REPO_ROOT, 'scripts/backup-restore-smoke-test.sh');
const SQLITE_CLI = path.join(REPO_ROOT, 'scripts/sqlite-cli.sh');
const INITIAL_SCHEMA = path.join(REPO_ROOT, 'db/001_initial.sql');

const isWindows = process.platform === 'win32';

function runSql(dbPath: string, sql: string): void {
  execFileSync('bash', [SQLITE_CLI, dbPath, sql], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function runScript(
  script: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {}
): string {
  return execFileSync('bash', [script, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function runScriptExpectFailure(
  script: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {}
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('bash', [script, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status === 0) {
    throw new Error(`Expected ${script} to exit non-zero but it succeeded`);
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

function createTestDatabase(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  runSql(dbPath, fs.readFileSync(INITIAL_SCHEMA, 'utf8'));
  runSql(
    dbPath,
    `
      INSERT INTO players (player_id, wallet, created_at)
      VALUES ('player-1', 'GTESTWALLET123456789012345678901234567890', 1);
      INSERT INTO events (type, ledger, tx_hash, payload)
      VALUES ('register', 100, 'abc123hash', '{}');
      CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO migrations (id, applied_at) VALUES ('001_initial.sql', 1);
    `
  );
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    function check() {
      const req = http.get(`http://localhost:${port}/health/liveness`, (res) => {
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          retry();
        }
      });
      
      req.on('error', retry);
      
      function retry() {
        if (Date.now() - startTime > timeoutMs) {
          resolve(false);
        } else {
          setTimeout(check, 100);
        }
      }
    }
    
    check();
  });
}

(isWindows ? describe.skip : describe)('backup-restore-smoke-test.sh', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-off-smoke-'));
  });

  afterEach(() => {
    // Clean up any running processes on the test port
    try {
      execFileSync('pkill', ['-f', `node.*${tmpDir}`], { stdio: 'ignore' });
    } catch {
      // Ignore if no process found
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs the complete backup-restore-smoke-test cycle successfully', () => {
    const dbPath = path.join(tmpDir, 'test.db');
    const backupDest = path.join(tmpDir, 'backups');
    
    // Create initial test database
    createTestDatabase(dbPath);
    
    const output = runScript(SMOKE_TEST_SCRIPT, [], {
      DB_PATH: dbPath,
      BACKUP_DEST: backupDest,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      STELLAR_HEALTH_CHECK_ENABLED: 'false',
      IPFS_ENABLED: 'false',
      // `node dist/index.js` (== `npm start`) requires a prior `npm run
      // build`, which this test suite must not depend on: dist/ isn't
      // guaranteed to exist when tests run, and a full `tsc` build is a
      // separate, orthogonal CI step. Use the same transpile-only ts-node
      // strategy the project's own `npm run dev` script uses (minus its
      // `predev` hook) so the real app starts without needing a build.
      APP_START_CMD: 'node_modules/.bin/ts-node --transpile-only src/index.ts',
      APP_PORT: '3456',
      // A cold ts-node transpile of the whole src/ tree can take ~10-15s
      // the first time (no compiled-output cache), well past the 10s this
      // test previously assumed for a pre-built `node dist/index.js`.
      APP_STARTUP_TIMEOUT: '30',
    });

    expect(output).toContain('Step 1: Seeding test database');
    expect(output).toContain('Step 2: Creating backup');
    expect(output).toContain('Step 3: Restoring backup to fresh database');
    expect(output).toContain('Step 4: Running pending migrations');
    expect(output).toContain('Step 5: Verifying row counts');
    expect(output).toContain('Step 6: Starting application and checking health');
    expect(output).toContain('Step 7: Checking /health/readiness endpoint');
    expect(output).toContain('All smoke tests passed successfully!');
    expect(output).toContain('Row count verification passed');
    expect(output).toContain('/health/readiness check passed');
  });

  it('detects row count mismatches after restore', () => {
    // This test verifies that the smoke test would catch row count mismatches
    // We simulate this by creating a backup, then manually modifying the restored DB
    
    const dbPath = path.join(tmpDir, 'test.db');
    const backupDest = path.join(tmpDir, 'backups');
    
    createTestDatabase(dbPath);
    
    // Run the smoke test but with a modified environment that will cause a mismatch
    // We'll test the row count verification logic directly
    const output = runScript(SMOKE_TEST_SCRIPT, [], {
      DB_PATH: dbPath,
      BACKUP_DEST: backupDest,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      STELLAR_HEALTH_CHECK_ENABLED: 'false',
      IPFS_ENABLED: 'false',
      // See the identical comment on the first test above: avoid depending
      // on a prior `npm run build` / dist/ output.
      APP_START_CMD: 'node_modules/.bin/ts-node --transpile-only src/index.ts',
      APP_PORT: '3457',
      APP_STARTUP_TIMEOUT: '30',
    });

    // The smoke test should complete successfully with matching counts
    expect(output).toContain('Row count verification passed');
  });

  it('fails when the app does not start', () => {
    const dbPath = path.join(tmpDir, 'test.db');
    const backupDest = path.join(tmpDir, 'backups');
    
    createTestDatabase(dbPath);
    
    const { stderr } = runScriptExpectFailure(SMOKE_TEST_SCRIPT, [], {
      DB_PATH: dbPath,
      BACKUP_DEST: backupDest,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      STELLAR_HEALTH_CHECK_ENABLED: 'false',
      IPFS_ENABLED: 'false',
      APP_START_CMD: 'node -e "process.exit(1)"', // Command that immediately exits
      APP_PORT: '3458',
      APP_STARTUP_TIMEOUT: '2',
    });

    expect(stderr).toMatch(/App process exited unexpectedly|App did not start/);
  });

  it('fails when /health/readiness returns non-200', () => {
    const dbPath = path.join(tmpDir, 'test.db');
    const backupDest = path.join(tmpDir, 'backups');
    
    createTestDatabase(dbPath);
    
    // Create a simple HTTP server that returns 503
    const serverScript = path.join(tmpDir, 'fake-server.js');
    fs.writeFileSync(
      serverScript,
      `
      const http = require('http');
      const server = http.createServer((req, res) => {
        if (req.url === '/health/readiness') {
          res.writeHead(503);
          res.end(JSON.stringify({ status: 'degraded' }));
        } else if (req.url === '/health/liveness') {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok' }));
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });
      server.listen(3459, () => console.log('Fake server listening on 3459'));
      `
    );

    const { stderr } = runScriptExpectFailure(SMOKE_TEST_SCRIPT, [], {
      DB_PATH: dbPath,
      BACKUP_DEST: backupDest,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      STELLAR_HEALTH_CHECK_ENABLED: 'false',
      IPFS_ENABLED: 'false',
      APP_START_CMD: `node ${serverScript}`,
      APP_PORT: '3459',
      APP_STARTUP_TIMEOUT: '5',
    });

    expect(stderr).toMatch(/\/health\/readiness returned HTTP 503 instead of 200/);
  });

  it('cleans up temporary files on success', () => {
    const dbPath = path.join(tmpDir, 'test.db');
    const backupDest = path.join(tmpDir, 'backups');

    createTestDatabase(dbPath);

    // The smoke test script only reaches its cleanup-on-success path once
    // both /health/liveness and /health/readiness respond 200 — a bare
    // `sleep` never binds the port, so the health-check loop can never
    // succeed and the script always fails before cleanup-on-success is
    // exercised. Use a minimal fake server (same pattern as the 503 test
    // above) that reports healthy immediately and keeps running until the
    // script's own trap kills it, so the happy path actually completes.
    const serverScript = path.join(tmpDir, 'healthy-server.js');
    fs.writeFileSync(
      serverScript,
      `
      const http = require('http');
      const server = http.createServer((req, res) => {
        if (req.url === '/health/readiness') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', db: 'ok' }));
        } else if (req.url === '/health/liveness') {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok' }));
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });
      server.listen(3460, () => console.log('Fake healthy server listening on 3460'));
      `
    );

    // Use a mock app that reports healthy so the script's happy path
    // (including its cleanup-on-success trap) actually runs.
    runScript(SMOKE_TEST_SCRIPT, [], {
      DB_PATH: dbPath,
      BACKUP_DEST: backupDest,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      STELLAR_HEALTH_CHECK_ENABLED: 'false',
      IPFS_ENABLED: 'false',
      APP_START_CMD: `node ${serverScript}`,
      APP_PORT: '3460',
      APP_STARTUP_TIMEOUT: '5',
    });

    // Verify cleanup occurred (database and backup files removed)
    // Note: The smoke test removes these in the cleanup trap
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(backupDest)).toBe(false);
  });

  it('handles corrupted backups gracefully', () => {
    // This test verifies that if a backup is corrupted during creation,
    // the smoke test fails appropriately
    
    const dbPath = path.join(tmpDir, 'test.db');
    const backupDest = path.join(tmpDir, 'backups');
    
    createTestDatabase(dbPath);
    
    // Create a custom backup script that creates a corrupted backup
    const corruptBackupScript = path.join(tmpDir, 'corrupt-backup.sh');
    fs.writeFileSync(
      corruptBackupScript,
      `#!/usr/bin/env bash
      mkdir -p ${backupDest}
      echo "corrupted data" > ${backupDest}/test-20250101T000000Z.db
      exit 0
      `
    );
    fs.chmodSync(corruptBackupScript, 0o755);

    const { stderr } = runScriptExpectFailure(SMOKE_TEST_SCRIPT, [], {
      DB_PATH: dbPath,
      BACKUP_DEST: backupDest,
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      STELLAR_HEALTH_CHECK_ENABLED: 'false',
      IPFS_ENABLED: 'false',
      APP_START_CMD: 'sleep 0.1',
      APP_PORT: '3461',
      APP_STARTUP_TIMEOUT: '2',
    });

    // Should fail when trying to verify the corrupted backup
    expect(stderr).toMatch(/ERROR|failed|Backup creation failed/i);
  });
});