/**
 * Versioned AEAD field encryption (#1328).
 *
 * Shared envelope used for webhook signing secrets and scout private notes.
 * Formats (AES-256-GCM):
 *   - `v2:<keyId>:<ivHex>:<authTagHex>:<ciphertextHex>` — written whenever a
 *     keyring (`*_ENCRYPTION_KEYS` + `*_ACTIVE_KEY_ID`) is configured (#1513).
 *     Decrypt looks the key up by id.
 *   - `v1:<ivHex>:<authTagHex>:<ciphertextHex>` — legacy single-key format,
 *     still written when no keyring is configured. Decrypt tries the primary
 *     key, then the previous key, then any keyring key.
 */
import crypto from 'crypto';
import config from '../config';
import { logger } from './logger';
import { Keyring, parseKeyring } from './keyring';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
export const FIELD_CIPHER_VERSION = 'v1';
export const FIELD_CIPHER_VERSION_V2 = 'v2';

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

const keyringCache = new Map<string, { raw: string; active: string; ring: Keyring | null }>();

/** The configured keyring for `purpose`, or null when only the legacy single key is set. */
export function getKeyring(purpose: FieldCipherPurpose): Keyring | null {
  const raw = purpose === 'webhook' ? config.webhookSecretEncryptionKeys : config.notesEncryptionKeys;
  const active =
    purpose === 'webhook'
      ? config.webhookSecretEncryptionActiveKeyId
      : config.notesEncryptionActiveKeyId;
  const cached = keyringCache.get(purpose);
  if (cached && cached.raw === raw && cached.active === active) return cached.ring;
  const ring =
    purpose === 'webhook'
      ? parseKeyring(raw, active, 'WEBHOOK_SECRET_ENCRYPTION_KEYS', 'WEBHOOK_SECRET_ENCRYPTION_ACTIVE_KEY_ID')
      : parseKeyring(raw, active, 'NOTES_ENCRYPTION_KEYS', 'NOTES_ENCRYPTION_ACTIVE_KEY_ID');
  keyringCache.set(purpose, { raw, active, ring });
  return ring;
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
  return (
    value.startsWith(`${FIELD_CIPHER_VERSION}:`) || value.startsWith(`${FIELD_CIPHER_VERSION_V2}:`)
  );
}

/**
 * Key id a stored value is encrypted under: the v2 key id, `v1` for the legacy
 * single-key format, or `plaintext` for rows not yet encrypted.
 */
export function getStoredKeyId(stored: string): string {
  if (stored.startsWith(`${FIELD_CIPHER_VERSION_V2}:`)) return stored.split(':')[1] ?? '';
  return stored.startsWith(`${FIELD_CIPHER_VERSION}:`) ? 'v1' : 'plaintext';
}

/**
 * Encrypts plaintext for storage with the active keyring key
 * (`v2:<keyId>:<ivHex>:<authTagHex>:<ciphertextHex>`), or the legacy primary
 * key (`v1:...`) when no keyring is configured.
 */
export function encryptField(
  plaintext: string,
  options: { purpose: FieldCipherPurpose } = { purpose: 'notes' },
): string {
  const ring = getKeyring(options.purpose);
  const key = ring ? ring.keys.get(ring.activeKeyId)! : resolvePrimaryKey(options.purpose);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const body = [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')];
  return (ring ? [FIELD_CIPHER_VERSION_V2, ring.activeKeyId, ...body] : [FIELD_CIPHER_VERSION, ...body]).join(
    ':',
  );
}

function decryptWithKey(ivHex: string, authTagHex: string, cipherHex: string, key: Buffer): string {
  if (!ivHex || !authTagHex || !cipherHex) {
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

/** Candidate keys for a legacy `v1:` value: primary, previous, then keyring keys. */
function v1Candidates(purpose: FieldCipherPurpose): Buffer[] {
  const ring = getKeyring(purpose);
  const rawPrimary = purpose === 'webhook' ? config.webhookSecretEncryptionKey : config.notesEncryptionKey;
  const candidates: Buffer[] = [];
  if (rawPrimary || !ring) candidates.push(resolvePrimaryKey(purpose));
  const previous = resolvePreviousKey(purpose);
  if (previous) candidates.push(previous);
  if (ring) candidates.push(...ring.keys.values());
  return candidates;
}

/**
 * Decrypts a value produced by encryptField().
 * Plaintext legacy rows (no `v1:`/`v2:` prefix) are returned unchanged so
 * migrations can run incrementally.
 */
export function decryptField(
  stored: string,
  options: { purpose: FieldCipherPurpose } = { purpose: 'notes' },
): string {
  if (!isEncryptedField(stored)) {
    return stored;
  }

  const parts = stored.split(':');
  if (parts[0] === FIELD_CIPHER_VERSION_V2) {
    if (parts.length !== 5) throw new Error('Malformed encrypted field');
    const [, keyId, ivHex, authTagHex, cipherHex] = parts;
    const key = getKeyring(options.purpose)?.keys.get(keyId);
    if (!key) {
      throw new Error(
        `Cannot decrypt ${options.purpose} field: key id "${keyId}" is not in the configured keyring`,
      );
    }
    return decryptWithKey(ivHex, authTagHex, cipherHex, key);
  }

  if (parts.length !== 4) throw new Error('Malformed encrypted field');
  const [, ivHex, authTagHex, cipherHex] = parts;
  let firstErr: unknown;
  for (const key of v1Candidates(options.purpose)) {
    try {
      return decryptWithKey(ivHex, authTagHex, cipherHex, key);
    } catch (err) {
      firstErr ??= err;
    }
  }
  throw firstErr;
}

/** Assert production encryption keys are present. Call from boot validation. */
export function assertFieldCipherKeysForProduction(): void {
  if (config.nodeEnv !== 'production') return;
  // Fails fast on an invalid keyring or an active key id missing from it (#1513).
  const webhookRing = getKeyring('webhook');
  const notesRing = getKeyring('notes');
  if (!webhookRing && !config.webhookSecretEncryptionKey) {
    throw new Error(
      'WEBHOOK_SECRET_ENCRYPTION_KEY is required in production. Generate one with: openssl rand -hex 32',
    );
  }
  if (config.webhookSecretEncryptionKey) {
    parseHexKey(config.webhookSecretEncryptionKey, 'WEBHOOK_SECRET_ENCRYPTION_KEY');
  }
  if (!notesRing && !config.notesEncryptionKey) {
    throw new Error(
      'NOTES_ENCRYPTION_KEY is required in production. Generate one with: openssl rand -hex 32',
    );
  }
  if (config.notesEncryptionKey) {
    parseHexKey(config.notesEncryptionKey, 'NOTES_ENCRYPTION_KEY');
  }
}
