import { Request } from 'express';
import config from '../config';

/**
 * Extract the real client IP from a request.
 * Respects X-Forwarded-For header and a trusted proxy count.
 *
 * The trusted proxy count is read from `config.trustedProxyCount`
 * (parsed and validated once at startup from the TRUSTED_PROXY_COUNT
 * environment variable, default 1) — this module never reads
 * environment variables directly, so a misconfigured value fails fast at startup
 * instead of degrading silently.
 *
 * Fail-safe behaviour: if the X-Forwarded-For chain contains fewer entries
 * than the trusted proxy count implies (direct connection bypassing a proxy,
 * misconfigured infrastructure, or an attacker supplying a shorter-than-expected
 * header), the function falls back to the raw socket address rather than
 * trusting the attacker-controlled leftmost value.
 *
 * Example: TRUSTED_PROXY_COUNT=2, X-Forwarded-For has only 1 entry.
 *   The expected chain is [client, proxy1, proxy2]; we only see 1 hop, so
 *   the leftmost value was NOT placed there by a proxy we control.
 *   → fall back to req.socket.remoteAddress.
 */
export function extractClientIp(req: Request): string {
  const trustedProxyCount = config.trustedProxyCount;
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      .split(',')
      .map((ip) => ip.trim());

    // A valid chain must have at least trustedProxyCount + 1 entries:
    // one for the real client and one per trusted proxy hop.
    // If the chain is shorter the leftmost entry is attacker-controlled —
    // fall back to the socket address to avoid trusting it.
    if (ips.length < trustedProxyCount + 1) {
      return req.socket.remoteAddress ?? 'unknown';
    }

    // The real client IP is at index: length - 1 - trustedProxyCount
    const idx = ips.length - 1 - trustedProxyCount;
    if (ips[idx]) return ips[idx];
  }
  return req.socket.remoteAddress ?? 'unknown';
}
