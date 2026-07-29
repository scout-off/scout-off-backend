import { logger } from '../utils/logger';
import { idempotencyKeysDeletedTotal } from '../middleware/metrics';

export interface IdempotencyCleanupDriver {
  deleteOlderThan(threshold: number): number;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_S = 24 * 60 * 60;

export function deleteExpiredIdempotencyKeys(
  driver: IdempotencyCleanupDriver,
  now: number = Math.floor(Date.now() / 1000)
): number {
  const threshold = now - TWENTY_FOUR_HOURS_S;
  const deleted = driver.deleteOlderThan(threshold);

  if (deleted > 0) {
    idempotencyKeysDeletedTotal.inc(deleted);
  }

  logger.debug(`Deleted ${deleted} expired idempotency key(s)`);
  return deleted;
}

export function startIdempotencyCleanupJob(
  driver: IdempotencyCleanupDriver
): NodeJS.Timeout | undefined {
  if (process.env.NODE_ENV === 'test') {
    logger.debug('Skipping idempotency cleanup job — NODE_ENV is test');
    return undefined;
  }

  const run = () => {
    try {
      deleteExpiredIdempotencyKeys(driver);
    } catch (err) {
      logger.error('Idempotency cleanup error:', (err as Error).message);
    }
  };

  run();
  return setInterval(run, ONE_HOUR_MS);
}
