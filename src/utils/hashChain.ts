import { createHash } from 'crypto';

/**
 * Genesis hash used as the `prev_hash` for the first row in a hash chain.
 * A fixed, recognizable sentinel (64 zero characters, matching a sha256 hex
 * digest's length) rather than NULL, so every row — including the first —
 * has a concrete, verifiable prev_hash to compare against.
 */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministically stringifies a value with object keys sorted (recursively,
 * at every level), so the same logical content always produces the same
 * string regardless of key insertion order. This is what makes the hash
 * chain reproducible: hashing `JSON.stringify` directly would be sensitive
 * to incidental key-ordering differences and could make an untampered row
 * fail verification for no real reason.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Computes the chained hash for a row: sha256(canonicalJSON(content) + prevHash).
 * `prevHash` should be the previous row's stored hash, or GENESIS_HASH for the
 * first row in the chain.
 */
export function computeChainHash(content: unknown, prevHash: string): string {
  return createHash('sha256').update(canonicalJSON(content) + prevHash).digest('hex');
}

/**
 * The subset of an audit_log row that participates in the hash chain (i.e.
 * everything except the id/prev_hash/hash columns themselves). Shared between
 * the write path (src/db/index.ts's insertAuditLog) and the verification path
 * (src/utils/auditVerify.ts's verifyAuditChain) so both always hash the exact
 * same shape — defining this in one place rather than duplicating it avoids
 * the two ever silently drifting apart.
 */
export interface AuditChainFields {
  action: string;
  adminWallet: string;
  queryParams: string;
  createdAt: string;
  eventSource: string;
}

/** Maps an AuditChainFields object to the snake_case shape hashed into the audit log chain. */
export function auditChainContent(f: AuditChainFields): Record<string, string> {
  return {
    action: f.action,
    admin_wallet: f.adminWallet,
    query_params: f.queryParams,
    created_at: f.createdAt,
    event_source: f.eventSource,
  };
}
