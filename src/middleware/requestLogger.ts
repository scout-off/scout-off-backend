import { Request, Response, NextFunction } from 'express';
import { extractClientIp } from '../utils/ipExtractor';
import { logger } from '../utils/logger';
import config from '../config';

/**
 * Request logging middleware.
 *
 * Paths listed in `config.requestLog.skipPaths` (default: all health/metrics
 * probes) produce no log output at all, eliminating Kubernetes probe noise.
 *
 * All other paths are subject to `config.requestLog.sampleRate` (0–1).
 * A rate of 1 (the default) logs every request; lower values randomly
 * suppress a fraction of entries for high-frequency application paths.
 *
 * Configuration:
 *   LOG_SKIP_PATHS  — comma-separated list of exact paths to silence
 *                     (default: /health,/health/liveness,/health/readiness,/ready,/metrics)
 *   LOG_SAMPLE_RATE — float 0–1 applied to non-skipped paths (default: 1)
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const { skipPaths, sampleRate } = config.requestLog;

  // Never log configured probe / metrics paths.
  if (skipPaths.includes(req.path)) {
    next();
    return;
  }

  // Apply sampling to all other paths.
  if (sampleRate < 1 && Math.random() >= sampleRate) {
    next();
    return;
  }

  const ip = extractClientIp(req);
  const { correlationId } = req;
  logger.info(
    `[request] ${req.method} ${req.path} ip=${ip}${correlationId ? ` correlationId=${correlationId}` : ''}`
  );
  next();
}
