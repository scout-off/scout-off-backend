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
import { z } from 'zod';
import config from '../config';
import {
  insertApiKey,
  listApiKeysByWallet,
  revokeApiKeyById,
  getApiKeyById,
  scheduleApiKeyRevocation,
  updateApiKeyMeta,
  ApiKeyRow,
} from '../db';
import { logger } from '../utils/logger';
import {
  parseApiKeyScopes,
  normalizeRequestedScopes,
  API_KEY_SCOPE_VOCABULARY,
} from '../utils/apiKeyScopes';
import { ApiKeyLimitError } from '../utils/scoutResourceLimits';
import { generateApiKey } from '../services/apiKeyService';

export { generateApiKey, resolveApiKey, verifyApiKey } from '../services/apiKeyService';
export type { ResolvedApiKey } from '../services/apiKeyService';

// ─── Validation ───────────────────────────────────────────────────────────────

export const issueKeySchema = z
  .object({
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
  })
  .strict();

// ── Key rotation (#676) ─────────────────────────────────────────────────────

/** Default grace period: the old key keeps authenticating for 24h post-rotation. */
const DEFAULT_ROTATION_GRACE_PERIOD_SECONDS = 24 * 60 * 60;
/** Upper bound on a caller-supplied grace period, to keep "grace" from becoming indefinite. */
const MAX_ROTATION_GRACE_PERIOD_SECONDS = 7 * 24 * 60 * 60;

export const rotateKeySchema = z
  .object({
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
  })
  .strict()
  .prefault({});

// ── Key metadata updates: relabel + narrow scopes (#1329) ─────────────────────

/**
 * Body schema for PATCH /api/scouts/:wallet/api-keys/:id. Both fields are
 * optional; omitted fields are left unchanged. Unlike issuance, `scopes` may
 * only narrow the key's existing privileges — the handler rejects any scope
 * the key does not already hold.
 */
export const updateKeySchema = z
  .object({
    /** New human-readable label. Omitted → keep the existing label. */
    label: z.string().max(100).optional(),
    /**
     * New scope list. Omitted → keep the existing scopes. When present it must
     * be a subset of the key's current scopes (scope changes may only narrow).
     */
    scopes: z.array(z.string()).optional(),
  })
  .strict();

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/api-keys
 *
 * Issue a new API key.  The plaintext key is returned exactly once in the
 * response and is never stored.  Subsequent GET calls return only the hash
 * prefix and metadata.
 *
 * @response 409 Scout API key limit reached
 */
export async function issueApiKey(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const parsed = issueKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid body' });
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
  let id: number;
  try {
    id = await insertApiKey({
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
  } catch (err) {
    if (err instanceof ApiKeyLimitError) {
      res.status(409).json({ success: false, error: err.message });
      return;
    }
    throw err;
  }

  logger.info({
    scout: req.params.wallet as string,
    action: 'api_key_issued',
    keyId: id,
    scopes: grantedScopes.length > 0 ? grantedScopes : null,
    expiresAt,
  });

  res.status(201).json({
    success: true,
    data: {
      id,
      key, // plaintext — returned once only
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
export async function listApiKeys(req: Request, res: Response, _next: NextFunction): Promise<void> {
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
  _next: NextFunction,
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
 * PATCH /api/scouts/:wallet/api-keys/:id
 *
 * Update an API key's label and/or scopes in place, without rotating the
 * secret. Because the credential keeps working, there is nothing to redeploy
 * — this is what lets a scout reduce a key's privileges without rolling the
 * key out everywhere it is consumed. Scope changes may only narrow the key's
 * existing privileges: every scope requested must already be held by the key,
 * and an attempt to widen access is rejected rather than silently applied
 * (#1329).
 */
export async function updateApiKey(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid API key id' });
    return;
  }

  const parsed = updateKeySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid body' });
    return;
  }

  const row = await getApiKeyById(id, req.params.wallet as string);
  if (!row || row.revoked_at !== null) {
    res.status(404).json({ success: false, error: 'API key not found' });
    return;
  }

  const labelChanged = parsed.data.label !== undefined;
  const scopesChanged = parsed.data.scopes !== undefined;

  // `null` (legacy / migration-default / unparseable) means the key is
  // unrestricted and effectively holds the whole vocabulary.
  const currentScopes = parseApiKeyScopes(row.scopes, (message) => logger.warn(message));

  const nextLabel = parsed.data.label ?? row.label;
  let nextScopesRaw: string | null = row.scopes;

  if (scopesChanged) {
    const normalized = normalizeRequestedScopes(parsed.data.scopes);
    if (!normalized.ok) {
      res.status(400).json({ success: false, error: normalized.error });
      return;
    }
    if (normalized.scopes.length === 0) {
      res.status(400).json({
        success: false,
        error: 'scopes must contain at least one scope; revoke the key with DELETE instead',
      });
      return;
    }

    const allowed = currentScopes ?? (API_KEY_SCOPE_VOCABULARY as readonly string[]);
    const notGranted = normalized.scopes.filter((scope) => !allowed.includes(scope));
    if (notGranted.length > 0) {
      res.status(400).json({
        success: false,
        error: `scopes may only be narrowed; not currently granted: ${notGranted.join(', ')}`,
      });
      return;
    }

    const requestedRaw = JSON.stringify(normalized.scopes);
    // The stored list must remain a restriction. The migration default is
    // interpreted as "unrestricted" (see apiKeyScopes), so persisting it would
    // silently widen the key — reject that round-trip case.
    if (currentScopes !== null && parseApiKeyScopes(requestedRaw) === null) {
      res.status(400).json({ success: false, error: 'scopes may only be narrowed' });
      return;
    }

    nextScopesRaw = requestedRaw;
  }

  // Nothing to change — return the current metadata without writing.
  if (!labelChanged && !scopesChanged) {
    res.json({
      success: true,
      data: { id, label: row.label, scopes: currentScopes ?? [] },
    });
    return;
  }

  const updated = await updateApiKeyMeta(id, req.params.wallet as string, nextLabel, nextScopesRaw);
  if (!updated) {
    // Row was revoked between the read and the write.
    res.status(404).json({ success: false, error: 'API key not found' });
    return;
  }

  const resolvedScopes = parseApiKeyScopes(nextScopesRaw, (message) => logger.warn(message));

  logger.info({
    scout: req.params.wallet as string,
    action: 'api_key_updated',
    keyId: id,
    labelChanged,
    scopesChanged,
    scopes: resolvedScopes,
  });

  res.json({
    success: true,
    data: {
      id,
      label: nextLabel,
      // Empty array == legacy/unrestricted key.
      scopes: resolvedScopes ?? [],
    },
  });
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
  _next: NextFunction,
): Promise<void> {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid API key id' });
    return;
  }

  const parsed = rotateKeySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid body' });
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

  let newId: number;
  try {
    newId = await insertApiKey({
      key_hash: keyHash,
      scout_wallet: req.params.wallet as string,
      label: oldRow.label,
      created_at: now,
      scopes: inheritedScopes ?? undefined,
      lookup_hash: lookupHash,
      expires_at: newExpiresAt,
    });
  } catch (err) {
    if (err instanceof ApiKeyLimitError) {
      res.status(409).json({ success: false, error: err.message });
      return;
    }
    throw err;
  }

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
        key, // plaintext — returned once only
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
