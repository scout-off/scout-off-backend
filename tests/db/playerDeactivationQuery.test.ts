import { getDriver, queryPlayers, countPlayers, insertOrUpdatePlayer, deactivatePlayer, reactivatePlayer } from '../../src/db';

describe('Player Query Deactivation Filtering', () => {
  beforeEach(async () => {
    await getDriver().run('DELETE FROM players');
  });

  it('excludes deactivated players by default in queryPlayers and countPlayers', async () => {
    await insertOrUpdatePlayer({ player_id: 'p-active', wallet: 'G-wallet-active', position: 'striker', region: 'europe', created_at: 100 });
    await insertOrUpdatePlayer({ player_id: 'p-deactivated', wallet: 'G-wallet-deactivated', position: 'striker', region: 'europe', created_at: 200 });

    await deactivatePlayer('p-deactivated');

    // Default query
    const activeRows = await queryPlayers({ region: 'europe' });
    const activeCount = await countPlayers({ region: 'europe' });

    expect(activeRows.map((r) => r.player_id)).toEqual(['p-active']);
    expect(activeCount).toBe(1);
  });

  it('includes deactivated players in queryPlayers when includeDeactivated is true', async () => {
    await insertOrUpdatePlayer({ player_id: 'p-active', wallet: 'G-wallet-active', position: 'striker', region: 'europe', created_at: 100 });
    await insertOrUpdatePlayer({ player_id: 'p-deactivated', wallet: 'G-wallet-deactivated', position: 'striker', region: 'europe', created_at: 200 });

    await deactivatePlayer('p-deactivated');

    const allRows = await queryPlayers({ region: 'europe', includeDeactivated: true });
    expect(allRows.map((r) => r.player_id)).toContain('p-active');
    expect(allRows.map((r) => r.player_id)).toContain('p-deactivated');
    expect(allRows).toHaveLength(2);
  });

  it('makes reactivated players visible again', async () => {
    await insertOrUpdatePlayer({ player_id: 'p-reactivated', wallet: 'G-wallet-reactivated', position: 'striker', region: 'europe', created_at: 100 });

    await deactivatePlayer('p-reactivated');
    expect(await queryPlayers({ region: 'europe' })).toHaveLength(0);

    await reactivatePlayer('p-reactivated');
    expect((await queryPlayers({ region: 'europe' })).map((r) => r.player_id)).toEqual(['p-reactivated']);
  });
});
