#!/usr/bin/env npx ts-node
/**
 * scripts/seed.ts — Development database seeder
 *
 * Populates the local SQLite database with a realistic sample dataset so new
 * contributors have real data to work with immediately after cloning.
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/seed.ts
 *   npm run seed
 *
 * Selective seeding with --only:
 *   npm run seed -- --only players
 *   npm run seed -- --only players,subscriptions
 *
 * Supported types: players, events, milestones, subscriptions, contacts
 * (milestones and subscriptions are sub-sets of events; contacts is also a
 * sub-set of events.  Using --only milestones, --only subscriptions, or
 * --only contacts seeds only those event types plus any player rows they
 * reference.)
 *
 * When no --only flag is provided, all types are seeded (existing behaviour).
 *
 * The script is idempotent: running it multiple times is safe.  Each player,
 * event, and subscription is keyed by a stable ID so re-runs skip rows that
 * already exist rather than creating duplicates.
 *
 * Sample data:
 *   • 5 players across different regions / positions / progress tiers
 *   • 2 scouts with active subscriptions
 *   • 3 milestone-approved events (one per player, spread across tiers)
 *   • contact_unlocked events so scout contacts show up in the API
 */

// Bootstrap env before importing config (mirrors how the backfill script works)
import 'dotenv/config';

if (!process.env.CONTRACT_ID)
  process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'seed-script';

import { initDb, getDb, getDriver, insertOrUpdatePlayer, updatePlayerProgress } from '../src/db';

// ─── Sample data ──────────────────────────────────────────────────────────────

const PLAYERS = [
  {
    player_id: 'seed-player-001',
    wallet: 'GAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZFAZQXNK3BFMN7XRVGB',
    position: 'Forward',
    region: 'West Africa',
    metadata_uri: 'ipfs://QmSeedPlayer001MetadataHashForward',
    progress_level: 2,
    created_at: 1_700_000_000,
  },
  {
    player_id: 'seed-player-002',
    wallet: 'GBXNV6WTWQCRGMPTL7AXJBGZFAZQXNK3BFMN7XRVGBAEZI3BYWDXHZV',
    position: 'Midfielder',
    region: 'East Africa',
    metadata_uri: 'ipfs://QmSeedPlayer002MetadataMidfielder',
    progress_level: 1,
    created_at: 1_700_100_000,
  },
  {
    player_id: 'seed-player-003',
    wallet: 'GCRVGBAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZFAZQXNK3BFMN7X',
    position: 'Defender',
    region: 'South America',
    metadata_uri: 'ipfs://QmSeedPlayer003MetadataDefender',
    progress_level: 3,
    created_at: 1_700_200_000,
  },
  {
    player_id: 'seed-player-004',
    wallet: 'GDMN7XRVGBAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZFAZQXNK3BF',
    position: 'Goalkeeper',
    region: 'Europe',
    metadata_uri: 'ipfs://QmSeedPlayer004MetadataGoalkeeper',
    progress_level: 0,
    created_at: 1_700_300_000,
  },
  {
    player_id: 'seed-player-005',
    wallet: 'GEZFAZQXNK3BFMN7XRVGBAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVHAJBG',
    position: 'Winger',
    region: 'Southeast Asia',
    metadata_uri: 'ipfs://QmSeedPlayer005MetadataWinger',
    progress_level: 1,
    created_at: 1_700_400_000,
  },
];

/** Scout wallet addresses */
const SCOUT_ALPHA = 'GFAZQXNK3BFMN7XRVGBAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZE';
const SCOUT_BETA  = 'GHAJBGZFAZQXNK3BFMN7XRVGBAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVB';

/**
 * Events seeded into the `events` table.
 * tx_hash values are stable so re-runs are idempotent (UNIQUE constraint on tx_hash).
 */
