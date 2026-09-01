import { validateMinTier } from '../../src/utils/minTierValidator';

describe('validateMinTier', () => {
  it('accepts valid tiers 0-3', () => {
    for (const t of [0, 1, 2, 3]) {
      const result = validateMinTier(t);
      expect(result.valid).toBe(true);
      expect(result.tier).toBe(t);
    }
  });

  it('accepts string representations of valid tiers', () => {
    const result = validateMinTier('2');
    expect(result.valid).toBe(true);
    expect(result.tier).toBe(2);
  });

  it('accepts boundary string values 0 and 3', () => {
    expect(validateMinTier('0')).toEqual({ valid: true, tier: 0 });
    expect(validateMinTier('3')).toEqual({ valid: true, tier: 3 });
  });

  it('accepts whitespace-padded string values', () => {
    expect(validateMinTier(' 1 ')).toEqual({ valid: true, tier: 1 });
  });

  it('returns valid with no tier when value is absent', () => {
    expect(validateMinTier(undefined)).toEqual({ valid: true });
    expect(validateMinTier(null)).toEqual({ valid: true });
    expect(validateMinTier('')).toEqual({ valid: true });
    expect(validateMinTier('   ')).toEqual({ valid: true });
  });

  it('rejects out-of-range values', () => {
    const result = validateMinTier(5);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('minTier must be between 0 (Unverified) and 3 (Elite Tier)');
  });

  it('rejects negative values', () => {
    const result = validateMinTier(-1);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('minTier must be between 0 (Unverified) and 3 (Elite Tier)');
  });

  it('rejects non-numeric strings', () => {
    const result = validateMinTier('elite');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('minTier must be a number; valid values are 0=Unverified, 1=Verified, 2=Performance, 3=Elite');
  });

  it('rejects string float values', () => {
    const result = validateMinTier('1.5');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('minTier must be an integer between 0 and 3');
  });

  it('rejects exponential string values', () => {
    const result = validateMinTier('1e1');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('minTier must be a number; valid values are 0=Unverified, 1=Verified, 2=Performance, 3=Elite');
  });

  it('rejects hexadecimal string values', () => {
    const result = validateMinTier('0x2');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('minTier must be a number; valid values are 0=Unverified, 1=Verified, 2=Performance, 3=Elite');
  });

  it('rejects float values', () => {
    const result = validateMinTier(1.5);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('minTier must be an integer between 0 and 3');
  });
});
