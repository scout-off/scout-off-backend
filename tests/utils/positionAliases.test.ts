import {
  normalizePosition,
  normalizePositionOrFallback,
  defaultPositionAliases,
  canonicalizePositionKey,
  CANONICAL_POSITIONS,
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

  // ── Programmatic coverage of every key-value pair in defaultPositionAliases ──

  describe('every alias in defaultPositionAliases resolves to its canonical value', () => {
    const entries = Object.entries(defaultPositionAliases) as [string, string][];

    it('has entries to test (guard against an empty map)', () => {
      expect(entries.length).toBeGreaterThan(0);
    });

    it('only maps onto known canonical positions', () => {
      const allowed = new Set<string>(CANONICAL_POSITIONS);
      for (const [, canonical] of entries) {
        expect(allowed.has(canonical)).toBe(true);
      }
    });

    test.each(entries)(
      'normalizePosition("%s") === "%s"',
      (alias, canonical) => {
        expect(normalizePosition(alias)).toBe(canonical);
      },
    );

    test.each(entries)(
      'normalizePosition("%s" uppercased) still resolves to "%s" (case-insensitive)',
      (alias, canonical) => {
        expect(normalizePosition(alias.toUpperCase())).toBe(canonical);
      },
    );

    test.each(entries)(
      'normalizePosition("%s" with surrounding whitespace) still resolves to "%s"',
      (alias, canonical) => {
        expect(normalizePosition(`  ${alias}  `)).toBe(canonical);
      },
    );
  });

  // ── Alias groups (spot-checks for abbreviations + regional spelling) ──

  describe('alias groups', () => {
    it('goalkeeper group', () => {
      for (const alias of ['gk', 'GK', 'goalkeeper', 'goalie', 'keeper', 'goal keeper', 'Goal-Keeper']) {
        expect(normalizePosition(alias)).toBe('goalkeeper');
      }
    });

    it('defender group (backs + wing-backs + regional spelling)', () => {
      for (const alias of [
        'cb',
        'CB',
        'centre back',
        'center-back',
        'centre-back',
        'Center Back',
        'lb',
        'left back',
        'rb',
        'right-back',
        'lwb',
        'rwb',
        'sw',
        'sweeper',
        'full back',
        'defence',
        'defense',
        'df',
        'def',
      ]) {
        expect(normalizePosition(alias)).toBe('defender');
      }
    });

    it('midfielder group (CDM/CM/CAM + British/American forms)', () => {
      for (const alias of [
        'cm',
        'CDM',
        'cam',
        'dm',
        'mf',
        'mid',
        'defensive midfielder',
        'attacking midfield',
        'centre midfielder',
        'center midfielder',
        'left midfielder',
        'right midfield',
        'box to box',
        'number 10',
      ]) {
        expect(normalizePosition(alias)).toBe('midfielder');
      }
    });

    it('forward group (ST/LW/RW/winger + centre/center forward)', () => {
      for (const alias of [
        'st',
        'ST',
        'fw',
        'fwd',
        'cf',
        'striker',
        'lw',
        'rw',
        'winger',
        'left wing',
        'right-winger',
        'centre forward',
        'center-forward',
        'second striker',
        'false 9',
      ]) {
        expect(normalizePosition(alias)).toBe('forward');
      }
    });
  });

  // ── Case-insensitivity spot-checks ──

  describe('case-insensitive matching', () => {
    it('lowercased alias resolves correctly', () => {
      expect(normalizePosition('FW')).toBe('forward');
      expect(normalizePosition('Fw')).toBe('forward');
      expect(normalizePosition('fW')).toBe('forward');
    });

    it('midfielder aliases are case-insensitive', () => {
      expect(normalizePosition('MF')).toBe('midfielder');
      expect(normalizePosition('MID')).toBe('midfielder');
      expect(normalizePosition('Midfield')).toBe('midfielder');
      expect(normalizePosition('MIDFIELDER')).toBe('midfielder');
    });

    it('defender aliases are case-insensitive', () => {
      expect(normalizePosition('DF')).toBe('defender');
      expect(normalizePosition('DEF')).toBe('defender');
      expect(normalizePosition('Defender')).toBe('defender');
    });

    it('goalkeeper aliases are case-insensitive', () => {
      expect(normalizePosition('GK')).toBe('goalkeeper');
      expect(normalizePosition('Goalkeeper')).toBe('goalkeeper');
    });
  });

  describe('hyphen / underscore / spacing normalization', () => {
    it('canonicalizePositionKey collapses separators', () => {
      expect(canonicalizePositionKey('Centre-Back')).toBe('centre back');
      expect(canonicalizePositionKey('center_back')).toBe('center back');
      expect(canonicalizePositionKey('  Left   Wing  ')).toBe('left wing');
    });

    it('hyphenated and spaced forms resolve identically', () => {
      expect(normalizePosition('centre-back')).toBe(normalizePosition('centre back'));
      expect(normalizePosition('center_forward')).toBe(normalizePosition('center forward'));
      expect(normalizePosition('left-wing')).toBe(normalizePosition('left wing'));
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('unknown alias: normalizePosition returns undefined', () => {
      expect(normalizePosition('quarterback')).toBeUndefined();
      expect(normalizePosition('point-guard')).toBeUndefined();
      expect(normalizePosition('not-a-real-position')).toBeUndefined();
    });

    it('ST resolves to forward', () => {
      expect(normalizePosition('ST')).toBe('forward');
      expect(normalizePosition('st')).toBe('forward');
      expect(normalizePosition('St')).toBe('forward');
    });

    it('CM resolves to midfielder', () => {
      expect(normalizePosition('CM')).toBe('midfielder');
      expect(normalizePosition('cm')).toBe('midfielder');
    });

    it('CB and LB resolve to defender', () => {
      expect(normalizePosition('CB')).toBe('defender');
      expect(normalizePosition('cb')).toBe('defender');
      expect(normalizePosition('lb')).toBe('defender');
      expect(normalizePosition('LB')).toBe('defender');
    });

    it('LW/RW/winger resolve to forward', () => {
      expect(normalizePosition('lw')).toBe('forward');
      expect(normalizePosition('rw')).toBe('forward');
      expect(normalizePosition('winger')).toBe('forward');
    });

    it('unknown alias: normalizePositionOrFallback returns the trimmed input unchanged', () => {
      expect(normalizePositionOrFallback('quarterback')).toBe('quarterback');
      expect(normalizePositionOrFallback('  quarterback  ')).toBe('quarterback');
    });

    it('empty string: normalizePosition returns undefined (falsy guard in implementation)', () => {
      expect(normalizePosition('')).toBeUndefined();
    });

    it('empty string: normalizePositionOrFallback returns an empty string', () => {
      expect(normalizePositionOrFallback('')).toBe('');
    });

    it('whitespace-only string: normalizePosition returns undefined', () => {
      expect(normalizePosition('   ')).toBeUndefined();
    });

    it('whitespace-only string: normalizePositionOrFallback returns empty string after trim', () => {
      expect(normalizePositionOrFallback('   ')).toBe('');
    });
  });
});
