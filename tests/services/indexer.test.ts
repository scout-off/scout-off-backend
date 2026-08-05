import { getDb, queryEvents, fetchLastIndexedLedger, persistLastIndexedLedger, insertOrUpdatePlayer, updatePlayerProgress, getPlayerById, queryPlayers, rollbackEventsFromLedger } from '../../src/db';
import { normalizeEventId, normalizePayload } from '../../src/services/indexer';

describe('indexer', () => {
  it('returns empty array when no events exist for a type', () => {
    const events = queryEvents('player_registered');
    expect(Array.isArray(events)).toBe(true);
  });

  describe('normalizePayload', () => {
    it('converts camelCase keys to snake_case', () => {
      const result = normalizePayload({ playerId: 'p1', evidenceUri: 'ipfs://x', unlockedAt: 100 });
      expect(result).toEqual({ player_id: 'p1', evidence_uri: 'ipfs://x', unlocked_at: 100 });
    });

    it('leaves snake_case keys unchanged', () => {
      const result = normalizePayload({ player_id: 'p1', evidence_uri: 'ipfs://x' });
      expect(result).toEqual({ player_id: 'p1', evidence_uri: 'ipfs://x' });
    });

    it('handles mixed payloads, normalising only camelCase keys', () => {
      const result = normalizePayload({ playerId: 'p1', region: 'EU', metadataUri: 'QmAbc', txHash: 'abc' });
      expect(result).toEqual({ player_id: 'p1', region: 'EU', metadata_uri: 'QmAbc', tx_hash: 'abc' });
    });

    it('returns empty object for empty input', () => {
      expect(normalizePayload({})).toEqual({});
    });
  });

  describe('normalizeEventId', () => {
    it('produces a stable canonical ID', () => {
      const id = normalizeEventId('CONTRACT_A', 100, '0xabc');
      expect(id).toBe('CONTRACT_A:100:0xabc');
    });

    it('produces different IDs for different inputs', () => {
      const a = normalizeEventId('C', 1, 'hash1');
      const b = normalizeEventId('C', 1, 'hash2');
      expect(a).not.toBe(b);
    });
  });
});

describe('player table helpers', () => {
  const PLAYER_ID = 'test-player-db-' + Math.random().toString(36).slice(2);
  const WALLET = 'GTEST' + 'A'.repeat(51);

  it('insertOrUpdatePlayer inserts a new player', () => {
    insertOrUpdatePlayer({ player_id: PLAYER_ID, wallet: WALLET, position: 'striker', region: 'EU', metadata_uri: 'QmTest', created_at: 1000 });
    const row = getPlayerById(PLAYER_ID);
    expect(row).not.toBeNull();
    expect(row!.wallet).toBe(WALLET);
    expect(row!.position).toBe('striker');
    expect(row!.region).toBe('EU');
    expect(row!.metadata_uri).toBe('QmTest');
    expect(row!.progress_level).toBe(0);
  });

  it('insertOrUpdatePlayer updates an existing player', () => {
    insertOrUpdatePlayer({ player_id: PLAYER_ID, wallet: WALLET, position: 'midfielder', region: 'NA' });
    const row = getPlayerById(PLAYER_ID);
    expect(row!.position).toBe('midfielder');
    expect(row!.region).toBe('NA');
  });

  it('updatePlayerProgress sets progress_level', () => {
    updatePlayerProgress(PLAYER_ID, 2);
    const row = getPlayerById(PLAYER_ID);
    expect(row!.progress_level).toBe(2);
  });

  it('getPlayerById returns null for unknown player', () => {
    expect(getPlayerById('nonexistent-player-xyz')).toBeNull();
  });

  it('queryPlayers returns players matching region filter', () => {
    const id2 = 'test-player-db2-' + Math.random().toString(36).slice(2);
    insertOrUpdatePlayer({ player_id: id2, wallet: WALLET, position: 'goalkeeper', region: 'EU' });
    const results = queryPlayers({ region: 'EU' });
    expect(results.some((r) => r.player_id === id2)).toBe(true);
  });

  it('queryPlayers returns players matching minTier filter', () => {
    updatePlayerProgress(PLAYER_ID, 3);
    const results = queryPlayers({ minTier: 3 });
    expect(results.some((r) => r.player_id === PLAYER_ID)).toBe(true);
    const belowTier = queryPlayers({ minTier: 4 });
    expect(belowTier.some((r) => r.player_id === PLAYER_ID)).toBe(false);
  });
});

// ─── Idempotent re-indexing ───────────────────────────────────────────────────

describe('idempotent re-indexing', () => {
  const TX_HASH = 'tx-reindex-test-' + Math.random().toString(36).slice(2);

  it('INSERT OR IGNORE deduplicates events with the same tx_hash', () => {
    const db = getDb();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO events (type, ledger, ledger_hash, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );

    // Insert once
    insert.run('player_registered', 100, 'hash', TX_HASH, '{}', Date.now());
    const countAfterFirst = queryEvents('player_registered').length;

    // Replay — same tx_hash must be silently ignored
    insert.run('player_registered', 100, 'hash', TX_HASH, '{}', Date.now());
    const countAfterReplay = queryEvents('player_registered').length;

    expect(countAfterReplay).toBe(countAfterFirst);
  });

  it('persistLastIndexedLedger / fetchLastIndexedLedger round-trips correctly', () => {
    persistLastIndexedLedger(5_000_000);
    expect(fetchLastIndexedLedger()).toBe(5_000_000);

    // Simulating a backfill reset
    persistLastIndexedLedger(4_999_000);
    expect(fetchLastIndexedLedger()).toBe(4_999_000);
  });

  it('replaying different tx_hashes at the same ledger inserts both', () => {
    const hash1 = 'tx-dedup-a-' + Math.random().toString(36).slice(2);
    const hash2 = 'tx-dedup-b-' + Math.random().toString(36).slice(2);
    const db = getDb();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload) VALUES (?, ?, ?, ?)'
    );

    const before = queryEvents().length;
    insert.run('scout_subscribed', 200, hash1, '{}');
    insert.run('scout_subscribed', 200, hash2, '{}');
    const after = queryEvents().length;

    expect(after).toBe(before + 2);
  });
});

describe('rollbackEventsFromLedger', () => {
  it('deletes events from the specified ledger forwards', () => {
    const db = getDb();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO events (type, ledger, ledger_hash, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insert.run('type_A', 300, 'h300', 'tx-300', '{}', Date.now());
    insert.run('type_A', 301, 'h301', 'tx-301', '{}', Date.now());
    insert.run('type_A', 302, 'h302', 'tx-302', '{}', Date.now());

    rollbackEventsFromLedger(301);

    const remaining = db.prepare('SELECT ledger FROM events WHERE ledger >= 300').all() as {ledger: number}[];
    expect(remaining.map(r => r.ledger)).toEqual([300]);
  });
});
