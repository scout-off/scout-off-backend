import { z } from 'zod';

const PLAYER_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

export const playerIdSchema = z
  .string()
  .min(1, 'playerId is required')
  .max(128, 'playerId cannot exceed 128 characters')
  .regex(PLAYER_ID_REGEX, 'playerId may only contain letters, numbers, underscores, and hyphens');

// Player ID validation utility
/**
 * Expected playerId format: letters, numbers, underscores, or hyphens.
 */
export function isValidPlayerId(id: string): boolean {
  if (typeof id !== 'string') return false;
  return playerIdSchema.safeParse(id).success;
}
