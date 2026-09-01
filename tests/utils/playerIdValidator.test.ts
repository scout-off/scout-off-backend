import { isValidPlayerId, playerIdSchema } from '../../src/utils/playerIdValidator';

describe('isValidPlayerId', () => {
  // Valid cases
  it('accepts a valid alphanumeric playerId', () => {
    expect(isValidPlayerId('player123')).toBe(true);
  });

  it('accepts a playerId with underscores and hyphens', () => {
    expect(isValidPlayerId('player_id-42')).toBe(true);
  });

  it('accepts a single character playerId', () => {
    expect(isValidPlayerId('a')).toBe(true);
  });

  it('accepts a playerId at the maximum length (128 chars)', () => {
    expect(isValidPlayerId('a'.repeat(128))).toBe(true);
  });

  // Invalid cases
  it('rejects an empty string', () => {
    expect(isValidPlayerId('')).toBe(false);
  });

  it('rejects a playerId exceeding the maximum length', () => {
    expect(isValidPlayerId('a'.repeat(129))).toBe(false);
  });

  it('rejects a playerId containing spaces', () => {
    expect(isValidPlayerId('player id')).toBe(false);
  });

  it('rejects a playerId containing special characters', () => {
    expect(isValidPlayerId('player@123')).toBe(false);
  });

  it('rejects a playerId containing a slash', () => {
    expect(isValidPlayerId('player/123')).toBe(false);
  });

  it('rejects a non-string input', () => {
    expect(isValidPlayerId(null as unknown as string)).toBe(false);
  });

  it('rejects a numeric input', () => {
    expect(isValidPlayerId(123 as unknown as string)).toBe(false);
  });
});

describe('edge cases — numeric and boundary inputs', () => {
  it('accepts string "1" as a valid player ID (positive integer as string)', () => {
    expect(isValidPlayerId('1')).toBe(true);
  });

  it('accepts string "9999" as a valid player ID (positive integer as string)', () => {
    expect(isValidPlayerId('9999')).toBe(true);
  });

  it('rejects number 0 — zero is not a valid player ID', () => {
    expect(isValidPlayerId(0 as unknown as string)).toBe(false);
  });

  it('rejects number -1 — negative integer is not a valid player ID', () => {
    expect(isValidPlayerId(-1 as unknown as string)).toBe(false);
  });

  it('rejects number 3.14 — floating-point value is not a valid player ID', () => {
    expect(isValidPlayerId(3.14 as unknown as string)).toBe(false);
  });

  it('rejects Number.MAX_SAFE_INTEGER + 1 — exceeds safe integer range', () => {
    expect(isValidPlayerId((Number.MAX_SAFE_INTEGER + 1) as unknown as string)).toBe(false);
  });

  it('rejects integer 42 where a string is expected', () => {
    expect(isValidPlayerId(42 as unknown as string)).toBe(false);
  });
});

describe('playerIdSchema', () => {
  it('parses a valid playerId successfully', () => {
    const result = playerIdSchema.safeParse('valid-player_1');
    expect(result.success).toBe(true);
  });

  it('fails to parse an empty string', () => {
    const result = playerIdSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('fails to parse a playerId with disallowed characters', () => {
    const result = playerIdSchema.safeParse('bad id!');
    expect(result.success).toBe(false);
  });
});
