/**
 * Database driver abstraction layer.
 * Supports both SQLite and PostgreSQL backends with a consistent interface.
 *
 * Every method is async. better-sqlite3's underlying calls are still
 * synchronous C++ bindings under the hood (there is no real I/O wait to
 * avoid), but the interface is async so callers are portable across both
 * drivers — including PostgresDriver, whose calls are genuinely async and
 * must never block the Node event loop. See SqliteDriver/PostgresDriver for
 * the two implementations, and docs/postgres-migration.md for the design
 * rationale (async-everywhere vs. a synchronous-execution primitive).
 */

export interface DbTxHandle {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  value<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastId: number }>;
  exec(sql: string): Promise<void>;

  /**
   * Serializes concurrent transactions that read-then-write against the same
   * logical resource (e.g. "read the last row, then insert one that chains
   * onto it"). Under READ COMMITTED — the default isolation level for both
   * drivers' `transaction()` — a plain `SELECT ... ORDER BY ... LIMIT 1`
   * takes no lock, so two concurrent transactions can both read the same
   * "last row" and both insert, producing two rows that both point at the
   * same predecessor instead of a linear chain.
   *
   * Callers must call this before the read half of a read-then-write
   * sequence, inside the same `transaction()` callback. It resolves once no
   * other transaction holds a lock on the same `key`, and the lock is held
   * until the transaction commits or rolls back — never released early.
   *
   * SqliteDriver is a no-op: `transaction()` there already funnels every
   * transaction through a single in-process queue (see sqlite-driver.ts),
   * so no two transactions ever run concurrently in the first place.
   * PostgresDriver uses a transaction-scoped advisory lock, since its
   * transactions run on genuinely concurrent pooled connections.
   */
  lockForWrite(key: string): Promise<void>;
}

export interface DbDriver extends DbTxHandle {
  /**
   * Execute `fn` atomically. All queries issued through the `tx` handle
   * passed to `fn` run on the same underlying connection/transaction and
   * either all commit together or all roll back together.
   *
   * Do NOT use `this`/the outer driver inside `fn` — use only `tx`. On
   * PostgresDriver, the outer driver's methods run against the connection
   * pool (a different connection than the one running the transaction), so
   * calls made against the outer driver from inside `fn` would not be part
   * of the transaction and could deadlock against it.
   */
  transaction<T>(fn: (tx: DbTxHandle) => Promise<T>): Promise<T>;

  /**
   * Close the database connection.
   * Returns a Promise that resolves only once the underlying connection has
   * genuinely finished closing. Callers in shutdown sequences must await
   * this to ensure resources are released before the process exits.
   */
  close(): Promise<void>;
}

export type DbDriverType = 'sqlite' | 'postgres';
