/** Request-scoped read-your-writes routing for optional PostgreSQL replicas. */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

interface ReadContext {
  allowReplica: boolean;
}
const requestContext = new AsyncLocalStorage<ReadContext>();

function ttlMs(): number {
  const seconds = Number(process.env.DATABASE_READ_AFTER_SECONDS ?? '10');
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 3600 ? seconds * 1000 : 10000;
}
function secret(): string {
  return process.env.JWT_SECRET ?? '';
}
function signedAt(time: number): string {
  const digest = crypto.createHmac('sha256', secret()).update(String(time)).digest('hex');
  return `${time}.${digest}`;
}
export function verifyReadAfter(token: string | undefined, now = Date.now()): boolean {
  if (!token || !secret()) return false;
  const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return false;
  const time = Number(match[1]);
  if (time > now || now - time > ttlMs()) return false;
  const expected = Buffer.from(signedAt(time).split('.')[1], 'hex');
  const observed = Buffer.from(match[2], 'hex');
  return expected.length === observed.length && crypto.timingSafeEqual(expected, observed);
}
/** Call only from the Express request pipeline; background/indexer reads remain on primary. */
export function canReadReplica(): boolean {
  return requestContext.getStore()?.allowReplica === true;
}
export function readConsistencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const readOnly = req.method === 'GET' || req.method === 'HEAD';
  const header = req.get('X-Read-After');
  const cookie = /(?:^|;\s*)scout_read_after=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const marker = header ?? cookie;
  const allowReplica = readOnly && Boolean(secret()) && !verifyReadAfter(marker);
  if (!readOnly && secret()) {
    // Conservatively mark every mutating request, including failures. This may
    // force extra primary reads but never allows stale reads after a write.
    const value = signedAt(Date.now());
    res.setHeader('X-Read-After', value);
    res.setHeader(
      'Set-Cookie',
      `scout_read_after=${value}; Max-Age=${Math.ceil(ttlMs() / 1000)}; Path=/; HttpOnly; SameSite=Lax; Secure`,
    );
    res.setHeader('Access-Control-Expose-Headers', 'X-Read-After');
  }
  requestContext.run({ allowReplica }, next);
}
