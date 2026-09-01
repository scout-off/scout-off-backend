import { Keypair } from '@stellar/stellar-sdk';
import { isValidStellarAddress } from '../../src/utils/stellarAddress';

describe('isValidStellarAddress', () => {
  it('accepts a valid G-address', () => {
    const validAddress = Keypair.random().publicKey();
    expect(isValidStellarAddress(validAddress)).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidStellarAddress('')).toBe(false);
  });

  it('rejects a random non-address string', () => {
    expect(isValidStellarAddress('not-a-stellar-address')).toBe(false);
  });

  it('rejects an S-address (secret key)', () => {
    const secretKey = Keypair.random().secret();
    expect(isValidStellarAddress(secretKey)).toBe(false);
  });

  it('rejects null-like values', () => {
    expect(isValidStellarAddress(null as unknown as string)).toBe(false);
    expect(isValidStellarAddress(undefined as unknown as string)).toBe(false);
  });

  it('rejects a string that is too short', () => {
    expect(isValidStellarAddress('GABC')).toBe(false);
  });

  it('rejects a string with wrong starting character', () => {
    expect(isValidStellarAddress('XAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN')).toBe(false);
  });

  it('rejects an address one character short (55 chars)', () => {
    const valid = Keypair.random().publicKey();
    expect(valid).toHaveLength(56);
    expect(isValidStellarAddress(valid.slice(0, 55))).toBe(false);
  });

  it('rejects an address one character long (57 chars)', () => {
    const valid = Keypair.random().publicKey();
    expect(isValidStellarAddress(valid + 'A')).toBe(false);
  });

  it("rejects an address starting with 'H' instead of 'G'", () => {
    const valid = Keypair.random().publicKey();
    const wrongPrefix = 'H' + valid.slice(1);
    expect(isValidStellarAddress(wrongPrefix)).toBe(false);
  });

  it('rejects an address containing a space', () => {
    const valid = Keypair.random().publicKey();
    const withSpace = valid.slice(0, 28) + ' ' + valid.slice(29);
    expect(isValidStellarAddress(withSpace)).toBe(false);
  });

  it('rejects null without throwing', () => {
    expect(() => isValidStellarAddress(null as unknown as string)).not.toThrow();
    expect(isValidStellarAddress(null as unknown as string)).toBe(false);
  });
});
