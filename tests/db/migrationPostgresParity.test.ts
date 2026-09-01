// Parity test for issue #1190: every db/NNN_*.sql migration should have a
// matching `_postgres.sql` counterpart, unless explicitly allowlisted below.
//
// A base-only migration is not necessarily a Postgres schema gap — migrate.ts
// runs it through convertSqlToPostgres() when no dedicated `_postgres.sql`
// file exists (see src/db/migrate.ts's getDialectCounterpart/applyMigration
// logic), so files using only portable syntax that the converter already
// handles (AUTOINCREMENT, INSERT OR IGNORE, datetime('now')) are safe without
// a hand-written counterpart. Anything else must be paired.

import fs from 'fs';
import path from 'path';

const DB_DIR = path.resolve(__dirname, '../../db');

// Base migrations that intentionally have no dedicated `_postgres.sql` file
// because they contain only syntax convertSqlToPostgres() already translates
// (see src/db/migrate.ts). Linked to #1190.
const ALLOWLIST = new Set([
  '010_profile_views.sql', // INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL PRIMARY KEY
  '013_composite_indexes.sql', // CREATE INDEX only, no dialect-specific syntax
  '014_api_key_scopes.sql', // ALTER TABLE ADD COLUMN + partial index, portable
  '025_api_key_rotation.sql', // ALTER TABLE ADD COLUMN, portable
]);

describe('db/ migration Postgres parity', () => {
  it('every base migration has a _postgres.sql counterpart or is allowlisted', () => {
    const files = fs.readdirSync(DB_DIR).filter((f) => f.endsWith('.sql'));
    const baseFiles = files.filter(
      (f) => !f.includes('_postgres') && !f.endsWith('.down.sql'),
    );

    const unpaired = baseFiles.filter((f) => {
      const counterpart = f.replace('.sql', '_postgres.sql');
      return !files.includes(counterpart) && !ALLOWLIST.has(f);
    });

    expect(unpaired).toEqual([]);
  });

  it('does not allowlist a file that already has a _postgres.sql counterpart', () => {
    const files = fs.readdirSync(DB_DIR).filter((f) => f.endsWith('.sql'));
    const staleAllowlistEntries = [...ALLOWLIST].filter((f) =>
      files.includes(f.replace('.sql', '_postgres.sql')),
    );

    expect(staleAllowlistEntries).toEqual([]);
  });
});
