/**
 * Manual Jest mock for better-sqlite3.
 * Provides a minimal in-memory SQL-like interface so tests can run without
 * the native binary (which requires a matching Node ABI).
 */

class Statement {
  constructor(db, sql) {
    this._db = db;
    this._sql = sql.trim();
  }

  run(...args) {
    const sql = this._sql.toUpperCase();
    if (sql.startsWith('INSERT OR IGNORE INTO EVENTS')) {
      const [type, ledger, txHash, payload] = args;
      if (!this._db._events.find((e) => e.tx_hash === txHash)) {
        this._db._events.push({ type, ledger, tx_hash: txHash, payload });
      }
      return { changes: 1, lastInsertRowid: 0 };
    }

    if (
      sql.startsWith('INSERT INTO INDEXER_STATE') ||
      sql.startsWith('INSERT OR REPLACE INTO INDEXER_STATE')
    ) {
      const [key, value] = args;
      this._db._state.set(key, value);
      return { changes: 1, lastInsertRowid: 0 };
    }

    if (sql.startsWith('INSERT INTO IDEMPOTENCY_KEYS')) {
      const [key, expiresAt, requestHash, method, path, statusCode, responseBody, createdAt] = args;
      this._db._idempotencyRows.set(key, {
        key,
        expires_at: expiresAt,
        request_hash: requestHash,
        method,
        path,
        status_code: statusCode,
        response_body: responseBody,
        created_at: createdAt,
      });
      return { changes: 1, lastInsertRowid: 0 };
    }

    if (sql.startsWith('DELETE FROM IDEMPOTENCY_KEYS')) {
      const threshold = args[0];
      let deleted = 0;
      for (const [key, row] of Array.from(this._db._idempotencyRows.entries())) {
        if (row.expires_at <= threshold) {
          this._db._idempotencyRows.delete(key);
          deleted += 1;
        }
      }
      return { changes: deleted, lastInsertRowid: 0 };
    }

    return { changes: 1, lastInsertRowid: 0 };
  }

  get(...args) {
    const sql = this._sql.toUpperCase();
    if (sql.includes('INDEXER_STATE')) {
      const key = args[0];
      const value = this._db._state.get(key);
      return value !== undefined ? { value } : undefined;
    }

    if (sql.includes('FROM IDEMPOTENCY_KEYS')) {
      const [key, now] = args;
      const row = this._db._idempotencyRows.get(key);
      if (row && row.expires_at > now) {
        return {
          key: row.key,
          expiresAt: row.expires_at,
          requestHash: row.request_hash,
          method: row.method,
          path: row.path,
          statusCode: row.status_code,
          responseBody: row.response_body,
          createdAt: row.created_at,
        };
      }
      return undefined;
    }

    return undefined;
  }

  all(...args) {
    const sql = this._sql.toUpperCase();
    if (sql.includes('FROM EVENTS')) {
      if (sql.includes('WHERE TYPE = ?')) {
        return this._db._events.filter((e) => e.type === args[0]);
      }
      return [...this._db._events];
    }

    if (sql.includes('FROM IDEMPOTENCY_KEYS')) {
      return Array.from(this._db._idempotencyRows.values()).map((row) => ({
        key: row.key,
      }));
    }

    return [];
  }
}

class Database {
  constructor(_path) {
    this._events = [];
    this._state = new Map();
    this._idempotencyRows = new Map();
  }

  exec(_sql) {
    // no-op: CREATE TABLE statements are ignored
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  transaction(fn) {
    return (...args) => fn(...args);
  }

  close() {}
}

module.exports = Database;