const EVENTS: Array<{
  type: string;
  ledger: number;
  tx_hash: string;
  payload: object;
}> = [
  // ── Player registrations ──────────────────────────────────────────────────
  {
    type: 'player_registered',
    ledger: 5_000_001,
    tx_hash: 'seed-tx-player-001-register',
    payload: {
      player_id: 'seed-player-001',
      wallet: PLAYERS[0].wallet,
      metadata_uri: PLAYERS[0].metadata_uri,
      position: PLAYERS[0].position,
      region: PLAYERS[0].region,
    },
  },
  {
    type: 'player_registered',
    ledger: 5_000_002,
    tx_hash: 'seed-tx-player-002-register',
    payload: {
      player_id: 'seed-player-002',
      wallet: PLAYERS[1].wallet,
      metadata_uri: PLAYERS[1].metadata_uri,
      position: PLAYERS[1].position,
      region: PLAYERS[1].region,
    },
  },
  {
    type: 'player_registered',
    ledger: 5_000_003,
    tx_hash: 'seed-tx-player-003-register',
    payload: {
      player_id: 'seed-player-003',
      wallet: PLAYERS[2].wallet,
      metadata_uri: PLAYERS[2].metadata_uri,
      position: PLAYERS[2].position,
      region: PLAYERS[2].region,
    },
  },
  {
    type: 'player_registered',
    ledger: 5_000_004,
    tx_hash: 'seed-tx-player-004-register',
    payload: {
      player_id: 'seed-player-004',
      wallet: PLAYERS[3].wallet,
      metadata_uri: PLAYERS[3].metadata_uri,
      position: PLAYERS[3].position,
      region: PLAYERS[3].region,
    },
  },
  {
    type: 'player_registered',
    ledger: 5_000_005,
    tx_hash: 'seed-tx-player-005-register',
    payload: {
      player_id: 'seed-player-005',
      wallet: PLAYERS[4].wallet,
      metadata_uri: PLAYERS[4].metadata_uri,
      position: PLAYERS[4].position,
      region: PLAYERS[4].region,
    },
  },

  // ── Milestone approvals (3 milestones across different players) ───────────
  {
    type: 'milestone_approved',
    ledger: 5_001_000,
    tx_hash: 'seed-tx-milestone-001',
    payload: {
      player_id: 'seed-player-001',
      milestone_type: 'performance',
      evidence_uri: 'ipfs://QmSeedEvidence001TopSpeed32kmh',
      validator: 'GVALIDATOR1BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZFAZQXNK3BFMN7XR',
      new_progress_level: 2,
      timestamp: 1_700_050_000,
    },
  },
  {
    type: 'milestone_approved',
    ledger: 5_001_100,
    tx_hash: 'seed-tx-milestone-002',
    payload: {
      player_id: 'seed-player-002',
      milestone_type: 'identity',
      evidence_uri: 'ipfs://QmSeedEvidence002AcademyKYC',
      validator: 'GVALIDATOR1BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZFAZQXNK3BFMN7XR',
      new_progress_level: 1,
      timestamp: 1_700_150_000,
    },
  },
  {
    type: 'milestone_approved',
    ledger: 5_001_200,
    tx_hash: 'seed-tx-milestone-003',
    payload: {
      player_id: 'seed-player-003',
      milestone_type: 'trial_offer',
      evidence_uri: 'ipfs://QmSeedEvidence003TrialOfferEliteTier',
      validator: 'GVALIDATOR2BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZFAZQXNK3BFMN7XR',
      new_progress_level: 3,
      timestamp: 1_700_250_000,
    },
  },

  // ── Scout subscriptions ───────────────────────────────────────────────────
  {
    type: 'scout_subscribed',
    ledger: 5_002_000,
    tx_hash: 'seed-tx-scout-alpha-subscribe',
    payload: {
      scout: SCOUT_ALPHA,
      tier: 'premium',
      duration_days: 90,
      // expires ~90 days from a fixed past date — still active for ~2 years from seed
      subscription_expiry: Math.floor(Date.now() / 1000) + 90 * 86_400,
      tx_hash: 'seed-tx-scout-alpha-subscribe',
    },
  },
  {
    type: 'scout_subscribed',
    ledger: 5_002_100,
    tx_hash: 'seed-tx-scout-beta-subscribe',
    payload: {
      scout: SCOUT_BETA,
      tier: 'basic',
      duration_days: 30,
      subscription_expiry: Math.floor(Date.now() / 1000) + 30 * 86_400,
      tx_hash: 'seed-tx-scout-beta-subscribe',
    },
  },

  // ── Contact unlocks ───────────────────────────────────────────────────────
  {
    type: 'contact_unlocked',
    ledger: 5_003_000,
    tx_hash: 'seed-tx-alpha-unlocks-001',
    payload: {
      scout: SCOUT_ALPHA,
      player_id: 'seed-player-001',
      fee: '0.5',
      unlocked_at: 1_700_500_000,
      tx_hash: 'seed-tx-alpha-unlocks-001',
    },
  },
  {
    type: 'contact_unlocked',
    ledger: 5_003_100,
    tx_hash: 'seed-tx-beta-unlocks-003',
    payload: {
      scout: SCOUT_BETA,
      player_id: 'seed-player-003',
      fee: '0.5',
      unlocked_at: 1_700_600_000,
      tx_hash: 'seed-tx-beta-unlocks-003',
    },
  },
];

// ─── CLI argument parsing ─────────────────────────────────────────────────────

/** All recognised seed-type names. */
const VALID_TYPES = ['players', 'events', 'milestones', 'subscriptions', 'contacts'] as const;
type SeedType = typeof VALID_TYPES[number];

/**
 * Parse the --only flag from process.argv.
 *
 * Returns a Set of the requested types, or null when --only is not supplied
 * (meaning "seed everything").
 *
 * Unknown type names are logged as warnings and skipped.
 */
