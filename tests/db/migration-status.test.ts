import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import {
  discoverMigrationFiles,
  getAppliedMigrations,
  generateStatusReport,
} from '../../src/db/migration-status';

describe('discoverMigrationFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-test-'));
  });

  afterEach(() => {
    // Clean up the temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty array for empty directory', () => {
    const result = discoverMigrationFiles(tempDir);
    expect(result).toEqual([]);
  });

  it('filters for .sql files only', () => {
    // Create mixed files
    fs.writeFileSync(path.join(tempDir, '001_initial.sql'), '');
    fs.writeFileSync(path.join(tempDir, 'README.md'), '');
    fs.writeFileSync(path.join(tempDir, 'config.json'), '');
    fs.writeFileSync(path.join(tempDir, '002_audit.sql'), '');

    const result = discoverMigrationFiles(tempDir);
    expect(result).toHaveLength(2);
    expect(result).toContain('001_initial.sql');
    expect(result).toContain('002_audit.sql');
    expect(result).not.toContain('README.md');
    expect(result).not.toContain('config.json');
  });

  it('returns files sorted alphabetically', () => {
    // Create files in non-alphabetical order
    fs.writeFileSync(path.join(tempDir, '003_tables.sql'), '');
    fs.writeFileSync(path.join(tempDir, '001_initial.sql'), '');
    fs.writeFileSync(path.join(tempDir, '002_audit_log.sql'), '');
    fs.writeFileSync(path.join(tempDir, '002_validators.sql'), '');

    const result = discoverMigrationFiles(tempDir);
    expect(result).toEqual([
      '001_initial.sql',
      '002_audit_log.sql',
      '002_validators.sql',
      '003_tables.sql',
    ]);
  });

  it('handles directory with only non-.sql files', () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), '');
    fs.writeFileSync(path.join(tempDir, 'notes.txt'), '');
    fs.writeFileSync(path.join(tempDir, 'data.json'), '');

    const result = discoverMigrationFiles(tempDir);
    expect(result).toEqual([]);
  });

  it('handles mixed case correctly in sorting', () => {
    // Create files that test case-sensitive sorting
    fs.writeFileSync(path.join(tempDir, 'a_lowercase.sql'), '');
    fs.writeFileSync(path.join(tempDir, 'A_uppercase.sql'), '');
    fs.writeFileSync(path.join(tempDir, '1_number.sql'), '');

    const result = discoverMigrationFiles(tempDir);
    // JavaScript's default string sort is case-sensitive, numbers sort before letters
    expect(result[0]).toBe('1_number.sql');
    // Uppercase comes before lowercase in ASCII sorting
    expect(result.includes('A_uppercase.sql'));
    expect(result.includes('a_lowercase.sql'));
  });

  it('returns filenames only, not full paths', () => {
    fs.writeFileSync(path.join(tempDir, '001_initial.sql'), '');
    fs.writeFileSync(path.join(tempDir, '002_audit.sql'), '');

    const result = discoverMigrationFiles(tempDir);
    result.forEach((file) => {
      expect(file).not.toContain(path.sep);
      expect(file).not.toContain('/');
    });
  });

  it('throws an error when directory does not exist', () => {
    const nonexistentDir = path.join(tempDir, 'does-not-exist');
    expect(() => {
      discoverMigrationFiles(nonexistentDir);
    }).toThrow();
  });
});

describe('discoverMigrationFiles - integration with real db/', () => {
  it('discovers all .sql files from the actual db/ directory', () => {
    const dbDir = path.resolve(__dirname, '../../db');
    const result = discoverMigrationFiles(dbDir);

    // Should find migration files
    expect(result.length).toBeGreaterThan(0);

    // All results should be .sql files
    result.forEach((file) => {
      expect(file).toMatch(/\.sql$/);
    });

    // Should be sorted alphabetically
    const sorted = [...result].sort();
    expect(result).toEqual(sorted);

    // Should contain known migrations
    expect(result).toContain('001_initial.sql');
    expect(result).toContain('002_audit_log.sql');
  });
});

