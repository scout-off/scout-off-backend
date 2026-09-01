import { ProgressLevel } from '../types';
import { normalizePositionOrFallback } from './positionAliases';

/** UI-friendly label for each progress tier */
const PROGRESS_LABELS: Record<number, string> = {
  0: 'Unverified',
  1: 'Verified Identity',
  2: 'Performance Milestones',
  3: 'Elite Tier',
};

/** Verification badge assigned per tier */
const VERIFICATION_BADGES: Record<number, string> = {
  0: 'none',
  1: 'identity_verified',
  2: 'performance_verified',
  3: 'elite',
};

export interface EnrichedPlayerResult {
  progressLabel: string;
  verificationBadge: string;
}

/**
 * Compute UI-friendly metadata from raw player profile data.
 *
 * Kept intentionally separate from raw data retrieval so callers can
 * enrich only when building API responses without coupling it to storage.
 *
 * @param progressLevel - The player's numeric progress tier (0–3).
 */
export function enrichPlayerResult(
  progressLevel: number | ProgressLevel,
): EnrichedPlayerResult {
  const level = Number(progressLevel);
  return {
    progressLabel: PROGRESS_LABELS[level] ?? 'Unknown',
    verificationBadge: VERIFICATION_BADGES[level] ?? 'none',
  };
}

/**
 * Normalise a raw position query string as part of query enrichment.
 *
 * Converts abbreviated or aliased position terms (case-insensitive) to their
 * canonical stored values (e.g. 'ST' -> 'forward', 'CM' -> 'midfielder').
 * Unknown positions are returned unchanged so callers never receive an error.
 *
 * @param position - Raw position string from a query param or request body.
 * @returns The canonical position name, or the original trimmed string if no
 *          alias mapping exists.
 */
export function normalizePositionQuery(position: string): string {
  return normalizePositionOrFallback(position);
}