function parseOnly(): Set<SeedType> | null {
  const idx = process.argv.indexOf('--only');
  if (idx === -1) return null; // no flag → seed all

  const raw = process.argv[idx + 1];
  if (!raw || raw.startsWith('--')) {
    console.warn('⚠️  --only requires a value, e.g. --only players,subscriptions');
    return new Set<SeedType>(); // empty set → nothing seeded
  }

  const requested = new Set<SeedType>();
  for (const token of raw.split(',').map((t) => t.trim().toLowerCase())) {
    if ((VALID_TYPES as readonly string[]).includes(token)) {
      requested.add(token as SeedType);
    } else {
      console.warn(`⚠️  Unknown seed type "${token}" — skipped. Valid types: ${VALID_TYPES.join(', ')}`);
    }
  }
  return requested;
}

// ─── Seeding logic ────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  // initDb() already applies pending migrations internally — no separate
  // runMigrations() call needed here.
  await initDb();
  const db = getDb();

  const only = parseOnly();

  // Determine which categories to seed.
  // When --only is absent (only === null) every category is included.
  // When --only lists "milestones", "subscriptions", or "contacts" those map
  // to specific event types within the events table.  Requesting them does NOT
  // implicitly seed players — only an explicit "players" entry does that.
  const seedPlayers      = only === null || only.has('players');
  const seedEvents       = only === null || only.has('events');
  const seedMilestones   = only === null || only.has('milestones');
  const seedSubscriptions = only === null || only.has('subscriptions');
  const seedContacts     = only === null || only.has('contacts');

  // Derive which event types to insert
  const allowedEventTypes = new Set<string>();
  if (seedEvents) {
    // "events" flag means all event sub-types
    for (const ev of EVENTS) allowedEventTypes.add(ev.type);
  } else {
    if (seedMilestones)    allowedEventTypes.add('milestone_approved');
    if (seedSubscriptions) allowedEventTypes.add('scout_subscribed');
    if (seedContacts)      allowedEventTypes.add('contact_unlocked');
    // Always include player_registered events when players are being seeded so
    // the events table stays consistent with the players table.
    if (seedPlayers)       allowedEventTypes.add('player_registered');
  }

  console.log('🌱  ScoutOff seed starting…\n');
  if (only !== null) {
    console.log(`  Seeding only: ${[...only].join(', ') || '(nothing requested)'}\n`);
  }

  // ── Players ────────────────────────────────────────────────────────────────
  if (seedPlayers) {
    const insertedPlayers: string[] = [];
    const skippedPlayers: string[] = [];

    for (const p of PLAYERS) {
      const existing = db.prepare('SELECT player_id FROM players WHERE player_id = ?').get(p.player_id);
      if (existing) {
        skippedPlayers.push(p.player_id);
        continue;
      }
      await insertOrUpdatePlayer({
        player_id: p.player_id,
        wallet: p.wallet,
        position: p.position,
        region: p.region,
        metadata_uri: p.metadata_uri,
        created_at: p.created_at,
      });
      await updatePlayerProgress(p.player_id, p.progress_level);
      insertedPlayers.push(p.player_id);
    }

    console.log(`  Players   inserted=${insertedPlayers.length}  skipped=${skippedPlayers.length}`);
    if (insertedPlayers.length) console.log(`    + ${insertedPlayers.join(', ')}`);
  }

  // ── Events (registrations, milestones, subscriptions, contacts) ─────────
  if (allowedEventTypes.size > 0) {
    const insertEvent = db.prepare(
      'INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload) VALUES (?, ?, ?, ?)',
    );

    let insertedEvents = 0;
    let skippedEvents = 0;

    for (const ev of EVENTS) {
      if (!allowedEventTypes.has(ev.type)) continue;
      const result = insertEvent.run(ev.type, ev.ledger, ev.tx_hash, JSON.stringify(ev.payload));
      if (result.changes > 0) {
        insertedEvents++;
      } else {
        skippedEvents++;
      }
    }

    console.log(`  Events    inserted=${insertedEvents}  skipped=${skippedEvents}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const counts = {
    players: (db.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number }).n,
    events:  (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
    milestones: (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'milestone_approved'").get() as { n: number }).n,
    subscriptions: (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'scout_subscribed'").get() as { n: number }).n,
  };

  console.log('\n✅  Seed complete');
  console.log(`  DB totals — players: ${counts.players}  events: ${counts.events}  milestones: ${counts.milestones}  subscriptions: ${counts.subscriptions}`);
  console.log('\n  Scout wallets for manual API testing:');
  console.log(`    Scout Alpha (premium): ${SCOUT_ALPHA}`);
  console.log(`    Scout Beta  (basic):   ${SCOUT_BETA}`);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
