import fs from 'fs';
import path from 'path';
import os from 'os';
import { getMigrationFiles, isPostgresDialectFile } from '../../src/db/migration-files';

describe('getMigrationFiles', () => {
  let tempDir: string;

  const write = (filename: string): void => {
    fs.writeFileSync(path.join(tempDir, filename), '');
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-files-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty lists for an empty directory', () => {
    expect(getMigrationFiles(tempDir)).toEqual({ allFiles: [], upFiles: [] });
  });

  it('splits SQLite and Postgres migration files', () => {
    write('001_initial.sql');
    write('001_initial_postgres.sql');

    const { allFiles, upFiles } = getMigrationFiles(tempDir);

    expect(allFiles).toEqual(['001_initial.sql', '001_initial_postgres.sql']);
    expect(upFiles).toEqual(['001_initial.sql', '001_initial_postgres.sql']);
  });

  it('orders files by shared numeric prefix', () => {
    write('010_tenth.sql');
    write('002_second.sql');
    write('001_first.sql');
    write('002_second_postgres.sql');

    const { allFiles } = getMigrationFiles(tempDir);

    expect(allFiles).toEqual([
      '001_first.sql',
      '002_second.sql',
      '002_second_postgres.sql',
      '010_tenth.sql',
    ]);
  });

  it('ignores non-.sql files', () => {
    write('001_initial.sql');
    write('README.md');
    write('config.json');
    write('002_notes.sql.bak');

    const { allFiles, upFiles } = getMigrationFiles(tempDir);

    expect(allFiles).toEqual(['001_initial.sql']);
    expect(upFiles).toEqual(['001_initial.sql']);
  });

  it('keeps SQLite migrations that lack a Postgres twin', () => {
    write('001_initial.sql');
    write('002_sqlite_only.sql');
    write('002_sqlite_only_postgres.sql');

    const { allFiles, upFiles } = getMigrationFiles(tempDir);

    expect(allFiles).toContain('002_sqlite_only.sql');
    expect(upFiles).toContain('002_sqlite_only.sql');
    expect(upFiles).toHaveLength(3);
  });

  it('excludes down migrations from upFiles but keeps them in allFiles', () => {
    write('001_initial.sql');
    write('001_initial.down.sql');
    write('001_initial_postgres.sql');
    write('001_initial_postgres.down.sql');

    const { allFiles, upFiles } = getMigrationFiles(tempDir);

    expect(allFiles).toEqual([
      '001_initial.down.sql',
      '001_initial.sql',
      '001_initial_postgres.down.sql',
      '001_initial_postgres.sql',
    ]);
    expect(upFiles).toEqual(['001_initial.sql', '001_initial_postgres.sql']);
  });

  it('treats names merely containing "_postgres" as SQLite', () => {
    write('036_sqlite_postgres_parity.sql');

    const { upFiles } = getMigrationFiles(tempDir);

    expect(upFiles).toEqual(['036_sqlite_postgres_parity.sql']);
  });
});

describe('isPostgresDialectFile', () => {
  it('matches Postgres up and down migrations', () => {
    expect(isPostgresDialectFile('001_initial_postgres.sql')).toBe(true);
    expect(isPostgresDialectFile('001_initial_postgres.down.sql')).toBe(true);
  });

  it('does not match SQLite migrations', () => {
    expect(isPostgresDialectFile('001_initial.sql')).toBe(false);
    expect(isPostgresDialectFile('001_initial.down.sql')).toBe(false);
    expect(isPostgresDialectFile('036_sqlite_postgres_parity.sql')).toBe(false);
  });
});
