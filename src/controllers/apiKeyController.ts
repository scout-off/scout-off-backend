/**
 * API Key Controller (#490)
 *
 * Allows scouts to issue, list, and revoke long-lived API keys for
 * server-to-server integrations.  The raw key is returned exactly once at
 * issuance time and never persisted.
 *
 * Two derived representations are stored per key:
 *  - `key_hash`    — `salt:sha256(salt+key)`, the authentication proof. Salted
 *                    per row, therefore not searchable.
 *  - `lookup_hash` — a deterministic keyed digest used purely to locate the
 *                    candidate row with one indexed query (#1033). Never
 *                    sufficient to authenticate on its own, and never exposed
 *                    in an API response. See src/utils/apiKeyLookup.ts.
 */
import { Request, Response, NextFunction } from 'express';
import { randomBytes, createHash } from 'crypto';
import { z } from 'zod';
import config from '../config';
import {
  insertApiKey,
  listApiKeysByWallet,
  revokeApiKeyById,
  getApiKeyById,
  scheduleApiKeyRevocation,
  getActiveApiKeyByLookupHash,
  getActiveApiKeysAwaitingLookupHash,
  setApiKeyLookupHash,
  ApiKeyRow,
} from '../db';
import { logger } from '../utils/logger';
import {
  parseApiKeyScopes,
  normalizeRequestedScopes,
} from '../utils/apiKeyScopes';
import { deriveApiKeyLookupHash } from '../utils/apiKeyLookup';

// ─── Hashing helpers (mirrors tokenBlocklist.ts conventions) ──────────────────

/** Length of the random salt prepended before hashing. */
const SALT_BYTES = 16;
const SEPARATOR = ':';

/**
 * Generate a random API key and the two representations persisted for it.
 *
 * Returns `{ key, keyHash, lookupHash }` where:
 *  - `key`        is the raw (plaintext) value, returned to the caller once
 *                 and never stored;
 *  - `keyHash`    is `salt:sha256(salt+key)` — the *authentication proof*,
 *                 salted per row and therefore not searchable;
 *  - `lookupHash` is the deterministic HMAC used to find this row by indexed
 *                 equality (#1033). It is only a locator; possession of it
 *                 does not authenticate. See src/utils/apiKeyLookup.ts.
 */
export function generateApiKey(): { key: string; keyHash: string; lookupHash: string } {
  const key = randomBytes(32).toString('hex'); // 64-char hex string
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = createHash('sha256').update(salt + key).digest('hex');
  const keyHash = `${salt}${SEPARATOR}${hash}`;
  return { key, keyHash, lookupHash: deriveApiKeyLookupHash(key) };
}

/**
 * Verify a raw API key against a stored `salt:hash` value.
 */
export function verifyApiKey(rawKey: string, keyHash: string): boolean {
  const separatorIndex = keyHash.indexOf(SEPARATOR);
  if (separatorIndex === -1) return false;
  const salt = keyHash.slice(0, separatorIndex);
  const hash = keyHash.slice(separatorIndex + 1);
  if (!salt || !hash) return false;
  const expected = createHash('sha256').update(salt + rawKey).digest('hex');
  // Timing-safe comparison
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf   = Buffer.from(hash, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedBuf.length; i++) {
    diff |= expectedBuf[i] ^ actualBuf[i];
  }
  return diff === 0;
}

export interface ResolvedApiKey {
  scout_wallet: string;
  id: number;
  scopes: string[] | null;
}

/** Build the resolver's return value from a verified row. */
function toResolvedApiKey(row: ApiKeyRow): ResolvedApiKey {
  return {
    scout_wallet: row.scout_wallet,
    id: row.id,
    scopes: parseApiKeyScopes(row.scopes, (message) => logger.warn(message)),
  };
}

/**
 * Resolve a raw API key string to the associated scout wallet.
 *
 * Two distinct steps, and they must not be conflated (#1033):
 *
 *   1. LOCATE — derive the deterministic lookup value for the presented key
 *      and fetch the single candidate row with an indexed equality query.
 *      This replaces the former "load every active key and re-hash each one"
 *      scan, whose cost grew linearly with the number of issued keys.
 *   2. VERIFY — prove possession of the raw key against that row's salted
 *      `key_hash` using the existing timing-safe comparison. A row located in
 *      step 1 is *not* authenticated until this succeeds.
 *
 * Returns `{ scout_wallet, id, scopes }` on success or null on failure —
 * identical to the pre-optimization contract, including for unknown, revoked
 * (filtered out by the query's `revoked_at IS NULL`) and malformed keys.
 *
 * `scopes` is the parsed scope list (`null` = legacy/unrestricted key) so
 * REST middleware and GraphQL context can enforce the shared scope contract
 * through one code path (see src/utils/apiKeyScopes.ts).
 *
 * This is intentionally exported so auth.ts can call it without creating a
 * circular dependency — auth.ts calls this function only at runtime via a
 * lazy require so the module graph stays acyclic at load time.
 */
