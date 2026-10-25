/**
 * metricsGuard.ts
 *
 * Middleware that protects the /metrics endpoint with optional bearer token
 * and/or CIDR allowlist.
 *
 * - If METRICS_AUTH_TOKEN is set, requires Authorization: Bearer <token>
 * - If METRICS_ALLOWED_CIDRS is set, checks req.socket.remoteAddress against CIDR list
 * - Returns 401 for missing/invalid token, 403 for IP not in allowlist
 * - In development/test, passes through without protection (unless explicitly configured)
 * - In production with neither configured, logs a warning at startup (in config.ts)
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import config from '../config';
import { logger } from '../utils/logger';
import { ipInCidr, normalizeIpv4MappedIpv6 } from './ipAllowlist';

/**
 * Check if the metrics endpoint should be protected.
 * Returns true if either authToken or allowedCidrs is configured.
 */
function isMetricsProtectionEnabled(): boolean {
  return !!config.metrics.authToken || config.metrics.allowedCidrs.length > 0;
}

/**
 * Constant-time comparison of two strings to prevent timing attacks.
 * Returns true if the strings are equal, false otherwise.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

/**
 * Validate bearer token from Authorization header.
 * Returns true if token matches configured authToken, false otherwise.
 */
function validateBearerToken(authHeader: string | undefined): boolean {
  if (!config.metrics.authToken) return true; // No token configured, allow
  if (!authHeader) return false;

  const expectedPrefix = 'Bearer ';
  if (!authHeader.startsWith(expectedPrefix)) return false;

  const token = authHeader.slice(expectedPrefix.length);
  return timingSafeEqual(token, config.metrics.authToken);
}

/**
 * Check if client IP is in the configured CIDR allowlist.
 * Returns true if IP is allowed or no allowlist is configured, false otherwise.
 */
function validateCidr(remoteAddress: string | undefined): boolean {
  if (config.metrics.allowedCidrs.length === 0) return true; // No CIDR configured, allow
  if (!remoteAddress) return false;

  // Normalize IPv4-mapped IPv6 addresses
  const normalizedIp = normalizeIpv4MappedIpv6(remoteAddress);

  // Check against each CIDR entry
  return config.metrics.allowedCidrs.some((cidr) => ipInCidr(normalizedIp, cidr));
}

/**
 * Middleware that protects the /metrics endpoint.
 *
 * Behaviour:
 * - In development/test: passes through unless METRICS_AUTH_TOKEN or METRICS_ALLOWED_CIDRS is set
 * - In production: if neither is configured, logs a warning at startup (in config.ts)
 * - If METRICS_AUTH_TOKEN is set: requires Authorization: Bearer <token> (constant-time comparison)
 * - If METRICS_ALLOWED_CIDRS is set: checks req.socket.remoteAddress against CIDR list
 * - Returns 401 for missing/invalid token, 403 for IP not in allowlist
 * - Both checks must pass if both are configured
 */
export function metricsGuard(req: Request, res: Response, next: NextFunction): void {
  // If no protection is configured, pass through
  if (!isMetricsProtectionEnabled()) {
    next();
    return;
  }

  // Check bearer token if configured
  if (config.metrics.authToken) {
    const authHeader = req.headers.authorization;
    if (!validateBearerToken(authHeader)) {
      logger.warn({
        method: req.method,
        path: req.path,
        error: 'Metrics endpoint: invalid or missing bearer token',
      });
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
  }

  // Check CIDR allowlist if configured
  if (config.metrics.allowedCidrs.length > 0) {
    const remoteAddress = req.socket.remoteAddress;
    if (!validateCidr(remoteAddress)) {
      logger.warn({
        method: req.method,
        path: req.path,
        remoteAddress,
        error: 'Metrics endpoint: IP not in allowed CIDRs',
      });
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
  }

  // All checks passed
  next();
}
