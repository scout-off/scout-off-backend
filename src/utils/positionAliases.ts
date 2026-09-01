/**
 * Position alias mapping for football (soccer) positions.
 *
 * Canonical stored values (used in DB / GET /api/players?position=):
 * - goalkeeper
 * - defender
 * - midfielder
 * - forward
 *
 * Free-text input (abbreviations, full names, regional spellings, hyphenated
 * or spaced variants) is normalized to one of those four. Unrecognized strings
 * are not mapped: `normalizePosition` returns undefined; callers that need
 * stable passthrough use `normalizePositionOrFallback` (trimmed original).
 *
 * The mapping can be replaced or extended via the `aliases` parameter when needed.
 */

export type PositionAliasMap = Record<string, string>;

/** Canonical position names stored / matched in the players table. */
export const CANONICAL_POSITIONS = [
  'goalkeeper',
  'defender',
  'midfielder',
  'forward',
] as const;

export type CanonicalPosition = (typeof CANONICAL_POSITIONS)[number];

/**
 * Flat lowercase-key → canonical-value map.
 * Keys are stored without punctuation; `normalizePosition` collapses spaces,
 * hyphens, and underscores before lookup so "centre-back" and "centre back" match.
 */
export const defaultPositionAliases: PositionAliasMap = {
  // ── Goalkeeper ──────────────────────────────────────────────────────────
  gk: 'goalkeeper',
  g: 'goalkeeper',
  goalkeeper: 'goalkeeper',
  goalie: 'goalkeeper',
  keeper: 'goalkeeper',
  'goal keeper': 'goalkeeper',

  // ── Defender (back four / back three / wing-backs) ──────────────────────
  df: 'defender',
  def: 'defender',
  defence: 'defender',
  defense: 'defender',
  defender: 'defender',
  defenders: 'defender',
  cb: 'defender',
  'centre back': 'defender',
  'center back': 'defender',
  'centreback': 'defender',
  'centerback': 'defender',
  'central defender': 'defender',
  'central defence': 'defender',
  'central defense': 'defender',
  lb: 'defender',
  'left back': 'defender',
  'leftback': 'defender',
  rb: 'defender',
  'right back': 'defender',
  'rightback': 'defender',
  lwb: 'defender',
  'left wing back': 'defender',
  'left wingback': 'defender',
  rwb: 'defender',
  'right wing back': 'defender',
  'right wingback': 'defender',
  wb: 'defender',
  'wing back': 'defender',
  wingback: 'defender',
  sw: 'defender',
  sweeper: 'defender',
  'full back': 'defender',
  fullback: 'defender',
  'fullback left': 'defender',
  'fullback right': 'defender',

  // ── Midfielder (defensive / central / attacking / wide) ─────────────────
  mf: 'midfielder',
  mid: 'midfielder',
  midfield: 'midfielder',
  midfielder: 'midfielder',
  midfielders: 'midfielder',
  cm: 'midfielder',
  'central midfielder': 'midfielder',
  'central midfield': 'midfielder',
  'centre midfielder': 'midfielder',
  'center midfielder': 'midfielder',
  dm: 'midfielder',
  cdm: 'midfielder',
  'defensive midfielder': 'midfielder',
  'defensive midfield': 'midfielder',
  'holding midfielder': 'midfielder',
  'holding midfield': 'midfielder',
  'anchor man': 'midfielder',
  anchorman: 'midfielder',
  am: 'midfielder',
  cam: 'midfielder',
  'attacking midfielder': 'midfielder',
  'attacking midfield': 'midfielder',
  'central attacking midfielder': 'midfielder',
  'number 10': 'midfielder',
  'no 10': 'midfielder',
  'playmaker': 'midfielder',
  lm: 'midfielder',
  'left midfielder': 'midfielder',
  'left midfield': 'midfielder',
  rm: 'midfielder',
  'right midfielder': 'midfielder',
  'right midfield': 'midfielder',
  'wide midfielder': 'midfielder',
  'wide midfield': 'midfielder',
  'box to box': 'midfielder',
  'box to box midfielder': 'midfielder',

  // ── Forward / attacker / wide forwards ──────────────────────────────────
  fw: 'forward',
  fwd: 'forward',
  st: 'forward',
  cf: 'forward',
  striker: 'forward',
  forward: 'forward',
  forwards: 'forward',
  attacker: 'forward',
  'centre forward': 'forward',
  'center forward': 'forward',
  'centreforward': 'forward',
  'centerforward': 'forward',
  'central forward': 'forward',
  lw: 'forward',
  'left wing': 'forward',
  'left winger': 'forward',
  leftwing: 'forward',
  rw: 'forward',
  'right wing': 'forward',
  'right winger': 'forward',
  rightwing: 'forward',
  winger: 'forward',
  wing: 'forward',
  ss: 'forward',
  'second striker': 'forward',
  'second forward': 'forward',
  'false 9': 'forward',
  'false nine': 'forward',
  poacher: 'forward',
  'target man': 'forward',
  targetman: 'forward',
};

/**
 * Collapse punctuation/spacing so "centre-back", "centre_back", and
 * "Centre Back" all share one lookup key.
 */
export function canonicalizePositionKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize an input position term to a canonical position name.
 *
 * Returns the canonical position (e.g. "forward") if the input matches a
 * known alias; otherwise returns undefined so callers can fall back to other
 * behavior.
 */
export function normalizePosition(
  input: string,
  aliases: PositionAliasMap = defaultPositionAliases
): string | undefined {
  if (!input) return undefined;
  const key = canonicalizePositionKey(input);
  if (!key) return undefined;

  const direct = aliases[key];
  if (direct) return direct;

  // Also try compact form without spaces (centreback vs centre back)
  const compact = key.replace(/\s+/g, '');
  if (compact !== key) {
    return aliases[compact];
  }
  return undefined;
}

/**
 * Normalize or fallback: returns the normalized position when available,
 * otherwise returns the trimmed original input. Useful for cases where stable
 * API behavior is desired for unknown synonyms.
 *
 * Unknown / unrecognized position strings are passed through (trimmed) and will
 * only match players whose stored `position` equals that exact string.
 */
export function normalizePositionOrFallback(
  input: string,
  aliases: PositionAliasMap = defaultPositionAliases
): string {
  const normalized = normalizePosition(input, aliases);
  return normalized ?? input.trim();
}
