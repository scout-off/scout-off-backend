/**
 * Manual Jest mock for better-sqlite3.
 * Provides a minimal in-memory SQL-like interface so tests can run without
 * the native binary (which requires a matching Node ABI).
 */

/**
 * Case-insensitive LIKE match helper.
 * Supports '%value%' patterns only (the only pattern used in this codebase).
 */
function likeMatch(value, pattern) {
  if (value == null) return false;
  const inner = pattern.replace(/^%|%$/g, '').toLowerCase();
  return String(value).toLowerCase().includes(inner);
}

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
    } else if (sql.startsWith('INSERT INTO MIGRATIONS')) {
      const [id, appliedAt] = args;
      this._db._migrations.set(id, { id, applied_at: appliedAt });
    } else if (sql.startsWith('INSERT INTO INDEXER_STATE') || sql.startsWith('INSERT OR REPLACE INTO INDEXER_STATE')) {
      const [key, value] = args;
      this._db._state.set(key, value);
    } else if (sql.startsWith('INSERT INTO PLAYERS')) {
      const [player_id, wallet, position, region, metadata_uri, created_at] = args;
      const existing = this._db._players.findIndex((p) => p.player_id === player_id);
      if (existing >= 0) {
        // ON CONFLICT DO UPDATE — update mutable fields
        this._db._players[existing] = {
          ...this._db._players[existing],
          wallet,
          position,
          region,
          metadata_uri,
        };
      } else {
        this._db._players.push({ player_id, wallet, position, region, metadata_uri, progress_level: 0, created_at });
      }
    } else if (sql.startsWith('UPDATE PLAYERS SET PROGRESS_LEVEL')) {
      const [level, player_id] = args;
      const idx = this._db._players.findIndex((p) => p.player_id === player_id);
      if (idx >= 0) this._db._players[idx].progress_level = level;
    }
    return { changes: 1, lastInsertRowid: 0 };
  }

  _filterPlayers(args) {
    let rows = [...this._db._players];
    const sql = this._sql.toUpperCase();

    const whereMatch = sql.match(/WHERE (.+?)(?:ORDER|LIMIT|$)/);
    if (!whereMatch) return rows;

    // Parse conditions split by ' AND ' — handles nested parens for LIKE group.
    const rawWhere = whereMatch[1].trim();
    // Split on ' AND ' but not inside parentheses.
    const conditions = [];
    let depth = 0, start = 0;
    for (let i = 0; i < rawWhere.length; i++) {
      if (rawWhere[i] === '(') depth++;
      else if (rawWhere[i] === ')') depth--;
      else if (depth === 0 && rawWhere.slice(i, i + 5) === ' AND ') {
        conditions.push(rawWhere.slice(start, i).trim());
        i += 4;
        start = i + 1;
      }
    }
    conditions.push(rawWhere.slice(start).trim());

    let argIdx = 0;
    for (const cond of conditions) {
      if (cond.includes('REGION = ?')) {
        const val = args[argIdx++];
        rows = rows.filter((r) => r.region === val);
      } else if (cond.includes('POSITION = ?')) {
        const val = args[argIdx++];
        rows = rows.filter((r) => r.position === val);
      } else if (cond.includes('PROGRESS_LEVEL >= ?')) {
        const val = args[argIdx++];
        rows = rows.filter((r) => r.progress_level >= val);
      } else if (cond.includes('LOWER(POSITION) LIKE') || cond.includes('LOWER(REGION) LIKE') || cond.includes('LOWER(METADATA_URI) LIKE')) {
        // LIKE group: (LOWER(position) LIKE LOWER(?) OR LOWER(region) LIKE LOWER(?) OR LOWER(metadata_uri) LIKE LOWER(?))
        // consumes 3 args, all the same term
        const term = args[argIdx++];
        argIdx += 2; // skip the duplicated term args
        rows = rows.filter((r) =>
          likeMatch(r.position, term) ||
          likeMatch(r.region, term) ||
          likeMatch(r.metadata_uri, term)
        );
      }
    }
    return { rows, nextArgIdx: argIdx };
  }

  get(...args) {
    const sql = this._sql.toUpperCase();
    if (sql.includes('FROM MIGRATIONS')) {
      const id = args[0];
      return this._db._migrations.get(id) ?? undefined;
    }
    if (sql.includes('INDEXER_STATE')) {
      const key = args[0];
      const value = this._db._state.get(key);
      return value !== undefined ? { value } : undefined;
    }
    if (sql.includes('FROM PLAYERS') && sql.includes('WHERE PLAYER_ID = ?')) {
      return this._db._players.find((p) => p.player_id === args[0]) ?? undefined;
    }
    if (sql.includes('COUNT(*)') && sql.includes('FROM EVENTS')) {
      const rows = sql.includes('WHERE TYPE = ?')
        ? this._db._events.filter((e) => e.type === args[0])
        : this._db._events;
      return { count: rows.length };
    }
    if (sql.includes('COUNT(*)') && sql.includes('FROM PLAYERS')) {
      const result = this._filterPlayers(args);
      const rows = result.rows ?? result;
      return { count: rows.length };
    }
    return undefined;
  }

  all(...args) {
    const sql = this._sql.toUpperCase();
    if (sql.includes('FROM MIGRATIONS')) {
      return [...this._db._migrations.values()];
    }
    if (sql.includes('FROM EVENTS')) {
      let rows;
      let argIdx = 0;
      if (sql.includes('WHERE TYPE = ?')) {
        rows = this._db._events.filter((e) => e.type === args[argIdx++]);
      } else {
        rows = [...this._db._events];
      }
      if (sql.includes('LIMIT ?')) {
        const limit = args[argIdx++];
        const offset = args[argIdx++] ?? 0;
        rows = rows.slice(offset, offset + limit);
      }
      return rows;
    }
    if (sql.includes('FROM PLAYERS')) {
      const result = this._filterPlayers(args);
      let rows = result.rows ?? result;
      let nextArgIdx = result.nextArgIdx ?? 0;

      if (sql.includes('LIMIT ?')) {
        const limit = args[nextArgIdx++];
        const offset = args[nextArgIdx++] ?? 0;
        rows = rows.slice(offset, offset + limit);
      }
      return rows;
    }
    return [];
  }
}

class Database {
  constructor(_path) {
    this._events = [];
    this._state = new Map();
    this._players = [];
    this._migrations = new Map();
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
