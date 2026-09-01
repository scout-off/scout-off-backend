import { getDriver, queryPlayers, countPlayers, insertOrUpdatePlayer } from '../../src/db';

describe('queryPlayers — SQL LIMIT/OFFSET pagination (#305)', () => {
  beforeEach(async () => {
    await getDriver().run('DELETE FROM players');
  });

  it('applies SQL-side pagination for filtered players', async () => {
    await insertOrUpdatePlayer({ player_id: 'p1', wallet: 'G'.repeat(56), position: 'striker', region: 'europe', created_at: 100 });
    await insertOrUpdatePlayer({ player_id: 'p2', wallet: 'G'.repeat(56), position: 'striker', region: 'europe', created_at: 200 });
    await insertOrUpdatePlayer({ player_id: 'p3', wallet: 'G'.repeat(56), position: 'striker', region: 'asia',   created_at: 300 });

    const rows = await queryPlayers({ region: 'europe', limit: 1, offset: 1 });

    expect(rows.map((r) => r.player_id)).toEqual(['p2']);
  });

  it('returns first page correctly', async () => {
    for (let i = 1; i <= 5; i++) {
      await insertOrUpdatePlayer({ player_id: `pp${i}`, wallet: 'G'.repeat(56), position: 'striker', region: 'europe', created_at: i * 100 });
    }

    const page1 = await queryPlayers({ region: 'europe', limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);
  });

  it('returns second page correctly (no overlap with first page)', async () => {
    for (let i = 1; i <= 5; i++) {
      await insertOrUpdatePlayer({ player_id: `pg${i}`, wallet: 'G'.repeat(56), position: 'midfielder', region: 'sa', created_at: i * 10 });
    }

    const page1 = (await queryPlayers({ region: 'sa', limit: 2, offset: 0 })).map((r) => r.player_id);
    const page2 = (await queryPlayers({ region: 'sa', limit: 2, offset: 2 })).map((r) => r.player_id);

    // No overlap between pages.
    expect(page1.some((id) => page2.includes(id))).toBe(false);
  });

  it('returns an empty array when offset exceeds total rows', async () => {
    await insertOrUpdatePlayer({ player_id: 'only1', wallet: 'G'.repeat(56), position: 'goalkeeper', region: 'af', created_at: 1 });

    const rows = await queryPlayers({ region: 'af', limit: 10, offset: 5 });
    expect(rows).toHaveLength(0);
  });

  it('countPlayers returns the total matching rows independent of limit/offset', async () => {
    for (let i = 1; i <= 6; i++) {
      await insertOrUpdatePlayer({ player_id: `cnt${i}`, wallet: 'G'.repeat(56), position: 'defender', region: 'eu', created_at: i });
    }

    const total = await countPlayers({ region: 'eu' });
    const page = await queryPlayers({ region: 'eu', limit: 2, offset: 0 });

    expect(total).toBe(6);
    expect(page).toHaveLength(2);
  });

  it('pages metadata is correct: total / pageSize = pages (rounded up)', async () => {
    const pageSize = 3;
    for (let i = 1; i <= 7; i++) {
      await insertOrUpdatePlayer({ player_id: `meta${i}`, wallet: 'G'.repeat(56), position: 'winger', region: 'asia2', created_at: i });
    }

    const total = await countPlayers({ region: 'asia2' });
    const pages = Math.ceil(total / pageSize);

    expect(total).toBe(7);
    expect(pages).toBe(3); // ceil(7/3) = 3
  });
});
