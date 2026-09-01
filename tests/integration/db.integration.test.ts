/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration tests that run against a real better-sqlite3 in-memory database.
 * These bypass the __mocks__/better-sqlite3.js stub to catch SQL-level bugs
 * (wrong column names, missing indexes, conflict handling, type mismatches).
 */

// Unmock better-sqlite3 so we get the real native module
jest.unmock('better-sqlite3');

import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrate';
import { SqliteDriver } from '../../src/db/sqlite-driver';

let db: Database.Database;

beforeEach(async () => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL,
      ledger     INTEGER NOT NULL,
      tx_hash    TEXT NOT NULL UNIQUE,
      payload    TEXT NOT NULL,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_events_type_ledger ON events (type, ledger);
    CREATE TABLE IF NOT EXISTS indexer_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS players (
      player_id      TEXT    PRIMARY KEY,
      wallet         TEXT    NOT NULL,
      position       TEXT,
      region         TEXT,
      metadata_uri   TEXT,
      progress_level INTEGER DEFAULT 0,
      created_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_players_region   ON players (region);
    CREATE INDEX IF NOT EXISTS idx_players_position ON players (position);
    CREATE INDEX IF NOT EXISTS idx_players_tier     ON players (progress_level);
    CREATE TABLE IF NOT EXISTS validator_stats (
      wallet             TEXT PRIMARY KEY,
      milestones_approved INTEGER DEFAULT 0,
      milestones_rejected INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pending_milestones (
      milestone_id    TEXT PRIMARY KEY,
      player_id       TEXT NOT NULL,
      validator_wallet TEXT NOT NULL,
      milestone_type  TEXT NOT NULL,
      evidence_uri    TEXT NOT NULL,
      submitted_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_milestones_validator ON pending_milestones (validator_wallet);
    CREATE INDEX IF NOT EXISTS idx_pending_milestones_player ON pending_milestones (player_id);
    CREATE TABLE IF NOT EXISTS contact_unlocks (
      scout_wallet TEXT    NOT NULL,
      player_id    TEXT    NOT NULL,
      tx_hash      TEXT    NOT NULL,
      unlocked_at  INTEGER NOT NULL,
      PRIMARY KEY (scout_wallet, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_unlocks_scout ON contact_unlocks (scout_wallet);
  `);
  // runMigrations() expects the DbDriver abstraction (with .all()/.exec()/
  // .run()/.transaction()), not a raw better-sqlite3 Database instance —
  // wrap it the same way tests/db/migrate.test.ts and
  // tests/db/compositeIndex.test.ts do.
  await runMigrations(new SqliteDriver(db));
});

afterEach(() => {
  db.close();
});

// ─── Player insert / query ──────────────────────────────────────────────────

describe('Player insert and query (real DB)', () => {
  it('inserts a player and retrieves by player_id', () => {
    const insertSql = `INSERT INTO players (player_id, wallet, position, region, metadata_uri, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)`;
    db.prepare(insertSql).run('p1', 'GWALLET1', 'striker', 'EU', 'QmCID1', 1000);

    const row = db.prepare('SELECT * FROM players WHERE player_id = ?').get('p1') as any;
    expect(row).toBeDefined();
    expect(row.player_id).toBe('p1');
    expect(row.wallet).toBe('GWALLET1');
    expect(row.position).toBe('striker');
    expect(row.region).toBe('EU');
    expect(row.metadata_uri).toBe('QmCID1');
    expect(row.progress_level).toBe(0);
    expect(row.created_at).toBe(1000);
  });

  it('upserts a player (ON CONFLICT updates fields)', () => {
    const upsertSql = `INSERT INTO players (player_id, wallet, position, region, metadata_uri, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(player_id) DO UPDATE SET
                          wallet       = excluded.wallet,
                          position     = excluded.position,
                          region       = excluded.region,
                          metadata_uri = excluded.metadata_uri`;
    db.prepare(upsertSql).run('p1', 'GWALLET1', 'striker', 'EU', 'QmCID1', 1000);
    db.prepare(upsertSql).run('p1', 'GWALLET2', 'midfielder', 'NA', 'QmCID2', 2000);

    const row = db.prepare('SELECT * FROM players WHERE player_id = ?').get('p1') as any;
    expect(row.wallet).toBe('GWALLET2');
    expect(row.position).toBe('midfielder');
    expect(row.region).toBe('NA');
    expect(row.metadata_uri).toBe('QmCID2');
    // created_at should remain unchanged since ON CONFLICT doesn't update it
    expect(row.created_at).toBe(1000);
  });

  it('queries players by region and position', () => {
    const insertSql = `INSERT INTO players (player_id, wallet, position, region, metadata_uri, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)`;
    db.prepare(insertSql).run('p1', 'GW1', 'striker', 'EU', 'Qm1', 1000);
    db.prepare(insertSql).run('p2', 'GW2', 'defender', 'EU', 'Qm2', 1001);
    db.prepare(insertSql).run('p3', 'GW3', 'striker', 'NA', 'Qm3', 1002);

    const euStrikers = db
      .prepare('SELECT * FROM players WHERE region = ? AND position = ?')
      .all('EU', 'striker') as any[];
    expect(euStrikers).toHaveLength(1);
    expect(euStrikers[0].player_id).toBe('p1');

    const allEU = db
      .prepare('SELECT * FROM players WHERE region = ?')
      .all('EU') as any[];
    expect(allEU).toHaveLength(2);
  });

  it('filters players by progress_level (minTier)', () => {
    const insertSql = `INSERT INTO players (player_id, wallet, position, region, metadata_uri, progress_level, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.prepare(insertSql).run('p1', 'GW1', 'striker', 'EU', 'Qm1', 0, 1000);
    db.prepare(insertSql).run('p2', 'GW2', 'striker', 'EU', 'Qm2', 2, 1001);
    db.prepare(insertSql).run('p3', 'GW3', 'striker', 'EU', 'Qm3', 3, 1002);

    const tier2Plus = db
      .prepare('SELECT * FROM players WHERE progress_level >= ?')
      .all(2) as any[];
    expect(tier2Plus).toHaveLength(2);
  });

  it('counts players correctly with WHERE clauses', () => {
    const insertSql = `INSERT INTO players (player_id, wallet, position, region, metadata_uri, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)`;
    db.prepare(insertSql).run('p1', 'GW1', 'striker', 'EU', 'Qm1', 1000);
    db.prepare(insertSql).run('p2', 'GW2', 'defender', 'EU', 'Qm2', 1001);

    const count = db
      .prepare('SELECT COUNT(*) as count FROM players WHERE region = ?')
      .get('EU') as any;
    expect(count.count).toBe(2);

    const countStrikers = db
      .prepare('SELECT COUNT(*) as count FROM players WHERE region = ? AND position = ?')
      .get('EU', 'striker') as any;
    expect(countStrikers.count).toBe(1);
  });
});

// ─── Event insert / filter ──────────────────────────────────────────────────

describe('Event insert and filter (real DB)', () => {
  it('inserts an event and retrieves by type', () => {
    const insertSql = `INSERT INTO events (type, ledger, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)`;
    db.prepare(insertSql).run('player_registered', 100, 'tx1', JSON.stringify({ player_id: 'p1' }), 1000);

    const rows = db.prepare('SELECT * FROM events WHERE type = ? ORDER BY ledger ASC').all('player_registered') as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('player_registered');
    expect(rows[0].ledger).toBe(100);
    expect(JSON.parse(rows[0].payload)).toEqual({ player_id: 'p1' });
  });

  it('enforces UNIQUE constraint on tx_hash', () => {
    const insertSql = `INSERT INTO events (type, ledger, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)`;
    db.prepare(insertSql).run('player_registered', 100, 'tx-dup', '{}', 1000);

    expect(() => {
      db.prepare(insertSql).run('player_registered', 101, 'tx-dup', '{}', 1001);
    }).toThrow();
  });

  it('filters events by type and supports pagination (LIMIT/OFFSET)', () => {
    const insertSql = `INSERT INTO events (type, ledger, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)`;
    for (let i = 0; i < 5; i++) {
      db.prepare(insertSql).run('milestone_approved', 100 + i, `tx-ma-${i}`, JSON.stringify({ idx: i }), 1000 + i);
    }
    db.prepare(insertSql).run('player_registered', 200, 'tx-pr', '{}', 2000);

    const allMilestones = db
      .prepare('SELECT * FROM events WHERE type = ? ORDER BY ledger ASC')
      .all('milestone_approved') as any[];
    expect(allMilestones).toHaveLength(5);

    const page = db
      .prepare('SELECT * FROM events WHERE type = ? ORDER BY ledger ASC LIMIT ? OFFSET ?')
      .all('milestone_approved', 2, 1) as any[];
    expect(page).toHaveLength(2);
    expect(JSON.parse(page[0].payload).idx).toBe(1);
  });

  it('returns events count by type', () => {
    const insertSql = `INSERT INTO events (type, ledger, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)`;
    db.prepare(insertSql).run('contact_unlocked', 100, 'tx1', '{}', 1000);
    db.prepare(insertSql).run('contact_unlocked', 101, 'tx2', '{}', 1001);
    db.prepare(insertSql).run('player_registered', 102, 'tx3', '{}', 1002);

    const countRow = db.prepare('SELECT COUNT(*) AS count FROM events WHERE type = ?').get('contact_unlocked') as any;
    expect(countRow.count).toBe(2);

    const totalRow = db.prepare('SELECT COUNT(*) AS count FROM events').get() as any;
    expect(totalRow.count).toBe(3);
  });
});

// ─── Migration runner ───────────────────────────────────────────────────────

describe('Migration runner (real DB)', () => {
  it('records applied migrations in the migrations table', () => {
    const migrations = db.prepare('SELECT * FROM migrations').all() as any[];
    expect(migrations.length).toBeGreaterThan(0);
    for (const m of migrations) {
      expect(m.id).toBeDefined();
      expect(typeof m.applied_at).toBe('number');
    }
  });

  it('is idempotent — running migrations twice does not error or duplicate', async () => {
    const before = db.prepare('SELECT COUNT(*) as count FROM migrations').get() as any;
    await expect(runMigrations(new SqliteDriver(db))).resolves.not.toThrow();
    const after = db.prepare('SELECT COUNT(*) as count FROM migrations').get() as any;
    expect(after.count).toBe(before.count);
  });

  it('creates the player_profile_history table via migration', () => {
    const insertSql = `INSERT INTO player_profile_history (player_id, metadata_uri, changed_at, tx_hash)
                        VALUES (?, ?, ?, ?)`;
    expect(() => {
      db.prepare(insertSql).run('p1', 'QmNewCID', Date.now(), 'tx-hist-1');
    }).not.toThrow();

    const rows = db
      .prepare('SELECT * FROM player_profile_history WHERE player_id = ?')
      .all('p1') as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata_uri).toBe('QmNewCID');
  });

  it('creates the idempotency_keys table via migration', () => {
    const now = Date.now();
    const insertSql = `INSERT INTO idempotency_keys (key, status_code, response, created_at, expires_at)
                        VALUES (?, ?, ?, ?, ?)`;
    expect(() => {
      db.prepare(insertSql).run('test-key', 200, '{}', now, now + 86400000);
    }).not.toThrow();

    const row = db
      .prepare('SELECT * FROM idempotency_keys WHERE key = ?')
      .get('test-key') as any;
    expect(row).toBeDefined();
    expect(row.status_code).toBe(200);
  });

  it('creates the subscriptions table via migration', () => {
    const now = Math.floor(Date.now() / 1000);
    const insertSql = `INSERT INTO subscriptions (scout_wallet, tier, expires_at, created_at) VALUES (?, ?, ?, ?)`;
    expect(() => {
      db.prepare(insertSql).run('GSCOUT1', 'basic', now + 86400, now);
    }).not.toThrow();

    const row = db
      .prepare('SELECT * FROM subscriptions WHERE scout_wallet = ?')
      .get('GSCOUT1') as any;
    expect(row).toBeDefined();
    expect(row.tier).toBe('basic');
  });
});

// ─── Contact unlocks ────────────────────────────────────────────────────────

describe('Contact unlocks (real DB)', () => {
  it('inserts and queries contact unlocks', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO contact_unlocks (scout_wallet, player_id, tx_hash, unlocked_at) VALUES (?, ?, ?, ?)`
    ).run('GSCOUT1', 'player-1', 'txhash1', now);

    const row = db
      .prepare('SELECT 1 FROM contact_unlocks WHERE scout_wallet = ? AND player_id = ? LIMIT 1')
      .get('GSCOUT1', 'player-1');
    expect(row).toBeDefined();
  });

  it('enforces PRIMARY KEY (scout_wallet, player_id) — no duplicate unlocks', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO contact_unlocks (scout_wallet, player_id, tx_hash, unlocked_at) VALUES (?, ?, ?, ?)`
    ).run('GSCOUT1', 'player-1', 'txhash1', now);

    expect(() => {
      db.prepare(
        `INSERT INTO contact_unlocks (scout_wallet, player_id, tx_hash, unlocked_at) VALUES (?, ?, ?, ?)`
      ).run('GSCOUT1', 'player-1', 'txhash2', now + 1);
    }).toThrow();
  });

  it('INSERT OR IGNORE skips duplicate contact unlocks silently', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO contact_unlocks (scout_wallet, player_id, tx_hash, unlocked_at) VALUES (?, ?, ?, ?) ON CONFLICT(scout_wallet, player_id) DO NOTHING`
    ).run('GSCOUT1', 'player-1', 'txhash1', now);

    expect(() => {
      db.prepare(
        `INSERT INTO contact_unlocks (scout_wallet, player_id, tx_hash, unlocked_at) VALUES (?, ?, ?, ?) ON CONFLICT(scout_wallet, player_id) DO NOTHING`
      ).run('GSCOUT1', 'player-1', 'txhash2', now + 1);
    }).not.toThrow();

    const rows = db
      .prepare('SELECT * FROM contact_unlocks WHERE scout_wallet = ?')
      .all('GSCOUT1') as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tx_hash).toBe('txhash1');
  });
});
