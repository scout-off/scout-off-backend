/**
 * Normalize text for storage: Unicode NFC, trim, strip control characters (log-injection defense).
 * Does NOT apply HTML entity encoding — text is stored verbatim for proper filtering, round-tripping, and non-HTML consumers.
 * HTML escaping is an output concern, applied when rendering to HTML (see escapeHtml).
 *
 * @throws If the input is a string, returns the normalized version. Otherwise returns unchanged.
 */
export function normalizeText(input: string): string {
  if (typeof input !== 'string') return input;

  // 1. Unicode Normalisation (NFC) — ensures consistent representation
  let normalized = input.normalize('NFC');

  // 2. Trim surrounding whitespace
  normalized = normalized.trim();

  // 3. Strip null bytes and control chars (U+0000 to U+001F and U+007F)
  // This inherently removes \n and \r (log injection / CRLF injection defense).
  normalized = normalized
    .split('')
    .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127)
    .join('');

  return normalized;
}

/**
 * Escape text for safe HTML output. Converts &<>"' to their entity equivalents.
 * Use this when rendering user-supplied text into HTML contexts.
 * Note: does NOT normalize (that should be done on input via normalizeText).
 */
export function escapeHtml(text: string): string {
  if (typeof text !== 'string') return String(text);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Legacy function for backward compatibility. Apply normalization only (no HTML encoding).
 * New code should call normalizeText() directly.
 * Existing call sites will continue to work but without the problematic HTML entity encoding (#1319).
 */
export function sanitizeInput(input: string): string {
  if (typeof input !== 'string') return input;
  return normalizeText(input);
}

/**
 * Recursively applies normalizeText to all string values within an object or array.
 * Does NOT encode HTML — text is stored verbatim.
 */
export function sanitizeObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return normalizeText(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }
  if (obj !== null && typeof obj === 'object') {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitizedObj[key] = sanitizeObject(value);
    }
    return sanitizedObj;
  }
  return obj;
}
