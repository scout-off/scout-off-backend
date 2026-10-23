import { createHash, randomBytes } from 'crypto';
import {
  getActiveApiKeyByLookupHash,
  getActiveApiKeysAwaitingLookupHash,
  setApiKeyLookupHash,
  revokeApiKeyById,
} from '../db';
import type { ApiKeyRow } from '../db';
import { logger } from '../utils/logger';
import { deriveApiKeyLookupHash } from '../utils/apiKeyLookup';
import { parseApiKeyScopes } from '../utils/apiKeyScopes';
import { EventEmitter } from 'events';
import { publishSecurityEvent } from './redis';

const SALT_BYTES = 16;
const SEPARATOR = ':';

export interface ResolvedApiKey {
  scout_wallet: string;
  id: number;
  /** Parsed scope list; null = legacy/unrestricted key. */
  scopes: string[] | null;
}

/**
 * Generate a key plus the salted authentication hash and indexed lookup hash
 * persisted by the API-key issuance path.
 */
export function generateApiKey(): { key: string; keyHash: string; lookupHash: string } {
  const key = randomBytes(32).toString('hex');
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = createHash('sha256').update(salt + key).digest('hex');
  const keyHash = `${salt}${SEPARATOR}${hash}`;
  return { key, keyHash, lookupHash: deriveApiKeyLookupHash(key) };
}

/** Verify a raw API key against its stored `salt:hash` value. */
export function verifyApiKey(rawKey: string, keyHash: string): boolean {
  const separatorIndex = keyHash.indexOf(SEPARATOR);
  if (separatorIndex === -1) return false;
  const salt = keyHash.slice(0, separatorIndex);
  const hash = keyHash.slice(separatorIndex + 1);
  if (!salt || !hash) return false;
  const expected = createHash('sha256').update(salt + rawKey).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(hash, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedBuf.length; i++) {
    diff |= expectedBuf[i] ^ actualBuf[i];
  }
  return diff === 0;
}

function toResolvedApiKey(row: ApiKeyRow): ResolvedApiKey {
  return {
    scout_wallet: row.scout_wallet,
    id: row.id,
    scopes: parseApiKeyScopes(row.scopes, (message) => logger.warn(message)),
  };
}

/**
 * Resolve an X-API-Key by indexed lookup and verify its salted authentication
 * proof. Legacy rows are lazily migrated after successful verification.
 */
export async function resolveApiKey(rawKey: string): Promise<ResolvedApiKey | null> {
  if (!rawKey || typeof rawKey !== 'string') return null;

  const lookupHash = deriveApiKeyLookupHash(rawKey);
  const candidate = await getActiveApiKeyByLookupHash(lookupHash);
  if (candidate) {
    return verifyApiKey(rawKey, candidate.key_hash) ? toResolvedApiKey(candidate) : null;
  }

  return resolvePreMigrationApiKey(rawKey, lookupHash);
}

async function resolvePreMigrationApiKey(
  rawKey: string,
  lookupHash: string,
): Promise<ResolvedApiKey | null> {
  const pending: ApiKeyRow[] = await getActiveApiKeysAwaitingLookupHash();
  for (const row of pending) {
    if (!verifyApiKey(rawKey, row.key_hash)) continue;
    try {
      await setApiKeyLookupHash(row.id, lookupHash);
      logger.info({ action: 'api_key_lookup_hash_backfilled', keyId: row.id });
    } catch {
      // A successful key verification remains valid if the best-effort migration write fails.
    }
    return toResolvedApiKey(row);
  }
  return null;
}
// ─── API key revocation emitter (for SSE session termination) ─────────────────

/** In-process emitter for API key revocation events. */
const apiKeyRevocationEmitter = new EventEmitter();

/** Subscribe to API key revocation events. */
export function onApiKeyRevoked(callback: (apiKeyId: number) => void): () => void {
  apiKeyRevocationEmitter.on('revoked', callback);
  return () => {
    apiKeyRevocationEmitter.removeListener('revoked', callback);
  };
}

/** Publish API key revocation event to Redis (cross-instance propagation). */
async function publishApiKeyRevoked(apiKeyId: number): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      await publishSecurityEvent('api_key_revoked', { apiKeyId });
      logger.debug(`[apiKeyService] published api_key_revoked for key ${apiKeyId}`);
    } catch (err) {
      logger.error(`[apiKeyService] failed to publish api_key_revoked for key ${apiKeyId}:`, err);
    }
  }
}

// ─── Remote handlers (called via Redis pub/sub from other instances) ─────────

/** Handle API key revocation event from another instance. */
export function onApiKeyRevokedRemote(apiKeyId: number): void {
  logger.debug(`[apiKeyService] processing remote api_key_revoked for key ${apiKeyId}`);
  apiKeyRevocationEmitter.emit('revoked', apiKeyId);
}
