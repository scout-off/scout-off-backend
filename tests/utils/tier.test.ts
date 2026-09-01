import { getTierMeta, tierName } from '../../src/utils/tier';
import { ProgressLevel } from '../../src/types';

describe('getTierMeta', () => {
  const levels: ProgressLevel[] = [0, 1, 2, 3];

  it.each(levels)('returns tierName and tierDescription for level %i', (level) => {
    const meta = getTierMeta(level);
    expect(typeof meta.tierName).toBe('string');
    expect(meta.tierName.length).toBeGreaterThan(0);
    expect(typeof meta.tierDescription).toBe('string');
    expect(meta.tierDescription.length).toBeGreaterThan(0);
  });

  it('uses canonical tier names matching docs/tier-promotion.md', () => {
    expect(getTierMeta(0).tierName).toBe('Unverified');
    expect(getTierMeta(1).tierName).toBe('Emerging');
    expect(getTierMeta(2).tierName).toBe('Established');
    expect(getTierMeta(3).tierName).toBe('Elite');
  });

  it('returns fallback for unknown level', () => {
    const meta = getTierMeta(99);
    expect(meta.tierName).toBe('Unknown');
  });
});

describe('tierName', () => {
  it('returns "Unverified" for level 0', () => {
    expect(tierName(0)).toBe('Unverified');
  });

  it('returns "Verified Identity" for level 1', () => {
    expect(tierName(1)).toBe('Verified Identity');
  });

  it('returns "Performance Milestones" for level 2', () => {
    expect(tierName(2)).toBe('Performance Milestones');
  });

  it('returns "Elite Tier" for level 3', () => {
    expect(tierName(3)).toBe('Elite Tier');
  });

  it('returns "Unknown" for an out-of-range level', () => {
    expect(tierName(99)).toBe('Unknown');
    expect(tierName(-1)).toBe('Unknown');
  });
});