export async function resolveApiKey(rawKey: string): Promise<ResolvedApiKey | null> {
  if (!rawKey || typeof rawKey !== 'string') return null;

  const lookupHash = deriveApiKeyLookupHash(rawKey);

  // ── 1. Indexed lookup ──────────────────────────────────────────────────────
  const candidate = await getActiveApiKeyByLookupHash(lookupHash);
  if (candidate) {
    // ── 2. Cryptographic verification against the salted stored hash ─────────
    return verifyApiKey(rawKey, candidate.key_hash) ? toResolvedApiKey(candidate) : null;
  }

  return resolvePreMigrationApiKey(rawKey, lookupHash);
}

/**
 * TRANSITIONAL fallback for keys issued before db/024_api_key_lookup_hash.sql.
 *
 * Those rows have `lookup_hash IS NULL` and cannot be backfilled in SQL: only
 * a one-way salted hash of each key is stored, so the raw key needed to derive
 * the lookup value simply does not exist server-side. Rather than force every
 * scout to rotate, such a key is verified the old way *once* — against the
 * strictly-shrinking set of not-yet-migrated rows, never the full table — and
 * its lookup_hash is written on that first successful authentication, moving
 * it onto the indexed path for good.
 *
 * The set is backed by the partial index idx_api_keys_lookup_pending, so once
 * every active key has been healed this costs one empty indexed read. It is
 * deliberately not a general-purpose fallback: a wrong or revoked key never
 * reaches the full-table scan the old implementation performed.
 */
async function resolvePreMigrationApiKey(rawKey: string, lookupHash: string): Promise<ResolvedApiKey | null> {
  const pending: ApiKeyRow[] = await getActiveApiKeysAwaitingLookupHash();
  for (const row of pending) {
    if (!verifyApiKey(rawKey, row.key_hash)) continue;
    try {
      await setApiKeyLookupHash(row.id, lookupHash);
      logger.info({ action: 'api_key_lookup_hash_backfilled', keyId: row.id });
    } catch {
      // Best-effort: failing to persist the lookup value must never fail an
      // otherwise valid authentication. The row is simply retried next time.
    }
    return toResolvedApiKey(row);
  }
  return null;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export const issueKeySchema = z.object({
  label: z.string().max(100).default(''),
  /**
   * Optional explicit scope list. Omitted → legacy key with unrestricted
   * scout-level access (backward compatible). Restricted keys may only
   * perform operations covered by their granted scopes (#1019).
   */
  scopes: z.array(z.string()).optional(),
  /**
   * Key lifetime in days from issuance (#674). Omitted → use the server
   * default (API_KEY_DEFAULT_TTL_DAYS, default 90 days). Pass 0 to
   * explicitly request a non-expiring key.
   */
  expiresInDays: z.number().int().min(0).optional(),
}).strict();

// ── Key rotation (#676) ─────────────────────────────────────────────────────

/** Default grace period: the old key keeps authenticating for 24h post-rotation. */
const DEFAULT_ROTATION_GRACE_PERIOD_SECONDS = 24 * 60 * 60;
/** Upper bound on a caller-supplied grace period, to keep "grace" from becoming indefinite. */
const MAX_ROTATION_GRACE_PERIOD_SECONDS = 7 * 24 * 60 * 60;

export const rotateKeySchema = z.object({
  /**
   * How long the old key keeps authenticating after rotation, in seconds.
   * Omitted → DEFAULT_ROTATION_GRACE_PERIOD_SECONDS. 0 revokes the old key
   * immediately, same as DELETE.
   */
  gracePeriodSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_ROTATION_GRACE_PERIOD_SECONDS)
    .default(DEFAULT_ROTATION_GRACE_PERIOD_SECONDS),
}).strict().default({});

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/api-keys
 *
 * Issue a new API key.  The plaintext key is returned exactly once in the
 * response and is never stored.  Subsequent GET calls return only the hash
 * prefix and metadata.
 */
export async function issueApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const parsed = issueKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid body' });
    return;
  }

  const scopesResult = normalizeRequestedScopes(parsed.data.scopes);
  if (!scopesResult.ok) {
    res.status(400).json({ success: false, error: scopesResult.error });
    return;
  }

  const { key, keyHash, lookupHash } = generateApiKey();
  const now = Math.floor(Date.now() / 1000);

  // Compute expiry: explicit 0 → no expiry; explicit N → N days; omitted →
  // server default (API_KEY_DEFAULT_TTL_DAYS). Default 0 disables expiry.
  let expiresAt: number | null = null;
  const requestedDays = parsed.data.expiresInDays;
  const effectiveDays = requestedDays !== undefined ? requestedDays : config.apiKeyDefaultTtlDays;
  if (effectiveDays > 0) {
    expiresAt = now + effectiveDays * 86400;
  }

  const grantedScopes = scopesResult.scopes;
  const id = await insertApiKey({
    key_hash: keyHash,
    scout_wallet: req.params.wallet as string,
    label: parsed.data.label,
    created_at: now,
    scopes: grantedScopes.length > 0 ? grantedScopes : undefined,
    // Indexed lookup value (#1033). Persisted alongside the salted
    // verification hash so this key never touches the transitional scan
    // path; deliberately absent from the response body below.
    lookup_hash: lookupHash,
    expires_at: expiresAt,
  });

  logger.info({ scout: req.params.wallet as string, action: 'api_key_issued', keyId: id, scopes: grantedScopes.length > 0 ? grantedScopes : null, expiresAt });

  res.status(201).json({
    success: true,
    data: {
      id,
      key,          // plaintext — returned once only
      label: parsed.data.label,
      created_at: now,
      expires_at: expiresAt,
      // Empty array == legacy/unrestricted key (omitted scopes).
      scopes: grantedScopes,
    },
  });
}

