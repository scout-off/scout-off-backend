import { Request, Response, NextFunction } from 'express';
import config, { isProduction, isStaging } from '../config';

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  const h = config.securityHeaders;

  // HSTS — only meaningful over TLS; omit in development/test to avoid
  // accidentally pinning localhost or CI environments.
  if (isProduction() || isStaging()) {
    res.setHeader('Strict-Transport-Security', h.hsts);
  } else {
    // helmet() (mounted earlier in app.ts) sets this header by default
    // regardless of environment — explicitly strip it here so it's absent
    // outside production/staging regardless of middleware ordering.
    res.removeHeader('Strict-Transport-Security');
  }

  res.setHeader('Content-Security-Policy', h.csp);
  res.setHeader('X-Content-Type-Options', h.xContentTypeOptions);
  res.setHeader('X-Frame-Options', h.xFrameOptions);
  res.setHeader('Referrer-Policy', h.referrerPolicy);
  res.setHeader('Permissions-Policy', h.permissionsPolicy);

  // Belt-and-suspenders: helmet already removes this, but set it explicitly
  // so the header is absent regardless of middleware ordering.
  res.removeHeader('X-Powered-By');

  next();
}
