/**
 * Unit coverage for strict mutating-body schemas introduced in #1145.
 */
import { emptyBodySchema } from '../../src/validators/emptyBody';
import { addBookmarkSchema } from '../../src/controllers/scoutBookmarksController';
import { setIpReputationSchema } from '../../src/controllers/ipReputationController';
import { subscribeSchema } from '../../src/controllers/scoutController';

describe('emptyBodySchema', () => {
  it('accepts an empty object', () => {
    expect(emptyBodySchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown keys', () => {
    const result = emptyBodySchema.safeParse({ foo: 1 });
    expect(result.success).toBe(false);
  });
});

describe('addBookmarkSchema', () => {
  it('accepts a valid bookmark body', () => {
    const result = addBookmarkSchema.safeParse({
      playerId: 'player-1',
      folderId: 2,
      note: 'watch',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys', () => {
    const result = addBookmarkSchema.safeParse({
      playerId: 'player-1',
      extra: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('setIpReputationSchema', () => {
  it('accepts score bounds 0 and 100', () => {
    expect(setIpReputationSchema.safeParse({ ip: '1.2.3.4', score: 0 }).success).toBe(true);
    expect(setIpReputationSchema.safeParse({ ip: '1.2.3.4', score: 100 }).success).toBe(true);
  });

  it('rejects out-of-bounds scores', () => {
    expect(setIpReputationSchema.safeParse({ ip: '1.2.3.4', score: -1 }).success).toBe(false);
    expect(setIpReputationSchema.safeParse({ ip: '1.2.3.4', score: 101 }).success).toBe(false);
  });
});

describe('subscribeSchema (.strict)', () => {
  it('accepts a valid subscribe body', () => {
    expect(
      subscribeSchema.safeParse({ tier: 'basic', duration: 30 }).success,
    ).toBe(true);
  });

  it('rejects unknown keys', () => {
    expect(
      subscribeSchema.safeParse({ tier: 'basic', duration: 30, promo: 'x' }).success,
    ).toBe(false);
  });
});
