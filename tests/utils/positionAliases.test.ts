import {
  normalizePosition,
  normalizePositionOrFallback,
  defaultPositionAliases,
} from '../../src/utils/positionAliases';

describe('positionAliases', () => {
  test('normalizes common synonyms (fw -> forward)', () => {
    expect(normalizePosition('fw')).toBe('forward');
    expect(normalizePosition('FWD')).toBe('forward');
    expect(normalizePosition('Forward')).toBe('forward');
  });

  test('returns undefined for unknown synonyms', () => {
    expect(normalizePosition('unknown-position')).toBeUndefined();
  });

  test('normalizePositionOrFallback falls back to original for unknown', () => {
    expect(normalizePositionOrFallback('unknown-position')).toBe('unknown-position');
    expect(normalizePositionOrFallback('  Unknown-Position  ')).toBe('Unknown-Position');
  });

  test('custom alias map works', () => {
    const custom = { x: 'extra' } as typeof defaultPositionAliases & Record<string, string>;
    expect(normalizePosition('x', custom)).toBe('extra');
  });
});
