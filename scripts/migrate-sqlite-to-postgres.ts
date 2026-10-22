/** Offline, resumable migration. Never start application writers until verification succeeds. */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { Client, types } from 'pg';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { PostgresDriver } from '../src/db/postgres-driver';
import { runMigrations } from '../src/db/migrate';
import { getMigrationFiles } from '../src/db/migration-files';

type Row = Record<string, unknown>;
interface Column { column_name: string; data_type: string; }
interface Table { name: string; columns: Column[]; fingerprint: string; resumeFingerprint: string; count: number; }
export interface MigrationOptions {
  sqlitePath: string;
  databaseUrl: string;
  batchSize?: number;
  resume?: boolean;
  /** Embedders can observe committed batches; throwing here simulates interruption. */
  onBatch?: (table: string, copied: number) => void | Promise<void>;
}
export interface Verification { table: string; sourceRows: number; targetRows: number; checksum: string; verified: boolean; }

const MIGRATIONS = path.resolve(__dirname, '../db');
const META = '_migration_progress';
const INTERNAL = new Set(['migrations', 'schema_migrations', META]);
// Only convert columns whose target schema has the corresponding native type.
export const TYPE_OVERRIDES: Record<string, Record<string, string>> = {
  scout_saved_searches: { notify_enabled: 'boolean' },
};
const quote = (name: string): string => '"' + name.replace(/"/g, '""') + '"';

export function convertValue(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  if (type === 'boolean') {
    if (value === true || value === 1 || value === 1n || value === '1') return true;
    if (value === false || value === 0 || value === 0n || value === '0') return false;
    throw new Error('Invalid SQLite boolean; expected 0 or 1');
  }
  if (type === 'json' || type === 'jsonb') {
    try { return typeof value === 'string' ? JSON.parse(value) : value; }
    catch { throw new Error('Invalid JSON value in source column'); }
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** pg must receive serialized JSON, including the JSON literal null as 'null'. */
export function toPostgresValue(value: unknown, type: string): unknown {
  const converted = convertValue(value, type);
  return /^(json|jsonb)$/.test(type) && value !== null && value !== undefined
    ? typeof value === 'string' ? value : JSON.stringify(converted) : converted;
}

/** Canonical JSON tokens retain numeric precision instead of round-tripping JS numbers. */
function canonicalJson(text: string): unknown {
  // Validate first; the tokenizer below only needs to handle valid JSON.
  try { JSON.parse(text); } catch { throw new Error('Invalid JSON value in source column'); }
  let position = 0;
  const whitespace = (): void => { while (/\s/.test(text[position] ?? '') && position < text.length) position++; };
  const string = (): string => {
    const start = position++;
    while (position < text.length) {
      if (text[position] === '\\') { position += 2; continue; }
      if (text[position++] === '"') break;
    }
    return JSON.parse(text.slice(start, position)) as string;
  };
  const value = (): unknown => {
    whitespace();
    const next = text[position];
    if (next === '"') return ['string', string()];
    if (next === '[') {
      position++;
      const items: unknown[] = [];
      whitespace();
      while (text[position] !== ']') {
        items.push(value());
        whitespace();
        if (text[position] === ',') position++;
      }
      position++;
      return ['array', items];
    }
    if (next === '{') {
      position++;
      const entries = new Map<string, unknown>();
      whitespace();
      while (text[position] !== '}') {
        whitespace();
        const key = string();
        whitespace();
        position++; // colon
        entries.set(key, value()); // JSONB and JSON.parse use the last duplicate key.
        whitespace();
        if (text[position] === ',') position++;
      }
      position++;
      return ['object', [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)];
    }
    for (const literal of ['null', 'true', 'false']) {
      if (text.startsWith(literal, position)) { position += literal.length; return [literal]; }
    }
    const token = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?/.exec(text.slice(position));
    if (!token) throw new Error('Invalid JSON number');
    position += token[0].length;
    let digits = (token[2] + (token[3] ?? '')).replace(/^0+/, '');
    let exponent = BigInt(token[4] ?? '0') - BigInt((token[3] ?? '').length);
    while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++; }
    return ['number', digits ? token[1] + digits + 'e' + exponent.toString() : '0'];
  };
  return value();
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return '{' + Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ':' + stable(item)).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

export function canonical(row: Row, columns: Column[]): string {
  return stable(columns.map(({ column_name, data_type }) => {
    const original = row[column_name];
    const value = convertValue(original, data_type);
    // Tag JSON values so a JSON null remains distinct from SQL NULL. The pg
    // client retains raw JSON text rather than collapsing both to JS null.
    if (/^(json|jsonb)$/.test(data_type) && original !== null && original !== undefined) {
      return { json: canonicalJson(typeof original === 'string' ? original : JSON.stringify(original)) };
    }
    // pg returns int8/numeric as strings, SQLite returns integers as bigint.
    if (value !== null && /^(smallint|integer|bigint|numeric|decimal|real|double precision)$/.test(data_type)) return String(value);
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value.toString('hex');
    return value;
  }));
}

/** Multiset SHA-256: modular addition preserves duplicate multiplicity, independent of row order. */
export class TableChecksum {
  count = 0;
  private sum = 0n;
  add(serialized: string): void {
    this.sum = (this.sum + BigInt('0x' + createHash('sha256').update(serialized).digest('hex'))) % (1n << 256n);
    this.count++;
  }
  digest(): string { return this.sum.toString(16).padStart(64, '0'); }
}

export function orderTables(names: string[], dependencies: Map<string, string[]>): string[] {
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    if (ordered.includes(name)) return;
    if (visiting.has(name)) throw new Error(`Foreign-key cycle involving ${name}; resolve before migrating`);
    visiting.add(name);
    for (const parent of dependencies.get(name) ?? []) if (names.includes(parent)) visit(parent);
    visiting.delete(name);
    ordered.push(name);
  };
  names.forEach(visit);
  return ordered;
}

function verifySourceHistory(db: Database.Database): string {
  const expected = getMigrationFiles(MIGRATIONS).upFiles;
  const columns = db.prepare('PRAGMA table_info(migrations)').all() as { name: string }[];
  if (!columns.length) throw new Error('Source has no migrations history; upgrade SQLite first');
  const rows = db.prepare('SELECT * FROM migrations').all() as { id: string; checksum?: string | null }[];
  const ids = new Set(rows.map(row => row.id));
  if (expected.some(id => !ids.has(id)) || rows.some(row => !expected.includes(row.id))) {
    throw new Error('Source migration version differs from this checkout; upgrade SQLite first');
  }
  for (const row of rows) {
    const checksum = createHash('sha256').update(fs.readFileSync(path.join(MIGRATIONS, row.id))).digest('hex');
    if (row.checksum && checksum !== row.checksum) throw new Error(`Source migration checksum mismatch: ${row.id}`);
  }
  // Legacy history rows can have null checksums. Bind progress to this exact migration bundle.
  return createHash('sha256').update(expected.map(id => id + ':' + createHash('sha256')
    .update(fs.readFileSync(path.join(MIGRATIONS, id))).digest('hex')).join('\n')).digest('hex');
}

export async function migrateSqliteToPostgres(options: MigrationOptions): Promise<Verification[]> {
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10000) throw new Error('batch-size must be 1..10000');
  const db = new Database(options.sqlitePath, { readonly: true, fileMustExist: true });
  const sslValue = process.env.DATABASE_SSL;
  const ssl = sslValue === 'no-verify' ? { rejectUnauthorized: false }
    : /^(true|1|yes)$/i.test(sslValue ?? '') ? { rejectUnauthorized: true } : undefined;
  const client = new Client({ connectionString: options.databaseUrl, ssl,
    // The app driver installs a numeric int8 parser globally; retain full 64-bit
    // precision in this tool, independently of application return-value policy.
    types: { getTypeParser: (oid, format) => [20, 114, 3802].includes(oid) ? (value: string) => value : types.getTypeParser(oid, format) },
  });
  let connected = false;
  let locked = false;
  try {
    db.defaultSafeIntegers(true);
    db.exec('BEGIN'); // One source snapshot, including its history and every table.
    const bundle = verifySourceHistory(db);
    const sourceNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]).map(row => row.name).filter(name => !INTERNAL.has(name));
    await client.connect();
    connected = true;
    const lock = await client.query('SELECT pg_try_advisory_lock(1507, 1507) AS locked');
    locked = lock.rows[0].locked;
    if (!locked) throw new Error('Another SQLite migration is running');
    const existing = await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','S','f')`);
    if (existing.rowCount && !options.resume) throw new Error('Target schema is non-empty; use an empty database or --resume');
    if (!existing.rowCount && options.resume) throw new Error('Cannot resume: target has no migration progress');
    if (options.resume && !existing.rows.some(row => row.relname === META)) throw new Error('Cannot resume: target has no migration progress manifest');
    if (!options.resume) {
      const driver = new PostgresDriver(options.databaseUrl, sslValue === 'no-verify' ? 'no-verify' : !!ssl, 1);
      try {
        await driver.connect();
        const results = await runMigrations(driver);
        const failed = results.filter(result => !result.applied);
        if (failed.length) throw new Error('Target schema migrations failed: ' + failed.map(result => `${result.filename}: ${result.error}`).join('; '));
      } finally { await driver.close(); }
    }
    const targetHistory = await client.query('SELECT id, checksum FROM migrations');
    const expected = getMigrationFiles(MIGRATIONS).upFiles;
    if (targetHistory.rows.length !== expected.length || expected.some(id => !targetHistory.rows.some(row => row.id === id))) {
      throw new Error('Target migration version differs from source');
    }
    for (const row of targetHistory.rows) {
      if (row.checksum && row.checksum !== createHash('sha256').update(fs.readFileSync(path.join(MIGRATIONS, row.id))).digest('hex')) {
        throw new Error(`Target migration checksum mismatch: ${row.id}`);
      }
    }
    const targets = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'");
    const targetNames = targets.rows.map(row => row.table_name as string).filter(name => !INTERNAL.has(name)).sort();
    if (JSON.stringify(sourceNames) !== JSON.stringify(targetNames)) throw new Error('Source/target table drift; repair schemas before migrating');
    const dependencies = new Map<string, string[]>();
    const tables = new Map<string, Table>();
    for (const name of sourceNames) {
      const sqliteColumns = db.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[];
      const targetColumns = await client.query<Column>('SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY column_name', [name]);
      const columns = targetColumns.rows.sort((a, b) => a.column_name < b.column_name ? -1 : a.column_name > b.column_name ? 1 : 0);
      if (JSON.stringify(sqliteColumns.map(column => column.name).sort()) !== JSON.stringify(columns.map(column => column.column_name))) {
        throw new Error(`Column drift in ${name}; repair schemas before migrating`);
      }
      for (const column of columns) {
        const override = TYPE_OVERRIDES[name]?.[column.column_name];
        if (override && override !== column.data_type) throw new Error(`Type override drift in ${name}.${column.column_name}`);
      }
      const fks = db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as { table: string }[];
      const pgFks = await client.query(`SELECT parent.relname AS parent FROM pg_constraint c
        JOIN pg_class child ON child.oid = c.conrelid JOIN pg_namespace n ON n.oid = child.relnamespace
        JOIN pg_class parent ON parent.oid = c.confrelid
        WHERE c.contype = 'f' AND n.nspname = current_schema() AND child.relname = $1`, [name]);
      dependencies.set(name, [...new Set([...fks.map(fk => fk.table), ...pgFks.rows.map(row => row.parent)])]);
      const checksum = new TableChecksum();
      const resumeHash = createHash('sha256');
      for (const row of db.prepare(`SELECT rowid AS __migration_rowid, * FROM ${quote(name)} ORDER BY rowid`).iterate()) {
        const serialized = canonical(row as Row, columns);
        checksum.add(serialized);
        resumeHash.update(stable([String((row as Row).__migration_rowid), serialized]) + '\n');
      }
      tables.set(name, { name, columns, count: checksum.count, fingerprint: checksum.digest(), resumeFingerprint: resumeHash.digest('hex') });
    }
    const names = orderTables(sourceNames, dependencies);
    if (!options.resume) {
      await client.query('BEGIN');
      await client.query(`CREATE TABLE ${quote(META)} (table_name TEXT PRIMARY KEY, bundle TEXT NOT NULL, fingerprint TEXT NOT NULL, source_rows BIGINT NOT NULL, copied BIGINT NOT NULL DEFAULT 0)`);
      // Migrations seed feature flags. Source rows must replace those defaults exactly.
      if (names.length) await client.query('TRUNCATE ' + names.map(quote).join(', '));
      for (const table of tables.values()) await client.query(`INSERT INTO ${quote(META)} (table_name, bundle, fingerprint, source_rows) VALUES ($1,$2,$3,$4)`, [table.name, bundle, table.resumeFingerprint, table.count]);
      await client.query('COMMIT');
    }
    const progress = await client.query(`SELECT * FROM ${quote(META)}`);
    if (progress.rows.length !== names.length) throw new Error('Incomplete migration manifest');
    const copiedByTable = new Map<string, number>();
    // Validate the entire manifest before resuming any writes.
    for (const name of names) {
      const table = tables.get(name)!;
      const checkpoint = progress.rows.find(row => row.table_name === name);
      if (!checkpoint || checkpoint.bundle !== bundle || checkpoint.fingerprint !== table.resumeFingerprint || Number(checkpoint.source_rows) !== table.count) {
        throw new Error(`Source changed since migration began: ${name}; restart with a new empty target`);
      }
      const copied = Number(checkpoint.copied);
      if (!Number.isSafeInteger(copied) || copied < 0 || copied > table.count) throw new Error(`Invalid progress for ${name}`);
      const targetCount = await client.query(`SELECT count(*) AS count FROM ${quote(name)}`);
      if (Number(targetCount.rows[0].count) !== copied) throw new Error(`Target was modified outside the migration: ${name}`);
      copiedByTable.set(name, copied);
    }
    for (const name of names) {
      const table = tables.get(name)!;
      let copied = copiedByTable.get(name)!;
      // rowid gives a stable total order even for nullable/composite primary keys.
      const iterator = db.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid LIMIT -1 OFFSET ?`).iterate(copied);
      let batch: Row[] = [];
      const flush = async (): Promise<void> => {
        if (!batch.length) return;
        const values: unknown[] = [];
        const tuples = batch.map(row => '(' + table.columns.map(column => {
          values.push(toPostgresValue(row[column.column_name], column.data_type));
          return '$' + values.length;
        }).join(',') + ')');
        await client.query('BEGIN');
        try {
          await client.query(`INSERT INTO ${quote(name)} (${table.columns.map(column => quote(column.column_name)).join(',')}) VALUES ${tuples.join(',')}`, values);
          copied += batch.length;
          await client.query(`UPDATE ${quote(META)} SET copied = $1 WHERE table_name = $2`, [copied, name]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        batch = [];
        await options.onBatch?.(name, copied);
      };
      // PostgreSQL has a 65,535-parameter limit per statement.
      const size = Math.min(batchSize, Math.floor(60000 / table.columns.length));
      for (const row of iterator) { batch.push(row as Row); if (batch.length >= size) await flush(); }
      await flush();
    }
    const report: Verification[] = [];
    await client.query('BEGIN');
    // Prevent accidental application writes while checksums and sequences are finalized.
    if (names.length) await client.query('LOCK TABLE ' + names.map(quote).join(', ') + ' IN SHARE MODE');
    for (const name of names) {
      const table = tables.get(name)!;
      const checksum = new TableChecksum();
      await client.query(`DECLARE migration_verify NO SCROLL CURSOR FOR SELECT * FROM ${quote(name)}`);
      while (true) {
        const rows = await client.query(`FETCH FORWARD ${batchSize} FROM migration_verify`);
        if (!rows.rows.length) break;
        for (const row of rows.rows) checksum.add(canonical(row, table.columns));
      }
      await client.query('CLOSE migration_verify');
      report.push({ table: name, sourceRows: table.count, targetRows: checksum.count, checksum: checksum.digest(), verified: table.count === checksum.count && table.fingerprint === checksum.digest() });
    }
    console.table(report);
    if (report.some(row => !row.verified)) throw new Error('Verification failed; keep writes frozen and do not cut over');
    for (const name of names) {
      const table = tables.get(name)!;
      for (const column of table.columns) {
        const sequence = await client.query('SELECT pg_get_serial_sequence($1, $2) AS name', [quote(name), column.column_name]);
        if (sequence.rows[0].name) {
          await client.query(`SELECT setval($1::regclass, GREATEST(COALESCE(MAX(${quote(column.column_name)}), 1), 1), COALESCE(MAX(${quote(column.column_name)}) >= 1, false)) FROM ${quote(name)}`, [sequence.rows[0].name]);
        }
      }
    }
    await client.query('COMMIT');
    return report;
  } finally {
    if (connected) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (locked) await client.query('SELECT pg_advisory_unlock(1507, 1507)').catch(() => undefined);
      await client.end();
    }
    db.close();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    return value;
  };
  void (async () => {
    const allowed = new Set(['--sqlite', '--batch-size', '--resume']);
    for (let i = 0; i < args.length; i++) {
      if (!allowed.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
      if (args[i] !== '--resume') i++;
    }
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    await migrateSqliteToPostgres({ sqlitePath: read('--sqlite') ?? process.env.DB_PATH ?? '/data/scout-off.db', databaseUrl: process.env.DATABASE_URL, batchSize: read('--batch-size') ? Number(read('--batch-size')) : undefined, resume: args.includes('--resume') });
  })().catch(error => {
    // Avoid logging connection strings, credentials or row contents.
    const code = (error as { code?: unknown })?.code;
    console.error('Migration failed:', typeof code === 'string' ? `Database/connection error (${code})` : error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
