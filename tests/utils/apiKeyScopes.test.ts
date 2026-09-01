/**
 * Unit tests for the shared API-key scope contract (#1019).
 *
 * Verifies:
 *   - legacy (NULL/missing/empty) scopes are unrestricted
 *   - the migration-default scope list is treated as unrestricted
 *   - malformed JSON fails open (unrestricted)
 *   - explicit scope lists are restricted
 *   - hasApiKeyScope semantics (null = always allowed)
 *   - normalizeRequestedScopes validation at issuance time
 */

import {
  parseApiKeyScopes,
  hasApiKeyScope,
  normalizeRequestedScopes,
  LEGACY_DEFAULT_API_KEY_SCOPES,
} from '../../src/utils/apiKeyScopes';

describe('parseApiKeyScopes — legacy compatibility (NULL/missing)', () => {
  it('returns null (unrestricted) for null scopes', () => {
    expect(parseApiKeyScopes(null)).toBeNull();
  });

  it('returns null (unrestricted) for undefined scopes', () => {
    expect(parseApiKeyScopes(undefined)).toBeNull();
  });

  it('returns null (unrestricted) for an empty string', () => {
    expect(parseApiKeyScopes('')).toBeNull();
  });

  it('returns null (unrestricted) for whitespace-only scopes', () => {
    expect(parseApiKeyScopes('   ')).toBeNull();
  });

  it('returns null for the literal string "null"', () => {
    expect(parseApiKeyScopes('null')).toBeNull();
  });

  it('returns null (unrestricted) for an empty JSON array', () => {
    expect(parseApiKeyScopes('[]')).toBeNull();
  });
});

describe('parseApiKeyScopes — migration default compatibility', () => {
  it('treats the exact 014 migration default as unrestricted (existing installs)', () => {
    const raw = JSON.stringify(LEGACY_DEFAULT_API_KEY_SCOPES);
    expect(parseApiKeyScopes(raw)).toBeNull();
  });

  it('treats the default list in a different order as unrestricted too', () => {
    const shuffled = [...LEGACY_DEFAULT_API_KEY_SCOPES].reverse();
    expect(parseApiKeyScopes(JSON.stringify(shuffled))).toBeNull();
  });
});

describe('parseApiKeyScopes — malformed values fail open', () => {
  it('returns null (unrestricted) for invalid JSON with a warning', () => {
    const warnings: string[] = [];
    const result = parseApiKeyScopes('not-json{{{', (msg) => warnings.push(msg));
    expect(result).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('returns null (unrestricted) for a bare string JSON value', () => {
    expect(parseApiKeyScopes('"read:players"')).toBeNull();
  });

  it('returns null (unrestricted) for a non-array JSON value', () => {
    expect(parseApiKeyScopes('42')).toBeNull();
  });

  it('ignores non-string entries inside the array', () => {
    expect(parseApiKeyScopes(JSON.stringify(['read:players', 42, null]))).toEqual(['read:players']);
  });
});

describe('parseApiKeyScopes — explicit restricted lists', () => {
  it('returns the scope list for an explicit restricted set', () => {
    expect(parseApiKeyScopes(JSON.stringify(['read:milestones']))).toEqual(['read:milestones']);
  });

  it('deduplicates nothing — preserves the stored list as-is', () => {
    expect(parseApiKeyScopes(JSON.stringify(['write:contacts', 'write:contacts']))).toEqual([
      'write:contacts',
      'write:contacts',
    ]);
  });
});

describe('hasApiKeyScope', () => {
  it('allows everything when scopes are null (legacy key)', () => {
    expect(hasApiKeyScope(null, 'write:contacts')).toBe(true);
    expect(hasApiKeyScope(null, 'write:webhooks')).toBe(true);
  });

  it('allows everything when scopes are undefined (JWT/non-API-key auth)', () => {
    expect(hasApiKeyScope(undefined, 'write:contacts')).toBe(true);
  });

  it('allows when the scope is present', () => {
    expect(hasApiKeyScope(['read:milestones', 'write:contacts'], 'write:contacts')).toBe(true);
  });

  it('denies when the scope is missing', () => {
    expect(hasApiKeyScope(['read:milestones'], 'write:contacts')).toBe(false);
    expect(hasApiKeyScope([], 'write:contacts')).toBe(false);
  });
});

describe('normalizeRequestedScopes — issuance validation', () => {
  it('accepts undefined/null as an empty (legacy) scope list', () => {
    expect(normalizeRequestedScopes(undefined)).toEqual({ ok: true, scopes: [] });
    expect(normalizeRequestedScopes(null)).toEqual({ ok: true, scopes: [] });
  });

  it('deduplicates repeated scopes', () => {
    expect(normalizeRequestedScopes(['write:contacts', 'write:contacts'])).toEqual({
      ok: true,
      scopes: ['write:contacts'],
    });
  });

  it('rejects non-array input', () => {
    expect(normalizeRequestedScopes('write:contacts').ok).toBe(false);
    expect(normalizeRequestedScopes(42).ok).toBe(false);
  });

  it('rejects unknown scopes (fail-closed at issuance)', () => {
    expect(normalizeRequestedScopes(['write:contacts', 'admin:*']).ok).toBe(false);
  });

  it('rejects non-string entries', () => {
    expect(normalizeRequestedScopes(['write:contacts', 7]).ok).toBe(false);
  });

  it('accepts every scope in the vocabulary', () => {
    const all = [
      'read:players',
      'read:milestones',
      'read:subscription',
      'read:contacts',
      'write:contacts',
      'write:subscriptions',
      'write:trial_offers',
      'write:webhooks',
      'write:api_keys',
      'write:bookmarks',
      'write:notes',
      'write:saved_searches',
      'write:player_tokens',
    ];
    expect(normalizeRequestedScopes(all)).toEqual({ ok: true, scopes: all });
  });
});