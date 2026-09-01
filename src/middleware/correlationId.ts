import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { requestContext } from '../utils/requestContext';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
      account?: string;
      role?: string;
    }
  }
}

export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers?.['x-correlation-id'] as string) || randomUUID();
  req.correlationId = id;
  res.setHeader('X-Correlation-ID', id);
  // Bind the rest of this request's async chain to the context so every
  // logger call downstream picks up the correlationId automatically.
  requestContext.run({ correlationId: id }, next);
}
