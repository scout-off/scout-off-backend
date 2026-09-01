import { isIP } from 'net';

/**
 * src/utils/validators.ts
 *
 * Shared validation helpers used across controllers.
 * Centralising these constants prevents duplicate definitions and ensures
 * consistent validation logic throughout the codebase.
 */

/**
 * Matches a valid Stellar public key (G… address).
 * A Stellar public key is a 56-character base-32 encoded string that starts
 * with 'G', followed by 55 characters from the set [A-Z2-7].
 *
 * @example
 *   STELLAR_ADDRESS_RE.test('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN') // true
 *   STELLAR_ADDRESS_RE.test('notakey') // false
 */
export const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * Returns true if ip is a syntactically valid IPv4 or IPv6 address.
 * Backed by Node's built-in net.isIP(), which returns 0 for anything
 * that isn't a valid IPv4 or IPv6 address (including non-string input).
 *
 * @example
 *   isValidIpAddress('203.0.113.5') // true
 *   isValidIpAddress('::1') // true
 *   isValidIpAddress('not-an-ip') // false
 */
export function isValidIpAddress(ip: string): boolean {
  return typeof ip === 'string' && isIP(ip) !== 0;
}
