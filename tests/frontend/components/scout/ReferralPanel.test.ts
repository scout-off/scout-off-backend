/**
 * Tests for ReferralPanel component (#682)
 *
 * Covers:
 *  - Initial loading state while loadStats is pending
 *  - Successful stats load
 *  - Generate invite link — adds code to list
 *  - Double-submit guard (generating flag)
 *  - Copy button sets copiedCodeId; clearCopied resets it
 *  - loadStats failure → error state
 *  - generateCode failure → error state
 *  - copyCode failure → error state
 */
import {
  ReferralPanel,
  type ReferralPanelDeps,
  type ReferralStats,
  type ReferralCode,
} from '../../../../src/frontend/components/scout/ReferralPanel';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_STATS: ReferralStats = {
  totalReferrals:  12,
  activeReferrals: 8,
  pendingReferrals: 4,
  rewardBalance:   250,
};

const MOCK_CODE: ReferralCode = {
  id:        'code-001',
  code:      'SCOUT-XYZ-2026',
  createdAt: 1_700_000_000,
  uses:      0,
};

const MOCK_CODE_2: ReferralCode = {
  id:        'code-002',
  code:      'SCOUT-ABC-2026',
  createdAt: 1_700_000_100,
  uses:      3,
};

function makeDeps(overrides: Partial<ReferralPanelDeps> = {}): ReferralPanelDeps {
  return {
    getReferralStats:    jest.fn().mockResolvedValue(MOCK_STATS),
    generateReferralCode: jest.fn().mockResolvedValue(MOCK_CODE),
    copyToClipboard:     jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ─── Initial state ────────────────────────────────────────────────────────────

describe('initial state', () => {
  it('starts with null stats and empty codes', () => {
    const panel = new ReferralPanel(makeDeps());
    const state = panel.getState();
    expect(state.stats).toBeNull();
    expect(state.codes).toEqual([]);
  });

  it('starts with loading: false, generating: false, error: null', () => {
    const panel = new ReferralPanel(makeDeps());
    const state = panel.getState();
    expect(state.loading).toBe(false);
    expect(state.generating).toBe(false);
    expect(state.error).toBeNull();
  });

  it('starts with copiedCodeId: null', () => {
    const panel = new ReferralPanel(makeDeps());
    expect(panel.getState().copiedCodeId).toBeNull();
  });
});

// ─── loadStats ────────────────────────────────────────────────────────────────

describe('loadStats', () => {
  it('sets loading: true synchronously before the request resolves', async () => {
    const deps = makeDeps({
      getReferralStats: jest.fn().mockImplementation(() => {
        // Capture state while the promise is still in-flight
        return new Promise<ReferralStats>((resolve) => {
          setImmediate(() => resolve(MOCK_STATS));
        });
      }),
    });
    const panel = new ReferralPanel(deps);
    const promise = panel.loadStats();
    const capturedLoading = panel.getState().loading;
    await promise;
    expect(capturedLoading).toBe(true);
  });

  it('populates stats and sets loading: false on success', async () => {
    const panel = new ReferralPanel(makeDeps());
    await panel.loadStats();
    const state = panel.getState();
    expect(state.loading).toBe(false);
    expect(state.stats).toEqual(MOCK_STATS);
    expect(state.error).toBeNull();
  });

  it('renders correct stat values after load', async () => {
    const panel = new ReferralPanel(makeDeps());
    await panel.loadStats();
    const { stats } = panel.getState();
    expect(stats?.totalReferrals).toBe(12);
    expect(stats?.activeReferrals).toBe(8);
    expect(stats?.pendingReferrals).toBe(4);
    expect(stats?.rewardBalance).toBe(250);
  });

  it('sets error and clears loading on failure', async () => {
    const deps = makeDeps({
      getReferralStats: jest.fn().mockRejectedValue(new Error('Network error')),
    });
    const panel = new ReferralPanel(deps);
    await panel.loadStats();
    const state = panel.getState();
    expect(state.loading).toBe(false);
    expect(state.stats).toBeNull();
    expect(state.error).toBe('Network error');
  });

  it('sets a fallback error message for non-Error rejections', async () => {
    const deps = makeDeps({
      getReferralStats: jest.fn().mockRejectedValue('plain string error'),
    });
    const panel = new ReferralPanel(deps);
    await panel.loadStats();
    expect(panel.getState().error).toBe('Failed to load referral stats');
  });

  it('clears a previous error on a subsequent successful load', async () => {
    const failDeps = makeDeps({
      getReferralStats: jest.fn()
        .mockRejectedValueOnce(new Error('First failure'))
        .mockResolvedValueOnce(MOCK_STATS),
    });
    const panel = new ReferralPanel(failDeps);
    await panel.loadStats(); // fails
    expect(panel.getState().error).toBe('First failure');
    await panel.loadStats(); // succeeds
    expect(panel.getState().error).toBeNull();
  });
});

// ─── generateCode ─────────────────────────────────────────────────────────────

describe('generateCode (Generate Invite Link)', () => {
  it('sets generating: true while the request is in-flight', async () => {
    const deps = makeDeps({
      generateReferralCode: jest.fn().mockImplementation(() => {
        return new Promise<ReferralCode>((resolve) => {
          setImmediate(() => resolve(MOCK_CODE));
        });
      }),
    });
    const panel = new ReferralPanel(deps);
    const promise = panel.generateCode();
    const capturedGenerating = panel.getState().generating;
    await promise;
    expect(capturedGenerating).toBe(true);
  });

  it('appends the new code to the codes list on success', async () => {
    const panel = new ReferralPanel(makeDeps());
    await panel.generateCode();
    expect(panel.getState().codes).toHaveLength(1);
    expect(panel.getState().codes[0]).toEqual(MOCK_CODE);
  });

  it('sets generating: false after the request resolves', async () => {
    const panel = new ReferralPanel(makeDeps());
    await panel.generateCode();
    expect(panel.getState().generating).toBe(false);
  });

  it('appends multiple codes on successive calls', async () => {
    const deps = makeDeps({
      generateReferralCode: jest.fn()
        .mockResolvedValueOnce(MOCK_CODE)
        .mockResolvedValueOnce(MOCK_CODE_2),
    });
    const panel = new ReferralPanel(deps);
    await panel.generateCode();
    await panel.generateCode();
    expect(panel.getState().codes).toHaveLength(2);
    expect(panel.getState().codes[1]).toEqual(MOCK_CODE_2);
  });

  it('does NOT generate a second code while already generating (double-submit guard)', async () => {
    const generateFn = jest.fn().mockImplementation(
      () => new Promise<ReferralCode>((resolve) => setImmediate(() => resolve(MOCK_CODE))),
    );
    const panel = new ReferralPanel(makeDeps({ generateReferralCode: generateFn }));

    // Fire two concurrent calls
    const p1 = panel.generateCode();
    const p2 = panel.generateCode(); // should no-op
    await Promise.all([p1, p2]);

    // Only one actual API call should have been made
    expect(generateFn).toHaveBeenCalledTimes(1);
    expect(panel.getState().codes).toHaveLength(1);
  });

  it('sets error and clears generating on failure', async () => {
    const deps = makeDeps({
      generateReferralCode: jest.fn().mockRejectedValue(new Error('Code gen failed')),
    });
    const panel = new ReferralPanel(deps);
    await panel.generateCode();
    const state = panel.getState();
    expect(state.generating).toBe(false);
    expect(state.error).toBe('Code gen failed');
    expect(state.codes).toHaveLength(0);
  });
});

// ─── copyCode ─────────────────────────────────────────────────────────────────

describe('copyCode (copy to clipboard)', () => {
  it('sets copiedCodeId to the copied code\'s id on success', async () => {
    const panel = new ReferralPanel(makeDeps());
    await panel.copyCode('code-001', 'SCOUT-XYZ-2026');
    expect(panel.getState().copiedCodeId).toBe('code-001');
  });

  it('calls copyToClipboard with the correct code text', async () => {
    const copyFn = jest.fn().mockResolvedValue(undefined);
    const panel  = new ReferralPanel(makeDeps({ copyToClipboard: copyFn }));
    await panel.copyCode('code-001', 'SCOUT-XYZ-2026');
    expect(copyFn).toHaveBeenCalledWith('SCOUT-XYZ-2026');
  });

  it('copying a different code updates copiedCodeId to the new id', async () => {
    const panel = new ReferralPanel(makeDeps());
    await panel.copyCode('code-001', 'SCOUT-XYZ-2026');
    await panel.copyCode('code-002', 'SCOUT-ABC-2026');
    expect(panel.getState().copiedCodeId).toBe('code-002');
  });

  it('sets error when copyToClipboard rejects', async () => {
    const deps = makeDeps({
      copyToClipboard: jest.fn().mockRejectedValue(new Error('Clipboard denied')),
    });
    const panel = new ReferralPanel(deps);
    await panel.copyCode('code-001', 'SCOUT-XYZ-2026');
    expect(panel.getState().error).toBe('Clipboard denied');
    // copiedCodeId must NOT be set on failure
    expect(panel.getState().copiedCodeId).toBeNull();
  });
});

// ─── clearCopied ──────────────────────────────────────────────────────────────

describe('clearCopied', () => {
  it('resets copiedCodeId to null after a successful copy', async () => {
    const panel = new ReferralPanel(makeDeps());
    await panel.copyCode('code-001', 'SCOUT-XYZ-2026');
    expect(panel.getState().copiedCodeId).toBe('code-001');
    panel.clearCopied();
    expect(panel.getState().copiedCodeId).toBeNull();
  });

  it('is safe to call even when copiedCodeId is already null', () => {
    const panel = new ReferralPanel(makeDeps());
    expect(() => panel.clearCopied()).not.toThrow();
    expect(panel.getState().copiedCodeId).toBeNull();
  });
});

// ─── Error propagation (Toast path) ──────────────────────────────────────────

describe('error state (Toast-based error path)', () => {
  it('error is accessible via getState().error after loadStats failure', async () => {
    const deps = makeDeps({
      getReferralStats: jest.fn().mockRejectedValue(new Error('API down')),
    });
    const panel = new ReferralPanel(deps);
    await panel.loadStats();
    expect(panel.getState().error).toBe('API down');
  });

  it('error is accessible via getState().error after generateCode failure', async () => {
    const deps = makeDeps({
      generateReferralCode: jest.fn().mockRejectedValue(new Error('Rate limited')),
    });
    const panel = new ReferralPanel(deps);
    await panel.generateCode();
    expect(panel.getState().error).toBe('Rate limited');
  });

  it('error is accessible via getState().error after copyCode failure', async () => {
    const deps = makeDeps({
      copyToClipboard: jest.fn().mockRejectedValue(new Error('Permission denied')),
    });
    const panel = new ReferralPanel(deps);
    await panel.copyCode('id', 'code');
    expect(panel.getState().error).toBe('Permission denied');
  });

  it('a successful operation after a failure clears the error', async () => {
    const deps = makeDeps({
      getReferralStats: jest.fn()
        .mockRejectedValueOnce(new Error('Transient failure'))
        .mockResolvedValueOnce(MOCK_STATS),
    });
    const panel = new ReferralPanel(deps);
    await panel.loadStats();
    expect(panel.getState().error).toBe('Transient failure');
    await panel.loadStats();
    expect(panel.getState().error).toBeNull();
  });
});
