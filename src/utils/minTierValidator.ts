import { ProgressLevel } from '../types';

const VALID_TIERS: ProgressLevel[] = [0, 1, 2, 3];
const TIER_NAMES: Record<ProgressLevel, string> = {
  0: 'Unverified',
  1: 'Verified',
  2: 'Performance',
  3: 'Elite',
};

export interface TierValidationResult {
  valid: boolean;
  tier?: ProgressLevel;
  error?: string;
}

/**
 * Validates and normalises a raw minTier query parameter.
 * Returns the parsed ProgressLevel on success, or an error message on failure.
 */
export function validateMinTier(raw: unknown): TierValidationResult {
  const normalizedRaw = typeof raw === 'string' ? raw.trim() : raw;

  if (normalizedRaw === undefined || normalizedRaw === null || normalizedRaw === '') {
    return { valid: true }; // optional param — absence is fine
  }

  if (Array.isArray(normalizedRaw)) {
    return {
      valid: false,
      error: 'minTier must be an integer between 0 and 3',
    };
  }

  if (typeof normalizedRaw === 'string' && /^-?\d+\.\d+$/.test(normalizedRaw)) {
    return {
      valid: false,
      error: 'minTier must be an integer between 0 and 3',
    };
  }

  if (typeof normalizedRaw === 'string' && !/^-?\d+$/.test(normalizedRaw)) {
    return {
      valid: false,
      error: 'minTier must be a number; valid values are 0=Unverified, 1=Verified, 2=Performance, 3=Elite',
    };
  }

  const num = Number(normalizedRaw);

  if (!Number.isInteger(num) || isNaN(num)) {
    return {
      valid: false,
      error: 'minTier must be an integer between 0 and 3',
    };
  }

  if (!VALID_TIERS.includes(num as ProgressLevel)) {
    return {
      valid: false,
      error: 'minTier must be between 0 (Unverified) and 3 (Elite Tier)',
    };
  }

  return { valid: true, tier: num as ProgressLevel };
}
