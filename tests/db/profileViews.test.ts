/**
 * Repository tests for src/db/repositories/profileViews.ts (#1869).
 *
 * Covers insert, the 5-minute de-duplication window helper, aggregation
 * (lifetime + daily rollup) and unique-viewer counting. Runs on both the
 * SQLite and PostgreSQL drivers via getDriver().
 */
import { getDriver } from '../../src/db';
import {
  recordProfileView,
  getLastProfileView,
  getProfileViewCount,
  getUniqueViewerCount,
  getContactUnlockCount,
} from '../../src/db/repositories/profileViews';

const PLAYER = 'player-profile-views-1';
const OTHER_PLAYER = 'player-profile-views-2';
const SCOUT_A = 'GAAA-scout-a';
const SCOUT_B = 'GBBB-scout-b';
const DAY_MS = 86_400_000;

async function clear(): Promise<void> {
  await getDriver().run('DELETE FROM profile_views WHERE player_id IN (?, ?)', [
    PLAYER,
    OTHER_PLAYER,
  ]);
  await getDriver().run('DELETE FROM profile_view_daily WHERE player_id IN (?, ?)', [
    PLAYER,
    OTHER_PLAYER,
  ]);
  await getDriver().run('DELETE FROM contact_unlocks WHERE player_id IN (?, ?)', [
    PLAYER,
    OTHER_PLAYER,
  ]);
}

