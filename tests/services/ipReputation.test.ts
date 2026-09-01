import {
  addPoints,
  applyDecay,
  getScore,
  getTier,
  isBadUserAgent,
  resetReputationStore,
  setIpScore,
  stopDecayTimer,
  POINTS,
  SCORE_DELAY_THRESHOLD,
  SCORE_RESTRICT_THRESHOLD,
  SCORE_BLOCK_THRESHOLD,
  ipReputationCounters,
  resetIpReputationCounters,
} from '../../src/services/ipReputation';

beforeEach(() => {
  resetReputationStore();
  resetIpReputationCounters();
  stopDecayTimer();
});

// ─── Tier classification ──────────────────────────────────────────────────────

describe('getTier', () => {
  it('returns normal for score 0', () => {
    expect(getTier(0)).toBe('normal');
  });

  it('returns normal for score 49', () => {
    expect(getTier(49)).toBe('normal');
  });

  it('returns degraded for score 50', () => {
    expect(getTier(50)).toBe('degraded');
  });

  it('returns degraded for score 74', () => {
    expect(getTier(74)).toBe('degraded');
  });

  it('returns restricted for score 75', () => {
    expect(getTier(75)).toBe('restricted');
  });

  it('returns restricted for score 89', () => {
    expect(getTier(89)).toBe('restricted');
  });

  it('returns blocked for score 90', () => {
    expect(getTier(90)).toBe('blocked');
  });

  it('returns blocked for score 100', () => {
    expect(getTier(100)).toBe('blocked');
  });
});

// ─── Score accumulation ───────────────────────────────────────────────────────

describe('addPoints', () => {
  it('starts from 0 for unknown IP', () => {
    expect(getScore('10.0.0.1')).toBe(0);
  });

  it('accumulates points correctly', () => {
    addPoints('10.0.0.2', POINTS.RATE_LIMIT_HIT); // +5
    addPoints('10.0.0.2', POINTS.RATE_LIMIT_HIT); // +5
    expect(getScore('10.0.0.2')).toBe(10);
  });

  it('clamps score at 100', () => {
    for (let i = 0; i < 25; i++) {
      addPoints('10.0.0.3', POINTS.RATE_LIMIT_HIT); // +5 each → 125 without clamp
    }
    expect(getScore('10.0.0.3')).toBe(100);
  });

  it('hitting rate limit 20 times results in score 100 (clamped)', () => {
    for (let i = 0; i < 20; i++) {
      addPoints('10.0.0.4', POINTS.RATE_LIMIT_HIT); // 20 * 5 = 100
    }
    expect(getScore('10.0.0.4')).toBe(100);
    expect(getTier(100)).toBe('blocked');
  });

  it('auth failure adds 10 points', () => {
    addPoints('10.0.0.5', POINTS.AUTH_FAILURE);
    expect(getScore('10.0.0.5')).toBe(10);
  });

  it('bad user agent adds 20 points', () => {
    addPoints('10.0.0.6', POINTS.BAD_USER_AGENT);
    expect(getScore('10.0.0.6')).toBe(20);
  });

  it('4xx error adds 1 point', () => {
    addPoints('10.0.0.7', POINTS.ERROR_4XX);
    expect(getScore('10.0.0.7')).toBe(1);
  });

  it('5xx error adds 2 points', () => {
    addPoints('10.0.0.8', POINTS.ERROR_5XX);
    expect(getScore('10.0.0.8')).toBe(2);
  });
});

// ─── Decay logic ──────────────────────────────────────────────────────────────

describe('applyDecay', () => {
  it('decays score by ~10% after 1 hour', () => {
    addPoints('10.0.1.1', 60); // score = 60
    applyDecay('10.0.1.1', 1);
    // 60 * (1 - 0.10)^1 = 54
    expect(getScore('10.0.1.1')).toBe(54);
  });

  it('score of 60 decays to ~35 after 6 hours', () => {
    addPoints('10.0.1.2', 60);
    applyDecay('10.0.1.2', 6);
    // 60 * (0.9)^6 = 60 * 0.5314... = 31.88... → rounds to 32
    const score = getScore('10.0.1.2');
    // Allow ±2 for rounding
    expect(score).toBeGreaterThanOrEqual(30);
    expect(score).toBeLessThanOrEqual(36);
  });

  it('score decays to 0 and removes the entry after sufficient time', () => {
    addPoints('10.0.1.3', 10);
    applyDecay('10.0.1.3', 30); // 10 * 0.9^30 ≈ 0.42 → rounds to 0
    expect(getScore('10.0.1.3')).toBe(0);
  });

  it('pinned IP is immune to decay', () => {
    setIpScore('10.0.1.4', 60, true);
    applyDecay('10.0.1.4', 6);
    expect(getScore('10.0.1.4')).toBe(60);
  });
});

// ─── Admin whitelist/blacklist ────────────────────────────────────────────────

describe('setIpScore', () => {
  it('pins the IP score to 0 (whitelist)', () => {
    addPoints('10.0.2.1', 80);
    setIpScore('10.0.2.1', 0, true);
    expect(getScore('10.0.2.1')).toBe(0);
    // Further addPoints should be suppressed
    addPoints('10.0.2.1', POINTS.RATE_LIMIT_HIT);
    expect(getScore('10.0.2.1')).toBe(0);
  });

  it('pins the IP score to 100 (blacklist)', () => {
    setIpScore('10.0.2.2', 100, true);
    expect(getTier(getScore('10.0.2.2'))).toBe('blocked');
  });

  it('whitelist is permanent until overridden', () => {
    setIpScore('10.0.2.3', 0, true);
    applyDecay('10.0.2.3', 10);
    expect(getScore('10.0.2.3')).toBe(0);
    // Override
    setIpScore('10.0.2.3', 50, false);
    addPoints('10.0.2.3', POINTS.RATE_LIMIT_HIT);
    expect(getScore('10.0.2.3')).toBe(55); // 50 + 5
  });
});

// ─── Bad user agent detection ─────────────────────────────────────────────────

describe('isBadUserAgent', () => {
  it('detects sqlmap', () => {
    expect(isBadUserAgent('sqlmap/1.6')).toBe(true);
  });

  it('detects nikto', () => {
    expect(isBadUserAgent('Nikto/2.1.6')).toBe(true);
  });

  it('returns false for normal browser UA', () => {
    expect(isBadUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isBadUserAgent(undefined)).toBe(false);
  });
});

// ─── Prometheus counters ──────────────────────────────────────────────────────

describe('ipReputationCounters', () => {
  it('starts at 0 after reset', () => {
    expect(ipReputationCounters.blocked).toBe(0);
    expect(ipReputationCounters.penalised).toBe(0);
  });

  it('can be incremented externally', () => {
    ipReputationCounters.blocked += 1;
    ipReputationCounters.penalised += 2;
    expect(ipReputationCounters.blocked).toBe(1);
    expect(ipReputationCounters.penalised).toBe(2);
  });
});
