import type { Request } from 'express';
import { ErrorCode } from './errorCodes';
import { logger } from './logger';

/** Missing authentication identity is a hard failure for privileged actions. */
export class MissingAuthenticatedAccountError extends Error {
  readonly status = 401;
  readonly code = ErrorCode.UNAUTHORIZED;

  constructor() {
    super('Authenticated account is required');
    this.name = 'MissingAuthenticatedAccountError';
  }
}

export function requireAccount(req: Pick<Request, 'account'>): string {
  const account = req.account;
  if (
    typeof account !== 'string' ||
    !account.trim() ||
    account.trim().toLowerCase() === 'unknown'
  ) {
    logger.error('[auth] missing authenticated wallet for privileged action');
    throw new MissingAuthenticatedAccountError();
  }
  return account.trim();
}
