/**
 * SQLite driver implementation.
 * Uses better-sqlite3 for fast, synchronous database access, wrapped in an
 * async interface so callers are portable across SqliteDriver/PostgresDriver.
 */

import type Database from 'better-sqlite3';
import { DbDriver, DbTxHandle } from './driver';

export class SqliteDriver implements DbDriver {
  /**
   * better-sqlite3 exposes a single, synchronous connection. Transactions
   * are implemented as manual BEGIN/COMMIT/ROLLBACK (see `transaction()`
   * below) rather than db.transaction(fn), because fn here is async — and
   * db.transaction()'s built-in wrapper assumes its callback returns
   * synchronously, which an async function never does (it returns a pending
   * Promise immediately, so the wrapper would COMMIT before the callback's
   * queries actually ran). Manual BEGIN/COMMIT sidesteps that, but it means
   * two overlapping transaction() calls on this one connection would
   * otherwise interleave their BEGIN/COMMIT pairs. This queue guarantees at
   * most one transaction is in flight at a time, which is also what a
   * single-writer SQLite connection needs for correctness regardless.
   */
  private txQueue: Promise<unknown> = Promise.resolve();

  constructor(private db: Database.Database) {}

  async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    return (params ? stmt.all(...params) : stmt.all()) as T[];
  }

  async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const stmt = this.db.prepare(sql);
    return (params ? stmt.get(...params) : stmt.get()) as T | undefined;
  }

  async value<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const stmt = this.db.prepare(sql);
    const row = params ? stmt.get(...params) : stmt.get();
    if (!row) return undefined;
    // Return the first column value
    return Object.values(row as Record<string, unknown>)[0] as T;
  }

  async run(sql: string, params?: unknown[]): Promise<{ changes: number; lastId: number }> {
    const stmt = this.db.prepare(sql);
    const info = params ? stmt.run(...params) : stmt.run();
    return {
      changes: info.changes,
      lastId: typeof info.lastInsertRowid === 'number' ? info.lastInsertRowid : 0,
    };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  /**
   * No-op — see DbTxHandle.lockForWrite. The txQueue below already ensures
   * at most one transaction runs at a time on this connection, so there is
   * never a second concurrent transaction to race against.
   */
  async lockForWrite(_key: string): Promise<void> {}

  transaction<T>(fn: (tx: DbTxHandle) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const tx: DbTxHandle = {
        all: this.all.bind(this),
        get: this.get.bind(this),
        value: this.value.bind(this),
        run: this.run.bind(this),
        exec: this.exec.bind(this),
        lockForWrite: this.lockForWrite.bind(this),
      };
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(tx);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          console.error('[db] Rollback failed:', rollbackErr);
        }
        throw err;
      }
    };

    // Chain onto the queue so this transaction only starts once every
    // previously-queued one has fully committed/rolled back, and make sure a
    // failed transaction doesn't wedge the queue for subsequent callers.
    const scheduled = this.txQueue.then(run, run);
    this.txQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
