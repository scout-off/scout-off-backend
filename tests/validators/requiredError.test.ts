/**
 * Unit coverage for the zod 4 `requiredError` helper (#1867).
 */
import { z } from 'zod';
import { requiredError } from '../../src/validators/requiredError';

function firstMessage(result: z.ZodSafeParseResult<unknown>): string | undefined {
  return result.success ? undefined : result.error.issues[0]?.message;
}

describe('requiredError', () => {
  describe('strings', () => {
    const schema = z.object({ name: z.string(requiredError('name is required')) });

    it('uses the custom message when the field is missing', () => {
      const result = schema.safeParse({});
      expect(result.success).toBe(false);
      expect(firstMessage(result)).toBe('name is required');
    });

    it('keeps the default message for a wrong type', () => {
      const result = schema.safeParse({ name: 42 });
      expect(result.success).toBe(false);
      expect(firstMessage(result)).not.toBe('name is required');
      expect(firstMessage(result)).toMatch(/string/i);
    });

    it('accepts a valid string', () => {
      const result = schema.safeParse({ name: 'scout' });
      expect(result.success).toBe(true);
      expect(result.success && result.data).toEqual({ name: 'scout' });
    });
  });

  describe('numbers', () => {
    const schema = z.object({ fromLedger: z.number(requiredError('fromLedger is required')) });

    it('uses the custom message when the field is missing', () => {
      const result = schema.safeParse({});
      expect(result.success).toBe(false);
      expect(firstMessage(result)).toBe('fromLedger is required');
    });

    it('keeps the default message for a wrong type', () => {
      const result = schema.safeParse({ fromLedger: '10' });
      expect(result.success).toBe(false);
      expect(firstMessage(result)).not.toBe('fromLedger is required');
      expect(firstMessage(result)).toMatch(/number/i);
    });

    it('accepts a valid number', () => {
      const result = schema.safeParse({ fromLedger: 10 });
      expect(result.success).toBe(true);
      expect(result.success && result.data).toEqual({ fromLedger: 10 });
    });
  });

  describe('arrays', () => {
    const schema = z.object({ ids: z.array(z.string(), requiredError('ids is required')) });

    it('uses the custom message when the field is missing', () => {
      const result = schema.safeParse({});
      expect(result.success).toBe(false);
      expect(firstMessage(result)).toBe('ids is required');
    });

    it('keeps the default message for a wrong type', () => {
      const result = schema.safeParse({ ids: 'not-an-array' });
      expect(result.success).toBe(false);
      expect(firstMessage(result)).not.toBe('ids is required');
      expect(firstMessage(result)).toMatch(/array/i);
    });

    it('accepts a valid array', () => {
      const result = schema.safeParse({ ids: ['a', 'b'] });
      expect(result.success).toBe(true);
      expect(result.success && result.data).toEqual({ ids: ['a', 'b'] });
    });
  });

  it('returns the message only for undefined input', () => {
    const error = requiredError('field is required').error;
    expect(error({ input: undefined })).toBe('field is required');
    expect(error({ input: null })).toBeUndefined();
    expect(error({ input: 'value' })).toBeUndefined();
  });
});