/**
 * GET /api/scouts/:wallet/api-keys
 *
 * List existing API keys.  Returns metadata and a truncated hash prefix for
 * display purposes only — the full hash and plaintext key are never returned.
 */
export async function listApiKeys(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rows: ApiKeyRow[] = await listApiKeysByWallet(req.params.wallet as string);

  res.json({
    success: true,
    data: rows.map((r) => ({
      id: r.id,
      label: r.label,
      key_prefix: r.key_hash.slice(0, 8) + '…', // display hint only
      created_at: r.created_at,
      last_used_at: r.last_used_at ?? null,
      revoked: r.revoked_at !== null,
      revoked_at: r.revoked_at ?? null,
      // Set only while a rotation grace period is in effect (#676); null
      // once the key is either permanently revoked or never rotated.
      scheduled_revocation_at: r.revoked_at === null ? (r.revoke_after ?? null) : null,
      // Hard expiry timestamp (#674); null = no expiry.
      expires_at: r.expires_at ?? null,
      // Empty array = legacy/unrestricted key; otherwise the granted scope list.
      scopes: r.scopes ? (JSON.parse(r.scopes) as string[]) : [],
    })),
  });
}

/**
 * DELETE /api/scouts/:wallet/api-keys/:id
 *
 * Revoke an API key by its row id.  After revocation the key is rejected by
 * the auth middleware.
 */
export async function revokeApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid API key id' });
    return;
  }

  const revoked = await revokeApiKeyById(id, req.params.wallet as string);
  if (!revoked) {
    res.status(404).json({ success: false, error: 'API key not found' });
    return;
  }

  logger.info({ scout: req.params.wallet as string, action: 'api_key_revoked', keyId: id });

  res.json({ success: true, data: { id, revoked: true } });
}

/**
 * POST /api/scouts/:wallet/api-keys/:id/rotate
 *
 * Atomically issue a replacement key and schedule the old one for
 * revocation after a grace period (default 24h, caller-configurable up to
 * 7 days), instead of the caller having to issue-then-revoke as two
 * separate, non-atomic requests (#676). The replacement key inherits the
 * old key's label and scopes — rotation replaces credentials, not policy.
 *
 * The old key keeps authenticating until `oldKey.revokesAt`, giving the
 * caller a window to roll the new key out everywhere it's consumed before
 * the old one stops working.
 */
export async function rotateApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid API key id' });
    return;
  }

  const parsed = rotateKeySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid body' });
    return;
  }

  const oldRow = await getApiKeyById(id, req.params.wallet as string);
  if (!oldRow || oldRow.revoked_at !== null) {
    res.status(404).json({ success: false, error: 'API key not found' });
    return;
  }

  const inheritedScopes = parseApiKeyScopes(oldRow.scopes, (message) => logger.warn(message));

  const { key, keyHash, lookupHash } = generateApiKey();
  const now = Math.floor(Date.now() / 1000);

  // The replacement key inherits the old key's expiry policy. If the old key
  // had a concrete expires_at, recompute from now with the same lifetime so
  // the rotation doesn't silently shorten or extend it. If the old key had no
  // expiry (null), the replacement also has no expiry.
  let newExpiresAt: number | null = null;
  if (oldRow.expires_at !== null) {
    const originalLifetimeSecs = oldRow.expires_at - oldRow.created_at;
    newExpiresAt = now + Math.max(originalLifetimeSecs, 0);
  }

  const newId = await insertApiKey({
    key_hash: keyHash,
    scout_wallet: req.params.wallet as string,
    label: oldRow.label,
    created_at: now,
    scopes: inheritedScopes ?? undefined,
    lookup_hash: lookupHash,
    expires_at: newExpiresAt,
  });

  const revokesAt = now + parsed.data.gracePeriodSeconds;
  await scheduleApiKeyRevocation(id, req.params.wallet as string, revokesAt);

  logger.info({
    scout: req.params.wallet as string,
    action: 'api_key_rotated',
    oldKeyId: id,
    newKeyId: newId,
    revokesAt,
    newExpiresAt,
  });

  res.status(201).json({
    success: true,
    data: {
      newKey: {
        id: newId,
        key,          // plaintext — returned once only
        label: oldRow.label,
        created_at: now,
        expires_at: newExpiresAt,
        scopes: inheritedScopes ?? [],
      },
      oldKey: {
        id,
        revokesAt,
      },
    },
  });
}
