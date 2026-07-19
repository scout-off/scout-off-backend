import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { logger } from '../utils/logger';

interface ValidationOptions {
  context?: string;
}

function getCorrelationId(req: Request): string {
  if (!req.headers) return 'none';
  return String(req.headers['x-correlation-id'] ?? req.headers['correlation-id'] ?? 'none');
}

/**
 * Middleware factory that validates `req.body` against a Zod schema.
 *
 * On validation failure: returns HTTP 400 with `{ success: false, error: '<message>' }`.
 * On success: sets `req.body` to the parsed/coerced value and calls `next()`.
 *
 * Usage: router.post('/route', validateBody(mySchema), handler)
 */
export function validateBody<T>(schema: ZodSchema<T>, options?: ValidationOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const correlationId = getCorrelationId(req);
      logger.warn(
        `[validation] ${options?.context ?? 'body'} rejected — error=${
          result.error.errors[0]?.message ?? 'Invalid request body'
        } correlationId=${correlationId}`
      );
      res.status(400).json({
        success: false,
        error: result.error.errors[0]?.message ?? 'Invalid request body',
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Middleware factory that validates `req.query` against a Zod schema.
 *
 * On validation failure: returns HTTP 400 with `{ success: false, error: '<message>' }`.
 * On success: stores the parsed/coerced result in `req.query` and calls `next()`.
 *
 * Usage: router.get('/route', validateQuery(mySchema), handler)
 */
export function validateQuery<T>(schema: ZodSchema<T>, options?: ValidationOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const correlationId = getCorrelationId(req);
      logger.warn(
        `[validation] ${options?.context ?? 'query'} rejected — error=${
          result.error.errors[0]?.message ?? 'Invalid query parameters'
        } correlationId=${correlationId}`
      );
      res.status(400).json({
        success: false,
        error: result.error.errors[0]?.message ?? 'Invalid query parameters',
      });
      return;
    }
    // Cast so the controller can read coerced + defaulted values via req.query
    (req as any).query = result.data;
    next();
  };
}
