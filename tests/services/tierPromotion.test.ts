import { indexEvents } from '../../src/services/indexer';
import { getPlayerById } from '../../src/db';
import { tierForApprovedMilestones, TIER_THRESHOLDS } from '../../src/services/tierPromotion';

// The indexer reaches out to the chain and to the webhook dispatcher; stub both
// so the test exercises only the DB-backed tier-promotion path.
jest.mock('../../src/services/stellar', () => ({
  server: { getEvents: jest.fn() },
}));
jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { server } = require('../../src/services/stellar') as {
  server: { getEvents: jest.Mock };
};

function rawEvent(type: string, payload: Record<string, unknown>, txHash: string, ledger: number) {
  return {
    topic: [{ value: () => type }],
    value: { value: () => payload },
    ledger,
    txHash,
  };
}

describe('tierForApprovedMilestones (promotion criteria)', () => {
  it('promotes through tiers 0 → 1 → 2 → 3 as approved milestones accumulate', () => {
    // [approved milestone count, expected tier]
    const sequence: Array<[number, number]> = [
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
      [5, 2],
      [6, 3],
      [12, 3],
    ];
    for (const [count, expectedTier] of sequence) {
      expect(tierForApprovedMilestones(count)).toBe(expectedTier);
    }
  });

  it('clamps negative / fractional counts and never exceeds the top tier', () => {
    expect(tierForApprovedMilestones(-3)).toBe(0);
    expect(tierForApprovedMilestones(2.9)).toBe(1);
    expect(tierForApprovedMilestones(Number.MAX_SAFE_INTEGER)).toBe(3);
  });

  it('is monotonic — more milestones never lowers a tier', () => {
    for (let n = 0; n < 30; n++) {
      expect(tierForApprovedMilestones(n + 1)).toBeGreaterThanOrEqual(
        tierForApprovedMilestones(n),
      );
    }
    // thresholds stay within the valid ProgressLevel range
    for (const { tier } of TIER_THRESHOLDS) {
      expect(tier).toBeGreaterThanOrEqual(0);
      expect(tier).toBeLessThanOrEqual(3);
    }
  });

  // ── Exact threshold boundary tests ────────────────────────────────────────

  describe('exact threshold boundaries', () => {
    it('0 approved milestones → tier 0 (initial / unverified state)', () => {
      expect(tierForApprovedMilestones(0)).toBe(0);
    });

    it('exactly 1 approved milestone → tier 1 (lower boundary for tier 1)', () => {
      expect(tierForApprovedMilestones(1)).toBe(1);
    });

    it('exactly 2 approved milestones → tier 1 (upper boundary for tier 1)', () => {
      expect(tierForApprovedMilestones(2)).toBe(1);
    });

    it('exactly 3 approved milestones → tier 2 (lower boundary for tier 2)', () => {
      expect(tierForApprovedMilestones(3)).toBe(2);
    });

    it('exactly 5 approved milestones → tier 2 (upper boundary for tier 2)', () => {
      expect(tierForApprovedMilestones(5)).toBe(2);
    });

    it('exactly 6 approved milestones → tier 3 (lower boundary for tier 3 / max tier)', () => {
      expect(tierForApprovedMilestones(6)).toBe(3);
    });
  });

  // ── Already-at-max-tier tests ──────────────────────────────────────────────

  describe('already at max tier (tier 3)', () => {
    it('player with 6 milestones is at tier 3 — stays at tier 3', () => {
      expect(tierForApprovedMilestones(6)).toBe(3);
    });

    it('player with 7 milestones stays at tier 3 (no tier 4)', () => {
      expect(tierForApprovedMilestones(7)).toBe(3);
    });

    it('player with 100 milestones stays at tier 3 regardless of count', () => {
      expect(tierForApprovedMilestones(100)).toBe(3);
    });

    it('player with Number.MAX_SAFE_INTEGER milestones stays at tier 3', () => {
      expect(tierForApprovedMilestones(Number.MAX_SAFE_INTEGER)).toBe(3);
    });
  });

  // ── TIER_THRESHOLDS data integrity tests ──────────────────────────────────

  describe('TIER_THRESHOLDS data integrity', () => {
    it('thresholds are ordered highest-tier-first', () => {
      for (let i = 0; i < TIER_THRESHOLDS.length - 1; i++) {
        expect(TIER_THRESHOLDS[i].tier).toBeGreaterThan(TIER_THRESHOLDS[i + 1].tier);
      }
    });

    it('all tier values are valid ProgressLevel integers (0–3)', () => {
      for (const { tier } of TIER_THRESHOLDS) {
        expect(tier).toBeGreaterThanOrEqual(0);
        expect(tier).toBeLessThanOrEqual(3);
        expect(Number.isInteger(tier)).toBe(true);
      }
    });

    it('minApprovedMilestones values are non-negative', () => {
      for (const { minApprovedMilestones } of TIER_THRESHOLDS) {
        expect(minApprovedMilestones).toBeGreaterThanOrEqual(0);
      }
    });

    it('tier 0 threshold has minApprovedMilestones of 0 (always reachable)', () => {
      const tier0 = TIER_THRESHOLDS.find(t => t.tier === 0);
      expect(tier0).toBeDefined();
      expect(tier0!.minApprovedMilestones).toBe(0);
    });
  });
});

