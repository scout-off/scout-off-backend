import { Request, Response, NextFunction } from 'express';

/**
 * Middleware that measures request processing time and adds
 * the `X-Response-Time` header to every response (e.g. "42ms").
 */
export function responseTime(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const originalWriteHead = res.writeHead;
  res.writeHead = function(statusCode: any, ...args: any[]) {
    res.setHeader('X-Response-Time', `${Date.now() - start}ms`);
    return originalWriteHead.apply(res, [statusCode, ...args]);
  } as any;
  next();
}
