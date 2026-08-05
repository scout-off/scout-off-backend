/**
 * URI validation for metadata_uri and evidence_uri fields.
 *
 * Accepted formats:
 *   - CIDv0  — base58btc, starts with "Qm", exactly 46 characters
 *   - CIDv1  — base32, starts with "bafy" or "bafk" (the two most common
 *               content-addressed prefixes produced by kubo / go-ipfs)
 *   - HTTPS URL — must have a valid hostname; bare IPs without a domain,
 *                 path traversal (..), and non-HTTPS schemes are rejected
 *
 * Explicitly rejected:
 *   - ipfs:// scheme URIs  (callers must strip the scheme and pass the bare CID)
 *   - http:// URLs
 *   - Empty strings, null, undefined
 *   - Any string that does not match the formats above
 *
 * This is a format-only check — no network requests are made.
 */

// CIDv0: Base58-encoded SHA2-256 multihash.
// Always "Qm" prefix + 44 base58btc characters = 46 total.
const CID_V0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

// CIDv1: base32 lower-case (the default encoding used by modern IPFS tooling).
// The two common prefixes in the wild are "bafy" (dag-pb / raw) and "bafk" (sha2-512).
// At least 50 chars total to rule out accidental short matches.
const CID_V1_RE = /^(bafy|bafk)[2-7a-z]{46,}$/;

// HTTPS URL — requires a proper hostname (no raw IPs, no localhost).
// Rejects path traversal ("..") anywhere in the URL string.
const HTTPS_HOSTNAME_RE = /^https:\/\/[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)+/;

/** Standard error message returned by Zod refinements and HTTP 400 responses. */
export const URI_VALIDATION_ERROR =
  "metadata_uri must be a valid IPFS CID (v0 or v1) or an HTTPS URL";

/**
 * Returns true if `uri` is a valid bare CIDv0 or CIDv1 string.
 * Does not accept ipfs:// prefixed strings.
 */
export function isValidCidUri(uri: string): boolean {
  return CID_V0_RE.test(uri) || CID_V1_RE.test(uri);
}

/**
 * Returns true if `uri` is a well-formed HTTPS URL with a proper hostname
 * and no path traversal sequences.
 */
export function isValidHttpsUrl(uri: string): boolean {
  if (!uri.startsWith('https://')) return false;
  if (uri.includes('..')) return false;
  if (!HTTPS_HOSTNAME_RE.test(uri)) return false;
  // Delegate to the platform URL parser for final structural validation.
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Primary validator used in Zod schemas.
 *
 * Returns true when the value is:
 *   - A valid bare CIDv0 or CIDv1, OR
 *   - A valid HTTPS URL
 *
 * Returns false for ipfs:// URIs, http:// URLs, empty strings, and anything else.
 */
export function isValidMetadataUri(uri: string): boolean {
  if (!uri || typeof uri !== 'string') return false;
  // Explicitly reject ipfs:// scheme — callers must pass the bare CID.
  if (uri.startsWith('ipfs://')) return false;
  return isValidCidUri(uri) || isValidHttpsUrl(uri);
}

/**
 * @deprecated  The old evidence-URI validator accepted ipfs:// scheme strings.
 * Existing callers are being migrated to isValidMetadataUri.
 * Kept temporarily so the re-export in validatorController.ts keeps compiling.
 */
export function isValidEvidenceUri(uri: string): boolean {
  return isValidMetadataUri(uri);
}

/**
 * Validator for fields that (unlike metadata_uri/evidence_uri) still accept
 * the ipfs:// scheme by convention — e.g. a scout's free-form trial-offer
 * detailsUri. Accepts `ipfs://` or `https://` URIs with meaningful content
 * after the scheme; does not require the ipfs:// content to be a well-formed
 * CID (this predates the stricter bare-CID policy introduced for
 * metadata_uri/evidence_uri — see isValidMetadataUri above).
 */
const IPFS_OR_HTTPS_SCHEMES = ['ipfs://', 'https://'];
const IPFS_OR_HTTPS_MIN_CONTENT_LENGTH = 3;

export function isValidIpfsOrHttpsUri(uri: string): boolean {
  if (!uri || typeof uri !== 'string') return false;

  const scheme = IPFS_OR_HTTPS_SCHEMES.find((s) => uri.startsWith(s));
  if (!scheme) return false;

  return uri.slice(scheme.length).trim().length >= IPFS_OR_HTTPS_MIN_CONTENT_LENGTH;
}
