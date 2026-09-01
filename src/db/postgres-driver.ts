/**
 * PostgreSQL driver implementation.
 *
 * Uses a `pg` connection Pool (not a single Client) and genuine async/await
 * throughout — every query is awaited on the real promise `pg` returns, and
 * concurrent callers each get their own pooled connection, so N concurrent
 * queries run in parallel (bounded by pool size) instead of serializing.
 *
 * This replaces an earlier implementation that "blocked" on a single Client
 * by busy-waiting in a `while (!done) {}` loop until a `.then()` callback set
 * a flag — which can never work: a synchronous busy-loop starves the Node
 * event loop's microtask queue, and that's exactly where the pending
 * `.then()` callback was queued to run. The call could not resolve until the
 * 60-second timeout fired.
 */

import { Pool, types, type PoolConfig } from 'pg';
import { DbDriver, DbTxHandle } from './driver';

// `pg` returns BIGINT (OID 20) columns as JS strings by default — it doesn't
// trust a JS `number` to losslessly hold an arbitrary 64-bit value. Every
// timestamp column in the Postgres schema (created_at/updated_at/etc.) is
// BIGINT specifically because millisecond epoch values exceed Postgres's
// 32-bit INTEGER range, so left at the default this silently turns every
// such column into a string on the Postgres driver while SQLite/
// better-sqlite3 returns the equivalent INTEGER column as a real number —
// breaking callers that do arithmetic on it (`+` becomes string
// concatenation) or compare it against a number. Parsing as a JS number
// here is safe for this app's actual BIGINT usage (epoch-ms timestamps and
// autoincrementing ids, both far under Number.MAX_SAFE_INTEGER) and restores
// parity with SQLite's return shape. This is a `pg`-module-global setting
// (there is no per-Pool equivalent), acceptable because the whole process
// only ever speaks one DB dialect at a time (DB_DRIVER is fixed at startup).
types.setTypeParser(20, (val: string) => parseInt(val, 10));

/**
 * Converts SQLite-style `?` positional placeholders to Postgres-style
 * `$1, $2, ...` placeholders. node-postgres does not accept `?` — every
 * SQL string in this codebase is written once, against the SQLite dialect,
 * and shared with the Postgres driver, so this conversion must happen here
 * rather than duplicating each query per-dialect.
 *
 * `?` characters inside single-quoted string literals (with '' as the
 * escaped-quote form) or double-quoted identifiers are left untouched.
 */
export function convertPlaceholders(sql: string): string {
  let out = '';
  let paramIndex = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inSingleQuote) {
      out += ch;
      if (ch === "'") {
        // '' inside a single-quoted string is an escaped quote, not a close.
        if (sql[i + 1] === "'") {
          out += sql[++i];
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }

    if (inDoubleQuote) {
      out += ch;
      if (ch === '"') inDoubleQuote = false;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      out += ch;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      out += ch;
      continue;
    }

    if (ch === '?') {
      paramIndex += 1;
      out += `$${paramIndex}`;
      continue;
    }

    out += ch;
  }

  return out;
}

/** SSL option accepted by the PostgresDriver constructor. */
export type PostgresSslOption =
  /** Enable SSL with full certificate verification (recommended for managed providers). */
  | true
  /** Enable SSL but skip certificate verification (dev/staging with self-signed certs). */
  | 'no-verify'
  /** Disable SSL entirely (local / private-network Postgres without TLS). */
  | false;

/**
 * Translates the app's SQLite-style `?` positional placeholders into
 * PostgreSQL's `$1, $2, ...` placeholders, so query SQL can be shared
 * verbatim between SqliteDriver and PostgresDriver call sites. Placeholders
 * inside single-quoted string literals are left untouched (none of the
 * application's SQL currently embeds a literal `?` in a string, but this
 * keeps the translation correct rather than merely lucky).
 */
export function translatePlaceholders(sql: string): string {
  let out = '';
  let inString = false;
  let paramIndex = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      // SQL escapes a literal quote as '' — a doubled quote does not toggle
      // string state.
      inString = !inString;
      out += ch;
      continue;
    }
    if (ch === '?' && !inString) {
      paramIndex += 1;
      out += `$${paramIndex}`;
      continue;
    }
    out += ch;
  }
  return out;
}

export class PostgresDriver implements DbDriver {
  private pool: Pool;

  constructor(connectionString: string, ssl: PostgresSslOption = false, poolSize = 10) {
    const poolConfig: PoolConfig = { connectionString, max: poolSize };

    if (ssl === true) {
      // Full certificate verification — the default secure mode for production.
      poolConfig.ssl = { rejectUnauthorized: true };
    } else if (ssl === 'no-verify') {
      // SSL transport enabled, but certificate not verified. Use only in dev/staging
      // with self-signed certificates — never in production.
      poolConfig.ssl = { rejectUnauthorized: false };
    }
    // When ssl === false, no ssl property is set — pg connects without TLS.

    this.pool = new Pool(poolConfig);
    // A pooled connection erroring while idle (e.g. the network drops)
    // would otherwise crash the process as an uncaught 'error' event.
    this.pool.on('error', (err) => {
      console.error('[db] Unexpected error on idle PostgreSQL client:', err);
    });
  }

