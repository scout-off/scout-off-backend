import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const BACKUP_SCRIPT = path.join(REPO_ROOT, 'scripts/backup-db.sh');
const VERIFY_SCRIPT = path.join(REPO_ROOT, 'scripts/verify-backup.sh');
const SQLITE_CLI = path.join(REPO_ROOT, 'scripts/sqlite-cli.sh');
const INITIAL_SCHEMA = path.join(REPO_ROOT, 'db/001_initial.sql');

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
): string {
  try {
    execFileSync('bash', [script, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    throw new Error(`Expected ${script} to fail`);
  } catch (error: unknown) {
    const execError = error as { status?: number; stderr?: string; stdout?: string };
    if (execError.status === undefined) {
      throw error;
    }
    return `${execError.stderr ?? ''}${execError.stdout ?? ''}`;
  }
}

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
      VALUES ('player-1', 'GTESTWALLET123456789012345678901234567890', 1);
      INSERT INTO events (type, ledger, tx_hash, payload)
      VALUES ('register', 100, 'abc123hash', '{}');
      CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO migrations (id, applied_at) VALUES ('001_initial.sql', 1);
    `
  );
}

const isWindows = process.platform === 'win32';

(isWindows ? describe.skip : describe)('backup-db restore verification', () => {
  let tmpDir: string;
  let dbPath: string;
  let backupDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-off-backup-'));
    dbPath = path.join(tmpDir, 'scout-off.db');
    backupDir = path.join(tmpDir, 'backups');
    createTestDatabase(dbPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a backup, sidecar counts, and verifies it automatically', () => {
    const output = runScript(BACKUP_SCRIPT, [], {
      DB_PATH: dbPath,
      BACKUP_DEST: backupDir,
    });

    const backups = fs.readdirSync(backupDir).filter((name) => name.endsWith('.db'));
    expect(backups).toHaveLength(1);

    const backupPath = path.join(backupDir, backups[0]);
    const countsPath = `${backupPath}.counts`;

    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.existsSync(countsPath)).toBe(true);
    expect(fs.readFileSync(countsPath, 'utf8')).toContain('players=1');
    expect(output).toContain('PRAGMA integrity_check passed');
    expect(output).toContain('Backup verified successfully');
  });

  it('runs standalone verification against an existing local backup', () => {
    runScript(BACKUP_SCRIPT, [], {
      DB_PATH: dbPath,
      BACKUP_DEST: backupDir,
    });

    const backupPath = path.join(backupDir, fs.readdirSync(backupDir).find((n) => n.endsWith('.db'))!);
    const output = runScript(BACKUP_SCRIPT, ['--verify-only', backupPath]);

    expect(output).toContain('Backup verification succeeded');
  });

  it('detects a deliberately corrupted backup during standalone verification', () => {
    runScript(BACKUP_SCRIPT, [], {
      DB_PATH: dbPath,
      BACKUP_DEST: backupDir,
    });

    const backupPath = path.join(backupDir, fs.readdirSync(backupDir).find((n) => n.endsWith('.db'))!);
    const corruptedPath = path.join(tmpDir, 'corrupted.db');
    const backupBytes = fs.readFileSync(backupPath);
    fs.writeFileSync(corruptedPath, backupBytes.subarray(0, 100));

    const output = runScriptExpectFailure(VERIFY_SCRIPT, [corruptedPath]);

    expect(output).toMatch(/integrity_check failed|ERROR/i);
  });

  it('detects row-count drift when expected counts do not match the backup', () => {
    runScript(BACKUP_SCRIPT, [], {
      DB_PATH: dbPath,
      BACKUP_DEST: backupDir,
    });

    const backupPath = path.join(backupDir, fs.readdirSync(backupDir).find((n) => n.endsWith('.db'))!);
    const output = runScriptExpectFailure(VERIFY_SCRIPT, [backupPath], {
      EXPECT_PLAYERS: '999',
      EXPECT_EVENTS: '0',
      EXPECT_MIGRATIONS: '0',
    });

    expect(output).toContain('players row count mismatch');
  });

  // ── Issue #716: table_count() must fail loudly on query errors ─────────────

  it('fails loudly when the source DB is inaccessible (table_count failure)', () => {
    // Simulate an inaccessible database by pointing DB_PATH at a
    // plain text file that SQLite cannot open.  sqlite-cli.sh will exit
    // non-zero, and the updated table_count() must propagate that as a
    // hard failure rather than silently recording "0".
    const notADb = path.join(tmpDir, 'not-a-db.db');
    fs.writeFileSync(notADb, 'this is not a sqlite database\n');

    const output = runScriptExpectFailure(BACKUP_SCRIPT, [], {
      DB_PATH: notADb,
      BACKUP_DEST: backupDir,
    });

    // The script must exit non-zero (runScriptExpectFailure guarantees that)
    // and must emit an error message — NOT silently create a "successful" backup.
    expect(output).toMatch(/ERROR|table_count|query failed/i);
    // No backup file should have been created.
    const backups = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((n) => n.endsWith('.db'))
      : [];
    expect(backups).toHaveLength(0);
  });

  it('correctly records a genuine zero-row count without treating it as a failure', () => {
    // Create a valid database with an empty (zero-row) players table so we
    // can confirm that a real 0 still works — only query *errors* should fail.
    const emptyDbPath = path.join(tmpDir, 'empty-players.db');
    runSql(emptyDbPath, fs.readFileSync(INITIAL_SCHEMA, 'utf8'));
    // Add migrations table but leave players empty.
    runSql(emptyDbPath, `
      CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO migrations (id, applied_at) VALUES ('001_initial.sql', 1);
      INSERT INTO events (type, ledger, tx_hash, payload)
      VALUES ('register', 1, 'txhash1', '{}');
    `);

    const emptyBackupDir = path.join(tmpDir, 'empty-backups');
    const output = runScript(BACKUP_SCRIPT, [], {
      DB_PATH: emptyDbPath,
      BACKUP_DEST: emptyBackupDir,
    });

    // Should succeed — 0 players is a valid state.
    expect(output).toContain('Backup verified successfully');
    const countsPath = path.join(
      emptyBackupDir,
      fs.readdirSync(emptyBackupDir).find((n) => n.endsWith('.counts'))!
    );
    expect(fs.readFileSync(countsPath, 'utf8')).toContain('players=0');
  });
});
