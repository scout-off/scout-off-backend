import { Request, Response, NextFunction } from 'express';
import config from '../config';

/**
 * Returns an Express middleware that times out the request after `ms` milliseconds.
 *
 * When the timeout fires and no response has been sent yet, the middleware
 * writes a 503 JSON body with code REQUEST_TIMEOUT.
 *
 * Pass `0` to disable the timeout entirely (useful for long-running endpoints
 * such as POST /api/admin/reindex that return 202 immediately but kick off a
 * background job that should never be killed by a network timeout).
 *
 * @param ms  Timeout in milliseconds. 0 = no timeout.
 */
export function createTimeout(ms: number) {
  return function timeoutMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (ms === 0) {
      next();
      return;
    }

    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(503).json({
          success: false,
          error: 'Request timed out',
          code: 'REQUEST_TIMEOUT',
        });
      }
    }, ms);

    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  };
}

/**
 * Default request timeout middleware.
 * Uses REQUEST_TIMEOUT_MS from config (default 30 s).
 *
 * Applied globally in app.ts. Individual routes that need a different timeout
 * should prepend createTimeout(ms) before their handler.
 */
export const requestTimeout = createTimeout(config.requestTimeoutMs);
