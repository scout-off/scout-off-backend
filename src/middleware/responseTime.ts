import { Request, Response, NextFunction } from 'express';

/**
 * Middleware that measures request processing time and adds
 * the `X-Response-Time` header to every response (e.g. "42ms").
 *
 * Sets the header by wrapping `res.end` rather than listening on `finish` —
 * by the time `finish` fires, the response headers have already been flushed
 * to the client, so a `setHeader` call there is a silent no-op.
 */
export function responseTime(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const originalEnd = res.end.bind(res);

  res.end = ((...args: Parameters<Response['end']>) => {
    if (!res.headersSent) {
      res.setHeader('X-Response-Time', `${Date.now() - start}ms`);
    }
    return originalEnd(...args);
  }) as Response['end'];

  next();
}
