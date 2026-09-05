import crypto from 'crypto';
import config from '../config';

/**
 * Key names that should never be logged in any environment.
 * These are dropped entirely from log payloads.
 */
const SENSITIVE_KEYS = new Set([
  'token',
  'authorization',
  'secret',
  'apikey',
  'api_key',
  'password',
  'passwd',
  'x-api-key',
]);

/**
 * Stellar strkey patterns for wallet addresses and other identifiers.
 * - G... : public key (56 chars)
 * - S... : secret key (56 chars)
 * - M... : muxed account (69 chars)
 */
const STRKEY_PATTERN = /^[GSM][A-Z0-9]{55,68}$/;

/**
 * Mask a Stellar wallet address keeping prefix and suffix characters.
 * Example: GABCD...XYZ123 -> G...123
 */
function maskWalletAddress(address: string): string {
  const prefixLen = config.logRedaction.walletPrefixLength;
  const suffixLen = config.logRedaction.walletSuffixLength;
  
  if (address.length <= prefixLen + suffixLen) {
    // If address is too short, just mask most of it
    return address.slice(0, prefixLen) + '***';
  }
  
  return address.slice(0, prefixLen) + '...' + address.slice(-suffixLen);
}

/**
 * Hash a correlation ID for logging while preserving uniqueness.
 * Uses SHA-256 and returns the first 8 hex characters for brevity.
 */
function hashCorrelationId(cid: string): string {
  return crypto.createHash('sha256').update(cid).digest('hex').slice(0, 8);
}

/**
 * Recursively redact sensitive data from an object.
 * - Drops sensitive keys entirely
 * - Masks wallet addresses (strkey-shaped strings)
 * - Hashes correlation IDs if configured
 */
function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    
    // Drop sensitive keys entirely
    if (SENSITIVE_KEYS.has(lowerKey)) {
      continue;
    }
    
    // Recursively handle nested objects
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>);
      continue;
    }
    
    // Handle arrays
    if (Array.isArray(value)) {
      result[key] = value.map(item => {
        if (typeof item === 'string') {
          return redactString(item);
        }
        if (typeof item === 'object' && item !== null) {
          return redactObject(item as Record<string, unknown>);
        }
        return item;
      });
      continue;
    }
    
    // Handle strings - check for wallet addresses and correlation IDs
    if (typeof value === 'string') {
      result[key] = redactString(value);
      continue;
    }
    
    // Pass through other values unchanged
    result[key] = value;
  }
  
  return result;
}

/**
 * Redact sensitive data from a string value.
 * - Masks wallet addresses (strkey-shaped strings)
 * - Hashes correlation IDs if configured
 */
function redactString(str: string): string {
  // Check for Stellar wallet addresses
  if (STRKEY_PATTERN.test(str)) {
    return maskWalletAddress(str);
  }
  
  // Check for correlation ID patterns (if configured to hash)
  if (config.logRedaction.hashCorrelationIds) {
    // Look for correlationId= or cid= patterns
    const cidMatch = str.match(/(correlationId|cid)=([a-zA-Z0-9-]+)/);
    if (cidMatch) {
      return str.replace(cidMatch[0], `${cidMatch[1]}=${hashCorrelationId(cidMatch[2])}`);
    }
  }
  
  return str;
}

/**
 * Main redaction function applied to log arguments.
 * Returns a redacted copy of the input, or the original if redaction is disabled.
 */
export function redactLogArg(arg: unknown): unknown {
  // Pass-through in development or if redaction is disabled
  if (!config.logRedaction.enabled) {
    return arg;
  }
  
  // Handle objects
  if (arg !== null && typeof arg === 'object' && !Array.isArray(arg)) {
    return redactObject(arg as Record<string, unknown>);
  }
  
  // Handle arrays
  if (Array.isArray(arg)) {
    return arg.map(item => redactLogArg(item));
  }
  
  // Handle strings
  if (typeof arg === 'string') {
    return redactString(arg);
  }
  
  // Pass through primitives unchanged
  return arg;
}

/**
 * Log a message without redaction (for audit logs).
 * This bypasses the redaction layer to preserve full wallet addresses for compliance.
 */
export function logWithoutRedaction(
  level: 'debug' | 'info' | 'warn' | 'error' | 'critical',
  ...args: unknown[]
): void {
  // Temporarily disable redaction for this call
  const originalEnabled = config.logRedaction.enabled;
  config.logRedaction.enabled = false;
  try {
    // Call the appropriate console method directly
    switch (level) {
      case 'debug':
        console.debug('[debug]', ...args);
        break;
      case 'info':
        console.info('[info]', ...args);
        break;
      case 'warn':
        console.warn('[warn]', ...args);
        break;
      case 'error':
        console.error('[error]', ...args);
        break;
      case 'critical':
        console.error('[critical]', ...args);
        break;
    }
  } finally {
    config.logRedaction.enabled = originalEnabled;
  }
}