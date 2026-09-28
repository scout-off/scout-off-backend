/**
 * Encryption-at-rest for webhook subscription signing secrets (#686).
 *
 * Thin wrappers around {@link fieldCipher} so existing call sites keep working.
 */
import { decryptField, encryptField, isEncryptedField } from './fieldCipher';

/** True if `value` is already in this module's encrypted-at-rest format. */
export function isEncryptedWebhookSecret(value: string): boolean {
  return isEncryptedField(value);
}

/**
 * Encrypts a webhook signing secret for storage. Returns
 * `v1:<ivHex>:<authTagHex>:<ciphertextHex>`.
 */
export function encryptWebhookSecret(plaintext: string): string {
  return encryptField(plaintext, { purpose: 'webhook' });
}

/**
 * Decrypts a value produced by encryptWebhookSecret(). Rows written before
 * this encryption-at-rest change shipped are stored as plaintext (no `v1:`
 * prefix) — those are returned unchanged so existing subscriptions keep
 * signing correctly until scripts/reencrypt-webhook-secrets.js migrates them.
 */
export function decryptWebhookSecret(stored: string): string {
  return decryptField(stored, { purpose: 'webhook' });
}
