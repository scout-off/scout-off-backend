/**
 * IPFS CID validation helper.
 * Supports CIDv0 (base58, starts with Qm, 46 chars) and
 * CIDv1 (base32/base58/base64, starts with 'b', 'z', or 'f').
 */

// CIDv0: Base58-encoded SHA2-256 multihash — always starts with "Qm" and is 46 chars
const CID_V0_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

// CIDv1: multibase-prefixed (base32 "b", base58btc "z", base64 "f", etc.)
// Relaxed pattern: multibase prefix followed by at least 10 base-encoded chars
const CID_V1_REGEX = /^[bBzZfFuU][2-7A-Za-z0-9+/]{10,}$/;

/** Matches both CIDv0 and CIDv1 formats */
export const CID_REGEX = new RegExp(`(${CID_V0_REGEX.source})|(${CID_V1_REGEX.source})`);

/**
 * Returns true if the given string is a valid IPFS CID (v0 or v1).
 */
export function isValidCid(cid: string): boolean {
  if (typeof cid !== 'string') return false;
  return CID_V0_REGEX.test(cid) || CID_V1_REGEX.test(cid);
}
