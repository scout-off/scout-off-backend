import { isValidCid, CID_REGEX } from '../../src/utils/cidValidator';

describe('isValidCid', () => {
  // CIDv0 examples — base58, starts with Qm, 46 chars
  it('accepts a valid CIDv0', () => {
    expect(isValidCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(true);
  });

  it('accepts another valid CIDv0', () => {
    expect(isValidCid('QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB')).toBe(true);
  });

  // CIDv1 examples — base32 prefix 'b'
  it('accepts a valid CIDv1 base32', () => {
    expect(isValidCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe(true);
  });

  it('accepts a valid CIDv1 base58btc (z prefix)', () => {
    expect(isValidCid('zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7')).toBe(true);
  });

  // Invalid cases
  it('rejects an empty string', () => {
    expect(isValidCid('')).toBe(false);
  });

  it('rejects a random string', () => {
    expect(isValidCid('not-a-cid')).toBe(false);
  });

  it('rejects a CIDv0 that is too short', () => {
    expect(isValidCid('QmShort')).toBe(false);
  });

  it('rejects a non-string input', () => {
    expect(isValidCid(null as unknown as string)).toBe(false);
  });

  it('rejects a plain URL', () => {
    expect(isValidCid('https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(false);
  });
});

describe('isValidCid — CIDv0/CIDv1 edge cases', () => {
  const VALID_CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  const VALID_CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

  it('accepts a valid CIDv0 (starts with Qm, 46 characters, valid base58)', () => {
    expect(VALID_CID_V0).toHaveLength(46);
    expect(VALID_CID_V0.startsWith('Qm')).toBe(true);
    expect(isValidCid(VALID_CID_V0)).toBe(true);
  });

  it('rejects a CIDv0 with the correct prefix but only 45 characters', () => {
    const tooShort = VALID_CID_V0.slice(0, -1);
    expect(tooShort).toHaveLength(45);
    expect(isValidCid(tooShort)).toBe(false);
  });

  it('rejects a CIDv0 containing an invalid base58 character (e.g. "O")', () => {
    // Base58 excludes 0, O, I, and l to avoid visual ambiguity.
    const withInvalidChar = 'Qm' + 'O' + VALID_CID_V0.slice(3);
    expect(withInvalidChar).toHaveLength(46);
    expect(isValidCid(withInvalidChar)).toBe(false);
  });

  it('accepts a valid CIDv1 (starts with "bafy", base32)', () => {
    expect(VALID_CID_V1.startsWith('bafy')).toBe(true);
    expect(isValidCid(VALID_CID_V1)).toBe(true);
  });

  it('rejects a CIDv1 that starts with "bafy" but contains an invalid character', () => {
    const withInvalidChar = VALID_CID_V1.slice(0, -1) + '!';
    expect(withInvalidChar.startsWith('bafy')).toBe(true);
    expect(isValidCid(withInvalidChar)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidCid('')).toBe(false);
  });

  it('rejects null and undefined without throwing', () => {
    expect(() => isValidCid(null as unknown as string)).not.toThrow();
    expect(() => isValidCid(undefined as unknown as string)).not.toThrow();
    expect(isValidCid(null as unknown as string)).toBe(false);
    expect(isValidCid(undefined as unknown as string)).toBe(false);
  });
});

describe('CID_REGEX', () => {
  it('matches a valid CIDv0', () => {
    expect(CID_REGEX.test('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(true);
  });

  it('matches a valid CIDv1', () => {
    expect(CID_REGEX.test('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe(true);
  });

  it('does not match an empty string', () => {
    expect(CID_REGEX.test('')).toBe(false);
  });
});
