import { canAccessPlayer, PlayerAccessRow, PlayerAccessContext } from '../../src/utils/playerAccess';

function player(is_active: number | null | undefined): PlayerAccessRow {
  return { player_id: 'GPLAYER1', wallet: 'GWALLET1', is_active };
}

const ANONYMOUS: PlayerAccessContext = {};
const OWNER_BY_PLAYER_ID: PlayerAccessContext = { account: 'GPLAYER1' };
const OWNER_BY_WALLET: PlayerAccessContext = { account: 'GWALLET1' };
const OTHER_SCOUT: PlayerAccessContext = { account: 'GOTHER' };
const ADMIN: PlayerAccessContext = { account: 'GOTHER', role: 'admin' };

describe('canAccessPlayer', () => {
  describe.each([
    ['active (1)', 1],
    ['unknown (null)', null],
    ['unknown (undefined)', undefined],
  ] as const)('when is_active is %s', (_label, isActive) => {
    it.each([
      ['anonymous', ANONYMOUS],
      ['owner by player_id', OWNER_BY_PLAYER_ID],
      ['owner by wallet', OWNER_BY_WALLET],
      ['other scout', OTHER_SCOUT],
      ['admin', ADMIN],
    ])('%s -> true', (_role, ctx) => {
      expect(canAccessPlayer(player(isActive), ctx)).toBe(true);
    });
  });

  describe('when is_active is 0 (deactivated)', () => {
    it('anonymous -> false', () => {
      expect(canAccessPlayer(player(0), ANONYMOUS)).toBe(false);
    });

    it('owner by player_id -> true', () => {
      expect(canAccessPlayer(player(0), OWNER_BY_PLAYER_ID)).toBe(true);
    });

    it('owner by wallet -> true', () => {
      expect(canAccessPlayer(player(0), OWNER_BY_WALLET)).toBe(true);
    });

    it('other scout -> false', () => {
      expect(canAccessPlayer(player(0), OTHER_SCOUT)).toBe(false);
    });

    it('admin -> true', () => {
      expect(canAccessPlayer(player(0), ADMIN)).toBe(true);
    });
  });
});
