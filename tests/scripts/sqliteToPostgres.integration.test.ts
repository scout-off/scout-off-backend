import fs from 'fs';
import os from 'os';
import path from 'path';
import { fork } from 'child_process';
import { Client } from 'pg';
import Database from 'better-sqlite3';
import { migrateSqliteToPostgres } from '../../scripts/migrate-sqlite-to-postgres';
import { runMigrations } from '../../src/db/migrate';
import { SqliteDriver } from '../../src/db/sqlite-driver';

const url = process.env.MIGRATION_TEST_URL;
const integration = url ? describe : describe.skip;
integration('verified SQLite to Postgres migration (live service)', () => {
  let directory: string;
  let source: string;
  let target: string;
  let schema: string;
  let admin: Client;
  let pg: Client;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-postgres-'));
    source = path.join(directory, 'source.db');
    const fixture = process.env.MIGRATION_SQLITE_FIXTURE;
    if (fixture) {
      const seeded = new Database(fixture, { readonly: true });
      try { await seeded.backup(source); } finally { seeded.close(); }
    }
    const sqlite = new Database(source);
    try {
      const results = await runMigrations(new SqliteDriver(sqlite));
      expect(results.filter(result => !result.applied)).toEqual([]);
      sqlite.prepare('INSERT INTO events (id,type,ledger,tx_hash,payload,created_at) VALUES (?,?,?,?,?,?)')
        .run(90001, 'migration_test', 123, 'migration-test-one', '{"nested":[1,true,null]}', null);
      sqlite.prepare('INSERT INTO events (id,type,ledger,tx_hash,payload,created_at) VALUES (?,?,?,?,?,?)')
        .run(90002, 'migration_test', 124, 'migration-test-two', '{}', 1720000000123);
      sqlite.prepare('INSERT INTO scout_saved_searches (scout_wallet,name,filters,created_at,notify_enabled) VALUES (?,?,?,?,?)')
        .run('migration-wallet', 'off', '{"region":"West Africa"}', 1720000000123, 0);
      sqlite.prepare('INSERT INTO scout_player_notes (scout_wallet,player_id,note_text,updated_at) VALUES (?,?,?,?)')
        .run('migration-wallet', 'migration-player', 'enc:v1:opaque-do-not-decrypt', 1720000000123);
      sqlite.prepare('INSERT INTO security_event_log (event_type,subject,origin_instance_id,created_at) VALUES (?,?,?,?)')
        .run('wallet_blocked', 'migration-wallet', 'instance-1', 1720000000123);
      sqlite.prepare('INSERT INTO players (player_id,wallet,created_at,registered_at) VALUES (?,?,?,?)')
        .run('migration-null-date', 'migration-null-wallet', 1720000000123, null);
      const subscription = sqlite.prepare('INSERT INTO webhook_subscriptions (url,secret) VALUES (?,?)');
      subscription.run('https://migration.example.test/hook', 'enc:v1:secret');
      subscription.run('https://migration.example.test/hook', 'enc:v1:other-secret');
    } finally { sqlite.close(); }
    schema = 'migration_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const targetUrl = new URL(url!);
    targetUrl.searchParams.set('options', '-c search_path=' + schema);
    target = targetUrl.toString();
    pg = new Client({ connectionString: target });
    await pg.connect();
  }, 30000);

  afterEach(async () => {
    if (pg) await pg.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('copies every application table, verifies counts/checksums and resets serial sequences', async () => {
    const report = await migrateSqliteToPostgres({ sqlitePath: source, databaseUrl: target, batchSize: 2 });
    expect(report.every(row => row.verified)).toBe(true);
    const sqlite = new Database(source, { readonly: true });
    try {
      const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'migrations'")
        .all() as { name: string }[];
      expect(report.map(row => row.table).sort()).toEqual(tables.map(row => row.name).sort());
    } finally { sqlite.close(); }
    const result = await pg.query('SELECT created_at FROM events WHERE id=90001');
    expect(result.rows[0].created_at).toBeNull();
    expect((await pg.query("SELECT registered_at FROM players WHERE player_id='migration-null-date'")).rows[0].registered_at).toBeNull();
    expect((await pg.query("SELECT notify_enabled FROM scout_saved_searches WHERE name='off'")).rows[0].notify_enabled).toBe(false);
    expect((await pg.query("SELECT note_text FROM scout_player_notes WHERE scout_wallet='migration-wallet'")).rows[0].note_text).toBe('enc:v1:opaque-do-not-decrypt');
    expect((await pg.query("SELECT count(*) AS n FROM webhook_subscriptions WHERE url='https://migration.example.test/hook'")).rows[0].n).toBe('2');
    expect((await pg.query("SELECT secret FROM webhook_subscriptions WHERE url='https://migration.example.test/hook' ORDER BY id LIMIT 1")).rows[0].secret).toBe('enc:v1:secret');
    const inserted = await pg.query("INSERT INTO events (type,ledger,tx_hash,payload) VALUES ('after_copy',125,'after-copy','{}') RETURNING id");
    expect(Number(inserted.rows[0].id)).toBeGreaterThan(90002);
    const first = await pg.query("INSERT INTO validator_approvals (milestone_id,validator_wallet,approved_at) VALUES ('new','wallet',1720000000123) RETURNING id");
    expect(Number(first.rows[0].id)).toBe(1);
  }, 60000);

  it('resumes after a SIGKILL following a committed batch without duplicate rows', async () => {
    await new Promise<void>((resolve, reject) => {
      const child = fork(path.resolve(__dirname, 'fixtures/migration-child.ts'), [], {
        execArgv: ['-r', 'ts-node/register/transpile-only'],
        env: { ...process.env, TS_NODE_PROJECT: path.resolve(__dirname, '../../tsconfig.scripts.json'), MIGRATION_SOURCE: source, MIGRATION_TARGET: target },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let committed = false;
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Migration child timed out: ' + stderr)); }, 30000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('message', (message: { type: string; message?: string }) => {
        if (message.type === 'error') { clearTimeout(timer); child.kill('SIGKILL'); reject(new Error(message.message)); }
        if (message.type === 'committed') { committed = true; child.kill('SIGKILL'); }
      });
      child.on('exit', () => { clearTimeout(timer); if (committed) resolve(); else reject(new Error('Migration exited before checkpoint: ' + stderr)); });
    });
    const report = await migrateSqliteToPostgres({ sqlitePath: source, databaseUrl: target, batchSize: 2, resume: true });
    expect(report.every(row => row.verified)).toBe(true);
    expect((await pg.query("SELECT count(*) AS n FROM events WHERE type='migration_test'")).rows[0].n).toBe('2');
  }, 90000);

  it('refuses occupied targets and changed sources on resume', async () => {
    await pg.query('CREATE TABLE unrelated (id INTEGER)');
    await expect(migrateSqliteToPostgres({ sqlitePath: source, databaseUrl: target })).rejects.toThrow('non-empty');
    await pg.query('DROP TABLE unrelated');
    await expect(migrateSqliteToPostgres({ sqlitePath: source, databaseUrl: target, batchSize: 1, onBatch: () => { throw new Error('interrupted'); } })).rejects.toThrow('interrupted');
    const sqlite = new Database(source);
    try { sqlite.prepare("UPDATE events SET payload='changed' WHERE id=90001").run(); } finally { sqlite.close(); }
    await expect(migrateSqliteToPostgres({ sqlitePath: source, databaseUrl: target, resume: true })).rejects.toThrow('Source changed');
  }, 60000);

  it('rejects content corruption even when row counts match', async () => {
    await migrateSqliteToPostgres({ sqlitePath: source, databaseUrl: target });
    await pg.query("UPDATE events SET payload='corrupt' WHERE id=90001");
    await expect(migrateSqliteToPostgres({ sqlitePath: source, databaseUrl: target, resume: true })).rejects.toThrow('Verification failed');
  }, 60000);

  it('rejects edited migration checksums before touching the target', async () => {
    const sqlite = new Database(source);
    try { sqlite.prepare("UPDATE migrations SET checksum='invalid' WHERE id='001_initial.sql'").run(); } finally { sqlite.close(); }
    await expect(migrateSqliteToPostgres({ sqlitePath: source, databaseUrl: target })).rejects.toThrow('checksum mismatch');
    expect((await pg.query('SELECT count(*) AS n FROM pg_tables WHERE schemaname=current_schema()')).rows[0].n).toBe('0');
  });
});
