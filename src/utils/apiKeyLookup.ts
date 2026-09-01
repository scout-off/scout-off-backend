/**
 * Deterministic, indexable lookup values for API keys (#1033).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `api_keys.key_hash` stores `salt:sha256(salt+key)` with a *per-row random
 * salt*.  That is the right shape for proving possession of a raw key, but it
 * is deliberately non-deterministic: the same raw key hashes differently in
 * every row, so it can never be used as a database lookup term.  Before this
 * module existed, `resolveApiKey()` had no choice but to load every active row
 * and re-hash the presented key against each salt — an O(n) table scan plus n
 * SHA-256 computations on the hot path of every X-API-Key request.
 *
 * `lookup_hash` fixes that by adding a *second*, deterministic representation
 * of the same raw key that can be indexed and matched with a single equality
 * predicate.  It mirrors how `idempotency_keys` (db/003_idempotency_keys.sql)
 * finds a caller-supplied token: one indexed equality lookup, no scan.
 *
 * ── The lookup value is NOT the authentication proof ─────────────────────────
 * Finding a row by `lookup_hash` only narrows thousands of candidate rows down
 * to one.  Authentication still requires `verifyApiKey(rawKey, row.key_hash)`
 * — the salted, timing-safe check — to succeed.  A caller who somehow knew a
 * `lookup_hash` but not the raw key still cannot authenticate.
 *
 * ── Why HMAC rather than a bare SHA-256 ──────────────────────────────────────
 * A bare digest would let anyone holding a read-only copy of the database (a
 * leaked backup, a replica, an over-broad analytics grant) confirm a guessed
 * or intercepted raw key offline, and correlate the same key across
 * environments, without any server-side secret.  Keying the digest with a
 * pepper held outside the database (API_KEY_LOOKUP_SECRET) means the stored
 * column is inert on its own.  The pepper is loaded from configuration the
 * same way WEBHOOK_SECRET_ENCRYPTION_KEY is (src/utils/webhookSecretCipher.ts)
 * — never hard-coded outside the explicit development fallback below.
 */
import { createHmac, createHash } from 'crypto';
import config from '../config';
import { logger } from './logger';

/**
 * Version tag stored alongside the digest (`v1:<hex>`), matching the
 * `salt:hash` and `v1:iv:tag:ciphertext` conventions used elsewhere in this
 * codebase.  It makes a future construction change detectable in stored data
 * rather than silently ambiguous.
 */
const VERSION_PREFIX = 'v1';

/**
 * Domain separator mixed into every digest so the pepper can never produce a
 * value that collides with an HMAC computed for some other purpose.
 */
const DOMAIN = 'scout-off:api-key-lookup:v1';

/** Required length of API_KEY_LOOKUP_SECRET, in bytes, once hex-decoded. */
const SECRET_BYTES = 32;

/**
 * Fixed, publicly-known pepper used only when API_KEY_LOOKUP_SECRET is unset
 * outside production (local dev / CI).  Never reachable in production — see
 * resolveSecret() and the startup guard in src/config.ts.  This keeps the test
 * suite runnable without every contributor minting a secret.
 */
const INSECURE_DEV_SECRET = createHash('sha256')
  .update('scout-off-insecure-dev-only-api-key-lookup-pepper')
  .digest();

let warnedInsecureDevSecret = false;

function resolveSecret(): Buffer {
  const raw = config.apiKeyLookupSecret;
  if (raw) {
    const secret = Buffer.from(raw, 'hex');
    if (secret.length !== SECRET_BYTES) {
      throw new Error(
        `API_KEY_LOOKUP_SECRET must be a ${SECRET_BYTES * 2}-character hex string (${SECRET_BYTES} bytes). Generate one with: openssl rand -hex 32`,
      );
    }
    return secret;
  }

  if (config.nodeEnv === 'production') {
    // Unreachable in practice — src/config.ts throws at startup — but kept so
    // the derivation layer can never silently fall back to a public pepper.
    throw new Error(
      'API_KEY_LOOKUP_SECRET is required in production to derive API-key lookup hashes. Generate one with: openssl rand -hex 32',
    );
  }

  if (!warnedInsecureDevSecret) {
    logger.warn(
      '[apiKeyLookup] API_KEY_LOOKUP_SECRET is not set — using a fixed, insecure development-only pepper for api_keys.lookup_hash. Set API_KEY_LOOKUP_SECRET before deploying to staging/production.',
    );
    warnedInsecureDevSecret = true;
  }
  return INSECURE_DEV_SECRET;
}

/**
 * Derive the indexed lookup value for a raw API key.
 *
 * Deterministic for a given raw key + pepper, so it can be stored once at
 * issuance and matched later with `WHERE lookup_hash = ?`.
 *
 * Returns `v1:<64-char hex>`.  Never returns anything derived from the raw key
 * alone, and is never sufficient to authenticate on its own.
 */
export function deriveApiKeyLookupHash(rawKey: string): string {
  const digest = createHmac('sha256', resolveSecret())
    .update(DOMAIN)
    .update(rawKey)
    .digest('hex');
  return `${VERSION_PREFIX}:${digest}`;
}
