import { Request, Response, NextFunction } from 'express';
import config, { isProduction, isStaging } from '../config';

/**
 * Application-owned security headers (CSP, nosniff, frame options, referrer,
 * permissions-policy, HSTS). Helmet is configured in app.ts to leave these
 * unset so each header has exactly one middleware as its source of truth.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  const h = config.securityHeaders;

  // HSTS — only meaningful over TLS; omit in development/test to avoid
  // accidentally pinning localhost or CI environments. helmet's HSTS module
  // is disabled in app.ts, so we only set (never strip) here.
  if (isProduction() || isStaging()) {
    res.setHeader('Strict-Transport-Security', h.hsts);
  }

  res.setHeader('Content-Security-Policy', h.csp);
  res.setHeader('X-Content-Type-Options', h.xContentTypeOptions);
  res.setHeader('X-Frame-Options', h.xFrameOptions);
  res.setHeader('Referrer-Policy', h.referrerPolicy);
  res.setHeader('Permissions-Policy', h.permissionsPolicy);

  // Belt-and-suspenders: Express + helmet both suppress this, but remove it
  // explicitly so the header is absent regardless of middleware ordering.
  res.removeHeader('X-Powered-By');

  next();
}
