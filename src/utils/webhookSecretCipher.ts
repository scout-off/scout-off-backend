/**
 * Encryption-at-rest for webhook subscription signing secrets (#686).
 *
 * Unlike an API key (which only ever needs to be verified via a one-way
 * hash), a webhook signing secret must be retrievable in plaintext by the
 * backend at delivery time to compute the outbound HMAC — so it is encrypted
 * with a symmetric key held outside the database (WEBHOOK_SECRET_ENCRYPTION_KEY)
 * rather than hashed. Decryption happens only in the DB read path
 * (src/db/index.ts's listWebhookSubscriptions) immediately before signing;
 * the decrypted value is never written back to storage.
 */
import crypto from 'crypto';
import config from '../config';
import { logger } from './logger';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION_PREFIX = 'v1';

// Fixed, publicly-known key used only when WEBHOOK_SECRET_ENCRYPTION_KEY is
// unset outside production (local dev / CI). Never used in production — see
// resolveKey(). This keeps webhook subscriptions functional (and still
// encrypted-at-rest in the dev DB file) without every contributor needing to
// mint a key just to run the test suite.
const INSECURE_DEV_KEY = crypto.createHash('sha256').update('scout-off-insecure-dev-only-webhook-key').digest();

let warnedInsecureDevKey = false;

function resolveKey(): Buffer {
  const raw = config.webhookSecretEncryptionKey;
  if (raw) {
    const key = Buffer.from(raw, 'hex');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `WEBHOOK_SECRET_ENCRYPTION_KEY must be a ${KEY_BYTES * 2}-character hex string (${KEY_BYTES} bytes). Generate one with: openssl rand -hex 32`
      );
    }
    return key;
  }

  if (config.nodeEnv === 'production') {
    throw new Error(
      'WEBHOOK_SECRET_ENCRYPTION_KEY is required in production to encrypt webhook signing secrets at rest. Generate one with: openssl rand -hex 32'
    );
  }

  if (!warnedInsecureDevKey) {
    logger.warn(
      '[webhookSecretCipher] WEBHOOK_SECRET_ENCRYPTION_KEY is not set — using a fixed, insecure development-only key. Set WEBHOOK_SECRET_ENCRYPTION_KEY before deploying to staging/production.'
    );
    warnedInsecureDevKey = true;
  }
  return INSECURE_DEV_KEY;
}

/** True if `value` is already in this module's encrypted-at-rest format. */
export function isEncryptedWebhookSecret(value: string): boolean {
  return value.startsWith(`${VERSION_PREFIX}:`);
}

/**
 * Encrypts a webhook signing secret for storage. Returns
 * `v1:<ivHex>:<authTagHex>:<ciphertextHex>`.
 */
export function encryptWebhookSecret(plaintext: string): string {
  const key = resolveKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [VERSION_PREFIX, iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

/**
 * Decrypts a value produced by encryptWebhookSecret(). Rows written before
 * this encryption-at-rest change shipped are stored as plaintext (no `v1:`
 * prefix) — those are returned unchanged so existing subscriptions keep
 * signing correctly until scripts/reencrypt-webhook-secrets.js migrates them.
 */
export function decryptWebhookSecret(stored: string): string {
  if (!isEncryptedWebhookSecret(stored)) {
    return stored;
  }

  const parts = stored.split(':');
  const [, ivHex, authTagHex, cipherHex] = parts;
  if (parts.length !== 4 || !ivHex || !authTagHex || !cipherHex) {
    throw new Error('Malformed encrypted webhook secret');
  }

  const key = resolveKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}
