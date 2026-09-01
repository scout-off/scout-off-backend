import { Request } from 'express';

/**
 * Trusted proxy count. Set via TRUSTED_PROXY_COUNT env var (default: 1).
 * When behind a load balancer, the rightmost IP in X-Forwarded-For that
 * is NOT from a trusted proxy is the real client IP.
 */
const TRUSTED_PROXY_COUNT = parseInt(process.env.TRUSTED_PROXY_COUNT ?? '1', 10);

/**
 * Extract the real client IP from a request.
 * Respects X-Forwarded-For header and a trusted proxy count.
 *
 * Fail-safe behaviour: if the X-Forwarded-For chain contains fewer entries
 * than TRUSTED_PROXY_COUNT implies (direct connection bypassing a proxy,
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
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      .split(',')
      .map((ip) => ip.trim());

    // A valid chain must have at least TRUSTED_PROXY_COUNT + 1 entries:
    // one for the real client and one per trusted proxy hop.
    // If the chain is shorter the leftmost entry is attacker-controlled —
    // fall back to the socket address to avoid trusting it.
    if (ips.length < TRUSTED_PROXY_COUNT + 1) {
      return req.socket.remoteAddress ?? 'unknown';
    }

    // The real client IP is at index: length - 1 - TRUSTED_PROXY_COUNT
    const idx = ips.length - 1 - TRUSTED_PROXY_COUNT;
    if (ips[idx]) return ips[idx];
  }
  return req.socket.remoteAddress ?? 'unknown';
}
