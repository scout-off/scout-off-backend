/**
 * Tests for the ?q= keyword search feature across queryPlayers / countPlayers.
 * Uses the in-memory better-sqlite3 mock, so no native binary needed.
 */
import { initDb, upsertPlayer, queryPlayers, countPlayers } from '../../src/db';

beforeAll(() => {
  initDb();
});

beforeEach(() => {
  // Seed a known set of players before each test
  upsertPlayer({ player_id: 'p1', wallet: 'W'.repeat(56), position: 'striker', region: 'europe', metadata_uri: 'QmStrikerEurope', created_at: 1 });
  upsertPlayer({ player_id: 'p2', wallet: 'X'.repeat(56), position: 'midfielder', region: 'africa', metadata_uri: 'QmMidAfrica', created_at: 2 });
  upsertPlayer({ player_id: 'p3', wallet: 'Y'.repeat(56), position: 'goalkeeper', region: 'europe', metadata_uri: 'QmGoalEurope', created_at: 3 });
  upsertPlayer({ player_id: 'p4', wallet: 'Z'.repeat(56), position: 'defender', region: 'asia', metadata_uri: 'QmDefAsia', created_at: 4 });
});

// ── Basic keyword matching ────────────────────────────────────────────────────

describe('queryPlayers — keyword search (?q=)', () => {
  it('returns players matching q against position', () => {
    const rows = queryPlayers({ q: 'striker' });
    expect(rows.map((r) => r.player_id)).toEqual(['p1']);
  });

  it('returns players matching q against region', () => {
    const rows = queryPlayers({ q: 'africa' });
    expect(rows.map((r) => r.player_id)).toEqual(['p2']);
  });

  it('returns players matching q against metadata_uri', () => {
    const rows = queryPlayers({ q: 'QmGoalEurope' });
    expect(rows.map((r) => r.player_id)).toEqual(['p3']);
  });

  it('is case-insensitive', () => {
    const rows = queryPlayers({ q: 'STRIKER' });
    expect(rows.map((r) => r.player_id)).toEqual(['p1']);
  });

  it('returns multiple matches when q appears in several rows', () => {
    const rows = queryPlayers({ q: 'europe' });
    expect(rows.map((r) => r.player_id).sort()).toEqual(['p1', 'p3'].sort());
  });

  it('returns all players when q is empty string (no filter)', () => {
    const rows = queryPlayers({ q: '' });
    expect(rows).toHaveLength(4);
  });

  it('returns empty array when q matches nothing', () => {
    const rows = queryPlayers({ q: 'zzznomatch' });
    expect(rows).toHaveLength(0);
  });

  it('returns all players when q is undefined', () => {
    const rows = queryPlayers({ q: undefined });
    expect(rows).toHaveLength(4);
  });
});

// ── Composability with existing filters ───────────────────────────────────────

describe('queryPlayers — q composable with existing filters', () => {
  it('combines q with region filter', () => {
    // q=Qm matches all four (all metadata_uri start with Qm);
    // region=europe narrows to p1 and p3
    const rows = queryPlayers({ q: 'Qm', region: 'europe' });
    expect(rows.map((r) => r.player_id).sort()).toEqual(['p1', 'p3'].sort());
  });

  it('combines q with position filter', () => {
    const rows = queryPlayers({ q: 'europe', position: 'goalkeeper' });
    expect(rows.map((r) => r.player_id)).toEqual(['p3']);
  });

  it('combines q with minTier filter', () => {
    // Set p1 tier to 2 so only p1 passes minTier=2 among the europe matches
    const { updatePlayerProgress } = require('../../src/db');
    updatePlayerProgress('p1', 2);

    const rows = queryPlayers({ q: 'europe', minTier: 2 });
    expect(rows.map((r) => r.player_id)).toEqual(['p1']);
  });

  it('returns empty when q matches but other filter does not', () => {
    const rows = queryPlayers({ q: 'striker', region: 'asia' });
    expect(rows).toHaveLength(0);
  });
});

// ── Pagination with keyword search ────────────────────────────────────────────

describe('queryPlayers — q with pagination', () => {
  it('paginates keyword-filtered results', () => {
    // europe matches p1 and p3; page 1 of size 1 → p1
    const page1 = queryPlayers({ q: 'europe', limit: 1, offset: 0 });
    expect(page1).toHaveLength(1);
    expect(page1[0].player_id).toBe('p1');

    // page 2 → p3
    const page2 = queryPlayers({ q: 'europe', limit: 1, offset: 1 });
    expect(page2).toHaveLength(1);
    expect(page2[0].player_id).toBe('p3');
  });
});

// ── countPlayers reflects q ───────────────────────────────────────────────────

describe('countPlayers — keyword search (?q=)', () => {
  it('counts rows matching q', () => {
    expect(countPlayers({ q: 'europe' })).toBe(2);
    expect(countPlayers({ q: 'striker' })).toBe(1);
    expect(countPlayers({ q: 'zzznomatch' })).toBe(0);
  });

  it('counts all rows when q is empty', () => {
    expect(countPlayers({ q: '' })).toBe(4);
  });

  it('count and query agree on the number of matches', () => {
    const rows = queryPlayers({ q: 'europe' });
    const count = countPlayers({ q: 'europe' });
    expect(rows.length).toBe(count);
  });
});
