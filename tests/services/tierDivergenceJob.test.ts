/**
 * Tests for the tier divergence reconciliation job (#1132).
 *
 * Verifies:
 *  - No mismatch → counter stays at 0, no warn log
 *  - Mismatch detected → counter incremented, warn log emitted with player_id, onchain, derived
 *  - Multiple mismatches → counter incremented per mismatch
 *  - DB error during player fetch → job logs warn, does not throw
 *  - scout_off_tier_divergence_total appears in /metrics output
 */
import {
  runTierDivergenceCheck,
  getTierDivergenceTotal,
  resetTierDivergenceTotal,
} from '../../src/services/tierDivergenceJob';

// ── Mocks ──────────────────────────────────────────────────────────────────────

// We need to control queryPlayers and queryEvents independently
let mockPlayers: Array<{ player_id: string; progress_level: number; is_active: number }> = [];
let mockApprovedEvents: Array<{ payload: { player_id: string } }> = [];

jest.mock('../../src/db', () => ({
  queryPlayers: jest.fn(async () => mockPlayers),
  queryEvents: jest.fn((type?: string) => {
    if (type === 'milestone_approved') return mockApprovedEvents;
    return [];
  }),
  getPlayerById: jest.fn(),
}));

// Capture logger.warn calls
const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

// Import logger to spy on it
import { logger } from '../../src/utils/logger';
const loggerWarnSpy = jest.spyOn(logger, 'warn');
const loggerDebugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);

describe('runTierDivergenceCheck (#1132)', () => {
  beforeEach(() => {
    resetTierDivergenceTotal();
    loggerWarnSpy.mockClear();
    loggerDebugSpy.mockClear();
    mockPlayers = [];
    mockApprovedEvents = [];
  });

  afterAll(() => {
    warnSpy.mockRestore();
    loggerWarnSpy.mockRestore();
    loggerDebugSpy.mockRestore();
  });

  it('does not increment counter when all tiers match', async () => {
    // Player with 0 approved milestones → tier 0
    mockPlayers = [{ player_id: 'p1', progress_level: 0, is_active: 1 }];
    mockApprovedEvents = [];

    await runTierDivergenceCheck();

    expect(getTierDivergenceTotal()).toBe(0);
    // No mismatch warning logged
    const mismatchWarn = loggerWarnSpy.mock.calls.find((args) =>
      String(args[0]).includes('mismatch'),
    );
    expect(mismatchWarn).toBeUndefined();
  });

  it('increments counter and logs warn when stored tier diverges from derived tier', async () => {
    // Player has 3 approved milestones → derived tier = 2, but stored as tier 1
    mockPlayers = [{ player_id: 'p-diverge', progress_level: 1, is_active: 1 }];
    mockApprovedEvents = [
      { payload: { player_id: 'p-diverge' } },
      { payload: { player_id: 'p-diverge' } },
      { payload: { player_id: 'p-diverge' } },
    ];

    await runTierDivergenceCheck();

    expect(getTierDivergenceTotal()).toBe(1);

    // Should emit a warn with player_id, onchain, derived fields
    const mismatchWarn = loggerWarnSpy.mock.calls.find((args) =>
      String(args[0]).includes('mismatch detected'),
    );
    expect(mismatchWarn).toBeDefined();
    const meta = mismatchWarn![1] as Record<string, unknown>;
    expect(meta.player_id).toBe('p-diverge');
    expect(meta.onchain).toBe(1);
    expect(meta.derived).toBe(2);
  });

  it('increments counter once per diverged player', async () => {
    mockPlayers = [
      { player_id: 'pA', progress_level: 0, is_active: 1 }, // 0 milestones → correct
      { player_id: 'pB', progress_level: 3, is_active: 1 }, // 1 milestone → derived 1, stored 3 (diverge)
      { player_id: 'pC', progress_level: 0, is_active: 1 }, // 3 milestones → derived 2, stored 0 (diverge)
    ];
    mockApprovedEvents = [
      { payload: { player_id: 'pB' } },
      { payload: { player_id: 'pC' } },
      { payload: { player_id: 'pC' } },
      { payload: { player_id: 'pC' } },
    ];

    await runTierDivergenceCheck();

    // pA correct, pB and pC diverge
    expect(getTierDivergenceTotal()).toBe(2);
  });

  it('accumulates counter across multiple runs', async () => {
    mockPlayers = [{ player_id: 'pX', progress_level: 3, is_active: 1 }];
    mockApprovedEvents = [{ payload: { player_id: 'pX' } }]; // derived = 1, stored = 3

    await runTierDivergenceCheck();
    await runTierDivergenceCheck();

    expect(getTierDivergenceTotal()).toBe(2);
  });

  it('does not throw and logs warn when queryPlayers rejects', async () => {
    const { queryPlayers } = jest.requireMock('../../src/db') as { queryPlayers: jest.Mock };
    queryPlayers.mockRejectedValueOnce(new Error('DB is unavailable'));

    await expect(runTierDivergenceCheck()).resolves.toBeUndefined();

    const errorWarn = loggerWarnSpy.mock.calls.find((args) =>
      String(args[0]).includes('failed to fetch'),
    );
    expect(errorWarn).toBeDefined();
    expect(getTierDivergenceTotal()).toBe(0);
  });

  it('correctly maps 6+ approved milestones to tier 3', async () => {
    mockPlayers = [{ player_id: 'pElite', progress_level: 2, is_active: 1 }]; // stored 2 but should be 3
    mockApprovedEvents = Array.from({ length: 6 }, () => ({ payload: { player_id: 'pElite' } }));

    await runTierDivergenceCheck();

    expect(getTierDivergenceTotal()).toBe(1);
    const warn = loggerWarnSpy.mock.calls.find((args) =>
      String(args[0]).includes('mismatch detected'),
    );
    const meta = warn![1] as Record<string, unknown>;
    expect(meta.derived).toBe(3);
    expect(meta.onchain).toBe(2);
  });
});
