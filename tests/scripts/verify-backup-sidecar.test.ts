/**
 * Tests for verify-backup.sh sidecar-fetch error handling (issue #717).
 *
 * Verifies that:
 *   1. A genuinely missing local sidecar is tolerated — verification proceeds
 *      without row-count checks (pre-sidecar backup, legitimate case).
 *   2. A fetch error that is NOT "file not found" causes the script to fail
 *      loudly rather than silently skip verification.
 *
 * We simulate the S3/GCS cases with a stub `aws` / `gsutil` wrapper placed
 * earlier on PATH, which lets us exercise the error-classification logic
 * without a real cloud account.
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const VERIFY_SCRIPT = path.join(REPO_ROOT, 'scripts/verify-backup.sh');
const BACKUP_SCRIPT = path.join(REPO_ROOT, 'scripts/backup-db.sh');
const SQLITE_CLI = path.join(REPO_ROOT, 'scripts/sqlite-cli.sh');
const INITIAL_SCHEMA = path.join(REPO_ROOT, 'db/001_initial.sql');

const isWindows = process.platform === 'win32';

function runSql(dbPath: string, sql: string): void {
  execFileSync('bash', [SQLITE_CLI, dbPath, sql], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function createTestDatabase(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  runSql(dbPath, fs.readFileSync(INITIAL_SCHEMA, 'utf8'));
  runSql(
    dbPath,
    `
      INSERT INTO players (player_id, wallet, created_at)
      VALUES ('p1', 'GWALLET1234567890123456789012345678901234', 1);
      INSERT INTO events (type, ledger, tx_hash, payload)
      VALUES ('register', 1, 'txhash1', '{}');
      CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO migrations (id, applied_at) VALUES ('001_initial.sql', 1);
    `
  );
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

/**
 * Write a stub CLI script (aws or gsutil) into `binDir` that exits with the
 * given `exitCode` and writes `stderr` to standard error.  Returns the PATH
 * value that puts the stub ahead of the real CLI.
 */
function makeStubCli(
  binDir: string,
  cliName: string,
  exitCode: number,
  stderrOutput: string
): string {
  const stub = path.join(binDir, cliName);
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash\necho "${stderrOutput}" >&2\nexit ${exitCode}\n`,
    { mode: 0o755 }
  );
  return `${binDir}:${process.env.PATH ?? ''}`;
}

// ---------------------------------------------------------------------------

(isWindows ? describe.skip : describe)('verify-backup.sh sidecar-fetch error handling', () => {
  let tmpDir: string;
  let dbPath: string;
  let backupDir: string;
  let backupPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-off-717-'));
    dbPath = path.join(tmpDir, 'scout-off.db');
    backupDir = path.join(tmpDir, 'backups');
    createTestDatabase(dbPath);

    // Create a real local backup to use as the backup-under-test.
    execFileSync('bash', [BACKUP_SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, DB_PATH: dbPath, BACKUP_DEST: backupDir },
      encoding: 'utf8',
    });
    backupPath = path.join(
      backupDir,
      fs.readdirSync(backupDir).find((n) => n.endsWith('.db'))!
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Case 1: sidecar genuinely missing (pre-sidecar backup) ───────────────

  it('skips row-count checks when the local sidecar file is absent (tolerable)', () => {
    // Remove the sidecar so this looks like a pre-sidecar backup.
    const countsPath = `${backupPath}.counts`;
    if (fs.existsSync(countsPath)) fs.rmSync(countsPath);

    // Should still exit 0 — integrity_check passes; no row-count check done.
    const output = runScript(VERIFY_SCRIPT, [backupPath]);
    expect(output).toContain('Backup verification succeeded');
    expect(output).toMatch(/sidecar not (found|present)|skipping row-count/i);
  });

  // ── Case 2: fetch fails with a non-404 error (network / auth) ────────────

  it('fails loudly when the S3 sidecar fetch fails with a non-404 error', () => {
    const binDir = path.join(tmpDir, 'stub-bin');
    fs.mkdirSync(binDir, { recursive: true });

    // Stub `aws` to simulate a network/auth error (no "NoSuchKey" in output).
    const stubPath = makeStubCli(
      binDir,
      'aws',
      1,
      'RequestError: send request failed — connection refused'
    );

    const fakeS3Sidecar = 's3://my-bucket/backups/scout-off-20250101T000000Z.db.counts';

    const { stderr, stdout } = runScriptExpectFailure(VERIFY_SCRIPT, [backupPath], {
      COUNTS_FILE: fakeS3Sidecar,
      PATH: stubPath,
    });

    const combined = stderr + stdout;
    expect(combined).toMatch(/ERROR|failed to fetch|fetch.*failed/i);
    // Must NOT silently skip.
    expect(combined).not.toMatch(/skipping row-count spot-checks/);
  });

  it('skips row-count checks (silently tolerated) when S3 returns NoSuchKey (sidecar absent)', () => {
    const binDir = path.join(tmpDir, 'stub-bin-404');
    fs.mkdirSync(binDir, { recursive: true });

    // Stub `aws` to simulate a 404 / NoSuchKey response.
    const stubPath = makeStubCli(binDir, 'aws', 1, 'An error occurred (NoSuchKey) when calling the CopyObject operation');

    const fakeS3Sidecar = 's3://my-bucket/backups/scout-off-old.db.counts';

    // Should succeed — treats NoSuchKey as "sidecar absent, skip silently".
    const output = runScript(VERIFY_SCRIPT, [backupPath], {
      COUNTS_FILE: fakeS3Sidecar,
      PATH: stubPath,
    });

    expect(output).toContain('Backup verification succeeded');
  });

  it('fails loudly when the GCS sidecar fetch fails with a non-404 error', () => {
    const binDir = path.join(tmpDir, 'stub-bin-gcs');
    fs.mkdirSync(binDir, { recursive: true });

    // Stub `gsutil` to simulate a permission/network error.
    const stubPath = makeStubCli(binDir, 'gsutil', 1, 'AccessDeniedException: 403 Forbidden');

    const fakeGCSSidecar = 'gs://my-bucket/backups/scout-off-20250101T000000Z.db.counts';

    const { stderr, stdout } = runScriptExpectFailure(VERIFY_SCRIPT, [backupPath], {
      COUNTS_FILE: fakeGCSSidecar,
      PATH: stubPath,
    });

    const combined = stderr + stdout;
    expect(combined).toMatch(/ERROR|failed to fetch|fetch.*failed/i);
    expect(combined).not.toMatch(/skipping row-count spot-checks/);
  });

  it('skips row-count checks (silently tolerated) when GCS signals the sidecar is absent', () => {
    const binDir = path.join(tmpDir, 'stub-bin-gcs-404');
    fs.mkdirSync(binDir, { recursive: true });

    const stubPath = makeStubCli(binDir, 'gsutil', 1, 'CommandException: No such object: gs://my-bucket/backups/old.db.counts');

    const fakeGCSSidecar = 'gs://my-bucket/backups/old.db.counts';

    const output = runScript(VERIFY_SCRIPT, [backupPath], {
      COUNTS_FILE: fakeGCSSidecar,
      PATH: stubPath,
    });

    expect(output).toContain('Backup verification succeeded');
  });
});
