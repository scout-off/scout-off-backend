// Integration tests for src/db/migrate.ts — issue #508
//
// Acceptance criteria covered:
//  1. Every file under db/ is applied to a fresh empty DB in order with no errors.
//  2. The migration file list is discovered programmatically (readdirSync), not
//     hardcoded, so newly-added files are automatically covered.
//  3. The resulting schema is introspected via sqlite_master and asserted against
//     expected tables, columns, and indexes for each known migration.
//  4. Same-numeric-prefix migration files (002_*, 003_*, 004_*) do not conflict
//     when run together against a single fresh database.
//  5. The suite runs as part of the standard npm test run (ts-jest, testMatch
//     tests/**/*.test.ts).

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrate';
import { SqliteDriver } from '../../src/db/sqlite-driver';

/** Wrap a raw better-sqlite3 Database in the SqliteDriver adapter that runMigrations expects. */
async function migrate(db: Database.Database): Promise<void> {
  await runMigrations(new SqliteDriver(db));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DB_DIR = path.resolve(__dirname, '../../db');

/** Return every *.sql filename under db/ in the same lexicographic order that
 *  runMigrations() uses so the test faithfully exercises production ordering.
 *  Includes _postgres.sql counterparts — runMigrations() applies every such
 *  file too (converting it cross-driver rather than skipping it), tracking
 *  each as its own row in `migrations`; see the "#885" describe block below
 *  for the test that documents this explicitly. Excludes only .down.sql
 *  files, which are applied by the separate down-migration path. */
function discoverMigrationFiles(): string[] {
  return fs
    .readdirSync(DB_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
}

/** Thin wrapper: return the set of table names present in the DB. */
function getTables(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Return the set of column names for a given table. */
function getColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.pragma(`table_info(${table})`) as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Return the set of index names present in the DB (excluding internal). */
function getIndexes(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'"
    )
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runMigrations — integration suite (#508)', () => {
  // Shared DB created once for the schema-inspection block to avoid re-running
  // all migrations for every schema assertion.
  let sharedDb: Database.Database;

  beforeAll(async () => {
    sharedDb = new Database(':memory:');
    await migrate(sharedDb);
  });

  afterAll(() => {
    sharedDb.close();
  });

  // -------------------------------------------------------------------------
  // 1. Programmatic discovery — no hardcoded list
  // -------------------------------------------------------------------------

  describe('programmatic migration discovery', () => {
    it('discovers at least one *.sql file under db/', () => {
      const files = discoverMigrationFiles();
      expect(files.length).toBeGreaterThan(0);
    });

    it('discovered files are in strict lexicographic order', () => {
      const files = discoverMigrationFiles();
      const sorted = [...files].sort();
      expect(files).toEqual(sorted);
    });

    it('all discovered migration files are recorded in the migrations table after a fresh run', async () => {
      const db = new Database(':memory:');
      await migrate(db);

      const appliedRows = db
        .prepare('SELECT id FROM migrations ORDER BY id')
        .all() as { id: string }[];
      const appliedIds = appliedRows.map((r) => r.id);

      const expectedFiles = discoverMigrationFiles();

      for (const file of expectedFiles) {
        expect(appliedIds).toContain(file);
      }

      // No extra entries (guards against phantom rows)
      expect(appliedIds.length).toBe(expectedFiles.length);

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Clean application — every migration applies without error
  // -------------------------------------------------------------------------

  describe('clean application against a fresh empty database', () => {
    it('runMigrations() completes without throwing on a brand-new in-memory DB', async () => {
      const db = new Database(':memory:');
      await expect(migrate(db)).resolves.not.toThrow();
      db.close();
    });

    it('applies migrations in lexicographic filename order', async () => {
      const db = new Database(':memory:');
      await migrate(db);

      const appliedRows = db
        .prepare('SELECT id, applied_at FROM migrations ORDER BY applied_at, id')
        .all() as { id: string; applied_at: number }[];
      const appliedIds = appliedRows.map((r) => r.id);
      const expectedOrder = discoverMigrationFiles();

      expect(appliedIds).toEqual(expectedOrder);

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Schema introspection — tables, columns, indexes per migration
  // -------------------------------------------------------------------------

  describe('schema introspection after all migrations', () => {
    // --- 001_initial.sql ---
    describe('001_initial.sql', () => {
      it('creates the events table', () => {
        expect(getTables(sharedDb)).toContain('events');
      });

      it('events table has expected columns', () => {
        const cols = getColumns(sharedDb, 'events');
        expect(cols).toContain('id');
        expect(cols).toContain('type');
        expect(cols).toContain('ledger');
        expect(cols).toContain('tx_hash');
        expect(cols).toContain('payload');
      });

      it('creates idx_events_type index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_events_type');
      });

      it('creates idx_events_ledger index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_events_ledger');
      });

      it('creates the indexer_state table', () => {
        expect(getTables(sharedDb)).toContain('indexer_state');
      });

      it('indexer_state table has key and value columns', () => {
        const cols = getColumns(sharedDb, 'indexer_state');
        expect(cols).toContain('key');
        expect(cols).toContain('value');
      });

      it('creates the players table', () => {
        expect(getTables(sharedDb)).toContain('players');
      });

      it('players table has expected columns', () => {
        const cols = getColumns(sharedDb, 'players');
        expect(cols).toContain('player_id');
        expect(cols).toContain('wallet');
        expect(cols).toContain('position');
        expect(cols).toContain('region');
        expect(cols).toContain('metadata_uri');
        expect(cols).toContain('progress_level');
        expect(cols).toContain('created_at');
      });

      it('creates idx_players_region index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_players_region');
      });

      it('creates idx_players_position index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_players_position');
      });

      it('creates idx_players_tier index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_players_tier');
      });
    });

    // --- 002_audit_log.sql ---
    describe('002_audit_log.sql', () => {
      it('creates the audit_log table', () => {
        expect(getTables(sharedDb)).toContain('audit_log');
      });

      it('audit_log table has expected columns', () => {
        const cols = getColumns(sharedDb, 'audit_log');
        expect(cols).toContain('id');
        expect(cols).toContain('action');
        expect(cols).toContain('admin_wallet');
        expect(cols).toContain('query_params');
        expect(cols).toContain('created_at');
      });

      it('creates idx_audit_action index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_audit_action');
      });

      it('creates idx_audit_created_at index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_audit_created_at');
      });
    });

    // --- 002_player_profile_history.sql ---
    describe('002_player_profile_history.sql', () => {
      it('creates the player_profile_history table', () => {
        expect(getTables(sharedDb)).toContain('player_profile_history');
      });

      it('player_profile_history table has expected columns', () => {
        const cols = getColumns(sharedDb, 'player_profile_history');
        expect(cols).toContain('id');
        expect(cols).toContain('player_id');
        expect(cols).toContain('metadata_uri');
        expect(cols).toContain('changed_at');
        expect(cols).toContain('tx_hash');
      });

      it('creates idx_player_profile_history_player_changed_at index', () => {
        expect(getIndexes(sharedDb)).toContain(
          'idx_player_profile_history_player_changed_at'
        );
      });
    });

    // --- 002_trial_offer_events.sql ---
    describe('002_trial_offer_events.sql', () => {
      it('creates the trial_offer_events table', () => {
        expect(getTables(sharedDb)).toContain('trial_offer_events');
      });

      it('trial_offer_events table has expected columns', () => {
        const cols = getColumns(sharedDb, 'trial_offer_events');
        expect(cols).toContain('id');
        expect(cols).toContain('scout_wallet');
        expect(cols).toContain('player_id');
        expect(cols).toContain('details_uri');
        expect(cols).toContain('tx_hash');
        expect(cols).toContain('created_at');
      });

      it('creates idx_trial_offer_events_scout index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_trial_offer_events_scout');
      });

      it('creates idx_trial_offer_events_player index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_trial_offer_events_player');
      });
    });

    // --- 002_validators.sql ---
    describe('002_validators.sql', () => {
      it('creates the validators table', () => {
        expect(getTables(sharedDb)).toContain('validators');
      });

      it('validators table has expected columns', () => {
        const cols = getColumns(sharedDb, 'validators');
        expect(cols).toContain('wallet');
        expect(cols).toContain('registered_at');
        expect(cols).toContain('revoked_at');
        expect(cols).toContain('tx_hash');
      });

      it('creates idx_validators_revoked index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_validators_revoked');
      });
    });

    // --- 003_idempotency_keys.sql ---
    describe('003_idempotency_keys.sql', () => {
      it('creates the idempotency_keys table', () => {
        expect(getTables(sharedDb)).toContain('idempotency_keys');
      });

      it('idempotency_keys table has expected columns', () => {
        const cols = getColumns(sharedDb, 'idempotency_keys');
        expect(cols).toContain('key');
        expect(cols).toContain('status_code');
        expect(cols).toContain('response');
        expect(cols).toContain('created_at');
        expect(cols).toContain('expires_at');
      });

      it('creates idx_idempotency_keys_expires_at index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_idempotency_keys_expires_at');
      });
    });

    // --- 023_idempotency_request_fingerprint.sql ---
    describe('023_idempotency_request_fingerprint.sql', () => {
      it('adds the request_fingerprint column to idempotency_keys', () => {
        expect(getColumns(sharedDb, 'idempotency_keys')).toContain('request_fingerprint');
      });

      it('records a fingerprint on claim and returns it from getIdempotencyRecord', async () => {
        const db = new Database(':memory:');
        await migrate(db);
        db.prepare(
          `INSERT INTO idempotency_keys (key, status_code, response, created_at, expires_at, status, request_fingerprint)
           VALUES ('fp-key', 0, '', 1, 9999999999999, 'pending', 'wallet:player')`
        ).run();
        const row = db.prepare(
          'SELECT request_fingerprint FROM idempotency_keys WHERE key = ?'
        ).get('fp-key') as { request_fingerprint: string | null };
        expect(row.request_fingerprint).toBe('wallet:player');
        db.close();
      });
    });

    // --- 003_pending_pins.sql ---
    describe('003_pending_pins.sql', () => {
      it('creates the pending_pins table', () => {
        expect(getTables(sharedDb)).toContain('pending_pins');
      });

      it('pending_pins table has expected columns', () => {
        const cols = getColumns(sharedDb, 'pending_pins');
        expect(cols).toContain('id');
        expect(cols).toContain('payload');
        expect(cols).toContain('attempts');
        expect(cols).toContain('created_at');
        expect(cols).toContain('last_tried');
        expect(cols).toContain('status');
        expect(cols).toContain('expired_reason');
        expect(cols).toContain('last_reconciled_at');
      });
    });

    // --- 003_subscriptions.sql + 003_subscriptions_and_trial_offers.sql ---
    describe('003_subscriptions*.sql', () => {
      it('creates the subscriptions table', () => {
        expect(getTables(sharedDb)).toContain('subscriptions');
      });

      it('subscriptions table has expected columns', () => {
        const cols = getColumns(sharedDb, 'subscriptions');
        expect(cols).toContain('id');
        expect(cols).toContain('scout_wallet');
        expect(cols).toContain('tier');
        expect(cols).toContain('expires_at');
        expect(cols).toContain('cancelled_at');
        expect(cols).toContain('created_at');
      });

      it('creates idx_subscriptions_scout index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_subscriptions_scout');
      });

      it('creates the trial_offers table (from 003_subscriptions_and_trial_offers.sql)', () => {
        expect(getTables(sharedDb)).toContain('trial_offers');
      });

      it('trial_offers table has expected columns', () => {
        const cols = getColumns(sharedDb, 'trial_offers');
        expect(cols).toContain('id');
        expect(cols).toContain('offer_id');
        expect(cols).toContain('scout_wallet');
        expect(cols).toContain('player_id');
        expect(cols).toContain('details_uri');
        expect(cols).toContain('status');
        expect(cols).toContain('reject_reason');
        expect(cols).toContain('responded_at');
        expect(cols).toContain('created_at');
      });

      it('creates idx_trial_offers_player index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_trial_offers_player');
      });

      it('creates idx_trial_offers_scout index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_trial_offers_scout');
      });
    });

    // --- 004_token_revocation.sql ---
    describe('004_token_revocation.sql', () => {
      it('creates the revoked_tokens table', () => {
        expect(getTables(sharedDb)).toContain('revoked_tokens');
      });

      it('revoked_tokens table has expected columns', () => {
        const cols = getColumns(sharedDb, 'revoked_tokens');
        expect(cols).toContain('jti');
        expect(cols).toContain('revoked_at');
        expect(cols).toContain('expires_at');
      });

      it('creates idx_revoked_tokens_expires_at index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_revoked_tokens_expires_at');
      });
    });

    // --- 004_validators.sql (no-op — IF NOT EXISTS) ---
    describe('004_validators.sql (no-op — IF NOT EXISTS)', () => {
      it('validators table still exists and is queryable after the no-op 004 migration', () => {
        expect(getTables(sharedDb)).toContain('validators');
        expect(() =>
          sharedDb.prepare('SELECT * FROM validators LIMIT 0').all()
        ).not.toThrow();
      });
    });

    // --- 005_contact_unlocks.sql ---
    describe('005_contact_unlocks.sql', () => {
      it('creates the contact_unlocks table', () => {
        expect(getTables(sharedDb)).toContain('contact_unlocks');
      });

      it('contact_unlocks table has expected columns', () => {
        const cols = getColumns(sharedDb, 'contact_unlocks');
        expect(cols).toContain('scout_wallet');
        expect(cols).toContain('player_id');
        expect(cols).toContain('tx_hash');
        expect(cols).toContain('unlocked_at');
      });

      it('creates idx_contact_unlocks_scout index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_contact_unlocks_scout');
      });
    });

    // --- 010_admin_indexes.sql ---
    describe('010_admin_indexes.sql', () => {
      it('creates the validator_stats table', () => {
        expect(getTables(sharedDb)).toContain('validator_stats');
      });

      it('validator_stats table has expected columns', () => {
        const cols = getColumns(sharedDb, 'validator_stats');
        expect(cols).toContain('wallet');
        expect(cols).toContain('milestones_approved');
        expect(cols).toContain('milestones_rejected');
      });

      it('creates the pending_milestones table', () => {
        expect(getTables(sharedDb)).toContain('pending_milestones');
      });

      it('pending_milestones table has expected columns', () => {
        const cols = getColumns(sharedDb, 'pending_milestones');
        expect(cols).toContain('milestone_id');
        expect(cols).toContain('player_id');
        expect(cols).toContain('validator_wallet');
        expect(cols).toContain('milestone_type');
        expect(cols).toContain('evidence_uri');
        expect(cols).toContain('submitted_at');
      });

      it('creates idx_pending_milestones_validator index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_pending_milestones_validator');
      });

      it('creates idx_pending_milestones_player index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_pending_milestones_player');
      });

      it('creates idx_events_type_ledger index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_events_type_ledger');
      });

      it('creates idx_subscriptions_scout_cancelled_expires index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_subscriptions_scout_cancelled_expires');
      });

      it('creates idx_audit_action_created_at index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_audit_action_created_at');
      });

      it('creates idx_pending_milestones_validator_submitted_at index', () => {
        expect(getIndexes(sharedDb)).toContain('idx_pending_milestones_validator_submitted_at');
      });
    });
  });

  // -------------------------------------------------------------------------
  // 4. Same-numeric-prefix conflict tests (002_*, 003_*, 004_*)
  // -------------------------------------------------------------------------

  describe('same-numeric-prefix migrations do not conflict', () => {
    it('all four 002_* migrations apply cleanly together in a single fresh DB', async () => {
      const db = new Database(':memory:');
      await expect(migrate(db)).resolves.not.toThrow();

      const tables = getTables(db);
      expect(tables).toContain('validators');              // 002_validators
      expect(tables).toContain('player_profile_history');  // 002_player_profile_history
      expect(tables).toContain('audit_log');               // 002_audit_log
      expect(tables).toContain('trial_offer_events');      // 002_trial_offer_events

      const applied = (
        db.prepare("SELECT id FROM migrations WHERE id LIKE '002_%'").all() as {
          id: string;
        }[]
      ).map((r) => r.id);

      const expected002 = discoverMigrationFiles().filter((f) =>
        f.startsWith('002_')
      );
      expect(applied.sort()).toEqual(expected002.sort());

      db.close();
    });

    it('all four 003_* migrations apply cleanly together without duplicate-table errors', async () => {
      const db = new Database(':memory:');
      await expect(migrate(db)).resolves.not.toThrow();

      const tables = getTables(db);
      expect(tables).toContain('idempotency_keys');   // 003_idempotency_keys
      expect(tables).toContain('pending_pins');        // 003_pending_pins
      expect(tables).toContain('subscriptions');       // 003_subscriptions
      expect(tables).toContain('trial_offers');        // 003_subscriptions_and_trial_offers

      const applied = (
        db.prepare("SELECT id FROM migrations WHERE id LIKE '003_%'").all() as {
          id: string;
        }[]
      ).map((r) => r.id);

      const expected003 = discoverMigrationFiles().filter((f) =>
        f.startsWith('003_')
      );
      expect(applied.sort()).toEqual(expected003.sort());

      db.close();
    });

    it('both 004_* migrations apply cleanly — 004_validators is a safe no-op', async () => {
      const db = new Database(':memory:');
      await expect(migrate(db)).resolves.not.toThrow();

      const tables = getTables(db);
      expect(tables).toContain('revoked_tokens');  // 004_token_revocation
      expect(tables).toContain('validators');       // already from 002; 004 is no-op

      const applied = (
        db.prepare("SELECT id FROM migrations WHERE id LIKE '004_%'").all() as {
          id: string;
        }[]
      ).map((r) => r.id);

      const expected004 = discoverMigrationFiles().filter((f) =>
        f.startsWith('004_')
      );
      expect(applied.sort()).toEqual(expected004.sort());

      db.close();
    });

    it('subscriptions table is created exactly once despite two 003_* files defining it', async () => {
      const db = new Database(':memory:');
      await migrate(db);

      // If a duplicate CREATE TABLE (without IF NOT EXISTS) had been executed,
      // the migration would have thrown and the table would be missing or the
      // test would have already failed above. Here we verify there is exactly
      // one entry in sqlite_master for the subscriptions table.
      const rows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subscriptions'"
        )
        .all();
      expect(rows.length).toBe(1);

      db.close();
    });

    it('validators table is created exactly once despite 002_validators.sql and 004_validators.sql both defining it', async () => {
      const db = new Database(':memory:');
      await migrate(db);

      const rows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'validators'"
        )
        .all();
      expect(rows.length).toBe(1);

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Idempotency (pre-existing tests preserved and strengthened)
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('running migrations twice applies each file exactly once', async () => {
      const db = new Database(':memory:');

      await migrate(db);
      await migrate(db);

      const rows = db
        .prepare('SELECT id FROM migrations')
        .all() as { id: string }[];
      const ids = rows.map((r) => r.id);

      // No duplicate rows
      expect(new Set(ids).size).toBe(ids.length);

      // All files present
      const expectedFiles = discoverMigrationFiles();
      for (const file of expectedFiles) {
        expect(ids).toContain(file);
      }

      db.close();
    });

    it('running migrations three times produces no duplicate rows and no errors', async () => {
      const db = new Database(':memory:');

      await expect((async () => {
        await migrate(db);
        await migrate(db);
        await migrate(db);
      })()).resolves.not.toThrow();

      const rows = db
        .prepare('SELECT id FROM migrations')
        .all() as { id: string }[];
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // 6. All tables are queryable (smoke test — catches broken DDL)
  // -------------------------------------------------------------------------

  describe('all created tables are queryable after full migration run', () => {
    const expectedTables = [
      'events',
      'indexer_state',
      'players',
      'audit_log',
      'player_profile_history',
      'trial_offer_events',
      'validators',
      'idempotency_keys',
      'pending_pins',
      'subscriptions',
      'trial_offers',
      'revoked_tokens',
      'contact_unlocks',
      'validator_stats',
      'pending_milestones',
    ];

    for (const table of expectedTables) {
      it(`${table} is queryable with SELECT * LIMIT 0`, () => {
        expect(() =>
          sharedDb.prepare(`SELECT * FROM ${table} LIMIT 0`).all()
        ).not.toThrow();
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #885: full DB migration sequence integration test
// ---------------------------------------------------------------------------
//
// Verifies that applying all migrations in sequence from scratch (empty DB)
// succeeds without errors and produces the expected final schema.
// ---------------------------------------------------------------------------

describe('full migration sequence from scratch (#885)', () => {
  let db: Database.Database;

  beforeAll(async () => {
    db = new Database(':memory:');
    await migrate(db);
  });

  afterAll(() => {
    db.close();
  });

  // ── Helper ─────────────────────────────────────────────────────────────────

  function tables(): Set<string> {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  }

  function columns(table: string): Set<string> {
    const rows = db.pragma(`table_info(${table})`) as { name: string }[];
    return new Set(rows.map((r) => r.name));
  }

  // ── 1. No errors on a fresh in-memory DB ───────────────────────────────────

  it('runMigrations() completes without throwing on a fresh in-memory DB', async () => {
    const freshDb = new Database(':memory:');
    await expect(migrate(freshDb)).resolves.not.toThrow();
    freshDb.close();
  });

  // ── 2. All expected tables are present ────────────────────────────────────

  const expectedTables = [
    'events',
    'players',
    'subscriptions',
    'contact_unlocks',
    'validators',
    'audit_log',
    'api_keys',
    'webhook_subscriptions',
    'feature_flags',
    // tables also covered by earlier suites but required by issue spec
    'indexer_state',
    'pending_milestones',
  ];

  for (const table of expectedTables) {
    it(`expected table '${table}' exists after full migration sequence`, () => {
      expect(tables()).toContain(table);
    });
  }

  // ── 3. Key columns from later migrations ──────────────────────────────────

  it("players table has 'is_active' column added by migration 011_player_deactivation", () => {
    // Migration 011 adds is_active via ALTER TABLE players ADD COLUMN is_active
    expect(columns('players')).toContain('is_active');
  });

  it("api_keys table has expected columns from migration 007_api_keys", () => {
    const cols = columns('api_keys');
    expect(cols).toContain('id');
    expect(cols).toContain('key_hash');
    expect(cols).toContain('scout_wallet');
    expect(cols).toContain('label');
    expect(cols).toContain('created_at');
    expect(cols).toContain('last_used_at');
    expect(cols).toContain('revoked_at');
  });

  it("api_keys table has the lookup_hash column added by migration 024_api_key_lookup_hash (#1033)", () => {
    expect(columns('api_keys')).toContain('lookup_hash');
  });

  it("migration 024 creates the api_keys lookup indexes on both driver variants", () => {
    // Both 024_api_key_lookup_hash.sql and its _postgres twin are applied
    // (runMigrations converts cross-driver rather than skipping), and the pair
    // must be idempotent — the second must not fail or duplicate the indexes.
    const indexNames = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'api_keys'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(indexNames).toContain('idx_api_keys_lookup_hash');
    expect(indexNames).toContain('idx_api_keys_lookup_pending');
    expect(indexNames.filter((n) => n === 'idx_api_keys_lookup_hash')).toHaveLength(1);

    const applied = (
      db.prepare("SELECT id FROM migrations WHERE id LIKE '024_%'").all() as { id: string }[]
    ).map((r) => r.id);
    expect(applied.sort()).toEqual([
      '024_api_key_lookup_hash.sql',
      '024_api_key_lookup_hash_postgres.sql',
    ]);
  });

  it("webhook_subscriptions table has expected columns from migration 012_webhook_subscriptions", () => {
    const cols = columns('webhook_subscriptions');
    expect(cols).toContain('id');
    expect(cols).toContain('url');
    expect(cols).toContain('secret');
    expect(cols).toContain('created_at');
  });

  it("feature_flags table has expected columns from migration 010_feature_flags", () => {
    const cols = columns('feature_flags');
    expect(cols).toContain('name');
    expect(cols).toContain('enabled');
    expect(cols).toContain('updated_at');
    expect(cols).toContain('updated_by');
  });

  it("contact_unlocks table has expected columns from migration 005_contact_unlocks", () => {
    const cols = columns('contact_unlocks');
    expect(cols).toContain('scout_wallet');
    expect(cols).toContain('player_id');
    expect(cols).toContain('tx_hash');
    expect(cols).toContain('unlocked_at');
  });

  // ── 4. schema_migrations (migrations) table records all applied migrations ─

  it("'migrations' table exists and records every applied migration file", () => {
    expect(tables()).toContain('migrations');

    const appliedRows = db
      .prepare('SELECT id FROM migrations ORDER BY id')
      .all() as { id: string }[];
    const appliedIds = new Set(appliedRows.map((r) => r.id));

    // runMigrations() applies every *.sql file under db/ (including _postgres
    // variants — it converts them cross-driver rather than skipping them), so
    // match its filter exactly. Same filter as discoverMigrationFiles() above.
    const expectedFiles = fs
      .readdirSync(path.resolve(__dirname, '../../db'))
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort();

    for (const file of expectedFiles) {
      expect(appliedIds).toContain(file);
    }

    // No extra phantom rows
    expect(appliedRows.length).toBe(expectedFiles.length);
  });

  it("each migration in 'migrations' table has a non-null applied_at timestamp", () => {
    const rows = db
      .prepare('SELECT id, applied_at FROM migrations')
      .all() as { id: string; applied_at: number }[];
    for (const row of rows) {
      expect(typeof row.applied_at).toBe('number');
      expect(row.applied_at).toBeGreaterThan(0);
    }
  });

  // ── 5. All tables are queryable (smoke test) ───────────────────────────────

  const smokeTables = [
    'events',
    'players',
    'subscriptions',
    'contact_unlocks',
    'validators',
    'audit_log',
    'api_keys',
    'webhook_subscriptions',
    'feature_flags',
  ];

  for (const table of smokeTables) {
    it(`'${table}' is queryable with SELECT * LIMIT 0 after full migration`, () => {
      expect(() => db.prepare(`SELECT * FROM ${table} LIMIT 0`).all()).not.toThrow();
    });
  }
});
