import { ProgressLevel } from '../types';

// Canonical tier names and descriptions — must match docs/tier-promotion.md
// and the README tier table.
//
// NOTE: These are the agreed human-readable strings. Code-level unification
// into a shared module is tracked separately (see the canonical state-machine
// refactor issue). When i18n is wired up, swap these values for translation
// keys.
const TIER_META: Record<ProgressLevel, { tierName: string; tierDescription: string }> = {
  0: {
    tierName: 'Unverified',
    tierDescription: 'Player has registered but no milestones have been approved yet',
  },
  1: {
    tierName: 'Emerging',
    tierDescription: 'At least one approved milestone — initial ability confirmed',
  },
  2: {
    tierName: 'Established',
    tierDescription: 'Multiple approved milestones — consistent performance on record',
  },
  3: {
    tierName: 'Elite',
    tierDescription: 'Six or more approved milestones — top-tier verified performance',
  },
};

const FALLBACK_TIER = {
  tierName: 'Unknown',
  tierDescription: 'Unrecognised tier level',
};

/** Returns the i18n key pair (tierName, tierDescription) for a progress tier level, or a fallback for unknown levels. */
export function getTierMeta(level: number): { tierName: string; tierDescription: string } {
  return TIER_META[level as ProgressLevel] ?? FALLBACK_TIER;
}

/** Human-readable tier names for direct display (non-localized) */
const TIER_NAMES: Record<number, string> = {
  0: 'Unverified',
  1: 'Verified Identity',
  2: 'Performance Milestones',
  3: 'Elite Tier',
};

/** Returns the human-readable display name for a progress tier level. */
export function tierName(level: number): string {
  return TIER_NAMES[level] ?? 'Unknown';
}