describe('indexEvents — player tier in DB matches approved-milestone count (#359)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('advances a player from tier 0 to tier 3 over a known sequence of milestone_approved events', async () => {
    const player = 'tier-player-1';
    let ledger = 500;
    let seq = 0;
    const nextHash = () => `tx-${player}-${seq++}`;

    // Register the player — starts at tier 0.
    server.getEvents.mockResolvedValue({
      latestLedger: ledger,
      events: [
        rawEvent('player_registered', { player_id: player, wallet: 'GWALLET' }, nextHash(), ledger++),
      ],
    });
    await indexEvents();
    expect(getPlayerById(player)?.progress_level).toBe(0);

    // Helper: approve `n` more milestones in a single indexer batch.
    const approve = async (n: number) => {
      const events = [];
      for (let i = 0; i < n; i++) {
        events.push(rawEvent('milestone_approved', { player_id: player }, nextHash(), ledger++));
      }
      server.getEvents.mockResolvedValue({ latestLedger: ledger, events });
      await indexEvents();
    };

    await approve(1); // total 1 approved → tier 1
    expect(getPlayerById(player)?.progress_level).toBe(1);

    await approve(2); // total 3 approved → tier 2
    expect(getPlayerById(player)?.progress_level).toBe(2);

    await approve(3); // total 6 approved → tier 3
    expect(getPlayerById(player)?.progress_level).toBe(3);
  });

  it('counts milestones per player — one player\'s approvals do not promote another', async () => {
    const alice = 'tier-alice';
    const bob = 'tier-bob';
    let ledger = 800;
    let seq = 0;
    const nextHash = () => `tx-multi-${seq++}`;

    server.getEvents.mockResolvedValue({
      latestLedger: ledger,
      events: [
        rawEvent('player_registered', { player_id: alice, wallet: 'GA' }, nextHash(), ledger++),
        rawEvent('player_registered', { player_id: bob, wallet: 'GB' }, nextHash(), ledger++),
        // 3 approvals for Alice, 1 for Bob
        rawEvent('milestone_approved', { player_id: alice }, nextHash(), ledger++),
        rawEvent('milestone_approved', { player_id: alice }, nextHash(), ledger++),
        rawEvent('milestone_approved', { player_id: alice }, nextHash(), ledger++),
        rawEvent('milestone_approved', { player_id: bob }, nextHash(), ledger++),
      ],
    });
    await indexEvents();

    expect(getPlayerById(alice)?.progress_level).toBe(2); // 3 milestones → tier 2
    expect(getPlayerById(bob)?.progress_level).toBe(1); // 1 milestone → tier 1
  });

  it('player already at tier 3 stays at tier 3 when additional milestones are approved', async () => {
    const player = 'tier-maxed-player';
    let ledger = 1200;
    let seq = 0;
    const nextHash = () => `tx-maxed-${seq++}`;

    // Register and immediately give 6 milestones (→ tier 3).
    const events = [
      rawEvent('player_registered', { player_id: player, wallet: 'GWMAX' }, nextHash(), ledger++),
    ];
    for (let i = 0; i < 6; i++) {
      events.push(rawEvent('milestone_approved', { player_id: player }, nextHash(), ledger++));
    }
    server.getEvents.mockResolvedValue({ latestLedger: ledger, events });
    await indexEvents();
    expect(getPlayerById(player)?.progress_level).toBe(3);

    // Approve 3 more milestones — player must remain at tier 3.
    const moreEvents = [];
    for (let i = 0; i < 3; i++) {
      moreEvents.push(rawEvent('milestone_approved', { player_id: player }, nextHash(), ledger++));
    }
    server.getEvents.mockResolvedValue({ latestLedger: ledger, events: moreEvents });
    await indexEvents();
    expect(getPlayerById(player)?.progress_level).toBe(3);
  });
});
