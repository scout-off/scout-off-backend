import { getActiveSubscription, isActive, SUBSCRIPTION_GRACE_PERIOD_HOURS } from '../../src/utils/subscription';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  isSubscribed: jest.fn(),
}));

import { queryEvents } from '../../src/db';
import { isSubscribed } from '../../src/services/stellar';

const mockGetEvents = queryEvents as jest.Mock;
const mockIsSubscribed = isSubscribed as jest.Mock;

const WALLET = 'GSCOUTWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

beforeEach(() => {
  mockGetEvents.mockReset().mockReturnValue([]);
  mockIsSubscribed.mockReset().mockResolvedValue({ active: false, expiresAt: null });
});

// ─── On-chain (step 1) ────────────────────────────────────────────────────────

describe('getActiveSubscription — on-chain path', () => {
  it('returns active=true when on-chain reports active', async () => {
    mockIsSubscribed.mockResolvedValue({ active: true, expiresAt: '9999999999' });
    const result = await getActiveSubscription(WALLET);
    expect(result.active).toBe(true);
    expect(result.tier).toBe('basic');
  });

  it('coerces expiresAt to a number when on-chain returns it as a string', async () => {
    mockIsSubscribed.mockResolvedValue({ active: true, expiresAt: '1234567890' });
    const result = await getActiveSubscription(WALLET);
    expect(result.expiresAt).toBe(1234567890);
    expect(typeof result.expiresAt).toBe('number');
  });

  it('skips indexed events lookup when on-chain returns active', async () => {
    mockIsSubscribed.mockResolvedValue({ active: true, expiresAt: null });
    await getActiveSubscription(WALLET);
    expect(mockGetEvents).not.toHaveBeenCalled();
  });
});

// ─── Indexed events fallback (step 2) ────────────────────────────────────────

describe('getActiveSubscription — indexed events fallback', () => {
  it('returns active=false with nulls when no events exist', async () => {
    mockGetEvents.mockReturnValue([]);
    const result = await getActiveSubscription(WALLET);
    expect(result).toEqual({ active: false, tier: null, expiresAt: null });
  });

  it('returns active=true for a non-expired subscription event', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400 * 10;
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: expiresAt, tier: 'premium' },
      },
    ]);
    const result = await getActiveSubscription(WALLET);
    expect(result.active).toBe(true);
    expect(result.tier).toBe('premium');
    expect(result.expiresAt).toBe(expiresAt);
  });

  it('returns active=false for an expired subscription event', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 86400;
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: expiresAt },
      },
    ]);
    const result = await getActiveSubscription(WALLET);
    expect(result.active).toBe(false);
    expect(result.tier).toBeNull();
    expect(result.expiresAt).toBe(expiresAt);
  });

  it('defaults tier to "basic" when tier is absent from event payload', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: expiresAt },
      },
    ]);
    const result = await getActiveSubscription(WALLET);
    expect(result.tier).toBe('basic');
  });

  it('uses the most recent event when multiple subscription events exist', async () => {
    const olderExpiry = Math.floor(Date.now() / 1000) - 86400; // expired
    const newerExpiry = Math.floor(Date.now() / 1000) + 86400; // active
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: olderExpiry, tier: 'basic' },
      },
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscription_expiry: newerExpiry, tier: 'premium' },
      },
    ]);
    const result = await getActiveSubscription(WALLET);
    expect(result.active).toBe(true);
    expect(result.tier).toBe('premium');
    expect(result.expiresAt).toBe(newerExpiry);
  });

  it('filters events to the provided wallet only', async () => {
    const otherWallet = 'GOTHERWALLET2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: otherWallet, subscription_expiry: expiresAt, tier: 'premium' },
      },
    ]);
    const result = await getActiveSubscription(WALLET);
    expect(result.active).toBe(false);
    expect(result.tier).toBeNull();
  });
});

// ─── isActive — grace period boundary tests ─────────────────────────────────

describe('isActive — grace period boundary', () => {
  const now = Math.floor(Date.now() / 1000);

  it('returns true for an active subscription (expires in the future)', () => {
    const expiresAt = now + 86400; // expires in 24h
    expect(isActive(expiresAt)).toBe(true);
  });

  it('returns true for an expired subscription within the grace period', () => {
    const expiresAt = now - 3600; // expired 1h ago, within 24h grace
    expect(isActive(expiresAt)).toBe(true);
  });

  it('returns false for an expired subscription exactly at the grace period boundary (T + 24h)', () => {
    // expired exactly SUBSCRIPTION_GRACE_PERIOD_HOURS ago → boundary is exclusive
    const expiresAt = now - SUBSCRIPTION_GRACE_PERIOD_HOURS * 3600 - 1;
    expect(isActive(expiresAt)).toBe(false);
  });

  it('returns false for an expired subscription past the grace period', () => {
    const expiresAt = now - 86400 * 7; // expired 7 days ago
    expect(isActive(expiresAt)).toBe(false);
  });

  it('returns false when expiresAt is null', () => {
    expect(isActive(null)).toBe(false);
  });

  it('respects a custom grace period of 0 hours (no grace)', () => {
    const expiresAt = now - 1; // just expired
    expect(isActive(expiresAt, 0)).toBe(false);
  });

  it('respects a custom grace period of 48 hours', () => {
    const expiresAt = now - 86400; // expired 24h ago
    expect(isActive(expiresAt, 48)).toBe(true); // within 48h grace
  });
});