describe('profileViews repository', () => {
  beforeEach(clear);
  afterAll(clear);

  describe('recordProfileView', () => {
    it('inserts a row readable through getLastProfileView', async () => {
      await recordProfileView({
        scout_wallet: SCOUT_A,
        player_id: PLAYER,
        viewed_at: 1_000,
        created_at: 1_000,
      });
      await expect(getLastProfileView(SCOUT_A, PLAYER)).resolves.toBe(1_000);
    });

    it('returns null when the scout has never viewed the player', async () => {
      await expect(getLastProfileView(SCOUT_A, PLAYER)).resolves.toBeNull();
    });

    it('scopes the last view to the given scout and player', async () => {
      await recordProfileView({
        scout_wallet: SCOUT_A,
        player_id: PLAYER,
        viewed_at: 1_000,
        created_at: 1_000,
      });
      await recordProfileView({
        scout_wallet: SCOUT_B,
        player_id: PLAYER,
        viewed_at: 2_000,
        created_at: 2_000,
      });
      await recordProfileView({
        scout_wallet: SCOUT_A,
        player_id: OTHER_PLAYER,
        viewed_at: 3_000,
        created_at: 3_000,
      });

      await expect(getLastProfileView(SCOUT_A, PLAYER)).resolves.toBe(1_000);
      await expect(getLastProfileView(SCOUT_B, PLAYER)).resolves.toBe(2_000);
      await expect(getLastProfileView(SCOUT_A, OTHER_PLAYER)).resolves.toBe(3_000);
    });
  });

  describe('de-duplication window', () => {
    it('reports the newest view so callers can apply the 5-minute window', async () => {
      const base = 10_000_000;
      await recordProfileView({
        scout_wallet: SCOUT_A,
        player_id: PLAYER,
        viewed_at: base,
        created_at: base,
      });
      await recordProfileView({
        scout_wallet: SCOUT_A,
        player_id: PLAYER,
        viewed_at: base + 60_000,
        created_at: base + 60_000,
      });

      const last = await getLastProfileView(SCOUT_A, PLAYER);
      expect(last).toBe(base + 60_000);
      // A view inside the window is suppressed by the caller.
      expect(base + 60_000 - (last as number) < 5 * 60_000).toBe(true);
    });

    it('does not aggregate duplicate rows on insert (raw rows are preserved)', async () => {
      await recordProfileView({
        scout_wallet: SCOUT_A,
        player_id: PLAYER,
        viewed_at: 1_000,
        created_at: 1_000,
      });
      await recordProfileView({
        scout_wallet: SCOUT_A,
        player_id: PLAYER,
        viewed_at: 1_000,
        created_at: 1_000,
      });
      await expect(getProfileViewCount(PLAYER)).resolves.toBe(2);
    });
  });

  describe('getProfileViewCount', () => {
    it('returns 0 for an unknown player', async () => {
      await expect(getProfileViewCount(PLAYER)).resolves.toBe(0);
    });

    it('counts raw rows for the player only', async () => {
      await recordProfileView({
        scout_wallet: SCOUT_A,
        player_id: PLAYER,
        viewed_at: 1_000,
        created_at: 1_000,
      });
      await recordProfileView({
        scout_wallet: SCOUT_B,
        player_id: PLAYER,
        viewed_at: 2_000,
        created_at: 2_000,
      });
      await recordProfileView({
        scout_wallet: SCOUT_A,
        player_id: OTHER_PLAYER,
        viewed_at: 3_000,
        created_at: 3_000,
      });

      await expect(getProfileViewCount(PLAYER)).resolves.toBe(2);
      await expect(getProfileViewCount(OTHER_PLAYER)).resolves.toBe(1);
    });

    it('adds the daily rollup view_count to the raw row count', async () => {
      await recordProfileView({
        scout_wallet: SCOUT_A,
        player_id: PLAYER,
        viewed_at: 1_000,
        created_at: 1_000,
      });
      await getDriver().run(
        'INSERT INTO profile_view_daily (player_id, scout_wallet, day, view_count) VALUES (?, ?, ?, ?)',
        [PLAYER, SCOUT_A, 1, 4],
      );
      await getDriver().run(
        'INSERT INTO profile_view_daily (player_id, scout_wallet, day, view_count) VALUES (?, ?, ?, ?)',
        [PLAYER, SCOUT_B, 2, 3],
      );

      await expect(getProfileViewCount(PLAYER)).resolves.toBe(8);
    });

    it('returns a number (not a driver-specific string) for large counts', async () => {
      await getDriver().run(
        'INSERT INTO profile_view_daily (player_id, scout_wallet, day, view_count) VALUES (?, ?, ?, ?)',
        [PLAYER, SCOUT_A, 1, 1_000_000],
      );
      const count = await getProfileViewCount(PLAYER);
      expect(typeof count).toBe('number');
      expect(count).toBe(1_000_000);
    });
  });

  describe('getUniqueViewerCount', () => {
    it('returns 0 for an unknown player', async () => {
      await expect(getUniqueViewerCount(PLAYER)).resolves.toBe(0);
    });

    it('counts distinct scouts across raw rows and the daily rollup', async () => {
      await recordProfileView({
        scout_wallet: SCOUT_A,
        player_id: PLAYER,
        viewed_at: 1_000,
        created_at: 1_000,
      });
      await recordProfileView({
        scout_wallet: SCOUT_A,
        player_id: PLAYER,
        viewed_at: 2_000,
        created_at: 2_000,
      });
      await recordProfileView({
        scout_wallet: SCOUT_B,
        player_id: PLAYER,
        viewed_at: 3_000,
        created_at: 3_000,
      });
      // SCOUT_A also appears in the rollup — must not be double counted.
      await getDriver().run(
        'INSERT INTO profile_view_daily (player_id, scout_wallet, day, view_count) VALUES (?, ?, ?, ?)',
        [PLAYER, SCOUT_A, 1, 2],
      );
      await getDriver().run(
        'INSERT INTO profile_view_daily (player_id, scout_wallet, day, view_count) VALUES (?, ?, ?, ?)',
        [PLAYER, 'GCCC-scout-c', 1, 1],
      );

      await expect(getUniqueViewerCount(PLAYER)).resolves.toBe(3);
    });

    it('ignores views belonging to other players', async () => {
      await recordProfileView({
        scout_wallet: SCOUT_A,
        player_id: OTHER_PLAYER,
        viewed_at: 1_000,
        created_at: 1_000,
      });
      await expect(getUniqueViewerCount(PLAYER)).resolves.toBe(0);
    });
  });

  describe('getContactUnlockCount', () => {
    it('returns 0 when nothing is unlocked', async () => {
      await expect(getContactUnlockCount(PLAYER)).resolves.toBe(0);
    });
  });

  describe('date-bucketed rollup', () => {
    it('keeps per-day buckets separate in profile_view_daily', async () => {
      const day1 = Math.floor(1_700_000_000_000 / DAY_MS);
      const day2 = day1 + 1;
      for (const day of [day1, day1, day2]) {
        await getDriver().run(
          `INSERT INTO profile_view_daily (player_id, scout_wallet, day, view_count) VALUES (?, ?, ?, 1)
           ON CONFLICT (player_id, scout_wallet, day) DO UPDATE SET view_count = profile_view_daily.view_count + 1`,
          [PLAYER, SCOUT_A, day],
        );
      }

      const rows = await getDriver().all<{ day: number | string; view_count: number | string }>(
        'SELECT day, view_count FROM profile_view_daily WHERE player_id = ? ORDER BY day ASC',
        [PLAYER],
      );
      expect(rows).toHaveLength(2);
      expect(Number(rows[0].day)).toBe(day1);
      expect(Number(rows[0].view_count)).toBe(2);
      expect(Number(rows[1].day)).toBe(day2);
      expect(Number(rows[1].view_count)).toBe(1);
      await expect(getProfileViewCount(PLAYER)).resolves.toBe(3);
    });
  });
});
