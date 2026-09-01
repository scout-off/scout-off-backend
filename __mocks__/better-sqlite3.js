/**
 * Manual Jest mock for better-sqlite3.
 *
 * This mock delegates to the real better-sqlite3 library when native bindings
 * are present, or falls back to an in-memory mock implementation when native
 * bindings are unavailable (e.g. Node 24 without C++ build tools).
 */

'use strict';

const path = require('path');
let RealBetter;
try {
  RealBetter = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
} catch {
  RealBetter = null;
}

function MockDatabase(dbPath, options) {
  if (RealBetter) {
    try {
      return new RealBetter(dbPath, options);
    } catch {
      // Fall through to mock implementation if native binding is missing
    }
  }

  return {
    pragma: () => [],
    exec: () => {},
    prepare: (sql) => ({
      get: () => {
        if (sql.includes('sqlite_version')) return { version: '3.39.5' };
        if (sql.includes('version()')) return { version: 'PostgreSQL 14.5' };
        if (sql.includes('SELECT 1')) return { '1': 1 };
        return { version: '3.39.5' };
      },
      all: () => [],
      run: () => ({ changes: 1, lastInsertRowid: 1 }),
    }),
    close: () => {},
  };
}

module.exports = MockDatabase;
module.exports.default = MockDatabase;
