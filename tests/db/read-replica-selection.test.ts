import { verifyReadAfter } from '../../src/middleware/readYourWrites';

describe('read-after-write marker verification', () => {
  it('rejects malformed, unsigned or expired markers', () => {
    expect(verifyReadAfter(undefined)).toBe(false);
    expect(verifyReadAfter('not-signed')).toBe(false);
    expect(verifyReadAfter(`${Date.now() - 60000}.${'0'.repeat(64)}`)).toBe(false);
  });
});