  /**
   * Validate connectivity at startup by round-tripping a trivial query.
   * The Pool itself lazily opens connections on demand, so this exists to
   * fail fast (matching the previous single-Client driver's behaviour)
   * rather than deferring the first connection attempt to the first real
   * query.
   */
  async connect(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const result = await this.pool.query(translatePlaceholders(sql), params);
    return (result.rows || []) as T[];
  }

  async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows.length > 0 ? rows[0] : undefined;
  }

  async value<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const row = await this.get<Record<string, unknown>>(sql, params);
    if (!row) return undefined;
    const values = Object.values(row);
    return values.length > 0 ? (values[0] as T) : undefined;
  }

  async run(sql: string, params?: unknown[]): Promise<{ changes: number; lastId: number }> {
    const result = await this.pool.query(translatePlaceholders(sql), params);
    return extractRunResult(result);
  }

  async exec(sql: string): Promise<void> {
    // Multi-statement SQL (migrations) — not parameterised, no placeholder
    // translation needed or wanted (DDL never contains `?` placeholders).
    await this.pool.query(sql);
  }

  /**
   * DbDriver extends DbTxHandle, so this method exists to satisfy the
   * interface, but calling it here (outside a transaction) cannot do what
   * it promises: see DbTxHandle.lockForWrite — the lock only guards a
   * read-then-write sequence for the lifetime of one transaction, and there
   * is no transaction here to scope it to. Throwing rather than silently
   * acquiring-and-immediately-releasing a lock avoids a caller mistakenly
   * believing they got the exclusion they asked for.
   */
  async lockForWrite(_key: string): Promise<void> {
    throw new Error('lockForWrite() must be called on the tx handle inside driver.transaction(), not on the outer driver');
  }

  async transaction<T>(fn: (tx: DbTxHandle) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: DbTxHandle = {
      all: async <R>(sql: string, params?: unknown[]) => {
        const result = await client.query(translatePlaceholders(sql), params);
        return (result.rows || []) as R[];
      },
      get: async <R>(sql: string, params?: unknown[]) => {
        const result = await client.query(translatePlaceholders(sql), params);
        return (result.rows[0] as R | undefined) ?? undefined;
      },
      value: async <R>(sql: string, params?: unknown[]) => {
        const result = await client.query(translatePlaceholders(sql), params);
        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (!row) return undefined;
        const values = Object.values(row);
        return values.length > 0 ? (values[0] as R) : undefined;
      },
      run: async (sql: string, params?: unknown[]) => {
        const result = await client.query(translatePlaceholders(sql), params);
        return extractRunResult(result);
      },
      exec: async (sql: string) => {
        await client.query(sql);
      },
      lockForWrite: async (key: string) => {
        // pg_advisory_xact_lock takes a bigint key; hashtext() maps an
        // arbitrary string to a stable 32-bit int. Held for the lifetime of
        // the transaction (auto-released on COMMIT/ROLLBACK), so a second
        // transaction requesting the same key blocks here until the first
        // one finishes — turning the read-then-insert sequence into a
        // linearized, one-at-a-time operation across the whole pool.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      },
    };

    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[db] Rollback failed:', rollbackErr);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Close the PostgreSQL connection pool.
   * Returns a Promise that resolves only after every pooled connection has
   * genuinely finished closing, so the caller's shutdown sequence can await
   * it before exiting.
   */
  async close(): Promise<void> {
    try {
      await this.pool.end();
    } catch (err) {
      console.error('[db] Error closing PostgreSQL connection pool:', err);
    }
  }
}

/**
 * Extract { changes, lastId } from a pg QueryResult.
 *
 * lastId comes from the first column of the first returned row. When a
 * statement includes a RETURNING clause (e.g. "RETURNING id" or "RETURNING
 * wallet"), Postgres returns the requested value(s) in result.rows. We take
 * the *first column of the first row* rather than looking for a column
 * specifically named "id", so tables whose primary key has a different name
 * (player_id, wallet, composite keys, etc.) work correctly instead of
 * silently producing lastId: 0.
 *
 * If no RETURNING clause is present (result.rows is empty) we leave lastId
 * as 0 — that is expected and not misleading, because callers that care
 * about the inserted key should include RETURNING in their SQL.
 */
function extractRunResult(result: { rows: unknown[]; rowCount: number | null }): {
  changes: number;
  lastId: number;
} {
  let lastId = 0;
  if (result.rows && result.rows.length > 0) {
    const firstRow = result.rows[0] as Record<string, unknown>;
    const firstValue = Object.values(firstRow)[0];
    if (firstValue !== null && firstValue !== undefined) {
      const numeric = Number(firstValue);
      lastId = Number.isFinite(numeric) ? numeric : 0;
    }
  }

  return {
    changes: result.rowCount ?? 0,
    lastId,
  };
}
