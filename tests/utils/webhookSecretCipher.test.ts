import {
  encryptWebhookSecret,
  decryptWebhookSecret,
  isEncryptedWebhookSecret,
} from '../../src/utils/webhookSecretCipher';

describe('webhookSecretCipher (#686)', () => {
  it('round-trips a secret through encrypt/decrypt', () => {
    const plaintext = 'my-subscriber-secret';
    const encrypted = encryptWebhookSecret(plaintext);
    expect(decryptWebhookSecret(encrypted)).toBe(plaintext);
  });

  it('produces ciphertext that does not contain the plaintext', () => {
    const plaintext = 'super-secret-value-should-not-leak';
    const encrypted = encryptWebhookSecret(plaintext);
    expect(encrypted).not.toContain(plaintext);
  });

  it('produces a versioned, self-identifying format', () => {
    const encrypted = encryptWebhookSecret('abc');
    expect(isEncryptedWebhookSecret(encrypted)).toBe(true);
    expect(encrypted.split(':')).toHaveLength(4);
    expect(encrypted.startsWith('v1:')).toBe(true);
  });

  it('produces different ciphertext for the same plaintext on repeated calls (random IV)', () => {
    const a = encryptWebhookSecret('same-secret');
    const b = encryptWebhookSecret('same-secret');
    expect(a).not.toBe(b);
    expect(decryptWebhookSecret(a)).toBe('same-secret');
    expect(decryptWebhookSecret(b)).toBe('same-secret');
  });

  it('treats unrecognised (legacy plaintext) values as already-plaintext', () => {
    const legacyPlaintext = 'a-legacy-plaintext-secret-written-before-encryption-shipped';
    expect(isEncryptedWebhookSecret(legacyPlaintext)).toBe(false);
    expect(decryptWebhookSecret(legacyPlaintext)).toBe(legacyPlaintext);
  });

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const encrypted = encryptWebhookSecret('tamper-test');
    const parts = encrypted.split(':');
    // Flip a hex character in the ciphertext segment
    const tamperedCipher = parts[3].slice(0, -1) + (parts[3].slice(-1) === '0' ? '1' : '0');
    const tampered = [parts[0], parts[1], parts[2], tamperedCipher].join(':');
    expect(() => decryptWebhookSecret(tampered)).toThrow();
  });
});
