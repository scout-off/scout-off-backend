/** Trims whitespace and strips null bytes/control characters (U+0000–U+001F, U+007F) from a string. */
export function sanitizeInput(input: string): string {
  if (typeof input !== 'string') return input;
  
  // 1. Unicode Normalisation (NFC)
  let sanitized = input.normalize('NFC');
  
  // 2. Trim surrounding whitespace
  sanitized = sanitized.trim();
  
  // 3. Strip null bytes and control chars (U+0000 to U+001F and U+007F)
  // This inherently removes \n and \r (log injection).
  sanitized = sanitized
    .split('')
    .filter(c => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127)
    .join('');
    
  // 4. HTML entity encoding (XSS prevention)
  sanitized = sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
  
  return sanitized;
}

/**
 * Recursively applies sanitizeInput to all string values within an object or array.
 */
export function sanitizeObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return sanitizeInput(obj);
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