describe('getAppliedMigrations', () => {
  let db: Database.Database;
  let tempDb: string;

  beforeEach(() => {
    // Create a temporary in-memory database for each test
    tempDb = path.join(os.tmpdir(), `test-migrations-${Date.now()}.db`);
    db = new Database(tempDb);
  });

  afterEach(() => {
    // Close the database and clean up the temp file
    db.close();
    if (fs.existsSync(tempDb)) {
      fs.unlinkSync(tempDb);
    }
  });

  it('returns empty Map for fresh database with no migrations table', () => {
    const result = getAppliedMigrations(db);

    expect(result).toEqual(new Map());
    expect(result.size).toBe(0);
  });

  it('returns empty Map when migrations table exists but is empty', () => {
    // Create the migrations table but don't insert any records
    db.exec(`
      CREATE TABLE migrations (
        id         TEXT    PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    const result = getAppliedMigrations(db);

    expect(result).toEqual(new Map());
    expect(result.size).toBe(0);
  });

  it('returns Map with single applied migration', () => {
    // Create the migrations table and insert one record
    db.exec(`
      CREATE TABLE migrations (
        id         TEXT    PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    const timestamp = Date.now();
    db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(
      '001_initial.sql',
      timestamp
    );

    const result = getAppliedMigrations(db);

    expect(result.size).toBe(1);
    expect(result.get('001_initial.sql')).toBe(timestamp);
  });

  it('returns Map with multiple applied migrations', () => {
    // Create the migrations table and insert multiple records
    db.exec(`
      CREATE TABLE migrations (
        id         TEXT    PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    const timestamp1 = 1000000;
    const timestamp2 = 2000000;
    const timestamp3 = 3000000;

    db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(
      '001_initial.sql',
      timestamp1
    );
    db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(
      '002_audit_log.sql',
      timestamp2
    );
    db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(
      '003_tables.sql',
      timestamp3
    );

    const result = getAppliedMigrations(db);

    expect(result.size).toBe(3);
    expect(result.get('001_initial.sql')).toBe(timestamp1);
    expect(result.get('002_audit_log.sql')).toBe(timestamp2);
    expect(result.get('003_tables.sql')).toBe(timestamp3);
  });

  it('returns correct Map with correct timestamp values', () => {
    db.exec(`
      CREATE TABLE migrations (
        id         TEXT    PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    const now = Date.now();
    db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(
      'test_migration.sql',
      now
    );

    const result = getAppliedMigrations(db);
    const retrievedTimestamp = result.get('test_migration.sql');

    expect(retrievedTimestamp).toBe(now);
  });

  it('handles migration with special characters in filename', () => {
    db.exec(`
      CREATE TABLE migrations (
        id         TEXT    PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    const timestamp = Date.now();
    const specialFilename = '002_player_profile_history.sql';

    db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(
      specialFilename,
      timestamp
    );

    const result = getAppliedMigrations(db);

    expect(result.get(specialFilename)).toBe(timestamp);
  });
});

describe('generateStatusReport', () => {
  it('returns correct counts for all applied migrations', () => {
    const discoveredFiles = [
      '001_initial.sql',
      '002_audit_log.sql',
      '003_tables.sql',
    ];

    const appliedMigrations = new Map<string, number>([
      ['001_initial.sql', 1000000],
      ['002_audit_log.sql', 2000000],
      ['003_tables.sql', 3000000],
    ]);

    const report = generateStatusReport(discoveredFiles, appliedMigrations);

    expect(report.totalDiscovered).toBe(3);
    expect(report.appliedCount).toBe(3);
    expect(report.pendingCount).toBe(0);
  });

  it('returns correct counts for all pending migrations', () => {
    const discoveredFiles = [
      '001_initial.sql',
      '002_audit_log.sql',
      '003_tables.sql',
    ];

    const appliedMigrations = new Map<string, number>();

    const report = generateStatusReport(discoveredFiles, appliedMigrations);

    expect(report.totalDiscovered).toBe(3);
    expect(report.appliedCount).toBe(0);
    expect(report.pendingCount).toBe(3);
  });

  it('returns correct counts for mixed applied and pending migrations', () => {
    const discoveredFiles = [
      '001_initial.sql',
      '002_audit_log.sql',
      '003_tables.sql',
      '004_validators.sql',
      '005_new_feature.sql',
    ];

    const appliedMigrations = new Map<string, number>([
      ['001_initial.sql', 1000000],
      ['002_audit_log.sql', 2000000],
      ['003_tables.sql', 3000000],
    ]);

    const report = generateStatusReport(discoveredFiles, appliedMigrations);

    expect(report.totalDiscovered).toBe(5);
    expect(report.appliedCount).toBe(3);
    expect(report.pendingCount).toBe(2);
  });

  it('marks migrations with correct status', () => {
    const discoveredFiles = [
      '001_initial.sql',
      '002_audit_log.sql',
      '003_tables.sql',
    ];

    const appliedMigrations = new Map<string, number>([
      ['001_initial.sql', 1000000],
      ['003_tables.sql', 3000000],
    ]);

    const report = generateStatusReport(discoveredFiles, appliedMigrations);

    const migration1 = report.migrations.find(
      (m) => m.filename === '001_initial.sql'
    );
    const migration2 = report.migrations.find(
      (m) => m.filename === '002_audit_log.sql'
    );
    const migration3 = report.migrations.find(
      (m) => m.filename === '003_tables.sql'
    );

    expect(migration1?.status).toBe('applied');
    expect(migration1?.appliedAt).toBe(1000000);

    expect(migration2?.status).toBe('pending');
    expect(migration2?.appliedAt).toBeNull();

    expect(migration3?.status).toBe('applied');
    expect(migration3?.appliedAt).toBe(3000000);
  });

  it('preserves alphabetical order of migrations', () => {
    const discoveredFiles = [
      '003_tables.sql',
      '001_initial.sql',
      '002_audit_log.sql',
    ];

    const appliedMigrations = new Map<string, number>();

    const report = generateStatusReport(discoveredFiles, appliedMigrations);

    // Should maintain the order from discoveredFiles (already alphabetical)
    expect(report.migrations[0].filename).toBe('003_tables.sql');
    expect(report.migrations[1].filename).toBe('001_initial.sql');
    expect(report.migrations[2].filename).toBe('002_audit_log.sql');
  });

  it('handles empty discovered files array', () => {
    const discoveredFiles: string[] = [];
    const appliedMigrations = new Map<string, number>();

    const report = generateStatusReport(discoveredFiles, appliedMigrations);

    expect(report.totalDiscovered).toBe(0);
    expect(report.appliedCount).toBe(0);
    expect(report.pendingCount).toBe(0);
    expect(report.migrations).toEqual([]);
  });

  it('sets timestamp to current time', () => {
    const discoveredFiles = ['001_initial.sql'];
    const appliedMigrations = new Map<string, number>();

    const beforeTime = Date.now();
    const report = generateStatusReport(discoveredFiles, appliedMigrations);
    const afterTime = Date.now();

    expect(report.timestamp).toBeGreaterThanOrEqual(beforeTime);
    expect(report.timestamp).toBeLessThanOrEqual(afterTime);
  });

  it('includes all migration details in report', () => {
    const discoveredFiles = ['001_initial.sql'];
    const appliedMigrations = new Map<string, number>([
      ['001_initial.sql', 1000000],
    ]);

    const report = generateStatusReport(discoveredFiles, appliedMigrations);

    expect(report.migrations).toHaveLength(1);
    const migration = report.migrations[0];

    expect(migration.filename).toBe('001_initial.sql');
    expect(migration.status).toBe('applied');
    expect(migration.appliedAt).toBe(1000000);
    expect(migration.sequence).toBeDefined();
  });

  it('handles multiple migrations with same applied timestamp', () => {
    const discoveredFiles = [
      '001_initial.sql',
      '002_audit_log.sql',
      '002_validators.sql',
    ];

    const sharedTimestamp = 2000000;
    const appliedMigrations = new Map<string, number>([
      ['001_initial.sql', 1000000],
      ['002_audit_log.sql', sharedTimestamp],
      ['002_validators.sql', sharedTimestamp],
    ]);

    const report = generateStatusReport(discoveredFiles, appliedMigrations);

    expect(report.appliedCount).toBe(3);
    const migration2 = report.migrations.find(
      (m) => m.filename === '002_audit_log.sql'
    );
    const migration3 = report.migrations.find(
      (m) => m.filename === '002_validators.sql'
    );

    expect(migration2?.appliedAt).toBe(sharedTimestamp);
    expect(migration3?.appliedAt).toBe(sharedTimestamp);
  });

  it('correctly extracts sequence numbers from filenames', () => {
    const discoveredFiles = [
      '001_initial.sql',
      '002_audit_log.sql',
      '010_new_feature.sql',
      '100_major_change.sql',
    ];

    const appliedMigrations = new Map<string, number>();

    const report = generateStatusReport(discoveredFiles, appliedMigrations);

    expect(report.migrations[0].sequence).toBe(1);
    expect(report.migrations[1].sequence).toBe(2);
    expect(report.migrations[2].sequence).toBe(10);
    expect(report.migrations[3].sequence).toBe(100);
  });

  it('handles filenames without leading numbers gracefully', () => {
    const discoveredFiles = [
      'initial.sql',
      '002_audit_log.sql',
      'no_prefix.sql',
    ];

    const appliedMigrations = new Map<string, number>();

    const report = generateStatusReport(discoveredFiles, appliedMigrations);

    expect(report.migrations[0].sequence).toBe(0);
    expect(report.migrations[1].sequence).toBe(2);
    expect(report.migrations[2].sequence).toBe(0);
  });
});
