import { enrichPlayerResult, normalizePositionQuery, EnrichedPlayerResult } from '../../src/utils/searchEnrichment';

describe('enrichPlayerResult', () => {
  it('returns correct progressLabel and verificationBadge for level 0', () => {
    const result = enrichPlayerResult(0);
    expect(result.progressLabel).toBe('Unverified');
    expect(result.verificationBadge).toBe('none');
  });

  it('returns correct fields for level 1 (Verified Identity)', () => {
    const result = enrichPlayerResult(1);
    expect(result.progressLabel).toBe('Verified Identity');
    expect(result.verificationBadge).toBe('identity_verified');
  });

  it('returns correct fields for level 2 (Performance Milestones)', () => {
    const result = enrichPlayerResult(2);
    expect(result.progressLabel).toBe('Performance Milestones');
    expect(result.verificationBadge).toBe('performance_verified');
  });

  it('returns correct fields for level 3 (Elite Tier)', () => {
    const result = enrichPlayerResult(3);
    expect(result.progressLabel).toBe('Elite Tier');
    expect(result.verificationBadge).toBe('elite');
  });

  it('returns fallback fields for unknown levels', () => {
    const result = enrichPlayerResult(99);
    expect(result.progressLabel).toBe('Unknown');
    expect(result.verificationBadge).toBe('none');
  });

  it('result conforms to EnrichedPlayerResult shape', () => {
    const result: EnrichedPlayerResult = enrichPlayerResult(1);
    expect(typeof result.progressLabel).toBe('string');
    expect(typeof result.verificationBadge).toBe('string');
  });
});

describe('normalizePositionQuery', () => {
  it('normalises ST to forward (case-insensitive)', () => {
    expect(normalizePositionQuery('ST')).toBe('forward');
    expect(normalizePositionQuery('st')).toBe('forward');
    expect(normalizePositionQuery('St')).toBe('forward');
  });

  it('normalises CM to midfielder', () => {
    expect(normalizePositionQuery('CM')).toBe('midfielder');
    expect(normalizePositionQuery('cm')).toBe('midfielder');
  });

  it('normalises GK to goalkeeper', () => {
    expect(normalizePositionQuery('GK')).toBe('goalkeeper');
    expect(normalizePositionQuery('gk')).toBe('goalkeeper');
  });

  it('normalises CB and LB to defender', () => {
    expect(normalizePositionQuery('CB')).toBe('defender');
    expect(normalizePositionQuery('lb')).toBe('defender');
  });

  it('normalises winger / LW / RW to forward', () => {
    expect(normalizePositionQuery('winger')).toBe('forward');
    expect(normalizePositionQuery('Winger')).toBe('forward');
    expect(normalizePositionQuery('lw')).toBe('forward');
    expect(normalizePositionQuery('RW')).toBe('forward');
  });

  it('passes through unknown positions without error', () => {
    expect(normalizePositionQuery('quarterback')).toBe('quarterback');
    expect(normalizePositionQuery('Quarterback')).toBe('Quarterback');
  });

  it('trims whitespace around the input', () => {
    expect(normalizePositionQuery('  ST  ')).toBe('forward');
    expect(normalizePositionQuery('  quarterback  ')).toBe('quarterback');
  });

  it('returns empty string for empty input', () => {
    expect(normalizePositionQuery('')).toBe('');
  });

  it('canonical values resolve to themselves', () => {
    expect(normalizePositionQuery('Forward')).toBe('forward');
    expect(normalizePositionQuery('midfielder')).toBe('midfielder');
    expect(normalizePositionQuery('Defender')).toBe('defender');
    expect(normalizePositionQuery('goalkeeper')).toBe('goalkeeper');
  });
});
