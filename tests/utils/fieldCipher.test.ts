import crypto from 'crypto';
import {
  decryptField,
  encryptField,
  isEncryptedField,
} from '../../src/utils/fieldCipher';

describe('fieldCipher (#1328)', () => {
  it('round-trips notes through encrypt/decrypt', () => {
    const plaintext = 'Private scout observation';
    const encrypted = encryptField(plaintext, { purpose: 'notes' });
    expect(decryptField(encrypted, { purpose: 'notes' })).toBe(plaintext);
  });

  it('uses the v1 envelope format', () => {
    const encrypted = encryptField('hello', { purpose: 'notes' });
    expect(isEncryptedField(encrypted)).toBe(true);
    expect(encrypted.split(':')).toHaveLength(4);
    expect(encrypted.startsWith('v1:')).toBe(true);
  });

  it('does not embed plaintext in ciphertext', () => {
    const plaintext = 'super-secret-note-text';
    const encrypted = encryptField(plaintext, { purpose: 'notes' });
    expect(encrypted).not.toContain(plaintext);
  });

  it('returns legacy plaintext unchanged on decrypt', () => {
    const legacy = 'written-before-encryption-shipped';
    expect(decryptField(legacy, { purpose: 'notes' })).toBe(legacy);
  });

  it('decrypts with previous key during rotation', () => {
    const previousHex = crypto.randomBytes(32).toString('hex');
    const primaryHex = crypto.randomBytes(32).toString('hex');

    let encrypted = '';
    jest.isolateModules(() => {
      process.env.NOTES_ENCRYPTION_KEY = previousHex;
      delete process.env.NOTES_ENCRYPTION_KEY_PREVIOUS;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fc = require('../../src/utils/fieldCipher') as typeof import('../../src/utils/fieldCipher');
      encrypted = fc.encryptField('rotation-test', { purpose: 'notes' });
    });

    jest.isolateModules(() => {
      process.env.NOTES_ENCRYPTION_KEY = primaryHex;
      process.env.NOTES_ENCRYPTION_KEY_PREVIOUS = previousHex;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fc = require('../../src/utils/fieldCipher') as typeof import('../../src/utils/fieldCipher');
      expect(fc.decryptField(encrypted, { purpose: 'notes' })).toBe('rotation-test');
    });
  });
});
