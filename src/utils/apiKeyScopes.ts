/**
 * API-key scope contract (#1019)
 *
 * Single authoritative source of truth for API-key scope semantics. Used by
 * both REST middleware (requireApiKeyScope) and GraphQL context/resolvers so
 * the two API surfaces can never drift apart on scope enforcement.
 *
 * Compatibility model (documented in docs/auth.md):
 *
 *   - `null` / missing / empty scopes        → LEGACY key: unrestricted.
 *     Keys issued before scopes existed keep full scout-level access.
 *   - JSON parse failure                     → treated as unrestricted with a
 *     warning (fail-open) so a corrupt row never bricks an existing key.
 *   - The migration default value            → treated as unrestricted. The
 *     `db/014_api_key_scopes.sql` column default was written into every row
 *     that existed when the migration ran, so treating it as a literal
 *     restricted list would silently disable those installations.
 *   - Any other JSON array of strings        → restricted to exactly those
 *     scopes. Operations outside the list are denied with a 403 (REST) or
 *     UNAUTHORIZED (GraphQL).
 */

/**
 * Complete scope vocabulary. New scopes must be added here (and to the
 * documentation) so restricted keys can be granted exactly the operations
 * they need.
 */
export const API_KEY_SCOPE_VOCABULARY = [
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
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPE_VOCABULARY)[number];

/**
 * The exact scope list baked into db/014_api_key_scopes.sql as the column
 * DEFAULT. Rows created before/without an explicit scope value carry this
 * literal, so it is treated as "legacy / unrestricted" rather than as a
 * restricted set (otherwise upgrades would silently break every pre-existing
 * key). See module docs above.
 */
export const LEGACY_DEFAULT_API_KEY_SCOPES: readonly string[] = [
  'read:players',
  'read:milestones',
  'write:contacts',
  'read:subscription',
];

/**
 * Parse the raw `scopes` column value into a scope list.
 *
 * Returns `null` for "unrestricted" (legacy/unscoped key) and a string array
 * for keys that are explicitly restricted.
 */
export function parseApiKeyScopes(
  raw: string | null | undefined,
  warn: (message: string) => void = () => {},
): string[] | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Fail-open: a corrupt row must not brick an otherwise valid key.
    warn(`[apiKeyScopes] unparseable scopes value, treating key as unrestricted: ${trimmed.slice(0, 80)}`);
    return null;
  }

  // JSON values such as `"read:players"` (a bare string) or `42` are not a
  // scope list — fail-open to legacy behavior.
  if (!Array.isArray(parsed)) {
    warn(`[apiKeyScopes] non-array scopes value, treating key as unrestricted: ${trimmed.slice(0, 80)}`);
    return null;
  }

  const scopes = parsed
    .filter((s): s is string => typeof s === 'string')
    .filter(Boolean);

  // The literal migration default means "this key predates scope
  // enforcement" — keep it unrestricted for backward compatibility.
  if (
    scopes.length === LEGACY_DEFAULT_API_KEY_SCOPES.length &&
    LEGACY_DEFAULT_API_KEY_SCOPES.every((s) => scopes.includes(s)) &&
    scopes.every((s) => LEGACY_DEFAULT_API_KEY_SCOPES.includes(s))
  ) {
    return null;
  }

  return scopes.length > 0 ? scopes : null;
}

/**
 * Whether a parsed scope list permits the given scope.
 * `null` (legacy/unrestricted key) always permits.
 */
export function hasApiKeyScope(
  scopes: string[] | null | undefined,
  required: string,
): boolean {
  if (scopes === null || scopes === undefined) return true;
  return scopes.includes(required);
}

/**
 * Validate + dedupe a user-supplied scope list at key issuance time.
 * Unknown scope strings are rejected (fail-closed) so typos cannot silently
 * grant more access than intended.
 *
 * Returns `{ ok: true, scopes }` or `{ ok: false, error }`.
 */
export function normalizeRequestedScopes(
  input: unknown,
): { ok: true; scopes: string[] } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, scopes: [] };
  if (!Array.isArray(input)) {
    return { ok: false, error: 'scopes must be an array of scope strings' };
  }
  const seen = new Set<string>();
  const scopes: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string' || item.trim() === '') {
      return { ok: false, error: 'scopes must be an array of scope strings' };
    }
    const scope = item.trim();
    if (!(API_KEY_SCOPE_VOCABULARY as readonly string[]).includes(scope)) {
      return { ok: false, error: `unknown scope: ${scope}` };
    }
    if (!seen.has(scope)) {
      seen.add(scope);
      scopes.push(scope);
    }
  }
  return { ok: true, scopes };
}