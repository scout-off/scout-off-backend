/**
 * API Key Controller (#490)
 *
 * Allows scouts to issue, list, and revoke long-lived API keys for
 * server-to-server integrations.  Only a salted SHA-256 hash of each key is
 * ever persisted; the raw key is returned exactly once at issuance time.
 */
import { Request, Response, NextFunction } from 'express';
import { randomBytes, createHash } from 'crypto';
import { z } from 'zod';
import {
  insertApiKey,
  listApiKeysByWallet,
  revokeApiKeyById,
  getAllActiveApiKeys,
  ApiKeyRow,
} from '../db';
import { isValidStellarAddress } from '../utils/stellarAddress';
import { sendForbidden } from '../utils/authError';
import { logger } from '../utils/logger';

// ─── Hashing helpers (mirrors tokenBlocklist.ts conventions) ──────────────────

/** Length of the random salt prepended before hashing. */
const SALT_BYTES = 16;
const SEPARATOR = ':';

/**
 * Generate a random API key and its storable salted hash.
 * Returns `{ key, keyHash }` where `key` is the raw (plaintext) value and
 * `keyHash` is `salt:sha256(salt+key)`.
 */
export function generateApiKey(): { key: string; keyHash: string } {
  const key = randomBytes(32).toString('hex'); // 64-char hex string
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = createHash('sha256').update(salt + key).digest('hex');
  const keyHash = `${salt}${SEPARATOR}${hash}`;
  return { key, keyHash };
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

/**
 * Resolve a raw API key string to the associated scout wallet.
 * Scans all active (non-revoked) keys and verifies the hash.
 * Returns `{ scout_wallet, id }` on success or null on failure.
 *
 * This is intentionally exported so auth.ts can call it without creating a
 * circular dependency — auth.ts calls this function only at runtime via a
 * lazy require so the module graph stays acyclic at load time.
 */
export function resolveApiKey(rawKey: string): { scout_wallet: string; id: number } | null {
  const rows: ApiKeyRow[] = getAllActiveApiKeys();
  for (const row of rows) {
    if (verifyApiKey(rawKey, row.key_hash)) {
      return { scout_wallet: row.scout_wallet, id: row.id };
    }
  }
  return null;
}

// ─── Validation ───────────────────────────────────────────────────────────────

const issueKeySchema = z.object({
  label: z.string().max(100).default(''),
});

// ─── Ownership guard ──────────────────────────────────────────────────────────

function assertWalletOwnership(req: Request, res: Response): boolean {
  const { wallet } = req.params;
  if (!isValidStellarAddress(wallet)) {
    res.status(400).json({ success: false, error: 'Invalid Stellar address' });
    return false;
  }
  if (req.account !== wallet) {
    sendForbidden(res, 'Forbidden: wallet mismatch');
    return false;
  }
  return true;
}

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
  try {
    if (!assertWalletOwnership(req, res)) return;

    const parsed = issueKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid body' });
      return;
    }

    const { key, keyHash } = generateApiKey();
    const now = Math.floor(Date.now() / 1000);

    const id = insertApiKey({
      key_hash: keyHash,
      scout_wallet: req.params.wallet,
      label: parsed.data.label,
      created_at: now,
    });

    logger.info({ scout: req.params.wallet, action: 'api_key_issued', keyId: id });

    res.status(201).json({
      success: true,
      data: {
        id,
        key,          // plaintext — returned once only
        label: parsed.data.label,
        created_at: now,
      },
    });
  } catch (err) {
    next(err);
  }
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
  try {
    if (!assertWalletOwnership(req, res)) return;

    const rows: ApiKeyRow[] = listApiKeysByWallet(req.params.wallet);

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
      })),
    });
  } catch (err) {
    next(err);
  }
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
  try {
    if (!assertWalletOwnership(req, res)) return;

    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid API key id' });
      return;
    }

    const revoked = revokeApiKeyById(id, req.params.wallet);
    if (!revoked) {
      res.status(404).json({ success: false, error: 'API key not found' });
      return;
    }

    logger.info({ scout: req.params.wallet, action: 'api_key_revoked', keyId: id });

    res.json({ success: true, data: { id, revoked: true } });
  } catch (err) {
    next(err);
  }
}
