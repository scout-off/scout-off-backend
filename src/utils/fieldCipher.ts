/**
 * Versioned AEAD field encryption (#1328).
 *
 * Shared envelope used for webhook signing secrets and scout private notes.
 * Format: `v1:<ivHex>:<authTagHex>:<ciphertextHex>` (AES-256-GCM).
 *
 * Decrypt tries the primary key first, then the previous key (rotation window).
 */
import crypto from 'crypto';
import config from '../config';
import { logger } from './logger';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
export const FIELD_CIPHER_VERSION = 'v1';

export type FieldCipherPurpose = 'webhook' | 'notes';

const INSECURE_DEV_KEYS: Record<FieldCipherPurpose, Buffer> = {
  webhook: crypto.createHash('sha256').update('scout-off-insecure-dev-only-webhook-key').digest(),
  notes: crypto.createHash('sha256').update('scout-off-insecure-dev-only-notes-key').digest(),
};

const warnedInsecure: Partial<Record<FieldCipherPurpose, boolean>> = {};

function parseHexKey(raw: string, envName: string): Buffer {
  const key = Buffer.from(raw, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${envName} must be a ${KEY_BYTES * 2}-character hex string (${KEY_BYTES} bytes). Generate one with: openssl rand -hex 32`,
    );
  }
  return key;
}

function resolvePrimaryKey(purpose: FieldCipherPurpose): Buffer {
  if (purpose === 'webhook') {
    const raw = config.webhookSecretEncryptionKey;
    if (raw) return parseHexKey(raw, 'WEBHOOK_SECRET_ENCRYPTION_KEY');
    if (config.nodeEnv === 'production') {
      throw new Error(
        'WEBHOOK_SECRET_ENCRYPTION_KEY is required in production to encrypt webhook signing secrets at rest. Generate one with: openssl rand -hex 32',
      );
    }
  } else {
    const raw = config.notesEncryptionKey;
    if (raw) return parseHexKey(raw, 'NOTES_ENCRYPTION_KEY');
    if (config.nodeEnv === 'production') {
      throw new Error(
        'NOTES_ENCRYPTION_KEY is required in production to encrypt scout private notes at rest. Generate one with: openssl rand -hex 32',
      );
    }
  }

  if (!warnedInsecure[purpose]) {
    logger.warn(
      `[fieldCipher] ${purpose === 'webhook' ? 'WEBHOOK_SECRET_ENCRYPTION_KEY' : 'NOTES_ENCRYPTION_KEY'} is not set — using a fixed, insecure development-only key. Set the key before deploying to staging/production.`,
    );
    warnedInsecure[purpose] = true;
  }
  return INSECURE_DEV_KEYS[purpose];
}

function resolvePreviousKey(purpose: FieldCipherPurpose): Buffer | null {
  const raw =
    purpose === 'webhook'
      ? config.webhookSecretEncryptionKeyPrevious
      : config.notesEncryptionKeyPrevious;
  if (!raw) return null;
  const envName =
    purpose === 'webhook'
      ? 'WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS'
      : 'NOTES_ENCRYPTION_KEY_PREVIOUS';
  return parseHexKey(raw, envName);
}

/** True if `value` is already in the versioned encrypted-at-rest format. */
export function isEncryptedField(value: string): boolean {
  return value.startsWith(`${FIELD_CIPHER_VERSION}:`);
}

/**
 * Encrypts plaintext for storage.
 * Returns `v1:<ivHex>:<authTagHex>:<ciphertextHex>`.
 */
export function encryptField(
  plaintext: string,
  options: { purpose: FieldCipherPurpose; keyId?: string } = { purpose: 'notes' },
): string {
  void options.keyId; // reserved for multi-key id tagging in a follow-up
  const key = resolvePrimaryKey(options.purpose);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [FIELD_CIPHER_VERSION, iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(
    ':',
  );
}

function decryptWithKey(stored: string, key: Buffer): string {
  const parts = stored.split(':');
  const [, ivHex, authTagHex, cipherHex] = parts;
  if (parts.length !== 4 || !ivHex || !authTagHex || !cipherHex) {
    throw new Error('Malformed encrypted field');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(cipherHex, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/**
 * Decrypts a value produced by encryptField().
 * Plaintext legacy rows (no `v1:` prefix) are returned unchanged so migrations
 * can run incrementally.
 */
export function decryptField(
  stored: string,
  options: { purpose: FieldCipherPurpose } = { purpose: 'notes' },
): string {
  if (!isEncryptedField(stored)) {
    return stored;
  }

  const primary = resolvePrimaryKey(options.purpose);
  try {
    return decryptWithKey(stored, primary);
  } catch (primaryErr) {
    const previous = resolvePreviousKey(options.purpose);
    if (!previous) throw primaryErr;
    return decryptWithKey(stored, previous);
  }
}

/** Assert production encryption keys are present. Call from boot validation. */
export function assertFieldCipherKeysForProduction(): void {
  if (config.nodeEnv !== 'production') return;
  if (!config.webhookSecretEncryptionKey) {
    throw new Error(
      'WEBHOOK_SECRET_ENCRYPTION_KEY is required in production. Generate one with: openssl rand -hex 32',
    );
  }
  parseHexKey(config.webhookSecretEncryptionKey, 'WEBHOOK_SECRET_ENCRYPTION_KEY');
  if (!config.notesEncryptionKey) {
    throw new Error(
      'NOTES_ENCRYPTION_KEY is required in production. Generate one with: openssl rand -hex 32',
    );
  }
  parseHexKey(config.notesEncryptionKey, 'NOTES_ENCRYPTION_KEY');
}
